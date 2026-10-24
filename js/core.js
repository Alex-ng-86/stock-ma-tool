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
    KLINE_DAYS: 60,             // 请求并参与计算的交易日数量
    HISTORY_MAX: 20,            // 本地历史记录（localStorage）上限
    CHANGE_LIMIT: 10,           // 涨跌幅推演范围 ±N%
    HK_LOW_PRICE: 1,            // 港股低价股阈值（低于该值时使用 3 位小数）
    THEME_KEY: 'ma-tool-theme',
    HISTORY_KEY: 'ma-tool-history',
    // 图表配色（与 CSS 变量语义一致，按主题区分以满足对比度要求）
    COLORS: {
      light: {
        bg: '#ffffff', grid: '#f0f0f0', text: '#6b7280',
        win: '#dc2626', loss: '#15803d',
        ma5: '#b45309', ma10: '#7c3aed', ma20: '#0e7490', future: '#c2410c',
        resistance: '#dc2626', support: '#15803d', fib: '#ea580c'
      },
      dark: {
        bg: '#1e293b', grid: '#334155', text: '#94a3b8',
        win: '#f87171', loss: '#4ade80',
        ma5: '#f59e0b', ma10: '#a78bfa', ma20: '#22d3ee', future: '#fb923c',
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
   * 港股：集合竞价 9:00 起，连续交易 9:30-12:00、13:00-16:00
   * A股 ：集合竞价 9:15-9:30，连续交易 9:30-11:30、13:00-15:00
   */
  function detectMarketStatus(market, date) {
    var now = date || new Date();
    var day = now.getDay();
    if (day === 0 || day === 6) return 'closed';
    var t = now.getHours() * 60 + now.getMinutes();
    if (market === 'hk') {
      if ((t >= 540 && t < 720) || (t >= 780 && t < 960)) return 'intraday';
    } else {
      if ((t >= 555 && t < 690) || (t >= 780 && t < 900)) return 'intraday';
    }
    return 'closed';
  }

  // 涨跌幅档位，如 limit=10 → [-10, -9, ..., 0, ..., 10]
  function getChangeList(limit) {
    var n = Math.abs(Number(limit) || 0);
    var list = [];
    for (var p = -n; p <= n; p++) list.push(p === 0 ? 0 : p);  // 归一闪点：避免出现 -0
    return list;
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
   * 逐日构建 MA5/MA10/MA20 序列（供图表绘制）。
   * 使用滚动求和，避免逐点 slice 导致的 O(n²) 开销与临时数组分配。
   */
  function buildMAArrays(prices) {
    var periods = [5, 10, 20];
    var result = { ma5: [], ma10: [], ma20: [] };
    if (!prices || !prices.length) return result;
    var sums = [0, 0, 0];
    for (var i = 0; i < prices.length; i++) {
      for (var p = 0; p < periods.length; p++) {
        var period = periods[p];
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
    getChangeList: getChangeList,
    calcMA: calcMA,
    calcProjectedMA: calcProjectedMA,
    buildMAArrays: buildMAArrays,
    computeSupportResistance: computeSupportResistance,
    findNearestKeyLevel: findNearestKeyLevel,
    buildProjectionRows: buildProjectionRows,
    formatPrice: formatPrice,
    formatPct: formatPct,
    escapeHtml: escapeHtml
  };
});
