/* ============================================================
 * core.test.js — js/core.js 纯逻辑层单元测试
 * 运行：node --test test/     或     npm test
 * 仅使用 Node 内置模块（node:test / node:assert），零第三方依赖。
 * ============================================================ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

// 浮点近似比较
function approx(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `期望 ${expected}，实际 ${actual}`
  );
}

// 构造本地时间（不受运行环境时区影响，getHours 与构造参数一致）
function at(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}
const FRIDAY = 23;   // 2026-10-23 为周五
const SATURDAY = 24; // 2026-10-24 为周六

/* ===================== 市场识别与代码校验 ===================== */

test('validateCode：仅接受 5 位（港股）或 6 位（A股）纯数字', () => {
  assert.equal(C.validateCode('600519'), '600519');
  assert.equal(C.validateCode('  00700  '), '00700');
  assert.equal(C.validateCode('600519abc'), '600519');
  assert.equal(C.validateCode('12'), null);
  assert.equal(C.validateCode('1234567'), null);
  assert.equal(C.validateCode(''), null);
  assert.equal(C.validateCode(null), null);
  assert.equal(C.validateCode(undefined), null);
});

test('getMarket：优先按长度判断，5 位为港股，避免与深市前缀冲突', () => {
  assert.equal(C.getMarket('600519'), 'sh');
  assert.equal(C.getMarket('900901'), 'sh');
  assert.equal(C.getMarket('510300'), 'sh');
  assert.equal(C.getMarket('000001'), 'sz');
  assert.equal(C.getMarket('159915'), 'sz');
  assert.equal(C.getMarket('300750'), 'sz');
  assert.equal(C.getMarket('430047'), 'sz');
  assert.equal(C.getMarket('830799'), 'sz');
  // 关键回归：5 位代码一律识别为港股（即使以 0/6 开头）
  assert.equal(C.getMarket('00700'), 'hk');
  assert.equal(C.getMarket('60051'), 'hk');
  assert.equal(C.getMarket('0070'), null);
  assert.equal(C.getMarket('200001'), null);
  assert.equal(C.getMarket(''), null);
  assert.equal(C.getMarket(null), null);
});

test('getTicker：拼接接口所需的 ticker 前缀', () => {
  assert.equal(C.getTicker('600519'), 'sh600519');
  assert.equal(C.getTicker('000001'), 'sz000001');
  assert.equal(C.getTicker('00700'), 'hk00700');
  assert.equal(C.getTicker('200001'), null);
});

test('getPriceDigits：ETF 与低价港股使用 3 位小数，其余 2 位', () => {
  assert.equal(C.getPriceDigits('510300', 3.5), 3);   // 沪市 ETF
  assert.equal(C.getPriceDigits('159915', 3.5), 3);   // 深市 ETF
  assert.equal(C.getPriceDigits('588000', 1.2), 3);   // 科创板 ETF（5 开头）
  assert.equal(C.getPriceDigits('600519', 1500), 2);
  assert.equal(C.getPriceDigits('00700', 380), 2);
  assert.equal(C.getPriceDigits('08646', 0.5), 3);    // 港股低价股
  assert.equal(C.getPriceDigits('08646', 1.2), 2);
});

/* ===================== 交易时段判定 ===================== */

test('detectMarketStatus：周末一律已收盘', () => {
  assert.equal(C.detectMarketStatus('sh', at(2026, 10, SATURDAY, 10, 0)), 'closed');
  assert.equal(C.detectMarketStatus('hk', at(2026, 10, SATURDAY, 10, 0)), 'closed');
});

test('detectMarketStatus：A股 9:15-11:30 与 13:00-15:00 为盘中', () => {
  assert.equal(C.detectMarketStatus('sh', at(2026, 10, FRIDAY, 9, 20)), 'intraday');
  assert.equal(C.detectMarketStatus('sh', at(2026, 10, FRIDAY, 10, 0)), 'intraday');
  assert.equal(C.detectMarketStatus('sh', at(2026, 10, FRIDAY, 11, 30)), 'closed');   // 11:30 已收盘
  assert.equal(C.detectMarketStatus('sh', at(2026, 10, FRIDAY, 11, 45)), 'closed');   // 午休
  assert.equal(C.detectMarketStatus('sh', at(2026, 10, FRIDAY, 14, 0)), 'intraday');
  assert.equal(C.detectMarketStatus('sh', at(2026, 10, FRIDAY, 15, 0)), 'closed');    // 15:00 已收盘
  assert.equal(C.detectMarketStatus('sh', at(2026, 10, FRIDAY, 15, 30)), 'closed');
});

