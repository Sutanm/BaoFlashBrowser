#!/usr/bin/env node
/**
 * B1.2：真站定级——7k7k 上桥模式的三线并发。
 *
 *   BAO_DEVTOOLS_BRIDGE=1 node tools/devtools-spike/bridge-realsite-check.cjs
 *
 * 判定：
 *   1 真站页面在桥模式下能渲染 Elements 树（不是只有 fixture 能跑）
 *   2 桥 session 存活期间，密码捕获的 embedded attach 成功
 *      （日志出现 `[PasswordCapture] attached`，且没有
 *        `already attached by an unmanaged client`）
 *   3 页面本身没被拖死：通过桥执行 Runtime.evaluate 能拿到真实页面信息
 *
 * 第三条 actor（automation 输入）不在此脚本内驱动——它需要一份完整的 v3
 * 工作流文档（workflow + package + grant）。其底层是同一个 embedded 通道，
 * 桥完全不碰 embedded，故由第 2 条覆盖；见报告里的说明。
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
const SHOT_PATH = path.join(APP_ROOT, 'artifacts', 'bridge-realsite-7k7k.png');
const SITE = process.env.BFB_SITE || 'http://www.7k7k.com/';

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
        const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ error: { message: 'timeout' } }); } }, 20000);
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
  console.log('[b12] 等待超时:', label);
  return null;
}

const TREE_PROBE = `(() => {
  const deep = (sel) => {
    const acc = [];
    const visit = (root) => {
      root.querySelectorAll(sel).forEach((el) => acc.push(el));
      root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
    };
    visit(document);
    return acc;
  };
  const texts = deep('span[class*="webkit-html"]').map((el) => (el.textContent || '').trim());
  const tags = texts.filter((t) => /^<[a-zA-Z]/.test(t)).slice(0, 12);
  return JSON.stringify({ spans: texts.length, tags, has7k7k: texts.join(' ').indexOf('7k7k') !== -1 });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const logPath = path.join(os.tmpdir(), 'bfb-b12.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env, BAO_DEVTOOLS_BRIDGE: '1' };
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
  if (!port) process.exit(2);

  const shell = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || '')) || null;
  }, 30000, 'shell');
  if (!shell) process.exit(2);
  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;

  // 导航到真站
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(SITE)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (state === 'submitted') break;
    await sleep(500);
  }
  console.log('[b12] navigating to', SITE);

  const siteTarget = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => t.type === 'page' && /7k7k\.com/.test(t.url || '')) || null;
  }, 60000, '7k7k page target');
  console.log('[b12] site target:', siteTarget && siteTarget.id, siteTarget && siteTarget.url);
  if (!siteTarget) { client.close(); child.kill(); process.exit(2); }

  // 开抽屉（桥 attach）
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`).catch(() => 'no-button');
    if (state === 'clicked') break;
    await sleep(500);
  }
  console.log('[b12] drawer opened');

  // 等真站把广告/脚本加载完，再取树
  await sleep(20000);

  const front = (await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []))
    .find((t) => /devtools_app\.html/.test(t.url || ''));
  console.log('[b12] iframe url:', front && front.url.slice(0, 100));
  if (front) {
    const fc = cdp(front.webSocketDebuggerUrl);
    await fc.ready;
    const tree = await evaluate(fc, TREE_PROBE);
    console.log('[b12] elements tree:', tree);
    fc.close();
  }

  // 桥侧证据：当前绑的 target、事件量、经桥 evaluate 真实页面
  const statsRaw = await evaluate(client, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) {
    return JSON.stringify({ state: s.state, targetId: s.targetId, sessionId: s.sessionId, sent: s.sent, events: s.events, dropped: s.eventsDropped, bytesIn: s.bytesIn, bytesOut: s.bytesOut });
  })`, true);
  console.log('[b12] bridge stats:', statsRaw);

  const pageInfo = await evaluate(client, `window.electronAPI.devtoolbox.bridge.send('Runtime.evaluate', {
    expression: 'JSON.stringify({ title: document.title, url: location.href, ready: document.readyState, nodes: document.getElementsByTagName("*").length })',
    returnByValue: true
  }).then(function (r) {
    if (!r.ok) return 'err=' + JSON.stringify(r.error);
    var v = r.result && r.result.result && r.result.result.value;
    return String(v);
  })`, true);
  console.log('[b12] page via bridge:', pageInfo);

  // 三线证据（日志）：密码捕获的 embedded attach 是否成功
  await sleep(2000);
  const logText = fs.readFileSync(logPath, 'utf8');
  const captureAttached = (logText.match(/\[PasswordCapture\] attached/g) || []).length;
  const captureFailed = (logText.match(/\[PasswordCapture\] attach failed/g) || []).length;
  const unmanaged = (logText.match(/already attached by an unmanaged client/g) || []).length;
  const bridgeAttached = (logText.match(/\[DevToolsBridge\] attached target/g) || []).length;
  console.log('[b12] log evidence: bridgeAttached=%d captureAttached=%d captureFailed=%d unmanagedCollision=%d',
    bridgeAttached, captureAttached, captureFailed, unmanaged);
  const captureLines = logText.split('\n').filter((l) => l.indexOf('[PasswordCapture]') !== -1).slice(-6);
  for (const line of captureLines) console.log('  |', line.trim().slice(0, 140));

  const shot = await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot && shot.result && shot.result.data) {
    fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
    fs.writeFileSync(SHOT_PATH, Buffer.from(shot.result.data, 'base64'));
    console.log('[b12] screenshot:', SHOT_PATH);
  }

  client.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[b12] failed:', e.message); process.exit(1); });
