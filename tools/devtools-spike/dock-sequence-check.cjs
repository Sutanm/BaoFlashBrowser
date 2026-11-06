#!/usr/bin/env node
/**
 * 停靠序列：下 → 左 → 右（真实点击顶栏图标），每步对比「抽屉矩形」与「上报给原生视图的矩形」。
 *
 *   BAO_DEVTOOLS_BOUNDS_LOG=1 node tools/devtools-spike/dock-sequence-check.cjs
 *
 * 判据：抽屉在左 → 上报 x=0；抽屉在右 → 上报 x=窗口宽-抽屉宽。
 * 若某一步上报的 x 还是上一步的值，说明「只有 x 变、尺寸不变」没被补报（原生视图会留在原处）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');
const LOG = path.join(os.tmpdir(), 'bfb-dockseq.log');

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

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e(msg); }
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    send(method, params = {}) {
      const i = ++id;
      socket.send(JSON.stringify({ id: i, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ error: { message: 'timeout' } }); } }, 15000);
        pending.set(i, (m) => { clearTimeout(timer); resolve(m); });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression, awaitPromise = true) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) return `EXC ${r.exceptionDetails.text}`;
  return r && r.result && r.result.result && r.result.result.value;
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(400);
  }
  console.log('[dockseq] 等待超时:', label);
  return null;
}

const clickDock = (labelPart) => `(() => {
  const drawer = document.querySelector('[data-devtools-drawer]');
  if (!drawer) return 'no-drawer';
  const btn = [].slice.call(drawer.querySelectorAll('button'))
    .find((b) => (b.getAttribute('aria-label') || '').indexOf(${JSON.stringify(labelPart)}) !== -1);
  if (!btn) return 'no-btn';
  if (btn.disabled) return 'disabled';
  btn.click();
  return 'clicked';
})()`;

const MEASURE = `(() => {
  const drawer = document.querySelector('[data-devtools-drawer]');
  if (!drawer) return JSON.stringify({ present: false });
  const r = drawer.getBoundingClientRect();
  const host = document.querySelector('[data-devtools-host]');
  const h = host ? host.getBoundingClientRect() : null;
  return JSON.stringify({
    drawer: { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) },
    host: h ? { x: Math.round(h.x), y: Math.round(h.y), w: Math.round(h.width), h: Math.round(h.height) } : null,
    win: { w: window.innerWidth, h: window.innerHeight },
  });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const fixture = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>dockseq</title><style>body{margin:0}</style></head><body><div id="x">DOCKSEQ</div></body></html>');
  });
  const fixturePort = await new Promise((resolve) => { fixture.listen(0, '127.0.0.1', () => resolve(fixture.address().port)); });

  const out = fs.openSync(LOG, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  const startedAt = Date.now();
  const port = await waitUntil(async () => {
    try {
      if (fs.statSync(PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).split('\n')[0]);
        if (p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) return p;
      }
    } catch { /* not yet */ }
    return null;
  }, 40000, 'debug port');
  if (!port) { fixture.close(); process.exit(2); }

  const shell = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || '')) || null;
  }, 30000, 'shell');
  if (!shell) { fixture.close(); process.exit(2); }
  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;

  const navigate = (url) => evaluate(client, `(() => {
    const input = document.querySelector('.address-input');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(url)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return 'submitted';
  })()`, false);

  for (let i = 0; i < 40; i += 1) {
    if (await navigate(`http://127.0.0.1:${fixturePort}/page`) === 'submitted') break;
    await sleep(500);
  }
  await sleep(2500);

  for (let i = 0; i < 40; i += 1) {
    const st = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`, false).catch(() => 'no-button');
    if (st === 'clicked') break;
    await sleep(500);
  }
  await sleep(4000);
  console.log('[dockseq] 初始:', await evaluate(client, MEASURE, false));

  const stepMs = Number(process.env.BFB_STEP_MS || 1800);
  for (const label of ['底部', '左侧', '右侧']) {
    console.log(`[dockseq] 点「${label}」:`, await evaluate(client, clickDock(label), false));
    await sleep(stepMs);
    console.log(`[dockseq] ${label}后:`, await evaluate(client, MEASURE, false));
  }

  const bounds = fs.readFileSync(LOG, 'utf8').split('\n').filter((line) => line.includes('bounds →')).slice(-8);
  console.log('[dockseq] 主进程收到的矩形:');
  for (const line of bounds) console.log('   ', line.replace(/^\d+:\d+:\d+\.\d+ > /, ''));

  client.close();
  fixture.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[dockseq] failed:', e && e.message); process.exit(1); });