test('detectMarketStatus：港股含集合竞价 9:00 起，且收市晚于 A 股（回归用例）', () => {
  assert.equal(C.detectMarketStatus('hk', at(2026, 10, FRIDAY, 9, 10)), 'intraday');  // 集合竞价
  assert.equal(C.detectMarketStatus('hk', at(2026, 10, FRIDAY, 10, 0)), 'intraday');
  assert.equal(C.detectMarketStatus('hk', at(2026, 10, FRIDAY, 12, 30)), 'closed');   // 午休
  assert.equal(C.detectMarketStatus('hk', at(2026, 10, FRIDAY, 15, 30)), 'intraday'); // A股此刻已收盘
  assert.equal(C.detectMarketStatus('hk', at(2026, 10, FRIDAY, 16, 5)), 'intraday');  // 收市竞价 16:00-16:10
  assert.equal(C.detectMarketStatus('hk', at(2026, 10, FRIDAY, 16, 10)), 'closed');   // 收市竞价结束
  // 同一时刻两个市场结论不同，用于防止再次遗漏 market 参数
  assert.notEqual(
    C.detectMarketStatus('hk', at(2026, 10, FRIDAY, 15, 30)),
    C.detectMarketStatus('sh', at(2026, 10, FRIDAY, 15, 30))
  );
});

/* ===================== 行情时间解析与市场状态 ===================== */

test('parseQuoteTime：兼容 A股紧凑格式与港股斜杠格式', () => {
  assert.equal(C.parseQuoteTime('20261023161458'), '2026-10-23');
  assert.equal(C.parseQuoteTime('2026/10/23 16:08:14'), '2026-10-23');
  assert.equal(C.parseQuoteTime('2026-10-23 16:08:14'), '2026-10-23');
  assert.equal(C.parseQuoteTime(''), null);
  assert.equal(C.parseQuoteTime(null), null);
  assert.equal(C.parseQuoteTime('not-a-time'), null);
});

test('resolveMarketStatus：行情时间非当天一律视为已收盘（节假日防护）', () => {
  // 周五盘中查询，但接口只返回周四的行情时间 → 已收盘，避免把旧行情当成盘中
  assert.equal(C.resolveMarketStatus('sh', '20261022150000', at(2026, 10, FRIDAY, 10, 0)), 'closed');
  // 行情时间为当天，且时钟处于盘中 → 盘中
  assert.equal(C.resolveMarketStatus('sh', '20261023100000', at(2026, 10, FRIDAY, 10, 0)), 'intraday');
  // 行情时间为当天，但时钟已收市 → 已收盘
  assert.equal(C.resolveMarketStatus('sh', '20261023150000', at(2026, 10, FRIDAY, 15, 30)), 'closed');
  // 解析不到行情时间 → 退回按时钟判断
  assert.equal(C.resolveMarketStatus('sh', '', at(2026, 10, FRIDAY, 10, 0)), 'intraday');
});

/* ===================== 推演区间（涨跌停自适应） ===================== */

test('buildChangeList：支持非对称区间，且始终包含 0', () => {
  assert.deepEqual(C.buildChangeList(-10, 10), C.getChangeList(10));
  assert.deepEqual(C.buildChangeList(-20, 20).slice(0, 2), [-20, -19]);
  assert.deepEqual(C.buildChangeList(-20, 20).slice(-2), [19, 20]);
  assert.deepEqual(C.buildChangeList(-10, 20).slice(-1), [20]);
  assert.deepEqual(C.buildChangeList(0, 5), [0, 1, 2, 3, 4, 5]);           // 非法下限被归零
  assert.deepEqual(C.buildChangeList(-5, -3), [-5, -4, -3, -2, -1, 0]);    // 非法上限被归零，补齐到 0
});

test('buildChangeList：step 步长只保留整数倍档位（港股 ±30% 压缩为 13 档）', () => {
  const list = C.buildChangeList(-30, 30, 5);
  assert.equal(list.length, 13);
  assert.equal(list[0], -30);
  assert.equal(list[list.length - 1], 30);
  assert.ok(list.every((p) => p % 5 === 0), '应只保留 5 的倍数档位');
  assert.ok(list.indexOf(3) === -1, '非 5 倍数档位（如 3%）应被剔除');
  // 步长 1 等价于默认行为
  assert.deepEqual(C.buildChangeList(-10, 10, 1), C.buildChangeList(-10, 10));
  // 区间边界不是步长整数倍时，从区间内最小的倍数开始
  assert.deepEqual(C.buildChangeList(-12, 12, 5), [-10, -5, 0, 5, 10]);
  // 非法步长回退为 1
  assert.deepEqual(C.buildChangeList(-2, 2, 0), [-2, -1, 0, 1, 2]);
});

