/* ============================================================
 * ui.smoke.test.js — 集成冒烟测试
 * ------------------------------------------------------------
 * 用最小 DOM 桩在 Node 中加载 stock-ma-tool.html 的顶层 UI 脚本，
 * 并 mock fetch 返回一份行情数据，验证「查询 → 渲染」主链路可跑通：
 *   1) 顶层脚本能完整执行（拦截初始化顺序类缺陷，如 var 提升导致的中断）
 *   2) 查询成功后状态栏/结果区/推演表格/图表均被正确渲染
 *   3) 复制按钮能生成文本（核心输出）
 * ============================================================ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/* ---------- 最小 DOM 桩 ---------- */
function makeEl(tag) {
  const classes = new Set();
  const listeners = {};
  const ctxCalls = { count: 0 };

  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k in t) return t[k];
      return () => { ctxCalls.count++; };
    },
    set(t, k, v) { t[k] = v; return true; }
  });

  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, dataset: {},
    children: [],
    innerHTML: '', textContent: '', value: '', id: '',
    parentElement: null,
    getContext: () => ctx,
    toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',   // PNG 导出用
    _ctxCalls: ctxCalls,
    setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; }, getAttribute() { return null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    __fire(type, ev) { (listeners[type] || []).forEach((fn) => fn.call(el, ev || {})); },
    appendChild(child) { child.parentElement = el; el.children.push(child); return child; },
    removeChild(child) { return child; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 800, height: 360 }; },
    click() {},
    focus() {}, scrollIntoView() {}, closest() { return null; }
  };

  Object.defineProperty(el, 'className', {
    get() { return Array.from(classes).join(' '); },
    set(v) {
      classes.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    }
  });
  el.classList = {
    add(...c) { c.forEach((x) => classes.add(x)); },
    remove(...c) { c.forEach((x) => classes.delete(x)); },
    contains(c) { return classes.has(c); },
    toggle(c, force) {
      const want = force === undefined ? !classes.has(c) : !!force;
      if (want) classes.add(c); else classes.delete(c);
      return want;
    }
  };
  return el;
}

/* ---------- 安装全局环境并执行页面脚本 ---------- */
// Node 22 的 navigator/localStorage/fetch 等为只读 getter，必须用 defineProperty 覆盖
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
}

const elements = {};
const downloads = [];                 // 记录触发的下载文件名（PNG 导出验证用）
setGlobal('document', {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  getElementById(id) {
    if (!elements[id]) elements[id] = makeEl('div');
    return elements[id];
  },
  createElement(tag) {
    const el = makeEl(tag);
    el.click = function () { if (el.download) downloads.push(el.download); };
    return el;
  },
  addEventListener() {}
});
setGlobal('localStorage', { getItem() { return null; }, setItem() {}, removeItem() {} });
setGlobal('navigator', { clipboard: null });
setGlobal('getComputedStyle', () => ({ height: '360px' }));
setGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
setGlobal('cancelAnimationFrame', () => {});
setGlobal('window', globalThis);
setGlobal('addEventListener', () => {});

let appError = null;
function loadApp() {
  globalThis.MACore = require(path.join(ROOT, 'js', 'core.js'));
  const html = fs.readFileSync(path.join(ROOT, 'stock-ma-tool.html'), 'utf8');
  const blocks = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g));
  try {
    vm.runInThisContext(blocks[blocks.length - 1][1], { filename: 'stock-ma-tool.html' });
  } catch (err) {
    appError = err;
  }
}

/* ---------- mock 行情接口 ---------- */
// qt 数组沿用腾讯接口下标：3=最新价 4=昨收 30=行情时间 47=涨停价 48=跌停价
// quoteTime 固定为一个与「今天」不同的日期，使 resolveMarketStatus 稳定返回「已收盘」，
// 避免测试结论随运行时刻波动。
const QUOTE_TIME = '20260925150000';
function buildPayload(ticker, name, lastPrice, days, opts) {
  const o = opts || {};
  const kline = [];
  for (let i = 0; i < days; i++) {
    const close = lastPrice - (days - i) * 0.5;
    kline.push([
      '2026-09-' + String((i % 28) + 1).padStart(2, '0'),
      close.toFixed(2), close.toFixed(2),
      (close + 1).toFixed(2), (close - 1).toFixed(2), '10000'
    ]);
  }
  // 最后一根收盘价等于最新价，保证数据自洽
  kline[kline.length - 1][2] = lastPrice.toFixed(2);

  const qt = new Array(49).fill('');
  qt[1] = name; qt[2] = ticker; qt[3] = String(lastPrice);
  qt[4] = o.prevClose != null ? String(o.prevClose) : String(lastPrice);
  qt[30] = QUOTE_TIME;
  if (o.limitUp != null) qt[47] = String(o.limitUp);
  if (o.limitDown != null) qt[48] = String(o.limitDown);

  const payload = {};
  payload[ticker] = { qt: {}, qfqday: kline };
  payload[ticker].qt[ticker] = qt;
  return { data: payload };
}

