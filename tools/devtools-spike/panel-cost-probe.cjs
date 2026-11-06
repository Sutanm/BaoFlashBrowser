#!/usr/bin/env node
/**
 * 面板成本对比：Elements（渲染 1500 节点树）vs Console（几乎不画）vs Network（记录全部请求）。
 *
 *   node tools/devtools-spike/panel-cost-probe.cjs
 *
 * 目的：判断「开抽屉」那部分成本里，有多少是"前端框架本身"，有多少是
 * "当前面板在干活"。如果 Console 明显便宜，那"打开时落在轻面板"就是一个
 * 无损可用的优化；如果持平，说明成本在前端框架与 DOM 模型上，裁面板才有用。
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
const WINDOW_MS = Number(process.env.BFB_WINDOW_MS || 20000);
const LOAD_INTERVAL_MS = Number(process.env.BFB_LOAD_INTERVAL_MS || 200);

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
  console.log('[pcost] 等待超时:', label);
  return null;
}

function startServers() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/heavy')) {
      const rules = Array.from({ length: 500 }, (_, i) =>
        `.c${i}{color:#${(i % 9) + 1}33;margin:${i % 7}px;padding:${i % 5}px 0;border:1px solid #eee}`).join('');
      const items = Array.from({ length: 1500 }, (_, i) =>
        `<div class="c${i % 500}" data-i="${i}"><span>node-${i}</span></div>`).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><html><head><title>bfb-heavy</title><style>body{margin:0;font:12px sans-serif}${rules}</style></head><body><div id="heavy-root">${items}</div></body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end('pong');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function loadScript(pingUrl, intervalMs) {
  return `(() => {
    if (window.__bfbLoadTimer) return 'already';
    const host = document.createElement('div');
    host.id = 'bfb-load-host';
    host.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;overflow:hidden';
    document.body.appendChild(host);
    let n = 0;
    window.__bfbLoadTimer = setInterval(function () {
      n += 1;
      const el = document.createElement('div');
      el.className = 'bfb-load-item';
      el.textContent = 'item-' + n;
      host.appendChild(el);
      if (host.children.length > 40) host.removeChild(host.children[0]);
      fetch(${JSON.stringify(pingUrl)} + '?i=' + n, { mode: 'no-cors', cache: 'no-store' }).catch(function () {});
    }, ${intervalMs});
    return 'installed';
  })()`;
}

async function measure(windowMs, mainPid) {
  const samples = Math.max(3, Math.round(windowMs / 2000) + 2);
  const outFile = path.join(os.tmpdir(), `bfb-pcost-${Date.now()}.csv`);
  await new Promise((resolve) => {
    const child = spawn('typeperf', [
      '\\Process(electron*)\\% Processor Time',
      '\\Process(electron*)\\ID Process',
      '-sc', String(samples), '-si', '2', '-f', 'CSV', '-o', outFile, '-y',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
  let text = '';
  try { text = fs.readFileSync(outFile, 'utf8'); } catch { return null; }
  try { fs.unlinkSync(outFile); } catch { /* ignore */ }

  const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('"'));
  const header = (lines[0] || '').split('","').map((c) => c.replace(/^"|"$/g, ''));
  const cpuCols = [];
  const pidCols = [];
  header.forEach((h, i) => {
    if (!i) return;
    const m = /Process\(([^)]+)\)\\(.+)$/.exec(h);
    if (!m) return;
    if (m[2] === '% Processor Time') cpuCols.push({ name: m[1], index: i });
    else if (m[2] === 'ID Process') pidCols.push({ name: m[1], index: i });
  });
  const rows = lines.slice(1).map((r) => r.split('","').map((c) => c.replace(/^"|"$/g, '')));
  const pidBy = {};
  for (const col of pidCols) {
    for (let r = rows.length - 1; r >= 0; r -= 1) {
      const v = Number(rows[r][col.index]);
      if (Number.isFinite(v) && v > 0) { pidBy[col.name] = v; break; }
    }
  }
  const sums = [];
  const per = {};
  for (const cells of rows) {
    let sum = 0; let any = false;
    for (const col of cpuCols) {
      const v = Number(cells[col.index]);
      if (!Number.isFinite(v)) continue;
      any = true; sum += v;
      (per[col.name] ||= []).push(v);
    }
    if (any) sums.push(sum);
  }
  const usable = sums.slice(1);
  if (!usable.length) return null;
  const perInstance = {};
  let main = null;
  for (const [name, arr] of Object.entries(per)) {
    const tail = arr.slice(1);
    if (!tail.length) continue;
    perInstance[name] = Math.round((tail.reduce((a, b) => a + b, 0) / tail.length) * 10) / 10;
    if (mainPid && String(pidBy[name]) === String(mainPid)) main = perInstance[name];
  }
  return {
    total: Math.round((usable.reduce((a, b) => a + b, 0) / usable.length) * 10) / 10,
    main,
    perInstance,
  };
}

