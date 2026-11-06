#!/usr/bin/env node
/**
 * 验证 CDP 深探能读到「跨域 iframe」与「直接以 SWF 作为 frame URL」里的游戏。
 *
 *   node tools/devtools-spike/probe-deep-check.cjs
 *
 * fixture：/host 在 127.0.0.1 上，内嵌一个指向 `localhost` 的 iframe（跨域），
 * 以及一个 src 直接就是 .swf 的 iframe。旧实现（只 executeJavaScript 主文档 +
 * 同源 iframe）这两条都拿不到；深探应该都能列出来。
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
  console.log('[deep] 等待超时:', label);
  return null;
}

function startFixture() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/cross.swf') || url.startsWith('/direct.swf')) {
      res.writeHead(200, { 'content-type': 'application/x-shockwave-flash' });
      res.end('FWS');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.startsWith('/game')) {
      // 模拟游戏页：插件在 iframe 内部（跨域），外层读不到
      res.end(`<!doctype html><html><head><title>game</title></head><body>
        <div id="wrap"><embed type="application/x-shockwave-flash" src="/cross.swf" width="640" height="480" /></div>
      </body></html>`);
      return;
    }
    const port = server.address().port;
    res.end(`<!doctype html><html><head><title>host</title></head><body>
      <h1>CROSS-ORIGIN HOST</h1>
      <iframe src="http://localhost:${port}/game" width="700" height="520"></iframe>
      <iframe src="/direct.swf" width="400" height="300"></iframe>
    </body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const READ_FLASH_TAB = `(() => {
  const drawer = document.querySelector('[data-devtools-drawer]');
  if (!drawer) return JSON.stringify({ error: 'no-drawer' });
  const text = String(drawer.innerText || '');
  return JSON.stringify({
    cross: text.indexOf('/cross.swf') !== -1,
    direct: text.indexOf('/direct.swf') !== -1,
    readBadge: text.indexOf('跨域（已读取）') !== -1,
    hiddenBadge: text.indexOf('内容不可见') !== -1,
    deepEmpty: text.indexOf('各层 frame') !== -1,
    body: text.replace(/\\n{2,}/g, '\\n').slice(0, 900),
  });
})()`;

const clickFlashTab = `(() => {
  const drawer = document.querySelector('[data-devtools-drawer]');
  if (!drawer) return 'no-drawer';
  const btn = [].slice.call(drawer.querySelectorAll('button')).find((b) => (b.textContent || '').trim().indexOf('Flash') === 0);
  if (!btn) return 'no-flash-tab';
  btn.click();
  return 'clicked';
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const { server: fixture, port: fixturePort } = await startFixture();
  const hostUrl = `http://127.0.0.1:${fixturePort}/host`;
  console.log('[deep] fixture:', hostUrl, '| 跨域 iframe → http://localhost:' + fixturePort + '/game');

  const logPath = path.join(os.tmpdir(), 'bfb-deepprobe.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BAO_DEVTOOLS_PAGE_WS;
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
    if (await navigate(hostUrl).catch(() => 'no-input') === 'submitted') break;
    await sleep(500);
  }
  await sleep(4000);

  for (let i = 0; i < 40; i += 1) {
    const st = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`).catch(() => 'no-button');
    if (st === 'clicked') break;
    await sleep(500);
  }
  await sleep(1200);
  console.log('[deep] 切到 Flash 页:', await evaluate(client, clickFlashTab));
  await sleep(3500);

  const result = await evaluate(client, READ_FLASH_TAB);
  let parsed = null;
  try { parsed = JSON.parse(String(result)); } catch { /* ignore */ }
  console.log('[deep] 跨域 SWF 命中:', parsed && parsed.cross);
  console.log('[deep] 直载 SWF frame 命中:', parsed && parsed.direct);
  console.log('[deep] 「跨域（已读取）」徽标:', parsed && parsed.readBadge);
  console.log('[deep] 仍显示「内容不可见」:', parsed && parsed.hiddenBadge);
  console.log('[deep] Flash 页正文:\n' + (parsed ? parsed.body : String(result)));

  client.close();
  fixture.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[deep] failed:', e && e.message); process.exit(1); });
