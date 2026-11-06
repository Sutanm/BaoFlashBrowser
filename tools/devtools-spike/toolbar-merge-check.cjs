#!/usr/bin/env node
/**
 * 检查 DevTools 工具条合并：抽屉顶栏应该只有一行（页签 + 目标切换 + 图标按钮）。
 *
 *   node tools/devtools-spike/toolbar-merge-check.cjs
 *
 * 判据：
 * - 顶栏行数（抽屉内高度 28~34 的 flex 行）应为 1；
 * - DevToolsTab 里不再有第二行（占位容器上方没有别的行）；
 * - 顶栏 scrollWidth <= clientWidth（不横向溢出），底部/右侧两种停靠都测；
 * - 截图落 artifacts/devtools-toolbar-merged.png。
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
const SHOT = path.join(APP_ROOT, 'artifacts', 'devtools-toolbar-merged.png');

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

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
  console.log('[toolbar] 等待超时:', label);
  return null;
}

const MEASURE = `(() => {
  const drawer = document.querySelector('[data-devtools-drawer]');
  if (!drawer) return JSON.stringify({ error: 'no-drawer' });
  const rows = [];
  drawer.querySelectorAll('div').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.height >= 26 && r.height <= 34 && r.width > drawer.getBoundingClientRect().width * 0.8) {
      rows.push({ h: Math.round(r.height), y: Math.round(r.y), w: Math.round(r.width) });
    }
  });
  const header = rows.sort((a, b) => a.y - b.y)[0];
  // 顶栏元素（含最外层）本身去找横向溢出
  let over = null;
  drawer.querySelectorAll('div').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (header && Math.abs(r.y - header.y) < 2 && el.scrollWidth > el.clientWidth + 1) {
      over = { scroll: el.scrollWidth, client: el.clientWidth };
    }
  });
  const host = document.querySelector('[data-devtools-host]');
  const hostTop = host ? Math.round(host.getBoundingClientRect().top) : null;
  return JSON.stringify({
    rows: rows.length,
    headerY: header ? header.y : null,
    headerH: header ? header.h : null,
    hostTop,
    gapAboveHost: hostTop !== null && header ? hostTop - (header.y + header.h) : null,
    overflow: over,
    targets: drawer.querySelectorAll('[data-devtarget]').length,
    headerText: header ? '' : null,
  });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const fixture = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>tb</title></head><body><div id="x">TB</div></body></html>');
  });
  const fixturePort = await new Promise((resolve) => {
    fixture.listen(0, '127.0.0.1', () => resolve(fixture.address().port));
  });

  const out = fs.openSync(path.join(os.tmpdir(), 'bfb-toolbar.log'), 'w');
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
  })()`);

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
    })()`).catch(() => 'no-button');
    if (st === 'clicked') break;
    await sleep(500);
  }
  await sleep(4000);
  console.log('[toolbar] 底部停靠:', await evaluate(client, MEASURE));

  // 切到右侧停靠（最窄的场景：宽 340 左右）
  const rightBtn = `(() => {
    const drawer = document.querySelector('[data-devtools-drawer]');
    if (!drawer) return 'no-drawer';
    const btn = drawer.querySelector('button[aria-label]');
    const all = [].slice.call(drawer.querySelectorAll('button'));
    const target = all.find((b) => (b.getAttribute('aria-label') || '').indexOf('右侧') !== -1);
    if (!target) return 'no-right-btn';
    target.click();
    return 'clicked';
  })()`;
  console.log('[toolbar] 切右侧停靠:', await evaluate(client, rightBtn));
  await sleep(2500);
  console.log('[toolbar] 右侧停靠:', await evaluate(client, MEASURE));

  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.result && shot.result.data) {
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log('[toolbar] screenshot:', SHOT);
  }

  client.close();
  fixture.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[toolbar] failed:', e && e.message); process.exit(1); });
