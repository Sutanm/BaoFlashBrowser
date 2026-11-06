#!/usr/bin/env node
/**
 * S12：判定桥模式下 Elements 树到底渲染的是哪个文档。
 *   node tools/devtools-spike/bridge-tree-identity.cjs
 *
 * 手法：从外部 CDP 往目标页面注入一个 Unique 元素（id=uniq-probe-xyz），
 * 再在 iframe 的 Elements 树里搜这个 id。出现 → 树就是目标页（之前只是
 * 懒展开/时机问题）；不出现 → 树来自别的文档。
 *
 * 同时打印：桥 attach 的 targetId、该 target 的 URL、外壳 target 的 body 前 120 字。
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
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e.resolve(msg); }
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
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

const DEEP_TEXT = `(() => {
  const acc = [];
  const visit = (root) => {
    root.querySelectorAll('span').forEach((el) => { const t = (el.textContent || '').trim(); if (t) acc.push(t); });
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
  };
  visit(document);
  return acc;
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const fixture = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>tree-identity</title></head><body><div id="mark">ORIGINAL-MARK</div></body></html>');
  });
  await new Promise((res) => fixture.listen(0, '127.0.0.1', res));
  const fixturePort = fixture.address().port;
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

  const logPath = path.join(os.tmpdir(), 'bfb-s12.log');
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
            const ok = await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false);
            if (ok) { port = p; break; }
          }
        }
      } catch { /* not yet */ }
      await sleep(500);
    }
  }
  if (!port) { console.error('[s12] 端口没发现'); process.exit(2); }

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

  // 页面侧注入唯一元素
  const list1 = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const pageT = (list1 || []).find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url || ''));
  if (!pageT) { console.error('[s12] fixture target 没出现'); process.exit(2); }
  const pc = wsClient(pageT.webSocketDebuggerUrl);
  await pc.ready;
  const injected = await evalIn(pc, `(() => {
    const d = document.createElement('div');
    d.id = 'uniq-probe-xyz';
    d.textContent = 'UNIQ-PROBE-CONTENT';
    document.body.appendChild(d);
    return document.body.innerHTML.replace(/\\s+/g, ' ').slice(0, 160);
  })()`);
  console.log('[s12] page target url:', pageT.url);
  console.log('[s12] page body after inject:', JSON.stringify(injected));

  // 打开抽屉
  for (let i = 0; i < 40; i += 1) {
    const state = await evalIn(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`);
    if (state === 'clicked') break;
    await sleep(500);
  }

  let front = null;
  for (let i = 0; i < 60 && !front; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    front = (list || []).find((t) => /devtools_app\.html\?can_dock=true/.test(t.url || ''));
    if (!front) await sleep(500);
  }
  if (!front) { console.error('[s12] 前端 iframe 没出现'); process.exit(2); }
  const fc = wsClient(front.webSocketDebuggerUrl);
  await fc.ready;
  await fc.send('Runtime.enable');
  await sleep(12000);

  const treeTexts = await evalIn(fc, `JSON.stringify({
    hasUniq: ${DEEP_TEXT}.some(function (t) { return t.indexOf('uniq-probe-xyz') !== -1; }),
    hasMark: ${DEEP_TEXT}.some(function (t) { return t.indexOf('mark') !== -1; }),
    hasOriginal: ${DEEP_TEXT}.some(function (t) { return t.indexOf('ORIGINAL-MARK') !== -1; }),
    hasAutomation: ${DEEP_TEXT}.some(function (t) { return t.indexOf('bao-automation') !== -1; }),
    hasBaoFlashBadge: ${DEEP_TEXT}.some(function (t) { return t.indexOf('BaoFlash') !== -1 || t.indexOf('bf-head') !== -1; }),
    spanCount: ${DEEP_TEXT}.length,
    sample: ${DEEP_TEXT}.slice(0, 16),
  })`);
  console.log('[s12] tree identity:', treeTexts);

  // 滚动 Elements 树到底部，强制渲染后续节点（虚拟滚动只画可见区域）
  const scrolled = await evalIn(fc, `(() => {
    const cands = [].slice.call(document.querySelectorAll('*')).filter(function (el) { return el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 80; });
    cands.forEach(function (el) { el.scrollTop = el.scrollHeight; });
    return cands.length;
  })()`);
  await sleep(2500);
  const afterScroll = await evalIn(fc, `JSON.stringify({
    scrolled: ${JSON.stringify(scrolled)},
    hasUniq: ${DEEP_TEXT}.some(function (t) { return t.indexOf('uniq-probe-xyz') !== -1; }),
    hasMark: ${DEEP_TEXT}.some(function (t) { return t.indexOf('mark') !== -1; }),
    hasOriginal: ${DEEP_TEXT}.some(function (t) { return t.indexOf('ORIGINAL-MARK') !== -1; }),
    spanCount: ${DEEP_TEXT}.length,
  })`);
  console.log('[s12] after scroll:', afterScroll);

  // 桥的 targetId 与 target URL
  const statsRaw = await evalIn(client, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) { return JSON.stringify(s); })`, true);
  const stats = JSON.parse(statsRaw);
  const bound = ((await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => [])) || []).find((t) => t.id === stats.targetId);
  console.log('[s12] bridge target:', (stats.targetId || '').slice(0, 8), '->', bound ? bound.url : 'NOT FOUND');

  // 外壳 body 对照
  const shellBody = await evalIn(client, `document.body.innerHTML.replace(/\\s+/g, ' ').slice(0, 120)`);
  console.log('[s12] shell body:', JSON.stringify(shellBody));

  // 全量 target（不筛 type），并读每个 page target 的 body 前 80 字
  const all = await getJson('http://127.0.0.1:' + port + '/json/list').catch(() => []);
  for (const t of all) {
    let body = '';
    try {
      const c = wsClient(t.webSocketDebuggerUrl);
      await c.ready;
      body = await evalIn(c, 'document.body ? document.body.innerHTML.replace(/s+/g, " ").slice(0, 80) : "(no body)"');
      c.close();
    } catch (e) { body = 'ERR ' + e.message; }
    console.log('[s12] target', t.type, t.id.slice(0, 6), (t.url || '').slice(0, 60), '|', JSON.stringify(body));
  }

  fc.close(); pc.close(); client.close(); fixture.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
