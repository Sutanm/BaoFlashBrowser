#!/usr/bin/env node
/**
 * 抽屉几何一致性：切标签前后「抽屉高度 / 占位矩形 / 原生视图尺寸」三者是否对齐。
 *
 * 复现路径（用户报告）：
 *   1. 新标签页打开工具箱（此时没有 page target）
 *   2. 把抽屉往上拖
 *   3. 切到有内容的标签页 → 高度凭空变高、DevTools 不跟随
 *   4. 切回新标签页
 *
 * 每一步都读四个真值：
 *   - store 高度：localStorage['devtoolbox.height']
 *   - 抽屉 DOM 高度：[data-devtools-drawer] 的 rect
 *   - 占位矩形：[data-devtools-host] 的 rect（没有前端视图时为 null）
 *   - 原生视图尺寸：前端页面自己的 window.innerHeight/innerWidth
 *
 *   node tools/devtools-spike/drawer-geometry-check.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');
const LOG = path.join(os.tmpdir(), 'bfb-geom.log');
const FIXTURE = path.join(os.tmpdir(), 'bfb-geom.html');

fs.writeFileSync(FIXTURE, `<!doctype html><html><head><meta charset="utf-8"><title>geom</title>
<style>html,body{margin:0;background:#eef;font:13px sans-serif}</style></head>
<body><div style="padding:10px">GEOM-FIXTURE</div></body></html>`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(3000, () => req.destroy(new Error('timeout')));
});

function cdp(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) { const e = pending.get(m.id); pending.delete(m.id); e(m); return; }
    listeners.forEach((fn) => fn(m));
  });
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return {
    ready,
    onEvent(fn) { listeners.push(fn); },
    send(method, params = {}) {
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise((res) => {
        const t = setTimeout(() => { pending.delete(i); res({ error: { message: 'timeout' } }); }, 15000);
        pending.set(i, (m) => { clearTimeout(t); res(m); });
      });
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    return `EXC ${(d.exception && d.exception.description) || d.text}`;
  }
  return r && r.result && r.result.result && r.result.result.value;
}

const SNAP = `(() => {
  const rect = (el) => el ? { x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
  const drawer = document.querySelector('[data-devtools-drawer]');
  const host = document.querySelector('[data-devtools-host]');
  return JSON.stringify({
    inner: window.innerHeight,
    stored: localStorage.getItem('devtoolbox.height'),
    drawer: rect(drawer),
    host: rect(host),
    noTargetShown: (document.body.innerText || '').indexOf('当前标签没有可调试的页面') !== -1,
    noPortShown: (document.body.innerText || '').indexOf('调试端口') !== -1,
    drawerText: drawer ? String(drawer.innerText || '').slice(0, 160) : null,
    tabs: [].slice.call(document.querySelectorAll('.tab-inner')).map((el) => (el.textContent || '').trim().slice(0, 12)),
  });
})()`;

async function snap(client, label) {
  const raw = await evaluate(client, SNAP);
  let v = null;
  try { v = JSON.parse(String(raw)); } catch { /* ignore */ }
  console.log(`[geom] ${label}:`, JSON.stringify(v));
  return v;
}

