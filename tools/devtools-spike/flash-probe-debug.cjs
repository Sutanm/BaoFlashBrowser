#!/usr/bin/env node
/**
 * 复现「Flash 工具箱显示未检测到 SWF」：把游戏页的真实 DOM 结构 dump 出来。
 *
 *   node tools/devtools-spike/flash-probe-debug.cjs
 *   BFB_URL=https://news.7k7k.com/pkt/ node tools/devtools-spike/flash-probe-debug.cjs
 *
 * 只读：只看结构，不点不登不导航其它页面。
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
const LOG = path.join(os.tmpdir(), 'bfb-flashprobe.log');
const TARGET_URL = process.env.BFB_URL || 'https://news.7k7k.com/pkt/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(5000, () => req.destroy(new Error('timeout')));
});

function cdp(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) { const e = pending.get(m.id); pending.delete(m.id); e(m); }
  });
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return {
    ready,
    send(method, params = {}) {
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise((res) => {
        const t = setTimeout(() => { pending.delete(i); res({ error: { message: 'timeout' } }); }, 20000);
        pending.set(i, (m) => { clearTimeout(t); res(m); });
      });
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) return `EXC ${r.exceptionDetails.text}`;
  return r && r.result && r.result.result && r.result.result.value;
}

const DUMP = `(() => {
  const attr = (el, name) => { try { return el.getAttribute(name); } catch (e) { return null; } };
  const pick = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: attr(el, 'type'),
    src: attr(el, 'src'),
    data: attr(el, 'data'),
    name: attr(el, 'name'),
    value: attr(el, 'value'),
    id: attr(el, 'id'),
    cls: (attr(el, 'class') || '').slice(0, 40),
    box: el.clientWidth + 'x' + el.clientHeight,
  });
  const embeds = [].slice.call(document.querySelectorAll('embed, object, param')).map(pick);
  const iframes = [].slice.call(document.querySelectorAll('iframe, frame')).map((f) => {
    let sameOrigin = false;
    let inner = null;
    try {
      const d = f.contentDocument;
      sameOrigin = !!d;
      if (d) inner = (d.querySelectorAll('embed, object, param').length) + ' plugin nodes';
    } catch (e) { sameOrigin = false; }
    return { src: attr(f, 'src'), sameOrigin, inner, box: f.clientWidth + 'x' + f.clientHeight };
  });
  const swfResources = [];
  try {
    performance.getEntriesByType('resource').forEach((r) => {
      if (String(r.name).toLowerCase().indexOf('.swf') !== -1) swfResources.push(r.name);
    });
  } catch (e) { /* ignore */ }
  return JSON.stringify({
    url: location.href.slice(0, 120),
    title: document.title.slice(0, 40),
    embedCount: embeds.length,
    embeds: embeds.slice(0, 10),
    iframeCount: iframes.length,
    iframes: iframes.slice(0, 10),
    swfResources: swfResources.slice(0, 8),
    plugins: [].slice.call(navigator.plugins || []).map((p) => p.name).slice(0, 8),
    frameCount: window.frames.length,
  });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1200);

  const out = fs.openSync(LOG, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BAO_DEVTOOLS_PAGE_WS;
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
  if (!port) { console.error('[flash] 端口没发现'); process.exit(2); }

  let shell = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { child.kill(); process.exit(2); }
  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;

  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(TARGET_URL)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (state === 'submitted') break;
    await sleep(500);
  }
  console.log('[flash] 导航到', TARGET_URL);
  await sleep(9000);

  // 直接连页面 target（外壳看不到页面 DOM）
  const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const page = (list || []).find((t) => (t.url || '').indexOf('7k7k') !== -1 || (t.url || '') === TARGET_URL);
  if (!page) {
    console.log('[flash] 没找到页面 target，现有 target：');
    for (const t of list || []) console.log('  ', t.type, String(t.url).slice(0, 90));
    client.close(); child.kill(); process.exit(2);
  }
  console.log('[flash] page target:', String(page.url).slice(0, 100));
  const pc = cdp(page.webSocketDebuggerUrl);
  await pc.ready;

  const dump = await evaluate(pc, DUMP);
  try {
    const v = JSON.parse(String(dump));
    console.log('[flash] 顶层 embed/object/param:', v.embedCount);
    for (const e of v.embeds) console.log('   ', JSON.stringify(e));
    console.log('[flash] iframe:', v.iframeCount, '| window.frames:', v.frameCount);
    for (const f of v.iframes) console.log('   ', JSON.stringify(f));
    console.log('[flash] 资源里的 .swf:', v.swfResources.length, JSON.stringify(v.swfResources));
    console.log('[flash] navigator.plugins:', JSON.stringify(v.plugins));
    console.log('[flash] 页面:', v.title, '|', v.url);
  } catch {
    console.log('[flash] dump 解析失败:', String(dump).slice(0, 300));
  }

  pc.close();

  // 端到端：打开工具箱 → 切到 Flash 页 → 读它实际显示了什么
  await evaluate(client, `(() => {
    const b = document.querySelector('[data-devtoolbox-toggle]');
    if (b) b.click();
    return 'opened';
  })()`);
  await sleep(1500);
  const tabInfo = await evaluate(client, `(() => {
    const drawer = document.querySelector('[data-devtools-drawer]');
    if (!drawer) return 'no-drawer';
    const labels = [].slice.call(drawer.querySelectorAll('button')).map((b, i) => i + ':' + (b.textContent || '').trim().slice(0, 8));
    const target = [].slice.call(drawer.querySelectorAll('button')).find((b) => (b.textContent || '').trim().indexOf('Flash') === 0);
    if (target) target.click();
    return labels.join(' | ');
  })()`);
  console.log('[flash] 抽屉按钮:', tabInfo);
  await sleep(1500);
  const panel = await evaluate(client, `(() => {
    const el = document.querySelector('[data-devtools-drawer]');
    return el ? String(el.innerText || '').slice(0, 700) : 'no-drawer';
  })()`);
  console.log('[flash] 工具箱 Flash 页实际显示:\n' + String(panel).replace(/\n{2,}/g, '\n'));

  client.close();
  child.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('[flash] failed:', e && e.message); process.exit(1); });
