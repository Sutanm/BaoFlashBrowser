#!/usr/bin/env node
/**
 * S9：定位 S3 "flatten evaluate 报域未找到" 的触发条件（应用本体）。
 *   node tools/devtools-spike/flatten-app-mystery.cjs
 *
 * S3 失败场景 = 应用外壳 target + 2 个 page-ws 客户端 + flatten；S7 成功场景 =
 * about:blank + 仅 flatten（+ embedded）。本探针在应用本体上逐步加变量：
 *   a) flatten only            → evaluate
 *   b) + 1 page-ws             → evaluate
 *   c) + 2 page-ws             → evaluate
 *   d) detach flatten、重连    → evaluate（可恢复性）
 *   e) 另起标签页 target       → evaluate
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
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id); pending.delete(msg.id);
      resolve(msg);
    }
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    send(method, params = {}, sessionId) {
      const messageId = ++id;
      const message = { id: messageId, method, params };
      if (sessionId) message.sessionId = sessionId;
      socket.send(JSON.stringify(message));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { const e = pending.get(messageId); if (e) { pending.delete(messageId); resolve({ error: { message: 'timeout' } }); } }, 5000);
        pending.set(messageId, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function flatEval(browser, sessionId, label) {
  if (!sessionId) return `${label}: no-session`;
  const r = await browser.send('Runtime.evaluate', { expression: '"flat:"+(1+1)', returnByValue: true }, sessionId);
  if (r.error) return `${label}: ERR ${r.error.message}`;
  const v = r.result && r.result.result && r.result.result.value;
  return `${label}: ${v}`;
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const logPath = path.join(os.tmpdir(), 'bfb-s9.log');
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
  if (!port) { console.error('[s9] 端口没发现'); process.exit(2); }
  const version = await getJson(`http://127.0.0.1:${port}/json/version`);
  console.log('[s9] port', port);

  let shell = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { console.error('[s9] shell 没出现'); process.exit(2); }
  console.log('[s9] shell target:', shell.id);

  const browser = wsClient(version.webSocketDebuggerUrl);
  await browser.ready;

  // a) flatten only
  const a = await browser.send('Target.attachToTarget', { targetId: shell.id, flatten: true });
  console.log('[s9] a) flatten attach:', a.error ? JSON.stringify(a.error) : 'ok');
  console.log('[s9]', await flatEval(browser, a.result && a.result.sessionId, 'a) flatten only'));

  // b) + 1 page-ws
  const p1 = wsClient(shell.webSocketDebuggerUrl);
  await p1.ready;
  await p1.send('Runtime.enable');
  console.log('[s9]', await flatEval(browser, a.result && a.result.sessionId, 'b) +1 page-ws'));

  // c) + 2 page-ws
  const p2 = wsClient(shell.webSocketDebuggerUrl);
  await p2.ready;
  await p2.send('Runtime.enable');
  console.log('[s9]', await flatEval(browser, a.result && a.result.sessionId, 'c) +2 page-ws'));

  // d) 重连 flatten
  if (a.result && a.result.sessionId) {
    await browser.send('Target.detachFromTarget', { sessionId: a.result.sessionId });
  }
  const d = await browser.send('Target.attachToTarget', { targetId: shell.id, flatten: true });
  console.log('[s9] d) re-attach flatten:', d.error ? JSON.stringify(d.error) : 'ok');
  console.log('[s9]', await flatEval(browser, d.result && d.result.sessionId, 'd) flatten after re-attach'));

  // e) 另起一个标签页 target
  let tabTarget = null;
  {
    // 用地址栏导航到本地 fixture 之外——直接开新标签并导航到 about:blank 不会建 BrowserView；
    // 用 shell 的 store 不行，改走 CDP 在 shell 上执行应用 UI 操作太慢。
    // 简化：直接看当前是否有非 shell 的 page target；没有就跳过。
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    tabTarget = (list || []).find((t) => t.type === 'page' && !/dist\/renderer\/index\.html$/.test(t.url || ''));
  }
  if (tabTarget) {
    const e = await browser.send('Target.attachToTarget', { targetId: tabTarget.id, flatten: true });
    console.log('[s9] e) tab flatten attach:', e.error ? JSON.stringify(e.error) : 'ok');
    console.log('[s9]', await flatEval(browser, e.result && e.result.sessionId, 'e) tab flatten'));
    if (e.result && e.result.sessionId) await browser.send('Target.detachFromTarget', { sessionId: e.result.sessionId });
  } else {
    console.log('[s9] e) 无额外 page target，跳过（新标签页不建 BrowserView）');
  }

  p1.close(); p2.close(); browser.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