async function frontSize(port) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const front = (list || []).find((t) => /devtools_app\.html\?/.test(t.url || ''));
  if (!front) return null;
  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;
  const size = await evaluate(fc, `JSON.stringify({
    w: window.innerWidth, h: window.innerHeight,
    vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight
  })`);
  fc.close();
  try { return JSON.parse(String(size)); } catch { return String(size); }
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1200);

  const out = fs.openSync(LOG, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BAO_DEVTOOLS_PAGE_WS;
  delete env.BAO_DEVTOOLS_LEGACY_HTTP;
  delete env.BAO_DEVTOOLS_BRIDGE;
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  const startedAt = Date.now();
  let port = 0;
  for (let i = 0; i < 80 && !port; i += 1) {
    try {
      if (fs.statSync(PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).split('\n')[0]);
        if (Number.isFinite(p) && p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) port = p;
      }
    } catch { /* not yet */ }
    if (!port) await sleep(500);
  }
  if (!port) { console.error('[geom] 端口没发现'); process.exit(2); }

  const shell = await (async () => {
    for (let i = 0; i < 60; i += 1) {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      const hit = (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || ''));
      if (hit) return hit;
      await sleep(500);
    }
    return null;
  })();
  if (!shell) { child.kill(); process.exit(2); }
  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;
  const logs = [];
  client.onEvent((m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => String(a.value === undefined ? a.description : a.value)).join( ' ');
      if (text.indexOf('[DevToolsTab]') !== -1) logs.push(text);
    }
  });
  await client.send('Runtime.enable');

  // 1) 新标签页打开抽屉
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`);
    if (state === 'clicked') break;
    await sleep(500);
  }
  await sleep(1500);
  await snap(client, '1 新标签页/打开');

  // 2) 先缩小 150px（离开高度上限，否则拖不动、量不到任何延迟），再往上拖回去
  const shrink = `(async () => {
    const handle = document.querySelector('[data-devtools-resize]');
    if (!handle) return 'no-handle';
    const r = handle.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true }));
    for (let i = 1; i <= 15; i += 1) {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx, clientY: cy + 10 * i, pointerId: 1, isPrimary: true }));
      await new Promise((res) => setTimeout(res, 16));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy + 150, pointerId: 1, isPrimary: true }));
    return 'shrunk';
  })()`;
  console.log('[geom] shrink:', await evaluate(client, shrink, true));
  await sleep(600);
  await snap(client, '2a 新标签页/缩小后');

  const dragUp = `(async () => {
    const handle = document.querySelector('[data-devtools-resize]');
    const drawer = document.querySelector('[data-devtools-drawer]');
    if (!handle || !drawer) return 'no-handle';
    const r = handle.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    const lat = [];
    window.__lt = [];
    let ltObserver = null;
    try {
      ltObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration)));
      });
      ltObserver.observe({ entryTypes: ['longtask'] });
    } catch (e) { /* 不支持就只看延迟 */ }
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true }));
    for (let i = 1; i <= 20; i += 1) {
      const prev = Math.round(drawer.getBoundingClientRect().height);
      const t0 = performance.now();
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx, clientY: cy - 10 * i, pointerId: 1, isPrimary: true }));
      const ms = await new Promise((res) => {
        const loop = () => {
          if (Math.round(drawer.getBoundingClientRect().height) !== prev) return res(performance.now() - t0);
          if (performance.now() - t0 > 300) return res(-1);
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      lat.push(Math.round(ms));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy - 200, pointerId: 1, isPrimary: true }));
    await new Promise((res) => setTimeout(res, 250));
    if (ltObserver) ltObserver.disconnect();
    lat.sort((a, b) => a - b);
    const pick = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
    return JSON.stringify({
      latency: { median: pick(0.5), p90: pick(0.9), max: lat[lat.length - 1], all: lat },
      longtasks: window.__lt || [],
    });
  })()`;
  console.log('[geom] dragUp:', await evaluate(client, dragUp, true));
  await sleep(900);
  await snap(client, '2 新标签页/拖高后');

  // 3) 新建一个标签再导航到 fixture —— 这样"新标签页"标签仍在，才能来回切
  await evaluate(client, `(() => {
    const plus = document.querySelector('button.btn-tab');
    if (plus) plus.click();
    return plus ? 'clicked' : 'no-plus';
  })()`);
  await sleep(1500);
  await snap(client, '3 新建标签后');

  // 3) 到有内容的页面
  const fixtureUrl = `file:///${FIXTURE.replace(/\\/g, '/')}`;
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(fixtureUrl)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (state === 'submitted') break;
    await sleep(500);
  }
  await sleep(5000);
  await snap(client, '3 页面标签/刚切换');
  console.log('[geom] front size:', JSON.stringify(await frontSize(port)));

  // 4) 切回新标签页（第 1 个 tab）
  const clickTab = (i) => `(() => {
    const items = document.querySelectorAll('.tab-item');
    if (!items[${i}]) return 'no-tab';
    const r = items[${i}].getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) };
    items[${i}].dispatchEvent(new MouseEvent('mousedown', opts));
    items[${i}].dispatchEvent(new MouseEvent('mouseup', opts));
    items[${i}].dispatchEvent(new MouseEvent('click', opts));
    return 'clicked';
  })()`;

  const activeTab = `(() => {
    const items = [].slice.call(document.querySelectorAll('.tab-item'));
    return String(items.findIndex((el) => el.classList.contains('active')));
  })()`;
  console.log('[geom] switch→tab0:', await evaluate(client, clickTab(0)));
  await sleep(5000);
  console.log('[geom] active tab:', await evaluate(client, activeTab));
  console.log('[geom] tab logs:', JSON.stringify(logs.splice(0)));
  console.log('[geom] devtoolsUrl(page):', await evaluate(client, `window.electronAPI.devtoolbox.devtoolsUrl('page').then(function (r) { return JSON.stringify(r); })`, true));
  await snap(client, '4 切回新标签页');

  // 5) 再切回页面标签（第 2 个 tab）
  console.log('[geom] switch→tab1:', await evaluate(client, clickTab(1)));
  await sleep(2500);
  console.log('[geom] active tab:', await evaluate(client, activeTab));
  await snap(client, '5 再切回页面');
  console.log('[geom] front size:', JSON.stringify(await frontSize(port)));

  client.close();
  child.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('[geom] failed:', e && e.message); process.exit(1); });