test('getChangeList：step 参数生效且不产生 -0', () => {
  assert.deepEqual(C.getChangeList(10, 5), [-10, -5, 0, 5, 10]);
  assert.ok(C.getChangeList(10, 5).every((p) => !Object.is(p, -0)), '不应出现 -0');
  assert.deepEqual(C.getChangeList(2), [-2, -1, 0, 1, 2]);
  assert.deepEqual(C.getChangeList(0), [0]);
  assert.equal(C.getChangeList(10).length, 21);
});

test('deriveChangeRange：按涨跌停价反推区间，滥用值回退兜底', () => {
  // 主板 ±10%：昨收 10，涨停 11 / 跌停 9
  assert.deepEqual(C.deriveChangeRange(10, 11, 9, 10), { up: 10, down: 10, source: 'limit' });
  // 创业板/科创板 ±20%
  assert.deepEqual(C.deriveChangeRange(100, 120, 80, 10), { up: 20, down: 20, source: 'limit' });
  // 港股无效字段（接口返回的 47/48 并非涨跌停价）→ 回退
  assert.deepEqual(C.deriveChangeRange(380, 1.38, 658.7, 10), { up: 10, down: 10, source: 'default' });
  // 退市股 -1 → 回退
  assert.deepEqual(C.deriveChangeRange(3, -1, -1, 10), { up: 10, down: 10, source: 'default' });
  // 反推幅度超过上限 → 视为无涨跌停限制，回退
  assert.deepEqual(C.deriveChangeRange(10, 100, 1, 10), { up: 10, down: 10, source: 'default' });
});

/* ===================== 均线信号摘要 ===================== */

test('findLatestCross：从后向前定位最近一次金叉/死叉', () => {
  // MA5 在最后一根上穿 MA10
  const ma5 = [3, 3, 4];
  const ma10 = [4, 4, 3];
  assert.deepEqual(C.findLatestCross(ma5, ma10), { type: 'golden', daysAgo: 0 });
  // 最后一根下穿
  assert.deepEqual(C.findLatestCross([5, 5, 4], [4, 4, 5]), { type: 'death', daysAgo: 0 });
  // 倒数第二根发生金叉，最后一根保持在上方
  assert.deepEqual(C.findLatestCross([3, 4, 5], [4, 3, 3]), { type: 'golden', daysAgo: 1 });
  // 数据不足或未发生交叉
  assert.equal(C.findLatestCross([1], [1]), null);
  assert.equal(C.findLatestCross([1, 2, 3], [1, 2, 3]), null);
  assert.equal(C.findLatestCross(null, [1, 2]), null);
});

test('buildSignalSummary：多头/空头排列与价格相对均线位置', () => {
  const maArrs = {
    ma5: [9, 10, 11],
    ma10: [8, 9, 10],
    ma20: [7, 8, 9],
    ma60: [6, 7, 8]
  };
  const levels = [
    { price: 12, label: '短期压力' },
    { price: 10, label: '短期支撑' }
  ];
  const s = C.buildSignalSummary(maArrs, 11, levels);
  assert.equal(s.arrangement, 'bull');
  assert.ok(s.arrangementText.indexOf('多头排列') !== -1);
  assert.equal(s.vsMa20, 'above');
  assert.equal(s.vsMa60, 'above');
  assert.equal(s.support.label, '短期支撑');
  assert.equal(s.resistance.label, '短期压力');
  assert.ok(s.support.pctDiff > 0);

  // 数据不足时不猜测
  const empty = C.buildSignalSummary({}, 11, []);
  assert.equal(empty.arrangement, null);
  assert.equal(empty.arrangementText, '均线数据不足');
  assert.equal(empty.vsMa20, null);
});

/* ===================== 均线与推演计算 ===================== */

test('calcMA：不足周期返回 null，否则取最近 N 根均值', () => {
  const prices = [10, 11, 12, 13, 14, 15];
  assert.equal(C.calcMA(prices, 5), 13);      // (11+12+13+14+15)/5
  assert.equal(C.calcMA(prices, 6), 12.5);    // (10+...+15)/6
  assert.equal(C.calcMA(prices, 10), null);
  assert.equal(C.calcMA([], 5), null);
  assert.equal(C.calcMA(null, 5), null);
});