// 每个 ticker 的 mock 参数：主板 ±10%、创业板 ±20%、港股无涨跌停
const MOCK_QUOTES = {
  sh600519: { name: '贵州茅台', price: 1680, opts: { prevClose: 1680, limitUp: 1848, limitDown: 1512 } },
  sz300750: { name: '宁德时代', price: 100, opts: { prevClose: 100, limitUp: 120, limitDown: 80 } },
  hk00700: { name: '腾讯控股', price: 380, opts: {} }
};

let fetchCalls = 0;
setGlobal('fetch', async (url) => {
  fetchCalls++;
  const ticker = /param=([a-z]+\d+)/.exec(url)[1];
  const q = MOCK_QUOTES[ticker] || { name: '未知', price: 100, opts: {} };
  // 300 根日线 > KLINE_DAYS(260)，确保 MA250 也能算出数值
  return { ok: true, json: async () => buildPayload(ticker, q.name, q.price, 300, q.opts) };
});

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));

/* ---------- 用例 ---------- */
test('顶层脚本可完整执行（拦截 var 提升导致的初始化中断）', () => {
  loadApp();
  assert.equal(appError, null, appError && appError.stack);
  assert.equal(typeof globalThis._doQueryInline, 'function', '脚本应执行到末尾并挂载查询入口');
});

