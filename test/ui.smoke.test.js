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
setGlobal('document', {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  getElementById(id) {
    if (!elements[id]) elements[id] = makeEl('div');
    return elements[id];
  },
  createElement(tag) { return makeEl(tag); },
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
function buildPayload(ticker, name, lastPrice, days) {
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
  const payload = {};
  payload[ticker] = { qt: {}, qfqday: kline };
  payload[ticker].qt[ticker] = ['1', name, ticker, String(lastPrice), '', '', '', '', '', ''];
  return { data: payload };
}

let fetchCalls = 0;
setGlobal('fetch', async (url) => {
  fetchCalls++;
  const ticker = /param=([a-z]+\d+)/.exec(url)[1];
  const isHk = ticker.startsWith('hk');
  return {
    ok: true,
    json: async () => buildPayload(ticker, isHk ? '腾讯控股' : '贵州茅台', isHk ? 380 : 1680, 60)
  };
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
  assert.equal(rowCount, 21, '应有 21 档涨跌幅推演（-10% ~ +10%）');
  assert.ok(tablesWrapper.innerHTML.indexOf('贵州茅台') !== -1, '表格标题应含股票名称');

  const canvas = elements.chartArea.children[0].children[1].children[0];
  assert.ok(canvas._ctxCalls.count > 0, 'K 线图应完成绘制调用');
});

test('相同代码的重复查询命中缓存，不产生新请求', async () => {
  elements.stockInput.value = '600519';
  fetchCalls = 0;
  globalThis._doQueryInline();
  await tick(60);
  assert.equal(fetchCalls, 0, '60 秒内重复查询同代码应复用缓存');
});

test('港股 00700：按 5 位代码识别市场并渲染', async () => {
  elements.stockInput.value = '00700';
  fetchCalls = 0;
  globalThis._doQueryInline();
  await tick(60);
  assert.equal(fetchCalls, 1);
  assert.ok(elements.tablesWrapper.innerHTML.indexOf('腾讯控股') !== -1, '应渲染港股名称');
});

test('复制按钮可生成包含均线数据的文本', async () => {
  let copied = '';
  setGlobal('navigator', { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } });
  elements.copyBtn.__fire('click');
  await tick(20);
  assert.ok(copied.indexOf('均线测算') !== -1, '复制文本应包含标题');
  assert.ok(copied.indexOf('MA5') !== -1, '复制文本应包含 MA5 数值');
});

test('非法代码给出错误提示且不发起请求', async () => {
  elements.stockInput.value = '123';
  fetchCalls = 0;
  globalThis._doQueryInline();
  await tick(20);
  assert.equal(fetchCalls, 0, '非法代码不应发起请求');
  assert.equal(elements.errorToast.classList.contains('show'), true, '应显示错误提示');
});
