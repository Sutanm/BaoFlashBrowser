#!/usr/bin/env node
/**
 * 「开抽屉 vs 不开抽屉」的 CPU 增量分解。
 *
 *   node tools/devtools-spike/drawer-cost-breakdown.cjs
 *
 * 三档，同一受控页面 + 同一份负载：
 *   idle        不开抽屉（基线）
 *   instrument  不开抽屉，但用一个外部 CDP 客户端把前端初始化时会发的域全部
 *               enable（DOM/CSS/Debugger/Runtime/Network/Overlay/…）——只留下
 *               「被检查页的埋点成本」
 *   frontend    真的开抽屉（ws 模式，前端直连）——埋点成本 + 前端 UI 成本
 *
 * 分解方式：
 *   Δ埋点  = instrument - idle
 *   Δ前端  = frontend - instrument
 *
 * 注意：instrument 档的客户端只发 enable 与一次 getDocument/requestChildNodes，
 * 不渲染任何界面——所以它测的是纯粹的「被检查侧」开销。
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
const WINDOW_MS = Number(process.env.BFB_WINDOW_MS || 24000);
const SETTLE_MS = Number(process.env.BFB_SETTLE_MS || 15000);
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

function cdp(wsUrl, onEvent) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e.resolve(msg); return; }
    if (msg.method && onEvent) onEvent(msg);
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
  console.log('[cost] 等待超时:', label);
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

/** 前端初始化时会发的域（S14 基线录出来的那一套）。 */
const FRONTEND_DOMAINS = [
  ['Page.enable'], ['Runtime.enable'], ['Network.enable'], ['DOM.enable'], ['CSS.enable'],
  ['Debugger.enable'], ['Debugger.setPauseOnExceptions', { state: 'none' }],
  ['Debugger.setAsyncCallStackDepth', { maxDepth: 32 }],
  ['Overlay.enable'], ['Overlay.setShowViewportSizeOnResize', { show: false }],
  ['Log.enable'], ['Profiler.enable'], ['Inspector.enable'], ['Audits.enable'],
  ['ServiceWorker.enable'], ['CSS.trackComputedStyleUpdates'],
  ['Page.setAdBlockingEnabled', { enabled: false }],
  ['Emulation.setFocusEmulationEnabled', { enabled: true }],
  ['DOMDebugger.setBreakOnCSPViolation', { state: 'none' }],
];

