#!/usr/bin/env node
/**
 * 探针：Chromium 87（Electron 11）上 CDP 的三种客户端能否共存？
 *
 *   node tools/devtools-spike/cdp-coexist-check.cjs
 *
 * 场景矩阵：
 *   S1  page-ws × 2        —— 两个外部 ws 客户端连同一 /devtools/page/<id>
 *   S2  page-ws + flatten  —— DevTools 前端的 page ws + browser 级
 *                              Target.attachToTarget({flatten:true}) session
 *   S3  flatten + embedded —— flatten session 期间主进程 webContents.debugger.attach
 *                              （用 evaluate 让渲染层没法测，改从外部模拟不了 embedded，
 *                               这条只能真机在应用内测；本探针先给 S1/S2 的硬证据）
 *
 * 每个场景打印谁活着、谁被断、命令是否成功。结果决定"CDP 总线"方案的形态。
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
const DEBUG_PORT = Number(process.env.BFB_SPIKE_DEBUG_PORT || 19222);

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

/** 返回 { send, events, closed: Promise<原因>, close } */
function wsClient(url, label) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = [];
  const closed = new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason && reason.toString() }));
    socket.once('error', (err) => resolve({ error: err.message }));
  });
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve({ ok: !msg.error, error: msg.error, result: msg.result });
      return;
    }
    events.push(msg);
  });
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    ready,
    events,
    closed,
    send(method, params = {}, sessionId) {
      const messageId = ++id;
      const message = { id: messageId, method, params };
      if (sessionId) message.sessionId = sessionId;
      socket.send(JSON.stringify(message));
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const entry = pending.get(messageId);
          if (entry) { pending.delete(messageId); resolve({ ok: false, error: { message: 'timeout' } }); }
        }, 4000);
        pending.set(messageId, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
        });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(c, expr, sessionId) {
  const response = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
  if (!response.ok) return { error: response.error && response.error.message };
  return { value: response.result && response.result.result && response.result.result.value };
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1200);

  const logPath = path.join(os.tmpdir(), 'bfb-cdp-coexist.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [`--remote-debugging-port=${DEBUG_PORT}`, '.'], {
    cwd: APP_ROOT, stdio: ['ignore', out, out], env,
  });
  console.log('[coexist] electron pid', child.pid, '| log:', logPath);

  let shell = null;
  let version = null;
  for (let i = 0; i < 80 && (!shell || !version); i += 1) {
    const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`).catch(() => []);
    shell = shell || (list || []).find((t) => /\/dist\/renderer\/index\.html$/.test(t.url || ''));
    version = version || await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`).catch(() => null);
    if (!shell || !version) await sleep(500);
  }
  if (!shell || !version) { console.error('[coexist] 目标没出现'); process.exit(2); }
  const targetId = shell.id;
  console.log('[coexist] shell target:', targetId);
  console.log('[coexist] browser ws:', version.webSocketDebuggerUrl);

  // ---------- S1: page-ws × 2 ----------
  console.log('\n===== S1 两个 page-ws 客户端 =====');
  const p1 = wsClient(shell.webSocketDebuggerUrl, 'page-ws-1');
  await p1.ready;
  await p1.send('Runtime.enable');
  console.log('S1 client1 evaluate:', JSON.stringify(await evaluate(p1, '"c1:"+(1+1)')));

  const p2 = wsClient(shell.webSocketDebuggerUrl, 'page-ws-2');
  const p2Open = await p2.ready.then(() => 'open').catch((e) => `error:${e.message}`);
  console.log('S1 client2 connect:', p2Open);
  if (p2Open === 'open') {
    const p2Eval = await evaluate(p2, '"c2:"+(2+2)');
    console.log('S1 client2 evaluate:', JSON.stringify(p2Eval));
    await sleep(1500);
    const p1State = await Promise.race([p1.closed.then((c) => `closed:${JSON.stringify(c)}`), sleep(300).then(() => 'alive')]);
    console.log('S1 client1 after c2 connects:', p1State);
    const p1Eval = await evaluate(p1, '"c1-after:"+(3+3)');
    console.log('S1 client1 evaluate after:', JSON.stringify(p1Eval));
  }
  p1.close(); p2.close();
  await sleep(800);

  // ---------- S2: page-ws + flatten session ----------
  console.log('\n===== S2 page-ws + browser flatten session =====');
  const b = wsClient(version.webSocketDebuggerUrl, 'browser-ws');
  const bOpen = await b.ready.then(() => 'open').catch((e) => `error:${e.message}`);
  console.log('S2 browser-ws connect:', bOpen);
  if (bOpen === 'open') {
    const attached = await b.send('Target.attachToTarget', { targetId, flatten: true });
    console.log('S2 Target.attachToTarget(flatten):', JSON.stringify(attached.ok ? { ok: true } : attached.error));
    const sessionId = attached.result && attached.result.sessionId;

    const p = wsClient(shell.webSocketDebuggerUrl, 'page-ws-during-flatten');
    const pOpen = await p.ready.then(() => 'open').catch((e) => `error:${e.message}`);
    console.log('S2 page-ws connect during flatten:', pOpen);
    const pEval = pOpen === 'open' ? await evaluate(p, '"page:"+(4+4)') : null;
    console.log('S2 page-ws evaluate:', JSON.stringify(pEval));

    const bEval = sessionId ? await evaluate(b, '"flat:"+(5+5)', sessionId) : null;
    console.log('S2 flatten evaluate:', JSON.stringify(bEval));

    // 再看 page-ws 是否被 flatten 挤掉
    await sleep(1500);
    const pState = pOpen === 'open'
      ? await Promise.race([p.closed.then((c) => `closed:${JSON.stringify(c)}`), sleep(200).then(() => 'alive')])
      : 'never-opened';
    console.log('S2 page-ws state after flatten eval:', pState);
    const pEval2 = pOpen === 'open' && pState === 'alive' ? await evaluate(p, '"page-after:"+(6+6)') : 'dead';
    console.log('S2 page-ws evaluate after:', JSON.stringify(pEval2));

    // 以及反向：flatten session 是否仍活着
    const bEval2 = sessionId ? await evaluate(b, '"flat-after:"+(7+7)', sessionId) : 'dead';
    console.log('S2 flatten evaluate after:', JSON.stringify(bEval2));

    // 事件面：flatten session 能不能收到 page-ws 的 Domain 事件（互不干扰的证据）
    await p.send('Runtime.enable').catch(() => {});
    await b.send('Runtime.enable', {}, sessionId).catch(() => {});
    await sleep(1000);
    const bEvents = b.events.filter((m) => m.sessionId === sessionId).map((m) => m.method);
    console.log('S2 flatten 收到事件:', bEvents.slice(0, 8).join(', '), `(共 ${bEvents.length})`);
    p.close();
  }
  b.close();

  console.log('\n[coexist] done');
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((error) => {
  console.error('[coexist] failed:', error && error.message);
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(1);
});