test('calcProjectedMA：窗口为最近 (period-1) 根历史 + 预测价', () => {
  const prices = [10, 11, 12, 13, 14, 15];
  approx(C.calcProjectedMA(prices, 16, 5), 14);        // (12+13+14+15+16)/5
  approx(C.calcProjectedMA(prices, 15, 5), 13.8);      // (12+13+14+15+15)/5
  approx(C.calcProjectedMA(prices, 13.5, 5), 13.5);    // (12+13+14+15+13.5)/5
  assert.equal(C.calcProjectedMA(prices, 16, 10), null);          // 历史不足 9 根
  approx(C.calcProjectedMA([1, 2, 3, 4, 5], 6, 5), 4);            // 边界：恰好 (period-1) 根
  assert.equal(C.calcProjectedMA([], 6, 5), null);
  assert.equal(C.calcProjectedMA(null, 6, 5), null);
});

test('buildMAArrays：逐日序列与 calcMA 逐点计算结果一致', () => {
  const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  const arrs = C.buildMAArrays(prices);
  const periods = [5, 10, 20];
  periods.forEach((period) => {
    const arr = arrs['ma' + period];
    assert.equal(arr.length, prices.length);
    for (let i = 0; i < prices.length; i++) {
      const expected = C.calcMA(prices.slice(0, i + 1), period);
      assert.equal(arr[i], expected, `period=${period} index=${i}`);
    }
  });
  // 前 4 个点无 MA5
  assert.deepEqual(arrs.ma5.slice(0, 4), [null, null, null, null]);
  assert.equal(arrs.ma5[4], 12);
  assert.equal(arrs.ma5[11], 19);   // (17+18+19+20+21)/5

  // 默认周期为 CONFIG.MA_PERIODS（含长周期），空数组时返回各周期的空序列
  const empty = C.buildMAArrays([]);
  C.CONFIG.MA_PERIODS.forEach((period) => {
    assert.deepEqual(empty['ma' + period], [], `ma${period} 应为空数组`);
  });

  // 可自定义周期，且只返回传入的周期
  const custom = C.buildMAArrays([1, 2, 3], [2]);
  assert.deepEqual(Object.keys(custom), ['ma2']);
  assert.deepEqual(custom.ma2, [null, 1.5, 2.5]);
});

test('computeSupportResistance：短/中期高低点、斐波那契与去重排序', () => {
  const klines = [];
  for (let i = 0; i < 25; i++) {
    klines.push({ date: `2026-09-${i + 1}`, high: 10 + i, low: 9 + i, close: 9.5 + i });
  }
  const prices = klines.map((k) => k.close);
  const levels = C.computeSupportResistance(klines, prices);
  const pricesList = levels.map((l) => l.price);

  // 25 根：短期(20)高点 34、低点 14；中期(60→25)高点 34、低点 9
  assert.deepEqual([...pricesList].sort((a, b) => b - a), pricesList, '应按价格降序排列');
  assert.equal(levels.length, 6);
  const sorted = [34, 24.45, 21.5, 18.55, 14, 9];
  sorted.forEach((v, i) => approx(pricesList[i], v, 1e-9));

  assert.equal(levels[0].type, 'resistance');
  assert.equal(levels[0].label, '短期压力');
  // 中期压力与短期压力同价，去重后只保留一条 34
  assert.equal(levels.filter((l) => Math.abs(l.price - 34) < 1e-9).length, 1);
  assert.equal(levels.filter((l) => l.type === 'fibonacci').length, 3);
  assert.equal(levels[levels.length - 1].label, '中期支撑');

  assert.deepEqual(C.computeSupportResistance([], []), []);
});

test('findNearestKeyLevel：返回最近关键位，0.5% 内标记高亮', () => {
  const levels = [
    { price: 110, type: 'resistance', label: '压力' },
    { price: 100, type: 'support', label: '支撑' }
  ];
  const near = C.findNearestKeyLevel(levels, 104.6);
  assert.equal(near.level.price, 100);
  approx(near.pctDiff, 0.046);
  assert.equal(near.highlight, false);

  assert.equal(C.findNearestKeyLevel(levels, 100.4).highlight, true);   // 0.4%
  assert.equal(C.findNearestKeyLevel(levels, 100.6).highlight, false);  // 0.6%
  assert.equal(C.findNearestKeyLevel(levels, 100.5).highlight, false);  // 恰好 0.5%（不含）
  assert.equal(C.findNearestKeyLevel([], 100), null);
  assert.equal(C.findNearestKeyLevel(null, 100), null);
});