test('查询 A股 600519：状态栏/推演表/图表均渲染成功', async () => {
  elements.stockInput.value = '600519';
  fetchCalls = 0;
  globalThis._doQueryInline();
  await tick(60);

  assert.equal(appError, null, appError && appError.stack);
  assert.equal(fetchCalls, 1, '一次查询只应发起一次请求');

  const statusBar = elements.statusBar;
  const resultSection = elements.resultSection;
  const tablesWrapper = elements.tablesWrapper;
  const emptyState = elements.emptyState;

  assert.equal(statusBar.classList.contains('hidden'), false, '状态栏应显示');
  assert.equal(resultSection.classList.contains('show'), true, '结果区应显示');
  assert.equal(emptyState.classList.contains('hidden'), true, '空状态应隐藏');
  assert.equal(elements.loadingOverlay.classList.contains('show'), false, '加载遮罩应关闭');

  const rowCount = (tablesWrapper.innerHTML.match(/class="change-row/g) || []).length;
  assert.equal(rowCount, 21, '主板 ±10% 应有 21 档涨跌幅推演');
  assert.ok(tablesWrapper.innerHTML.indexOf('贵州茅台') !== -1, '表格标题应含股票名称');

  // 涨跌停价来自接口：1680 × 1.1 / × 0.9
  assert.ok(statusBar.innerHTML.indexOf('涨停') !== -1, '状态栏应显示涨停价');
  assert.ok(statusBar.innerHTML.indexOf('1848.00') !== -1, '涨停价应为 1848.00');
  assert.ok(statusBar.innerHTML.indexOf('1512.00') !== -1, '跌停价应为 1512.00');
  // 状态栏只保留名称/价格/涨跌停/市场状态/数据源，不再重复展示均线（均线在表格与图表中呈现）
  assert.equal(statusBar.innerHTML.indexOf('MA'), -1, '状态栏不应再显示均线值');

  // 信号摘要卡渲染
  assert.equal(elements.signalCard.classList.contains('hidden'), false, '信号摘要卡应显示');
  assert.ok(elements.signalCard.innerHTML.indexOf('sig-item') !== -1, '信号卡应含摘要条目');

  // 图表卡片结构：标题 → 标注层开关 → 画布，标注层开关位于 K 线图标题下方
  const card = elements.chartArea.children[0];
  assert.ok(card.children[1].id === 'srToggleBar' || card.children[1] === elements.srToggleBar,
    '标注层开关应位于图表卡片内、K 线图标题下方');
  const canvas = card.children[2].children[0];
  assert.ok(canvas._ctxCalls.count > 0, 'K 线图应完成绘制调用');
});

test('创业板 300750：推演区间随 ±20% 涨跌停自适应（41 档）', async () => {
  elements.stockInput.value = '300750';
  fetchCalls = 0;
  globalThis._doQueryInline();
  await tick(60);

  assert.equal(fetchCalls, 1);
  const rowCount = (elements.tablesWrapper.innerHTML.match(/class="change-row/g) || []).length;
  assert.equal(rowCount, 41, '创业板 ±20% 应有 41 档涨跌幅推演');
  assert.ok(elements.statusBar.innerHTML.indexOf('120.00') !== -1, '涨停价应为 120.00');
  assert.ok(elements.statusBar.innerHTML.indexOf('80.00') !== -1, '跌停价应为 80.00');
});

test('港股 00700：接口未提供涨跌停价时回退 ±30% 且不显示涨跌停', async () => {
  elements.stockInput.value = '00700';
  fetchCalls = 0;
  globalThis._doQueryInline();
  await tick(60);
  assert.equal(fetchCalls, 1);
  const rowCount = (elements.tablesWrapper.innerHTML.match(/class="change-row/g) || []).length;
  assert.equal(rowCount, 61, '港股无涨跌停，应按兜底 ±30% 生成 61 档');
  assert.equal(elements.statusBar.innerHTML.indexOf('涨停'), -1, '港股不应显示涨跌停价');
});

test('切换档位步长为 5%：±30% 区间压缩为 13 档且只保留 5 的倍数', async () => {
  // 承接上一条港股用例（±30% 区间，1% 步长 61 档）
  elements.step5.__fire('change');
  const html = elements.tablesWrapper.innerHTML;
  const pcts = Array.from(html.matchAll(/data-pct="(-?\d+)"/g)).map((m) => Number(m[1]));
  assert.equal(pcts.length, 13, '±30% 按 5% 步长应只有 13 档');
  assert.equal(Math.min(...pcts), -30);
  assert.equal(Math.max(...pcts), 30);
  assert.ok(pcts.every((p) => p % 5 === 0), '5% 步长下档位应均为 5 的倍数');
  assert.ok(html.indexOf('每 5% 一档') !== -1, '表格标题应体现当前档位步长');
});

test('相同代码的重复查询命中缓存，不产生新请求', async () => {
  elements.stockInput.value = '600519';
  fetchCalls = 0;
  globalThis._doQueryInline();
  await tick(60);
  assert.equal(fetchCalls, 0, '60 秒内重复查询同代码应复用缓存');
});

test('复制文本：包含涨跌停、关键位列与免责声明', async () => {
  let copied = '';
  setGlobal('navigator', { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } });
  elements.copyBtn.__fire('click');
  await tick(20);
  assert.ok(copied.indexOf('均线测算') !== -1, '复制文本应包含标题');
  assert.ok(copied.indexOf('MA5') !== -1, '复制文本应包含 MA5 数值');
  assert.ok(copied.indexOf('涨停') !== -1, '复制文本应包含涨停价');
  assert.ok(copied.indexOf('关键位') !== -1, '复制文本应包含关键位列');
  assert.ok(copied.indexOf('不构成投资建议') !== -1, '复制文本应包含免责声明');
});

test('导出：CSV / Markdown 复制与 PNG 下载均可生成', async () => {
  const copied = [];
  setGlobal('navigator', { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } });

  elements.copyCsvBtn.__fire('click');
  await tick(20);
  elements.copyMdBtn.__fire('click');
  await tick(20);

  assert.equal(copied.length, 2, 'CSV 与 Markdown 各应触发一次复制');
  assert.ok(copied[0].indexOf('涨跌幅,预测收盘价,关键位,MA5,MA10,MA20') !== -1, 'CSV 应含表头');
  assert.ok(copied[0].indexOf('贵州茅台(600519) 均线测算') !== -1, 'CSV 应含标题');
  assert.ok(copied[1].indexOf('| 涨跌幅 | 预测收盘价 | 关键位 | MA5 | MA10 | MA20 |') !== -1, 'Markdown 应含表头行');
  assert.ok(copied[1].indexOf('| --- | --- | --- | --- | --- | --- |') !== -1, 'Markdown 应含分隔行');

  downloads.length = 0;
  elements.exportPngBtn.__fire('click');
  assert.equal(downloads.length, 1, 'PNG 导出应触发一次下载');
  assert.ok(/\.png$/.test(downloads[0]), '下载文件应为 .png');
  assert.ok(downloads[0].indexOf('600519') !== -1, '文件名应含股票代码');
});

test('清除按钮：隐藏信号卡并重置结果区', async () => {
  elements.clearBtn.__fire('click');
  await tick(20);
  assert.equal(elements.signalCard.classList.contains('hidden'), true, '信号卡应被隐藏');
  assert.equal(elements.statusBar.classList.contains('hidden'), true, '状态栏应被隐藏');
  assert.equal(elements.resultSection.classList.contains('show'), false, '结果区应被隐藏');
});

test('非法代码给出错误提示且不发起请求', async () => {
  elements.stockInput.value = '123';
  fetchCalls = 0;
  globalThis._doQueryInline();
  await tick(20);
  assert.equal(fetchCalls, 0, '非法代码不应发起请求');
  assert.equal(elements.errorToast.classList.contains('show'), true, '应显示错误提示');
});
