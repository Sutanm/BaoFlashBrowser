#!/usr/bin/env node
/**
 * 验证「工具箱 Flash 页跟着活动标签走」。
 *
 *   node tools/devtools-spike/flash-tab-follow-check.cjs
 *
 * 两个标签各挂一个 SWF（/a.swf、/b.swf），来回切，读 Flash 页显示的地址：
 * 期望永远是当前标签那一份。修复前会因为主进程的"活动标签"晚一拍而显示上一页，
 * 必须重开面板才更正。
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

function page(title, swf) {
  return `<!doctype html><html><head><title>${title}</title></head><body>
    <div id="stage">
      <embed type="application/x-shockwave-flash" src="${swf}" width="640" height="480" />
    </div>
  </body></html>`;
}

function startFixture() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/a.swf') || url.startsWith('/b.swf')) {
      res.writeHead(200, { 'content-type': 'application/x-shockwave-flash' });
      res.end('FWS');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(url.startsWith('/b') ? page('b', '/b.swf') : page('a', '/a.swf'));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

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

async function evaluate(client, expression, awaitPromise = false) {
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
  console.log('[flashfollow] 等待超时:', label);
  return null;
}

/** Flash 页里出现的 SWF 地址（去重前，原始文本足够判断）。 */
const READ_FLASH_TAB = `(() => {
  const drawer = document.querySelector('[data-devtools-drawer]');
  if (!drawer) return JSON.stringify({ error: 'no-drawer' });
  const text = String(drawer.innerText || '');
  return JSON.stringify({
    a: text.indexOf('/a.swf') !== -1,
    b: text.indexOf('/b.swf') !== -1,
    empty: text.indexOf('未检测到 SWF') !== -1,
    head: text.split('\\n').slice(0, 6).join(' / '),
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

const clickTab = (i) => `(() => {
  const items = document.querySelectorAll('.tab-inner');
  if (!items[${i}]) return 'no-tab';
  const r = items[${i}].getBoundingClientRect();
  const opts = { bubbles: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) };
  items[${i}].dispatchEvent(new MouseEvent('mousedown', opts));
  items[${i}].dispatchEvent(new MouseEvent('mouseup', opts));
  items[${i}].dispatchEvent(new MouseEvent('click', opts));
  return 'clicked';
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const { server: fixture, port: fixturePort } = await startFixture();
  const aUrl = `http://127.0.0.1:${fixturePort}/a`;
  const bUrl = `http://127.0.0.1:${fixturePort}/b`;

  const logPath = path.join(os.tmpdir(), 'bfb-flashfollow.log');
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

  // 标签 1 → /a
  for (let i = 0; i < 40; i += 1) {
    if (await navigate(aUrl).catch(() => 'no-input') === 'submitted') break;
    await sleep(500);
  }
  await sleep(3000);

  // 打开工具箱
  for (let i = 0; i < 40; i += 1) {
    const st = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`).catch(() => 'no-button');
    if (st === 'clicked') break;
    await sleep(500);
  }
  await sleep(1500);
  console.log('[flashfollow] 切到 Flash 页:', await evaluate(client, clickFlashTab));
  await sleep(2500);
  console.log('[flashfollow] tab1(/a) 显示:', await evaluate(client, READ_FLASH_TAB));

  // 新标签 → /b
  await evaluate(client, `(() => { const b = document.querySelector('.btn-tab.no-drag'); if (b) b.click(); return 'ok'; })()`);
  await waitUntil(async () => {
    const v = await evaluate(client, `(() => { const el = document.querySelector('.address-input'); return el ? 'v:' + el.value : null; })()`);
    return typeof v === 'string' && v.indexOf('/a') === -1 ? v : null;
  }, 15000, 'new tab active');
  await sleep(800);
  for (let i = 0; i < 40; i += 1) {
    if (await navigate(bUrl).catch(() => 'no-input') === 'submitted') break;
    await sleep(500);
  }

  // 关键判据：切过去只等 1.2s 就读（不给"重开面板"的机会）
  await sleep(1200);
  console.log('[flashfollow] 切到 tab2(/b) 后 1.2s:', await evaluate(client, READ_FLASH_TAB));
  await sleep(3000);
  console.log('[flashfollow] 切到 tab2(/b) 后 4.2s:', await evaluate(client, READ_FLASH_TAB));

  // 切回标签 1
  console.log('[flashfollow] 切回 tab0:', await evaluate(client, clickTab(0)));
  await sleep(1200);
  console.log('[flashfollow] 切回 tab1(/a) 后 1.2s:', await evaluate(client, READ_FLASH_TAB));

  client.close();
  fixture.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[flashfollow] failed:', e && e.message); process.exit(1); });
