#!/usr/bin/env node
/**
 * 应用内 DevTools 的冒烟检查：启动应用 → 点顶栏工具箱按钮 → 看 iframe 有没有
 * 真的把 DevTools 渲染出来 → 截图。
 *
 *   node tools/devtools-spike/verify-in-app.cjs
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

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

async function waitForShell(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const shell = (list || []).find((t) => /\/dist\/renderer\/index\.html$/.test(t.url || ''));
      if (shell) return shell;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
        return;
      }
      events.push(msg);
      if (events.length > 400) events.shift();
    } catch { /* 探针不能因为一条畸形消息崩掉 */ }
  });
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    ready,
    events,
    send(method, params = {}) {
      const messageId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(messageId, { resolve, reject });
        socket.send(JSON.stringify({ id: messageId, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await new Promise((r) => setTimeout(r, 1500));

  const logPath = path.join(os.tmpdir(), 'bfb-verify-app.log');
  const out = fs.openSync(logPath, 'w');
  // 这个环境的 shell 会注入 ELECTRON_RUN_AS_NODE，Electron 会退化成 node 并
  // 拒绝 --remote-debugging-port（报 "bad option"），必须显式摘掉。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [`--remote-debugging-port=${DEBUG_PORT}`, '.'], {
    cwd: APP_ROOT, stdio: ['ignore', out, out], env,
  });
  console.log('[verify] electron pid', child.pid, 'log', logPath);

  const shell = await waitForShell(30000);
  if (!shell) { console.error('[verify] shell 目标没出现'); process.exit(2); }
  console.log('[verify] shell target', shell.id);

  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  // 页面可能还没挂载完，轮询等按钮出现再点
  let clicked = 'no-button';
  for (let attempt = 0; attempt < 40 && clicked === 'no-button'; attempt += 1) {
    const result = await client.send('Runtime.evaluate', {
      expression: "(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (!b) return 'no-button'; b.click(); return 'clicked'; })()",
      returnByValue: true,
    });
    clicked = (result.result && result.result.value) || 'no-button';
    if (clicked === 'no-button') await new Promise((r) => setTimeout(r, 500));
  }
  console.log('[verify] toolbar click:', clicked);

  await new Promise((r) => setTimeout(r, 9000));

  const state = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const frame = document.querySelector('iframe[title="DevTools"]');
      const placeholder = document.body.innerText.includes('没有可用的调试端口');
      return {
        hasIframe: Boolean(frame),
        src: frame ? frame.src : '',
        height: frame ? frame.clientHeight : 0,
        missingPortHint: placeholder,
      };
    })()`,
    returnByValue: true,
  });
  console.log('[verify] state:', JSON.stringify(state.result && state.result.value));

  // 深入 iframe：列出 frame 树，并在 bfb-devtools 的执行上下文里读文档长度
  const fetchProbe = await client.send('Runtime.evaluate', {
    expression: "fetch('bfb-devtools://app/inspector.html').then(r => 'status=' + r.status + ' len=' + (r.headers.get('content-length') || '?')).catch(e => 'ERR ' + e.message)",
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('[verify] fetch bfb-devtools:', fetchProbe.result && fetchProbe.result.value);
  const tree = await client.send('Page.getFrameTree');
  console.log('[verify] frames:', JSON.stringify(tree.frameTree).slice(0, 600));

  const contexts = client.events
    .filter((event) => event.method === 'Runtime.executionContextCreated')
    .map((event) => event.params.context)
    .filter((context) => String(context.origin || '').includes('bfb-devtools'));
  console.log('[verify] devtools contexts:', contexts.length);
  for (const context of contexts.slice(0, 2)) {
    try {
      const probe = await client.send('Runtime.evaluate', {
        expression: "document.title + ' | html=' + document.documentElement.outerHTML.length + ' | body=' + document.body.innerText.slice(0,120)",
        contextId: context.id,
        returnByValue: true,
      });
      console.log('[verify] context', context.id, '=>', probe.result && probe.result.value);
    } catch (error) {
      console.log('[verify] context', context.id, 'failed:', error.message);
    }
  }
  const failures = client.events
    .filter((event) => event.method === 'Page.loadingFailed' || event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params && (event.params.errorText || event.params.exceptionDetails && event.params.exceptionDetails.text));
  if (failures.length) console.log('[verify] failures:', JSON.stringify(failures.slice(0, 6)));

  // 跨源 iframe 在 Electron 里是 OOPIF，会作为独立 target 出现，单独探一下
  const after = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`).catch(() => []);
  console.log('[verify] targets now:', (after || []).map((t) => `${t.type}:${t.url}`).join(' | '));
  const frameTarget = (after || []).find((t) => /127\.0\.0\.1:\d+\/inspector\.html/.test(t.url || ''));
  if (frameTarget) {
    const inner = cdp(frameTarget.webSocketDebuggerUrl);
    await inner.ready;
    await inner.send('Runtime.enable');
    const probe = await inner.send('Runtime.evaluate', {
      expression: `(() => {
        const res = performance.getEntriesByType('resource');
        return JSON.stringify({
          htmlLen: document.documentElement.outerHTML.length,
          text: (document.body && document.body.innerText || '').slice(0, 80),
          resources: res.length,
          tabs: Array.from(document.querySelectorAll('.tabbed-pane-header-tab-title')).map((el) => (el.textContent || '').trim()).slice(0, 8),
        });
      })()`,
      returnByValue: true,
    });
    console.log('[verify] devtools frame =>', probe.result && probe.result.value);
    inner.close();
  }

  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(APP_ROOT, 'artifacts', 'devtools-in-app-2026-11-05.png');
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('[verify] screenshot:', shotPath);

  client.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((error) => {
  console.error('[verify] failed:', error);
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(1);
});