/** 与 bridge-load-baseline 同一份负载发生器。 */
function loadGeneratorScript(pingUrl, intervalMs) {
  return `(() => {
    if (window.__bfbLoadTimer) return 'already';
    const host = document.createElement('div');
    host.id = 'bfb-load-host';
    host.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;overflow:hidden';
    document.body.appendChild(host);
    let n = 0;
    window.__bfbLoadCount = 0;
    window.__bfbLoadTimer = setInterval(function () {
      n += 1;
      window.__bfbLoadCount = n;
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

/**
 * CPU：按实例逐进程的 % Processor Time（typeperf），再用 ID Process 认出主进程。
 * CDP 的 SystemInfo.getProcessInfo 在本应用会漏 renderer，已弃用。
 */
async function measureCpu(windowMs, mainPid) {
  const samples = Math.max(3, Math.round(windowMs / 2000) + 2);
  const outFile = path.join(os.tmpdir(), `bfb-cost-perf-${Date.now()}.csv`);
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
  const perInstance = {};
  for (const cells of rows) {
    let sum = 0;
    let any = false;
    for (const col of cpuCols) {
      const v = Number(cells[col.index]);
      if (!Number.isFinite(v)) continue;
      any = true;
      sum += v;
      (perInstance[col.name] ||= []).push(v);
    }
    if (any) sums.push(sum);
  }
  const usable = sums.slice(1);
  if (!usable.length) return { total: null, main: null, perInstance: {} };
  const total = Math.round((usable.reduce((a, b) => a + b, 0) / usable.length) * 10) / 10;

  const breakdown = {};
  let main = null;
  for (const [name, arr] of Object.entries(perInstance)) {
    const tail = arr.slice(1);
    if (!tail.length) continue;
    const value = Math.round((tail.reduce((a, b) => a + b, 0) / tail.length) * 10) / 10;
    breakdown[name] = value;
    if (mainPid && String(pidByInstance[name]) === String(mainPid)) main = value;
  }
  return { total, main, perInstance: breakdown, pidByInstance };
}

async function runMode(mode, pingPort) {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1500);

  const logPath = path.join(os.tmpdir(), `bfb-cost-${mode}.log`);
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
  if (!port) return null;

  const shell = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || '')) || null;
  }, 30000, 'shell');
  if (!shell) { child.kill(); return null; }
  const shellClient = cdp(shell.webSocketDebuggerUrl);
  await shellClient.ready;

  const site = `http://127.0.0.1:${pingPort}/heavy`;
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(shellClient, `(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(site)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (state === 'submitted') break;
    await sleep(500);
  }

  const page = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url || '') && t.url.indexOf('/heavy') !== -1) || null;
  }, 60000, 'heavy page');
  if (!page) { shellClient.close(); child.kill(); return null; }

  if (mode === 'frontend') {
    for (let i = 0; i < 40; i += 1) {
      const state = await evaluate(shellClient, `(() => {
        const b = document.querySelector('[data-devtoolbox-toggle]');
        if (!b) return 'no-button';
        b.click(); return 'clicked';
      })()`).catch(() => 'no-button');
      if (state === 'clicked') break;
      await sleep(500);
    }
  }

  await sleep(SETTLE_MS);

  // 负载发生器（同一份）
  const pageClient = cdp(page.webSocketDebuggerUrl);
  await pageClient.ready;
  const installed = await evaluate(pageClient, loadGeneratorScript(`http://127.0.0.1:${pingPort}/ping`, LOAD_INTERVAL_MS));
  console.log('[cost] load generator:', installed);

  // instrument 档：把前端会发的域全 enable，然后只保留事件计数（不渲染）
  let listener = null;
  let eventCount = 0;
  if (mode === 'instrument') {
    listener = cdp(page.webSocketDebuggerUrl, () => { eventCount += 1; });
    await listener.ready;
    for (const [method, params] of FRONTEND_DOMAINS) await listener.send(method, params ?? {});
    const doc = await listener.send('DOM.getDocument', { depth: 1 });
    const rootId = doc && doc.result && doc.result.root && doc.result.root.nodeId;
    if (rootId) await listener.send('DOM.requestChildNodes', { nodeId: rootId, depth: 2 });
    console.log('[cost] instrumented with', FRONTEND_DOMAINS.length, 'domains, rootId=', rootId);
  }

  await sleep(2000);
  // 不改窗口可见性：三档必须在同一可见性状态下比较。窗口被遮挡时 Chromium 会
  // 节流渲染，实测同一份负载能差 80pp（"idle 85% vs 7.3%"就是这么来的）。
  // 下面的 visibility 记录用于确认三档确实同态；混态的数据不采用。
  const visibility = [];
  const readVisibility = async () => {
    const v = await evaluate(pageClient, `JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus() })`);
    visibility.push(v);
    return v;
  };
  await readVisibility();

  const events0 = eventCount;
  const cpu = await measureCpu(WINDOW_MS, child.pid);
  const events = eventCount - events0;
  await readVisibility();

  const loadCount = await evaluate(pageClient, `String(window.__bfbLoadCount || 0)`);
  await evaluate(pageClient, `(() => { if (window.__bfbLoadTimer) { clearInterval(window.__bfbLoadTimer); window.__bfbLoadTimer = null; } return 'stopped'; })()`);

  const result = {
    mode,
    total: cpu.total,
    main: cpu.main,
    perInstance: cpu.perInstance,
    visibility,
    eventsPerSec: mode === 'instrument' ? Math.round((events / (WINDOW_MS / 1000)) * 10) / 10 : null,
    loadCount,
  };

  if (listener) listener.close();
  pageClient.close();
  shellClient.close();
  child.kill();
  await sleep(1200);
  return result;
}

(async () => {
  const { server, port: pingPort } = await startServers();
  console.log('[cost] load interval:', LOAD_INTERVAL_MS + 'ms', '| window:', WINDOW_MS + 'ms');
  const results = [];
  for (const mode of ['idle', 'instrument', 'frontend']) {
    console.log(`[cost] ---- ${mode} ----`);
    const r = await runMode(mode, pingPort);
    console.log('[cost]', JSON.stringify(r));
    if (r) results.push(r);
  }

  const by = Object.fromEntries(results.map((r) => [r.mode, r]));
  console.log('[cost] ==== 分解 ====');
  for (const r of results) {
    console.log(`  ${r.mode.padEnd(11)} 主进程=${String(r.main).padStart(5)}%  总=${String(r.total).padStart(6)}%  vis=${(r.visibility||[]).join("|")}  ${JSON.stringify(r.perInstance)}`);
  }
  if (by.idle && by.instrument && by.frontend) {
    console.log('[cost] Δ埋点（instrument-idle）  主进程 +%s pp  总 +%s pp',
      (by.instrument.main - by.idle.main).toFixed(1), (by.instrument.total - by.idle.total).toFixed(1));
    console.log('[cost] Δ前端（frontend-instrument）主进程 +%s pp  总 +%s pp',
      (by.frontend.main - by.instrument.main).toFixed(1), (by.frontend.total - by.instrument.total).toFixed(1));
  }
  server.close();
  process.exit(0);
})().catch((e) => { console.error('[cost] failed:', e.message); process.exit(1); });