/** 在前端 iframe 里点击面板标签（穿透 shadow DOM），返回点击到的标签名。 */
function clickPanelScript(label) {
  return `(() => {
    const deep = (root, acc) => {
      acc.push(root);
      root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) deep(el.shadowRoot, acc); });
      return acc;
    };
    const roots = deep(document, []);
    for (const root of roots) {
      const tabs = root.querySelectorAll('[role="tab"], .tabbed-pane-header-tab, button');
      for (const t of tabs) {
        const text = (t.getAttribute('aria-label') || t.textContent || '').trim();
        if (text === ${JSON.stringify(label)} || text.indexOf(${JSON.stringify(label)}) === 0) {
          t.click();
          return 'clicked:' + text.slice(0, 24);
        }
      }
    }
    return 'not-found';
  })()`;
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1500);

  const { server, port: pingPort } = await startServers();
  const heavy = `http://127.0.0.1:${pingPort}/heavy`;
  const ping = `http://127.0.0.1:${pingPort}/ping`;

  const out = fs.openSync(path.join(os.tmpdir(), 'bfb-pcost.log'), 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BAO_DEVTOOLS_BRIDGE;

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
  const shellClient = cdp(shell.webSocketDebuggerUrl);
  await shellClient.ready;

  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(shellClient, `(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(heavy)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (state === 'submitted') break;
    await sleep(500);
  }

  const page = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const t = (list || []).find((x) => x.type === 'page' && (x.url || '').indexOf('/heavy') !== -1);
    if (!t) return null;
    const c = cdp(t.webSocketDebuggerUrl);
    await c.ready;
    return c;
  }, 60000, 'heavy page');
  if (!page) process.exit(2);

  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(shellClient, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`).catch(() => 'no-button');
    if (state === 'clicked') break;
    await sleep(500);
  }

  const front = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /devtools_app\.html/.test(t.url || '')) || null;
  }, 30000, 'frontend iframe');
  if (!front) process.exit(2);
  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;
  await sleep(10000);

  // 统一开负载
  await evaluate(page, loadScript(ping, LOAD_INTERVAL_MS));
  await sleep(2500);

  const results = [];
  const runPanel = async (label, clickLabel) => {
    if (clickLabel) {
      const clicked = await evaluate(fc, clickPanelScript(clickLabel));
      console.log('[pcost] panel click:', label, '→', clicked);
      await sleep(4000);
    }
    const cpu = await measure(WINDOW_MS, child.pid);
    if (!cpu) return;
    const vis = await evaluate(page, `document.visibilityState + '/' + document.hasFocus()`);
    const row = { label, ...cpu, vis };
    console.log('[pcost]', JSON.stringify(row));
    results.push(row);
  };

  await runPanel('Elements', null);
  await runPanel('Console', 'Console');
  await runPanel('Network', 'Network');
  await runPanel('Elements-again', 'Elements');

  console.log('[pcost] ==== 汇总 ====');
  for (const r of results) {
    console.log(`  ${r.label.padEnd(15)} 主进程=${String(r.main).padStart(5)}%  总=${String(r.total).padStart(6)}%  vis=${r.vis}  ${JSON.stringify(r.perInstance)}`);
  }

  await evaluate(page, `(() => { if (window.__bfbLoadTimer) { clearInterval(window.__bfbLoadTimer); window.__bfbLoadTimer = null; } return 'stopped'; })()`);
  fc.close();
  page.close();
  shellClient.close();
  server.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[pcost] failed:', e.message); process.exit(1); });
