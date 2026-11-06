#!/usr/bin/env node
/**
 * 验证「原生 DevTools 的停靠/关闭」接进了外壳。
 *
 *   node tools/devtools-spike/frontend-intent-check.cjs
 *
 * 直接从前端 target 调 `window.bfbBridge.shell({dock})` / `{close:true}`
 * （原生菜单与 ✕ 就是走这两个入口），再看外壳的抽屉形态有没有跟着变：
 * - dock=right → 抽屉变成竖向（宽 < 高）
 * - dock=undocked → 抽屉消失并弹出独立窗口
 * - close=true → 抽屉收起
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
  console.log('[intent] 等待超时:', label);
  return null;
}

const DRAWER = `(() => {
  const drawer = document.querySelector('[data-devtools-drawer]');
  if (!drawer) return JSON.stringify({ present: false });
  const r = drawer.getBoundingClientRect();
  return JSON.stringify({ present: true, w: Math.round(r.width), h: Math.round(r.height), vertical: r.height > r.width });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const fixture = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>intent</title></head><body><div id="x">INTENT</div></body></html>');
  });
  const fixturePort = await new Promise((resolve) => { fixture.listen(0, '127.0.0.1', () => resolve(fixture.address().port)); });

  const out = fs.openSync(path.join(os.tmpdir(), 'bfb-intent.log'), 'w');
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
  await sleep(3500);
  console.log('[intent] 初始抽屉:', await evaluate(client, DRAWER, false));

  const frontendTarget = (url) => /devtools_app\.html/.test(url || '');
  const front = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => frontendTarget(t.url)) || null;
  }, 30000, 'frontend');
  if (!front) { client.close(); fixture.close(); process.exit(2); }
  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;

  console.log('[intent] 前端有 bfbBridge.shell:', await evaluate(fc, 'typeof (window.bfbBridge && window.bfbBridge.shell)'));

  console.log('[intent] 发 dock=right:', await evaluate(fc, `window.bfbBridge.shell({dock:'right'})||'sent'`));
  await sleep(1800);
  console.log('[intent] dock=right 后:', await evaluate(client, DRAWER, false));

  console.log('[intent] 回读 dockSide:', await evaluate(fc, "window.bfbBridge.dockSide()"));
  console.log('[intent] 发 dock=left:', await evaluate(fc, `window.bfbBridge.shell({dock:'left'})||'sent'`));
  await sleep(1800);
  console.log('[intent] dock=left 后:', await evaluate(client, DRAWER, false));

  console.log('[intent] 发 dock=bottom:', await evaluate(fc, `window.bfbBridge.shell({dock:'bottom'})||'sent'`));
  await sleep(1800);
  console.log('[intent] dock=bottom 后:', await evaluate(client, DRAWER, false));

  console.log('[intent] 发 close:', await evaluate(fc, `window.bfbBridge.shell({close:true})||'sent'`));
  await sleep(1500);
  console.log('[intent] close 后:', await evaluate(client, DRAWER, false));

  fc.close();
  client.close();
  fixture.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[intent] failed:', e && e.message); process.exit(1); });