test('buildProjectionRows：与表格同口径生成 21 档推演数据', () => {
  const prices = [10, 11, 12, 13, 14, 15];
  const levels = [{ price: 15, type: 'resistance', label: '短期压力' }];
  const rows = C.buildProjectionRows(prices, 15, C.getChangeList(10), levels);

  assert.equal(rows.length, 21);
  assert.equal(rows[0].pct, -10);
  assert.equal(rows[20].pct, 10);

  const flat = rows.find((r) => r.pct === 0);
  approx(flat.price, 15);
  approx(flat.ma5, 13.8);

  const up = rows.find((r) => r.pct === 10);
  approx(up.price, 16.5);
  approx(up.ma5, 14.1);

  const down = rows.find((r) => r.pct === -10);
  approx(down.price, 13.5);
  approx(down.ma5, 13.5);

  // 关键位信息直接来自 levels
  assert.equal(flat.keyLevel.label, '短期压力');
  assert.equal(flat.keyHighlight, true);

  // 历史不足时 MA20 应为 null，而不是被错误填充
  assert.equal(flat.ma20, null);
});

/* ===================== 格式化与转义 ===================== */

test('formatPrice / formatPct：空值与非法值统一显示为 -', () => {
  assert.equal(C.formatPrice(16.5, 2), '16.50');
  assert.equal(C.formatPrice(1.2, 3), '1.200');
  assert.equal(C.formatPrice(null, 2), '-');
  assert.equal(C.formatPrice(undefined, 2), '-');
  assert.equal(C.formatPrice(NaN, 2), '-');
  assert.equal(C.formatPct(3), '+3%');
  assert.equal(C.formatPct(-3), '-3%');
  assert.equal(C.formatPct(0), '+0%');
});

test('escapeHtml：转义接口返回的外部文本，避免注入', () => {
  assert.equal(
    C.escapeHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;'
  );
  assert.equal(C.escapeHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
  assert.equal(C.escapeHtml(null), '');
  assert.equal(C.escapeHtml(undefined), '');
});

test('CONFIG：常量集中管理，避免散落硬编码', () => {
  assert.equal(C.CONFIG.KLINE_DAYS, 260);          // 需 ≥ 250 才能算出 MA250
  assert.equal(C.CONFIG.CHANGE_LIMIT, 10);
  assert.equal(C.CONFIG.CHANGE_LIMIT_HK, 30);      // 港股无涨跌停限制，兜底放宽到 ±30%
  assert.equal(C.CONFIG.HISTORY_MAX, 20);
  assert.deepEqual(C.CONFIG.MA_PERIODS, [5, 10, 20, 60, 120, 250]);
  assert.deepEqual(C.CONFIG.CHANGE_STEPS, [1, 5]); // 表格可选档位步长
  assert.ok(C.CONFIG.CHANGE_LIMIT_MAX >= 20, '推演范围上限需覆盖创业板/科创板 ±20%');
  assert.ok(C.CONFIG.CHANGE_LIMIT_MAX >= C.CONFIG.CHANGE_LIMIT_HK, '上限需容纳港股兜底区间');
  // 图表显示密度：只裁剪绘制窗口，不影响均线与推演计算所用历史
  assert.ok(C.CONFIG.CHART_BARS > 0 && C.CONFIG.CHART_BARS <= C.CONFIG.KLINE_DAYS);
  assert.ok(C.CONFIG.CHART_BARS_LONG >= C.CONFIG.CHART_BARS, '开启长周期均线时应显示更长历史');
  assert.ok(C.CONFIG.CHART_MIN_BARS > 0 && C.CONFIG.CHART_MIN_BARS <= C.CONFIG.CHART_BARS);
  assert.ok(C.CONFIG.BAR_MIN_PX > 0);
  assert.ok(C.CONFIG.API_URL.startsWith('https://web.ifzq.gtimg.cn'));
  const colorKeys = ['bg', 'grid', 'text', 'win', 'loss', 'ma5', 'ma10', 'ma20',
    'ma60', 'ma120', 'ma250', 'future'];
  ['light', 'dark'].forEach((theme) => {
    colorKeys.forEach((key) => assert.ok(C.CONFIG.COLORS[theme][key], `${theme}.${key} 缺失`));
  });
});
