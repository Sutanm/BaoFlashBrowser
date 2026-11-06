#!/usr/bin/env node
/**
 * S10：验证 CDP 桥（桥 v2，B2 传输层）——经 preload API 从外壳直接驱动。
 *   node tools/devtools-spike/bridge-check.cjs
 *
 * 场景（应用本体、真实 BrowserView 标签）：
 *   1 导航到本地 fixture（产生 page target）
 *   2 bridge.attach        → 拿到 targetId + sessionId
 *   3 bridge.send Runtime.evaluate → 期望返回 fixture 页面值
 *   4 订阅 onEvents（attach 后立刻）→ 期望收到 Runtime.executionContextCreated 之类
 *   5 send 一个不存在的域方法 → 期望 ok:false 而不是崩
 *   6 attach 时无 target（切到新标签）→ 期望 no-target 语义
 *   7 stats              → 条数/字节增长
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
const ACTIVE_PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

function startFixture() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>bridge-fixture</title></head><body><h1 id="mark">BRIDGE</h1></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function wsClient(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e.resolve(msg.result); }
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    send(method, params = {}) {
      const i = ++id;
      socket.send(JSON.stringify({ id: i, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { const e = pending.get(i); if (e) { pending.delete(i); resolve(undefined); } }, 12000);
        pending.set(i, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const { server: fixtureServer, port: fixturePort } = await startFixture();
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

  const logPath = path.join(os.tmpdir(), 'bfb-s10.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  let port = 0;
  {
    const startedAt = Date.now();
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      try {
        if (fs.statSync(ACTIVE_PORT_FILE).mtimeMs > startedAt) {
          const p = Number(String(fs.readFileSync(ACTIVE_PORT_FILE, 'utf8')).split('\n')[0]);
          if (Number.isFinite(p) && p > 0) {
            const ok = await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false);
            if (ok) { port = p; break; }
          }
        }
      } catch { /* not yet */ }
      await sleep(500);
    }
  }
  if (!port) { console.error('[s10] 端口没发现'); process.exit(2); }

  let shell = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { console.error('[s10] shell 没出现'); process.exit(2); }
  console.log('[s10] port', port, '| shell', shell.id.slice(0, 8));

  const client = wsClient(shell.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');

  const ev = async (expr, awaitPromise = false) => {
    const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise, timeout: 20000 });
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      return `EXC ${(d.exception && d.exception.description) || d.text}`;
    }
    return r && r.result && r.result.value;
  };

  // 1) 导航到 fixture
  let submitted = 'no-input';
  for (let i = 0; i < 40 && submitted === 'no-input'; i += 1) {
    submitted = await ev(`(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(fixtureUrl)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (submitted === 'no-input') await sleep(500);
  }
  console.log('[s10] navigate:', submitted);
  await sleep(4000);

  // 4) 先挂事件订阅（再 attach，避免错过 attached 事件）
  const eventsProbe = await ev(`(() => {
    window.__bridgeEvents = [];
    if (window.__bridgeOff) window.__bridgeOff();
    window.__bridgeOff = window.electronAPI.devtoolbox.bridge.onEvents(function (batch) {
      (batch || []).forEach(function (e) { window.__bridgeEvents.push(String(e && e.method)); });
    });
    return 'subscribed';
  })()`);
  console.log('[s10] events subscribe:', eventsProbe);

  // 2) attach
  const attach = await ev(`window.electronAPI.devtoolbox.bridge.attach().then(function (r) { return JSON.stringify(r); })`, true);
  console.log('[s10] attach:', attach);

  // 3) send Runtime.evaluate（先 enable，事件才会产生）
  const enableResult = await ev(`window.electronAPI.devtoolbox.bridge.send('Runtime.enable', {}).then(function (r) { return JSON.stringify({ ok: r.ok }); })`, true);
  console.log('[s10] send Runtime.enable:', enableResult);
  const evalResult = await ev(`window.electronAPI.devtoolbox.bridge.send('Runtime.evaluate', { expression: '"bridge:" + document.getElementById("mark").textContent', returnByValue: true }).then(function (r) { return JSON.stringify(r); })`, true);
  console.log('[s10] send Runtime.evaluate:', evalResult);

  // 4 cont) 事件是否到达（页面里触发一条 console，必然产生 consoleAPICalled）
  await ev(`window.electronAPI.devtoolbox.bridge.send('Runtime.evaluate', { expression: 'console.log("bridge-probe-event")' }).then(function () { return 1; })`, true);
  await sleep(1500);
  const eventsSeen = await ev(`JSON.stringify({ count: window.__bridgeEvents.length, sample: window.__bridgeEvents.slice(0, 6) })`);
  console.log('[s10] events seen:', eventsSeen);

  // 5) 非法方法
  const bad = await ev(`window.electronAPI.devtoolbox.bridge.send('Nonexistent.method', {}).then(function (r) { return JSON.stringify(r); })`, true);
  console.log('[s10] bad method:', bad);

  // 7) stats
  const stats = await ev(`window.electronAPI.devtoolbox.bridge.stats().then(function (r) { return JSON.stringify(r); })`, true);
  console.log('[s10] stats:', stats);

  // 6) 新标签页 attach → no-target
  const newTab = await ev(`(() => { const b = document.querySelector('.btn-tab.no-drag'); if (!b) return 'no-button'; b.click(); return 'clicked'; })()`);
  await sleep(2500);
  const attachNoTarget = await ev(`window.electronAPI.devtoolbox.bridge.attach().then(function (r) { return JSON.stringify(r); })`, true);
  console.log('[s10] new-tab click:', newTab, '| attach after new tab:', attachNoTarget);

  client.close();
  fixtureServer.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
