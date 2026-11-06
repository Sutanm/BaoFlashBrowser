#!/usr/bin/env node
/**
 * 前端成本归因：那 ~30% 到底是「事件驱动」还是「常驻渲染」？
 *
 *   node tools/devtools-spike/frontend-cost-probe.cjs
 *
 * 四档，全部在同一个应用实例里连续测（避免重启带来的状态漂移），
 * 每档都记录页面可见性——可见性不统一的数据直接作废（±50pp 的混淆项）：
 *   A big-idle    大页面 + 不开负载        → 前端看一个 1500 节点页面的常驻成本
 *   B big-load    大页面 + 负载（30+ ev/s）→ 加上事件处理后的成本
 *   C unmounted   切到「捕获」子标签（iframe 被卸载）→ 验证省下的量
 *   D small-load  小页面（30 节点）+ 负载   → 成本对页面规模的敏感度
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
const SETTLE_MS = Number(process.env.BFB_SETTLE_MS || 12000);
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
  console.log('[fcost] 等待超时:', label);
  return null;
}

function startServers() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/small')) {
      const items = Array.from({ length: 30 }, (_, i) => `<div class="s${i % 5}" data-i="${i}"><span>node-${i}</span></div>`).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><html><head><title>bfb-small</title><style>body{margin:0;font:12px sans-serif}</style></head><body><div id="small-root">${items}</div></body></html>`);
      return;
    }
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
    window.__bfbLoadCount = 0;
    window.__bfbLoadTimer = setInterval(function () {
      n += 1; window.__bfbLoadCount = n;
      const el = document.createElement('div');
      el.className = 'bfb-load-item bfb-item-' + (n % 5);
      el.setAttribute('data-seq', String(n));
      el.textContent = 'item-' + n;
      el.style.color = n % 2 ? '#333' : '#666';
      host.appendChild(el);
      if (host.children.length > 40) host.removeChild(host.children[0]);
      fetch(${JSON.stringify(pingUrl)} + '?i=' + n, { mode: 'no-cors', cache: 'no-store' }).catch(function () {});
    }, ${intervalMs});
    return 'installed';
  })()`;
}

async function measure(windowMs, mainPid) {
  const samples = Math.max(3, Math.round(windowMs / 2000) + 2);
  const outFile = path.join(os.tmpdir(), `bfb-fcost-${Date.now()}.csv`);
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
  try { text = fs.readFileSync(outFile, 'utf8'); } catch { return { total: null, main: null, perInstance: {} }; }
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
  const pidByInstance = {};
  for (const col of pidCols) {
    for (let r = rows.length - 1; r >= 0; r -= 1) {
      const v = Number(rows[r][col.index]);
      if (Number.isFinite(v) && v > 0) { pidByInstance[col.name] = v; break; }
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
  if (!usable.length) return { total: null, main: null, perInstance: {} };
  const total = Math.round((usable.reduce((a, b) => a + b, 0) / usable.length) * 10) / 10;
  const perInstance = {};
  let main = null;
  for (const [name, arr] of Object.entries(per)) {
    const tail = arr.slice(1);
    if (!tail.length) continue;
    const value = Math.round((tail.reduce((a, b) => a + b, 0) / tail.length) * 10) / 10;
    perInstance[name] = value;
    if (mainPid && String(pidByInstance[name]) === String(mainPid)) main = value;
  }
  return { total, main, perInstance };
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1500);

  const { server, port: pingPort } = await startServers();
  const heavy = `http://127.0.0.1:${pingPort}/heavy`;
  const small = `http://127.0.0.1:${pingPort}/small`;
  const ping = `http://127.0.0.1:${pingPort}/ping`;

  const logPath = path.join(os.tmpdir(), 'bfb-fcost.log');
  const out = fs.openSync(logPath, 'w');
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

  const navigate = async (url) => {
    for (let i = 0; i < 40; i += 1) {
      const state = await evaluate(shellClient, `(() => {
        const input = document.querySelector('.address-input');
        if (!input) return 'no-input';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(url)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return 'submitted';
      })()`);
      if (state === 'submitted') return true;
      await sleep(500);
    }
    return false;
  };

  const pageClientFor = async (needle) => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const t = (list || []).find((x) => x.type === 'page' && (x.url || '').indexOf(needle) !== -1);
    if (!t) return null;
    const c = cdp(t.webSocketDebuggerUrl);
    await c.ready;
    return c;
  };

  await navigate(heavy);
  const heavyPage = await waitUntil(() => pageClientFor('/heavy'), 60000, 'heavy page');
  if (!heavyPage) process.exit(2);

  // 开抽屉（默认就是 DevTools 子标签）
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(shellClient, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`).catch(() => 'no-button');
    if (state === 'clicked') break;
    await sleep(500);
  }
  await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /devtools_app\.html/.test(t.url || '')) || null;
  }, 30000, 'frontend iframe');
  await sleep(SETTLE_MS);

  const readVis = async (client) => evaluate(client, `JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus() })`);
  const results = [];

  const runCase = async (label, client) => {
    const vis = await readVis(client);
    const cpu = await measure(WINDOW_MS, child.pid);
    const vis2 = await readVis(client);
    const row = { label, total: cpu.total, main: cpu.main, perInstance: cpu.perInstance, vis: `${vis} → ${vis2}` };
    console.log('[fcost]', JSON.stringify(row));
    results.push(row);
  };

  // A：大页面，不开负载
  await runCase('A big-idle', heavyPage);

  // B：大页面 + 负载
  await evaluate(heavyPage, loadScript(ping, LOAD_INTERVAL_MS));
  await sleep(2000);
  await runCase('B big-load', heavyPage);

  // C：切到「捕获」子标签 → DevToolsTab 卸载（iframe 销毁）
  await evaluate(heavyPage, `(() => { if (window.__bfbLoadTimer) { clearInterval(window.__bfbLoadTimer); window.__bfbLoadTimer = null; } return 'stopped'; })()`);
  await sleep(1500);
  await evaluate(shellClient, `(() => {
    const btns = [].slice.call(document.querySelectorAll('button'));
    const target = btns.find(function (b) { return (b.textContent || '').trim().indexOf('捕获') === 0; });
    if (!target) return 'no-tab';
    target.click();
    return 'clicked';
  })()`);
  await sleep(3000);
  const frontGone = !(await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []))
    .some((t) => /devtools_app\.html/.test(t.url || ''));
  console.log('[fcost] iframe destroyed after switch:', frontGone);
  await runCase('C unmounted', heavyPage);

  // D：回到 DevTools 标签，改小页面（30 节点）+ 负载
  await evaluate(shellClient, `(() => {
    const btns = [].slice.call(document.querySelectorAll('button'));
    const target = btns.find(function (b) { return (b.textContent || '').trim() === 'DevTools'; });
    if (!target) return 'no-tab';
    target.click();
    return 'clicked';
  })()`);
  await sleep(3000);
  await navigate(small);
  const smallPage = await waitUntil(() => pageClientFor('/small'), 30000, 'small page');
  if (smallPage) {
    await sleep(SETTLE_MS);
    await evaluate(smallPage, loadScript(ping, LOAD_INTERVAL_MS));
    await sleep(2000);
    await runCase('D small-load', smallPage);
    await evaluate(smallPage, `(() => { if (window.__bfbLoadTimer) { clearInterval(window.__bfbLoadTimer); window.__bfbLoadTimer = null; } return 'stopped'; })()`);
    smallPage.close();
  }

  console.log('[fcost] ==== 汇总 ====');
  for (const r of results) {
    console.log(`  ${r.label.padEnd(13)} 主进程=${String(r.main).padStart(5)}%  总=${String(r.total).padStart(6)}%  vis=${r.vis}  ${JSON.stringify(r.perInstance)}`);
  }

  heavyPage.close();
  shellClient.close();
  server.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[fcost] failed:', e.message); process.exit(1); });
