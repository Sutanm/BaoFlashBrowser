#!/usr/bin/env node
/**
 * 设置持久化验证：DevTools 的设置（语言、面板、dockSide…）存在前端 origin 的
 * localStorage 里，而静态服务用的是 `listen(0)` 随机端口 → **每次启动 origin 都不同**
 * → localStorage 天然隔离 → 设置永远存不住。
 *
 *   node tools/devtools-spike/settings-persistence-check.cjs
 *
 * 做法：连开两次应用，各自打开抽屉，在前端 iframe 里写一个标记 key，
 * 第二次读它。读不到 = origin 变了（本次假设成立）。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e.resolve(msg); }
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    send(method, params = {}) {
      const i = ++id;
      socket.send(JSON.stringify({ id: i, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ error: { message: 'timeout' } }); } }, 15000);
        pending.set(i, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) return `EXC ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`;
  return r && r.result && r.result.result && r.result.result.value;
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  console.log('[persist] 等待超时:', label);
  return null;
}

async function launchAndOpenDrawer() {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1500);

  const out = fs.openSync(path.join(os.tmpdir(), 'bfb-persist.log'), 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const startedAt = Date.now();
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  const port = await waitUntil(async () => {
    try {
      if (fs.statSync(ACTIVE_PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(ACTIVE_PORT_FILE, 'utf8')).split('\n')[0]);
        if (p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) return p;
      }
    } catch { /* not yet */ }
    return null;
  }, 45000, 'debug port');
  if (!port) return null;

  const shellT = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || '')) || null;
  }, 30000, 'shell');
  if (!shellT) return null;
  const shell = cdp(shellT.webSocketDebuggerUrl);
  await shell.ready;

  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(shell, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`).catch(() => 'no-button');
    if (state === 'clicked') break;
    await sleep(500);
  }
  await sleep(1500);
  // 新标签页没有 page target → 默认「当前页面」只会显示占位、不出 iframe。
  // 切到「外壳界面」保证一定有前端实例（也正是设置持久化要观察的那个 origin）。
  await evaluate(shell, `(() => {
    const btns = [].slice.call(document.querySelectorAll('button'));
    const t = btns.find(function (b) { return (b.textContent || '').trim() === '外壳界面'; });
    if (!t) return 'no-target-btn';
    t.click(); return 'clicked';
  })()`);

  const front = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /devtools_app\.html/.test(t.url || '')) || null;
  }, 30000, 'frontend iframe');
  if (!front) { shell.close(); child.kill(); return null; }

  await sleep(6000);
  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;

  const info = await evaluate(fc, `JSON.stringify({
    origin: location.origin,
    keys: Object.keys(localStorage).length,
    sample: Object.keys(localStorage).slice(0, 8),
    marker: localStorage.getItem('bfb-persist-probe'),
  })`);

  return { child, shell, fc, info };
}

(async () => {
  console.log('[persist] ---- 第一次启动 ----');
  const first = await launchAndOpenDrawer();
  if (!first) process.exit(2);
  console.log('[persist] run1:', first.info);
  await evaluate(first.fc, `localStorage.setItem('bfb-persist-probe', String(Date.now()))`);
  await evaluate(first.fc, `localStorage.setItem('language', '"zh-CN"')`);
  const afterWrite = await evaluate(first.fc, `JSON.stringify({ keys: Object.keys(localStorage).length, marker: localStorage.getItem('bfb-persist-probe') })`);
  console.log('[persist] run1 after write:', afterWrite);

  first.fc.close();
  first.shell.close();
  first.child.kill();
  await sleep(3000);

  console.log('[persist] ---- 第二次启动 ----');
  const second = await launchAndOpenDrawer();
  if (!second) process.exit(2);
  console.log('[persist] run2:', second.info);

  second.fc.close();
  second.shell.close();
  second.child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[persist] failed:', e.message); process.exit(1); });
