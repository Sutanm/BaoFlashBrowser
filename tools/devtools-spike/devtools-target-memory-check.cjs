#!/usr/bin/env node
/**
 * 「当前页面 / 外壳界面」的选择是否跟着标签走。
 *
 * 判据（读 DevToolsTab 那两个按钮的 aria-pressed）：
 *   1. tab1 选「外壳界面」→ pressed=shell
 *   2. 新开 tab2 → 应回到默认 page（不继承 tab1 的选择）
 *   3. 切回 tab1 → 应恢复 shell
 *
 *   node tools/devtools-spike/devtools-target-memory-check.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');
const LOG = path.join(os.tmpdir(), 'bfb-targetmem.log');
const FIXTURE = path.join(os.tmpdir(), 'bfb-targetmem.html');

fs.writeFileSync(FIXTURE, `<!doctype html><html><head><meta charset="utf-8"><title>tm</title>
<style>html,body{margin:0;background:#eef;font:13px sans-serif}</style></head>
<body><div style="padding:10px">TARGET-MEMORY-FIXTURE</div></body></html>`);

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

function cdp(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) { const e = pending.get(m.id); pending.delete(m.id); e(m); }
  });
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return {
    ready,
    send(method, params = {}) {
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise((res) => {
        const t = setTimeout(() => { pending.delete(i); res({ error: { message: 'timeout' } }); }, 20000);
        pending.set(i, (m) => { clearTimeout(t); res(m); });
      });
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) return `EXC ${r.exceptionDetails.text}`;
  return r && r.result && r.result.result && r.result.result.value;
}

const PRESSED = `(() => {
  const btn = document.querySelector('[data-devtarget][aria-pressed="true"]');
  return btn ? btn.getAttribute('data-devtarget') : 'none';
})()`;

const clickTarget = (name) => `(() => {
  const btn = document.querySelector('[data-devtarget="' + ${JSON.stringify(name)} + '"]');
  if (!btn) return 'no-btn';
  btn.click();
  return 'clicked';
})()`;

async function nav(client, url) {
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(url)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (state === 'submitted') return 'ok';
    await sleep(500);
  }
  return 'failed';
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1200);

  const out = fs.openSync(LOG, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BAO_DEVTOOLS_PAGE_WS;
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  const startedAt = Date.now();
  let port = 0;
  for (let i = 0; i < 80 && !port; i += 1) {
    try {
      if (fs.statSync(PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).split('\n')[0]);
        if (Number.isFinite(p) && p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) port = p;
      }
    } catch { /* not yet */ }
    if (!port) await sleep(500);
  }
  if (!port) { console.error('[tm] 端口没发现'); process.exit(2); }

  let shell = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { child.kill(); process.exit(2); }
  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;

  const fixtureUrl = `file:///${FIXTURE.replace(/\\/g, '/')}`;
  await nav(client, fixtureUrl);
  await sleep(3000);

  await evaluate(client, `(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (b) b.click(); return 'opened'; })()`);
  await sleep(6000);

  console.log('[tm] 初始（tab1）:', await evaluate(client, PRESSED));
  console.log('[tm] 点外壳界面:', await evaluate(client, clickTarget('shell')));
  await sleep(1200);
  console.log('[tm] tab1 选择:', await evaluate(client, PRESSED));

  // 新标签页
  await evaluate(client, `(() => { const b = document.querySelector('button.btn-tab'); if (b) b.click(); return 'newtab'; })()`);
  await sleep(1500);
  await nav(client, fixtureUrl);
  await sleep(3000);
  console.log('[tm] 新标签页选择（应为默认 page）:', await evaluate(client, PRESSED));

  // 切回 tab1
  await evaluate(client, `(() => {
    const items = document.querySelectorAll('.tab-item');
    if (!items[0]) return 'no-tab';
    const r = items[0].getBoundingClientRect();
    items[0].dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + 10, clientY: r.y + 10 }));
    return 'clicked';
  })()`);
  await sleep(2500);
  console.log('[tm] 切回 tab1（应恢复 shell）:', await evaluate(client, PRESSED));

  client.close();
  child.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('[tm] failed:', e && e.message); process.exit(1); });
