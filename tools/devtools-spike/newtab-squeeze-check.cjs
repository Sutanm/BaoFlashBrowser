#!/usr/bin/env node
/**
 * 新标签页在抽屉挤压下的变形检测。
 *
 * 判据：`.newtab-shell` 是 flex column + justify-content:center，子项默认
 * `flex-shrink:1`。抽屉变高时内容区变矮，搜索框（44px 固定高）与快捷图标
 * 会被压扁 —— 这里把抽屉从矮拖到高，逐步读：
 *   - search input 的实际高度（design 44）
 *   - .newtab-links 的高度与图标高度（design 40）
 *   - shell 是否出现溢出（scrollHeight > clientHeight）
 *
 *   node tools/devtools-spike/newtab-squeeze-check.cjs
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
const LOG = path.join(os.tmpdir(), 'bfb-squeeze.log');
const SHOT = path.join(APP_ROOT, 'artifacts', 'newtab-squeeze.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(3000, () => req.destroy(new Error('timeout')));
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
        const t = setTimeout(() => { pending.delete(i); res({ error: { message: 'timeout' } }); }, 15000);
        pending.set(i, (m) => { clearTimeout(t); res(m); });
      });
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    return `EXC ${(d.exception && d.exception.description) || d.text}`;
  }
  return r && r.result && r.result.result && r.result.result.value;
}

const MEASURE = `(() => {
  const shell = document.querySelector('.newtab-shell');
  const input = document.querySelector('.newtab-search-input');
  const links = document.querySelector('.newtab-links');
  const icon = document.querySelector('.newtab-link-icon');
  const box = (el) => el ? { h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) } : null;
  return JSON.stringify({
    shell: box(shell),
    shellScroll: shell ? { sh: shell.scrollHeight, ch: shell.clientHeight } : null,
    input: box(input),
    links: box(links),
    icon: box(icon),
    inner: window.innerHeight,
  });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1200);

  const out = fs.openSync(LOG, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BAO_DEVTOOLS_PAGE_WS;
  delete env.BAO_DEVTOOLS_LEGACY_HTTP;
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
  if (!port) { console.error('[squeeze] 端口没发现'); process.exit(2); }

  let shell = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { console.error('[squeeze] shell 没出现'); process.exit(2); }

  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;
  await sleep(1500);

  console.log('[squeeze] 打开前:', await evaluate(client, MEASURE));

  // 打开抽屉
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`);
    if (state === 'clicked') break;
    await sleep(500);
  }
  await sleep(2500);
  console.log('[squeeze] 抽屉默认高度:', await evaluate(client, MEASURE));

  // 不靠拖拽（no-target 抽屉里 handle 的命中不稳定），直接把内容区压到各个高度，
  // 看搜索框/图标从哪一档开始变形。这是纯 CSS 层面的判据，最干净。
  for (const h of [711, 400, 320, 300, 260, 220, 180, 154, 120]) {
    const out = await evaluate(client, `(() => {
      const shell = document.querySelector('.newtab-shell');
      if (!shell) return 'no-shell';
      shell.style.flex = 'none';
      shell.style.height = '${h}px';
      const input = document.querySelector('.newtab-search-input');
      const links = document.querySelector('.newtab-links');
      const icon = document.querySelector('.newtab-link-icon');
      const r = (el) => el ? Math.round(el.getBoundingClientRect().height) : null;
      const sr = shell.getBoundingClientRect();
      const ir = input ? input.getBoundingClientRect() : null;
      return JSON.stringify({
        shell: ${h},
        scrollH: shell.scrollHeight,
        input: r(input), links: r(links), icon: r(icon),
        // 搜索框是否被裁到可视区外（负值/0 表示顶部被吃掉）
        inputVisible: ir ? Math.max(0, Math.min(ir.bottom, sr.bottom) - Math.max(ir.top, sr.top)) : null,
        canScroll: shell.scrollHeight > shell.clientHeight,
      });
    })()`);
    console.log('[squeeze]', out);
  }

  // 复位，恢复自然布局后再截图
  await evaluate(client, `(() => { const s = document.querySelector('.newtab-shell'); if (s) { s.style.flex = ''; s.style.height = ''; } return 'reset'; })()`);
  await sleep(400);

  const shot = await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot && shot.result && shot.result.data) {
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log('[squeeze] screenshot:', SHOT);
  }

  client.close();
  child.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('[squeeze] failed:', e && e.message); process.exit(1); });
