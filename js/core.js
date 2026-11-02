/* ============================================================
 * core.js — 纯逻辑层（无 DOM 依赖）
 * ------------------------------------------------------------
 * 同一份代码同时支持两种运行环境：
 *   - 浏览器：普通 <script> 引入后挂载到 window.MACore
 *   - Node  ：require('./js/core.js') 直接用于单元测试
 * 约束：所有函数只依赖显式入参，不读写任何全局状态，
 *       以便被 UI 层复用且可被测试覆盖。
 * ============================================================ */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.MACore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ===== 配置：项目中所有硬编码常量的唯一来源 ===== */
  var CONFIG = {
    API_URL: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
    REQUEST_TIMEOUT_MS: 8000,   // 单次行情请求超时时间
    CACHE_TTL_MS: 60000,        // 同一代码结果缓存有效期，避免重复查询重复请求
    KLINE_DAYS: 260,            // 请求并参与计算的交易日数量（需 ≥ 250 才能算出年线 MA250）
    HISTORY_MAX: 20,            // 本地历史记录（localStorage）上限
    CHANGE_LIMIT: 10,           // A 股无有效涨跌停价时（退市股等）的兜底推演范围 ±N%
    CHANGE_LIMIT_HK: 30,        // 港股无涨跌停限制，兜底推演范围放宽到 ±N%
    CHANGE_LIMIT_MAX: 30,       // 推演范围上限：超过该值视为无涨跌停限制，回退到兜底值
    CHANGE_STEPS: [1, 5],       // 推演表格可选的档位步长（%）
    MA_PERIODS: [5, 10, 20, 60, 120, 250],   // 参与计算的均线周期
    // —— 图表显示密度（只影响绘制，不影响均线与推演的计算所用历史长度）——
    CHART_BARS: 120,            // 默认最多绘制的 K 线根数
    CHART_BARS_LONG: 250,       // 开启长周期均线时最多绘制的 K 线根数
    CHART_MIN_BARS: 40,         // 窄屏下的绘制根数下限，避免每根过窄
    BAR_MIN_PX: 6,              // 每根 K 线的期望最小像素宽度，用于按画布宽度自适应根数
    HK_LOW_PRICE: 1,            // 港股低价股阈值（低于该值时使用 3 位小数）
    THEME_KEY: 'ma-tool-theme',
    HISTORY_KEY: 'ma-tool-history',
    // 图表配色（与 CSS 变量语义一致，按主题区分以满足对比度要求）
    COLORS: {
      light: {
        bg: '#ffffff', grid: '#f0f0f0', text: '#6b7280',
        win: '#dc2626', loss: '#15803d',
        ma5: '#b45309', ma10: '#7c3aed', ma20: '#0e7490', future: '#c2410c',
        ma60: '#be185d', ma120: '#4d7c0f', ma250: '#475569',
        resistance: '#dc2626', support: '#15803d', fib: '#ea580c'
      },
      dark: {
        bg: '#1e293b', grid: '#334155', text: '#94a3b8',
        win: '#f87171', loss: '#4ade80',
        ma5: '#f59e0b', ma10: '#a78bfa', ma20: '#22d3ee', future: '#fb923c',
        ma60: '#f472b6', ma120: '#a3e635', ma250: '#cbd5e1',
        resistance: '#f87171', support: '#4ade80', fib: '#fb923c'
      }
    }
  };

  /* ===== 代码校验与市场识别 ===== */
  // 仅保留数字，A股为 6 位、港股为 5 位，其它长度视为非法
  function validateCode(input) {
    var code = String(input == null ? '' : input).replace(/\D/g, '');
    if (code.length === 6 || code.length === 5) return code;
    return null;
  }

  // 必须优先按长度判断：5 位为港股，避免与深市 0/1 开头代码前缀冲突
  function getMarket(code) {
    code = String(code || '');
    if (code.length === 5) return 'hk';
    if (code.length !== 6) return null;
    var prefix = code.charAt(0);
    if (['6', '9', '5'].indexOf(prefix) !== -1) return 'sh';  // 沪市 6xxxxx / 9xxxxx / 5xxxxx
    if (['0', '1', '3', '4', '8'].indexOf(prefix) !== -1) return 'sz';  // 深市 0/1/3/4/8 开头
    return null;
  }

  // 拼接行情接口所需的 ticker，如 sh600519 / sz159915 / hk00700
  function getTicker(code) {
    var market = getMarket(code);
    return market ? market + code : null;
  }

  /**
   * 价格显示精度：
   * - A股 ETF（6 位且以 5/1 开头，覆盖 51xx/15xx/58xx 等）使用 3 位小数
   * - 港股低价股（股价 < 1 港元）使用 3 位小数，避免均线四舍五入后显示完全一致
   * - 其余为 2 位小数
   */
  function getPriceDigits(code, price) {
    code = String(code || '');
    var isAStockEtf = code.length === 6 && (code.charAt(0) === '5' || code.charAt(0) === '1');
    var isLowPriceHk = code.length === 5 && Number(price) < CONFIG.HK_LOW_PRICE;
    return (isAStockEtf || isLowPriceHk) ? 3 : 2;
  }

  /**
   * 交易时段判定（以本机时区的传入日期为准，便于测试）
   * 港股：集合竞价 9:00 起，连续交易 9:30-12:00、13:00-16:00，收市竞价 16:00-16:10
   * A股 ：集合竞价 9:15-9:30，连续交易 9:30-11:30、13:00-15:00
   * 说明：本函数只看时钟，无法识别节假日；节假日请用 resolveMarketStatus 结合行情时间判断。
   */
  function detectMarketStatus(market, date) {
    var now = date || new Date();
    var day = now.getDay();
    if (day === 0 || day === 6) return 'closed';
    var t = now.getHours() * 60 + now.getMinutes();
    if (market === 'hk') {
      if ((t >= 540 && t < 720) || (t >= 780 && t < 970)) return 'intraday';
    } else {
      if ((t >= 555 && t < 690) || (t >= 780 && t < 900)) return 'intraday';
    }
    return 'closed';
  }

  /* ===== 行情时间解析与市场状态 ===== */
  /**
   * 解析接口 qt[30] 的行情时间，返回 'YYYY-MM-DD'，无法识别时返回 null。
   * 实测各市场格式不一致：
   *   A股  20261023161458
   *   港股 2026/10/23 16:08:14
   *   其它 2026-10-23 ...
   */
  function parseQuoteTime(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    var m = /^(\d{4})(\d{2})(\d{2})\d{6}$/.exec(s);
    if (!m) m = /^(\d{4})[/-](\d{2})[/-](\d{2})/.exec(s);
    if (!m) return null;
    return m[1] + '-' + m[2] + '-' + m[3];
  }

  // 本机时区下的 'YYYY-MM-DD'
  function localDateKey(date) {
    var d = date || new Date();
    var mm = String(d.getMonth() + 1);
    var dd = String(d.getDate());
    return d.getFullYear() + '-' + (mm.length < 2 ? '0' + mm : mm) + '-' + (dd.length < 2 ? '0' + dd : dd);
  }

  /**
   * 市场状态：优先用行情时间判断，避免节假日/休市时把「昨天的收盘行情」当成盘中。
   * - 行情时间不是当天 → closed（节假日、非交易日、A股 15:00 后拿到当日收盘数据的时间也可能非当天）
   * - 行情时间是当天 → 再用 detectMarketStatus 判断具体时段
   * - 解析不到行情时间 → 退回 detectMarketStatus（仅依赖本机时钟）
   */
  function resolveMarketStatus(market, quoteTime, date) {
    var now = date || new Date();
    var quoteKey = parseQuoteTime(quoteTime);
    if (!quoteKey) return detectMarketStatus(market, now);
    if (quoteKey !== localDateKey(now)) return 'closed';
    return detectMarketStatus(market, now);
  }

  // 涨跌幅档位，如 limit=10 → [-10, -9, ..., 0, ..., 10]
  function getChangeList(limit, step) {
    var n = Math.abs(Number(limit) || 0);
    return buildChangeList(-n, n, step);
  }

  /**
   * 指定区间 [minPct, maxPct] 的档位列表，保证包含 0 且升序。
   * step 为档位步长：1 表示逐 1%（默认）；大于 1 时只保留该步长的整数倍档位
   * （例如步长 5、区间 ±30% 时只输出 -30/-25/…/0/…/30，避免表格过长）。
   */
  function buildChangeList(minPct, maxPct, step) {
    var lo = Math.round(Number(minPct) || 0);
    var hi = Math.round(Number(maxPct) || 0);
    if (lo > 0) lo = 0;
    if (hi < 0) hi = 0;
    var s = Math.abs(Math.round(Number(step) || 0)) || 1;

    var list = [];
    if (s === 1) {
      for (var p = lo; p <= hi; p++) list.push(p === 0 ? 0 : p);   // 归一闪点：避免出现 -0
      return list;
    }
    var first = Math.ceil(lo / s) * s;
    for (var q = first; q <= hi; q += s) list.push(q === 0 ? 0 : q);
    return list;
  }

  /**
   * 由接口给出的昨收 / 涨停价 / 跌停价反推推演区间（整数百分比）。
   * 接口仅在 A 股返回有效涨跌停价（主板 ±10%、创业板/科创板 ±20%、ETF ±10%）；
   * 退市整理股、北交所等返回 -1，港股返回的 47/48 号字段并非涨跌停价，
   * 因此：仅在价格合法且反推出的涨跌幅落在 (0, CHANGE_LIMIT_MAX] 内时才采用，否则回退兜底值。
   */
  function deriveChangeRange(prevClose, limitUp, limitDown, fallback) {
    var fb = Math.abs(Number(fallback) || 0) || CONFIG.CHANGE_LIMIT;
    var base = Number(prevClose);
    var up = Number(limitUp);
    var down = Number(limitDown);
    if (!(base > 0) || !(up > 0) || !(down > 0)) return { up: fb, down: fb, source: 'default' };

    var upPct = Math.round((up / base - 1) * 100);
    var downPct = Math.round((1 - down / base) * 100);
    if (upPct <= 0 || downPct <= 0) return { up: fb, down: fb, source: 'default' };
    if (upPct > CONFIG.CHANGE_LIMIT_MAX || downPct > CONFIG.CHANGE_LIMIT_MAX) {
      return { up: fb, down: fb, source: 'default' };
    }
    return { up: upPct, down: downPct, source: 'limit' };
  }

  /* ===== 均线计算 ===== */
  // 简单移动平均：不足 period 根时返回 null（不产生误导性数值）
  function calcMA(prices, period) {
    if (!prices || !period || prices.length < period) return null;
    var sum = 0;
    for (var i = prices.length - period; i < prices.length; i++) sum += prices[i];
    return sum / period;
  }

  /**
   * 预测均线：以历史最后 (period-1) 根收盘价 + 预测收盘价构成 period 窗口后取均值。
   * 历史不足 period-1 根时返回 null。
   */
  function calcProjectedMA(histPrices, projectedPrice, period) {
    if (!histPrices || !period || histPrices.length < period - 1) return null;
    var sum = Number(projectedPrice);
    var start = histPrices.length - (period - 1);
    for (var i = start; i < histPrices.length; i++) sum += histPrices[i];
    return sum / period;
  }

  /**
   * 逐日构建均线序列（供图表绘制）。
   * periods 可自定义，默认取 CONFIG.MA_PERIODS（5/10/20/60/120/250）。
   * 使用滚动求和，避免逐点 slice 导致的 O(n²) 开销与临时数组分配。
   */
  function buildMAArrays(prices, periods) {
    var list = (periods && periods.length) ? periods : CONFIG.MA_PERIODS;
    var result = {};
    var p, i;
    for (p = 0; p < list.length; p++) result['ma' + list[p]] = [];
    if (!prices || !prices.length) return result;

    var sums = [];
    for (p = 0; p < list.length; p++) sums.push(0);
    for (i = 0; i < prices.length; i++) {
      for (p = 0; p < list.length; p++) {
        var period = list[p];
        sums[p] += prices[i];
        if (i >= period) sums[p] -= prices[i - period];
        result['ma' + period].push(i + 1 >= period ? sums[p] / period : null);
      }
    }
    return result;
  }

  /* ===== 支撑/压力与斐波那契回撤 ===== */
  /**
   * 计算关键价位：
   * - 短期压力/支撑：最近 20 根 K 线的最高价/最低价
   * - 中期压力/支撑：最近 60 根 K 线的最高价/最低价
   * - 斐波那契：最近 60 根 K 线高低点区间的 0.382 / 0.5 / 0.618 回撤位
   * 结果按价格从高到低排序，并对差异 < 0.3% 的价位去重。
   */
  function computeSupportResistance(klines, prices) {
    var levels = [];
    var n = Math.min((klines || []).length, (prices || []).length);
    if (n <= 0) return levels;

    function extremes(lookback) {
      var from = Math.max(0, n - lookback);
      var high = -Infinity, low = Infinity;
      for (var i = from; i < n; i++) {
        var k = klines[i];
        if (!k) continue;
        if (k.high) high = Math.max(high, k.high);
        if (k.low) low = Math.min(low, k.low);
      }
      return { high: high, low: low };
    }

    var short = extremes(20);
    if (short.high !== -Infinity) levels.push({ price: short.high, type: 'resistance', label: '短期压力' });
    if (short.low !== Infinity) levels.push({ price: short.low, type: 'support', label: '短期支撑' });

    var mid = extremes(60);
    if (mid.high !== -Infinity) levels.push({ price: mid.high, type: 'resistance', label: '中期压力' });
    if (mid.low !== Infinity) levels.push({ price: mid.low, type: 'support', label: '中期支撑' });

    if (mid.high !== -Infinity && mid.low !== Infinity && mid.high > mid.low) {
      var diff = mid.high - mid.low;
      var ratios = [0.382, 0.5, 0.618];
      for (var f = 0; f < ratios.length; f++) {
        var price = mid.high - diff * ratios[f];
        if (price > mid.low && price < mid.high) {
          levels.push({ price: price, type: 'fibonacci', label: '斐波那契' });
        }
      }
    }

    var unique = [];
    for (var j = 0; j < levels.length; j++) {
      var duplicated = false;
      for (var u = 0; u < unique.length; u++) {
        if (Math.abs(levels[j].price - unique[u].price) / levels[j].price < 0.003) {
          duplicated = true;
          break;
        }
      }
      if (!duplicated) unique.push(levels[j]);
    }
    return unique.sort(function (a, b) { return b.price - a.price; });
  }

  /**
   * 找到距离目标价最近的关键位。
   * 返回 null（无关键位）或 { level, distance, pctDiff, highlight }，
   * highlight 表示距离在 0.5% 以内（表格中高亮提示“临近关键位”）。
   */
  function findNearestKeyLevel(levels, price) {
    if (!levels || !levels.length) return null;
    var nearest = null;
    var nearestDist = Infinity;
    for (var i = 0; i < levels.length; i++) {
      var dist = Math.abs(levels[i].price - price);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = levels[i];
      }
    }
    if (!nearest || !nearest.price) return null;
    var pctDiff = nearestDist / nearest.price;
    return { level: nearest, distance: nearestDist, pctDiff: pctDiff, highlight: pctDiff < 0.005 };
  }

  /**
   * 均线信号摘要：把均线、价格与关键位压缩成一句可读结论，供界面直接展示。
   * 入参 maArrs 为 buildMAArrays 的结果；数据不足时对应字段返回 null 而不猜测。
   */
  function buildSignalSummary(maArrs, lastPrice, levels) {
    var out = {
      arrangement: null,      // bull / bear / mixed
      arrangementText: '均线数据不足',
      vsMa20: null,           // above / below
      vsMa60: null,
      cross: null,            // { type: 'golden' | 'death', daysAgo: n }
      support: null,          // { price, label, pctDiff }
      resistance: null
    };
    var price = Number(lastPrice);
    if (!(price > 0)) return out;

    function latest(key) {
      var arr = maArrs && maArrs[key];
      if (!arr) return null;
      for (var i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
      return null;
    }

    var m5 = latest('ma5');
    var m10 = latest('ma10');
    var m20 = latest('ma20');
    var m60 = latest('ma60');

    if (m5 != null && m10 != null && m20 != null) {
      if (m5 > m10 && m10 > m20) {
        out.arrangement = 'bull';
        out.arrangementText = 'MA5>MA10>MA20 多头排列';
      } else if (m5 < m10 && m10 < m20) {
        out.arrangement = 'bear';
        out.arrangementText = 'MA5<MA10<MA20 空头排列';
      } else {
        out.arrangement = 'mixed';
        out.arrangementText = '均线交织，趋势待确认';
      }
    }
    if (m20 != null) out.vsMa20 = price >= m20 ? 'above' : 'below';
    if (m60 != null) out.vsMa60 = price >= m60 ? 'above' : 'below';
    out.cross = findLatestCross(maArrs && maArrs.ma5, maArrs && maArrs.ma10);

    // 最近的下方支撑 / 上方压力（与类型无关，取离现价最近者）
    if (levels && levels.length) {
      for (var i = 0; i < levels.length; i++) {
        var lv = levels[i];
        if (!(lv.price > 0)) continue;
        var pctDiff = Math.abs(lv.price - price) / price;
        var item = { price: lv.price, label: lv.label, pctDiff: pctDiff };
        if (lv.price <= price) {
          if (!out.support || lv.price > out.support.price) out.support = item;
        } else if (!out.resistance || lv.price < out.resistance.price) {
          out.resistance = item;
        }
      }
    }
    return out;
  }

  // 从后向前查找 MA5 与 MA10 最近一次符号翻转（金叉 / 死叉）
  function findLatestCross(ma5Arr, ma10Arr) {
    if (!ma5Arr || !ma10Arr) return null;
    var n = Math.min(ma5Arr.length, ma10Arr.length);
    if (n < 2) return null;
    for (var i = n - 1; i >= 1; i--) {
      var a0 = ma5Arr[i - 1], b0 = ma10Arr[i - 1];
      var a1 = ma5Arr[i], b1 = ma10Arr[i];
      if (a0 == null || b0 == null || a1 == null || b1 == null) continue;
      var prev = a0 - b0;
      var curr = a1 - b1;
      if (prev === 0 || curr === 0) continue;
      if ((prev < 0) !== (curr < 0)) {
        return { type: curr > 0 ? 'golden' : 'death', daysAgo: n - 1 - i };
      }
    }
    return null;
  }

  /**
   * 生成涨跌幅推演数据（表格与复制文本的共同数据源）。
   * 与表格展示的基准价保持完全一致，避免图表与表格口径不一致。
   */
  function buildProjectionRows(prices, basePrice, changes, levels) {
    var rows = [];
    for (var i = 0; i < changes.length; i++) {
      var pct = changes[i];
      var price = basePrice * (1 + pct / 100);
      var key = findNearestKeyLevel(levels, price);
      rows.push({
        pct: pct,
        price: price,
        ma5: calcProjectedMA(prices, price, 5),
        ma10: calcProjectedMA(prices, price, 10),
        ma20: calcProjectedMA(prices, price, 20),
        keyLevel: key ? key.level : null,
        keyPctDiff: key ? key.pctDiff : null,
        keyHighlight: key ? key.highlight : false
      });
    }
    return rows;
  }

  /* ===== 格式化与安全 ===== */
  // 统一价格格式化：空值/非法值统一显示为 '-'，避免出现 NaN / null
  function formatPrice(value, digits) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    return Number(value).toFixed(digits == null ? 2 : digits);
  }

  function formatPct(pct) {
    return (pct >= 0 ? '+' : '') + pct + '%';
  }

  // 转义外部数据（接口返回的股票名称等），避免 innerHTML 注入与渲染破坏
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }

  return {
    CONFIG: CONFIG,
    validateCode: validateCode,
    getMarket: getMarket,
    getTicker: getTicker,
    getPriceDigits: getPriceDigits,
    detectMarketStatus: detectMarketStatus,
    parseQuoteTime: parseQuoteTime,
    resolveMarketStatus: resolveMarketStatus,
    getChangeList: getChangeList,
    buildChangeList: buildChangeList,
    deriveChangeRange: deriveChangeRange,
    calcMA: calcMA,
    calcProjectedMA: calcProjectedMA,
    buildMAArrays: buildMAArrays,
    computeSupportResistance: computeSupportResistance,
    findNearestKeyLevel: findNearestKeyLevel,
    buildSignalSummary: buildSignalSummary,
    findLatestCross: findLatestCross,
    buildProjectionRows: buildProjectionRows,
    formatPrice: formatPrice,
    formatPct: formatPct,
    escapeHtml: escapeHtml
  };
});
