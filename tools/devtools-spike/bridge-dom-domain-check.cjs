#!/usr/bin/env node
/**
 * S13：桥 session 的 DOM 域事件流取证（不开抽屉，排除 M97 前端干扰）。
 *   node tools/devtools-spike/bridge-dom-domain-check.cjs
 *
 * 手段：外壳里直接调 bridge.attach，然后跑
 *   DOM.enable → DOM.getDocument(depth:1) → DOM.requestChildNodes(root)
 * 打印每步响应原文 + 收到的 DOM.* 事件；再对同一 fixture target 用外部 page-ws
 * 跑同样序列做基线对照。
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

function wsClient(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = [];
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e.resolve(msg); return; }
    events.push(msg);
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    events,
    send(method, params = {}) {
      const i = ++id;
      socket.send(JSON.stringify({ id: i, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { const e = pending.get(i); if (e) { pending.delete(i); resolve({ error: { message: 'timeout' } }); } }, 12000);
        pending.set(i, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evalIn(client, expr, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) return `EXC ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`;
  return r && r.result && r.result.result && r.result.result.value;
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const fixture = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>dom-domain</title></head><body><div id="mark">MARK</div><p>para</p></body></html>');
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;

  const logPath = path.join(os.tmpdir(), 'bfb-s13.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env, BAO_DEVTOOLS_BRIDGE: '1' };
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
            if (await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) { port = p; break; }
          }
        }
      } catch { /* not yet */ }
      await sleep(500);
    }
  }
  if (!port) { console.error('[s13] 端口没发现'); process.exit(2); }

  let shell = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  const client = wsClient(shell.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');

  for (let i = 0; i < 40; i += 1) {
    const state = await evalIn(client, `(() => {
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
  await sleep(4000);

  // ---------- 桥侧：不开抽屉，直接跑 DOM 序列 ----------
  const bridgeSeq = await evalIn(client, `(async () => {
    const b = window.electronAPI.devtoolbox.bridge;
    const events = [];
    const off = b.onEvents(function (batch) { (batch || []).forEach(function (e) { events.push(String(e && e.method)); }); });
    const attach = await b.attach();
    const out = { attach: attach };
    if (!attach.ok) { off(); return JSON.stringify(out); }
    const enable = await b.send('DOM.enable', {});
    out.enable = { ok: enable.ok, error: enable.error };
    const doc = await b.send('DOM.getDocument', { depth: 1 });
    out.doc = { ok: doc.ok, error: doc.error, rootId: doc.result && doc.result.root && doc.result.root.nodeId, kids: doc.result && doc.result.root && doc.result.root.childNodeCount };
    if (out.doc.rootId) {
      const req = await b.send('DOM.requestChildNodes', { nodeId: out.doc.rootId, depth: -1 });
      out.requestChild = { ok: req.ok, error: req.error };
    }
    await new Promise(function (r) { setTimeout(r, 1500); });
    out.events = { total: events.length, dom: events.filter(function (m) { return m.indexOf('DOM.') === 0; }).slice(0, 8), all: events.slice(0, 10) };
    off();
    return JSON.stringify(out);
  })()`, true);
  console.log('[s13] bridge sequence:', bridgeSeq);

  // ---------- page-ws 基线：同一 fixture target ----------
  const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const pageT = (list || []).find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url || ''));
  if (pageT) {
    const pc = wsClient(pageT.webSocketDebuggerUrl);
    await pc.ready;
    const enable = await pc.send('DOM.enable', {});
    const doc = await pc.send('DOM.getDocument', { depth: 1 });
    const rootId = doc.result && doc.result.root && doc.result.root.nodeId;
    if (rootId) await pc.send('DOM.requestChildNodes', { nodeId: rootId, depth: -1 });
    await sleep(1500);
    const domEvents = pc.events.filter((m) => m.method && m.method.indexOf('DOM.') === 0).map((m) => m.method);
    console.log('[s13] page-ws baseline:', JSON.stringify({
      enableOk: !enable.error,
      rootId,
      childNodeCount: doc.result && doc.result.root && doc.result.root.childNodeCount,
      domEvents: domEvents.slice(0, 8),
      domEventCount: domEvents.length,
    }));
    pc.close();
  }

  client.close(); fixture.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
