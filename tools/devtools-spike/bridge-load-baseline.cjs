#!/usr/bin/env node
/**
 * B1.3：IPC 负载基线——桥模式 vs page-ws vs 不开抽屉，同一真站的 CPU 与消息量对比。
 *
 *   node tools/devtools-spike/bridge-load-baseline.cjs           # 三种模式全跑
 *   node tools/devtools-spike/bridge-load-baseline.cjs bridge    # 只跑一种
 *
 * CPU 用 CDP 的 `SystemInfo.getProcessInfo`（浏览器端点）取各进程累计 CPU 时间，
 * 首尾相减 / 墙钟 = 占单核百分比。这比外部采样工具准，而且采的就是被测进程。
 *
 * 输出每种模式：CPU%（单核占比）、桥的 sent/events/bytes 速率、页面节点数。
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
const SITE_DEFAULT = process.env.BFB_SITE || 'http://www.7k7k.com/';
const WINDOW_MS = Number(process.env.BFB_WINDOW_MS || 30000);
const SETTLE_MS = Number(process.env.BFB_SETTLE_MS || 15000);
/** 受控负载的间隔（毫秒）：150ms ≈ 6.7 次/秒 DOM 变更 + 请求。 */
const LOAD_INTERVAL_MS = Number(process.env.BFB_LOAD_INTERVAL_MS || 150);
/**
 * BFB_HEAVY=1：改用本地受控重页面，而不是真站。
 *
 * 真站（7k7k）自身就烧掉半核且广告轮播让它抖动，两次运行桥与 ws 的差值
 * 还会翻转——那种数据只能证明"两者同量级"，证不了增量。受控页面固定
 * 1500 个节点 + 500 条 CSS 规则，站点侧成本稳定，DevTools 的开销才可测。
 */
const USE_HEAVY = process.env.BFB_HEAVY === '1';
let SITE = SITE_DEFAULT;
const VERBOSE = process.env.BFB_VERBOSE === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 目标站匹配（受控页面模式下 host 是 127.0.0.1，不能写死 7k7k）。 */
function matchesSite(url) {
  try { return new URL(url).host === new URL(SITE).host; } catch { return false; }
}

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
  console.log('[b13] 等待超时:', label);
  return null;
}

/**
 * 用 Windows 性能计数器测 Electron 进程组的 CPU 占用。
 *
 * 为什么不用 CDP 的 `SystemInfo.getProcessInfo`：它在这个应用上只报 4~5 个进程
 * （漏掉部分 renderer），同一模式两次跑出 4% 与 54% 的荒谬差异——首尾相减的
 * 口径不可用。typeperf 是 OS 级、按实例逐进程给百分比，与任务管理器一致。
 *
 * 返回「占单核百分比」的均值（多进程相加，可 >100）。
 */
async function measureCpuWithTypeperf(windowMs, mainPid) {
  const samples = Math.max(3, Math.round(windowMs / 2000) + 2);
  const outFile = path.join(os.tmpdir(), `bfb-b13-perf-${Date.now()}.csv`);
  const args = [
    '\\Process(electron*)\\% Processor Time',
    '\\Process(electron*)\\ID Process',
    '-sc', String(samples),
    '-si', '2',
    '-f', 'CSV',
    '-o', outFile,
    '-y',
  ];
  await new Promise((resolve) => {
    const child = spawn('typeperf', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('exit', resolve);
    child.on('error', resolve);
  });

  let text = '';
  try { text = fs.readFileSync(outFile, 'utf8'); } catch { return { cpuPercent: null, samples: 0 }; }
  try { fs.unlinkSync(outFile); } catch { /* ignore */ }

  const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('"'));
  // 第一行是表头（列名），其余是采样点；首行采样点丢掉（速率计数器需要基线）
  const headerCells = (lines[0] || '').split('","').map((c) => c.replace(/^"|"$/g, ''));
  const cpuCols = [];
  const pidCols = [];
  headerCells.forEach((h, i) => {
    if (i === 0) return;
    const m = /Process\(([^)]+)\)\\(.+)$/.exec(h);
    if (!m) return;
    if (m[2] === '% Processor Time') cpuCols.push({ instance: m[1], index: i });
    else if (m[2] === 'ID Process') pidCols.push({ instance: m[1], index: i });
  });

  const rows = lines.slice(1).map((row) => row.split('","').map((c) => c.replace(/^"|"$/g, '')));
  // 实例 → PID（取最后一个有效值；实例名如 electron#3 与 PID 的对应关系在窗口内稳定）
  const pidByInstance = {};
  for (const pidCol of pidCols) {
    for (let r = rows.length - 1; r >= 0; r -= 1) {
      const v = Number(rows[r][pidCol.index]);
      if (Number.isFinite(v) && v > 0) { pidByInstance[pidCol.instance] = v; break; }
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
      (perInstance[col.instance] ||= []).push(v);
    }
    if (any) sums.push(sum);
  }
  const usable = sums.slice(1);
  if (!usable.length) return { cpuPercent: null, mainCpuPercent: null, samples: rows.length, perInstance: {} };
  const avg = usable.reduce((a, b) => a + b, 0) / usable.length;

  const breakdown = {};
  let mainCpuPercent = null;
  for (const [name, arr] of Object.entries(perInstance)) {
    const tail = arr.slice(1);
    if (!tail.length) continue;
    const value = Math.round((tail.reduce((a, b) => a + b, 0) / tail.length) * 10) / 10;
    breakdown[name] = value;
    if (mainPid && String(pidByInstance[name]) === String(mainPid)) mainCpuPercent = value;
  }
  return {
    cpuPercent: Math.round(avg * 10) / 10,
    mainCpuPercent,
    samples: usable.length,
    perInstance: breakdown,
    pidByInstance,
  };
}

/**
 * 受控负载：在目标页里每 150ms 制造 DOM 变更 + 一次 fetch。
 *
 * 为什么要它：7k7k 首屏加载完后 DevTools 几乎收不到事件（实测 events/s≈1.4），
 * 那种「静默窗口」测不出桥的开销，也测不出事件风暴下的丢失/乱序。这里把
 * DOM/CSS/Network 三个域一起打起来，三种模式跑同一份负载，比较才有意义。
 */
function startPingServer() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/heavy')) {
      // 受控重页面：1500 个节点，其中 500 个带 class、一套 500 条的样式表。
      const rules = Array.from({ length: 500 }, (_, i) =>
        `.c${i}{color:#${(i % 9) + 1}33;margin:${i % 7}px;padding:${i % 5}px 0;border:1px solid #eee}`).join('');
      const items = Array.from({ length: 1500 }, (_, i) =>
        `<div class="c${i % 500}" data-i="${i}"><span>node-${i}</span></div>`).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><html><head><title>bfb-heavy</title><style>body{margin:0;font:12px sans-serif}${rules}</style></head><body><div id="heavy-root">${items}</div></body></html>`);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/plain',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end('pong');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

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

async function installLoadGenerator(port, pingUrl, intervalMs) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const page = (list || []).find((t) => t.type === 'page' && matchesSite(t.url));
  if (!page) return 'no-page';
  const pc = cdp(page.webSocketDebuggerUrl);
  await pc.ready;
  const r = await evaluate(pc, loadGeneratorScript(pingUrl, intervalMs));
  pc.close();
  return r;
}

async function readBridgeStats(shell) {
  const raw = await evaluate(shell, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) {
    return JSON.stringify({ state: s.state, sent: s.sent, events: s.events, dropped: s.eventsDropped, bytesIn: s.bytesIn, bytesOut: s.bytesOut });
  })`, true);
  try { return JSON.parse(raw); } catch { return null; }
}

async function runMode(mode, pingPort) {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1500);

  const logPath = path.join(os.tmpdir(), `bfb-b13-${mode}.log`);
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (mode === 'bridge') env.BAO_DEVTOOLS_BRIDGE = '1';
  else delete env.BAO_DEVTOOLS_BRIDGE;

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

  const version = await getJson(`http://127.0.0.1:${port}/json/version`);
  const browser = cdp(version.webSocketDebuggerUrl);
  await browser.ready;

  const shell = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || '')) || null;
  }, 30000, 'shell');
  if (!shell) { browser.close(); child.kill(); return null; }
  const shellClient = cdp(shell.webSocketDebuggerUrl);
  await shellClient.ready;

  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(shellClient, `(() => {
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

  await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => t.type === 'page' && matchesSite(t.url)) || null;
  }, 60000, 'site target');

  if (mode !== 'nodrawer') {
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

  // 让页面与面板都稳定下来再开窗计时（否则首屏加载的峰值会污染稳态数据）
  await sleep(SETTLE_MS);

  // 打受控负载（三种模式同一份），保证窗口内 DevTools 真的有事件流
  const pingUrl = `http://127.0.0.1:${pingPort}/ping`;
  const installed = await installLoadGenerator(port, pingUrl, LOAD_INTERVAL_MS);
  console.log('[b13] load generator:', installed);
  await sleep(2000);

  // 前置条件：非 nodrawer 模式下前端 iframe 必须真的起来了，否则测的是占位页
  let frontendUp = null;
  if (mode !== 'nodrawer') {
    const before = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const front = (before || []).find((t) => /devtools_app\.html/.test(t.url || ''));
    frontendUp = Boolean(front);
    console.log('[b13] frontend iframe:', front ? front.url.slice(0, 96) : 'NOT FOUND（本次数据不可用）');
  }

  const stats0 = mode === 'bridge' ? await readBridgeStats(shellClient) : null;
  const t0 = Date.now();
  const cpu = await measureCpuWithTypeperf(WINDOW_MS, child.pid);
  const stats1 = mode === 'bridge' ? await readBridgeStats(shellClient) : null;
  const wall = (Date.now() - t0) / 1000;

  // 负载发生器的实际迭代数：与桥收到的事件数对照，粗判有无丢事件
  let loadCount = null;
  {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const page = (list || []).find((t) => t.type === 'page' && matchesSite(t.url));
    if (page) {
      const pc = cdp(page.webSocketDebuggerUrl);
      await pc.ready;
      loadCount = await evaluate(pc, `String(window.__bfbLoadCount || 0)`);
      await evaluate(pc, `(() => { if (window.__bfbLoadTimer) { clearInterval(window.__bfbLoadTimer); window.__bfbLoadTimer = null; } return 'stopped'; })()`);
      pc.close();
    }
  }

  const pageInfo = await evaluate(shellClient, `(() => { return document.title; })()`);

  let result = { mode, wall, frontendUp, cpuPercent: cpu.cpuPercent, mainCpuPercent: cpu.mainCpuPercent, cpuSamples: cpu.samples, perInstance: cpu.perInstance, sentPerSec: null, eventsPerSec: null, bytesInPerSec: null, targetTitle: pageInfo, loadCount };
  if (stats0 && stats1) {
    result.sentPerSec = Math.round((stats1.sent - stats0.sent) / wall * 10) / 10;
    result.eventsPerSec = Math.round((stats1.events - stats0.events) / wall * 10) / 10;
    result.bytesInPerSec = Math.round((stats1.bytesIn - stats0.bytesIn) / wall);
    result.dropped = stats1.dropped;
  }

  shellClient.close();
  browser.close();
  child.kill();
  await sleep(1200);
  return result;
}

(async () => {
  const arg = process.argv[2];
  const modes = arg ? [arg] : ['ws', 'bridge', 'nodrawer'];
  const { server: pingServer, port: pingPort } = await startPingServer();
  if (USE_HEAVY) SITE = `http://127.0.0.1:${pingPort}/heavy`;
  console.log('[b13] site:', SITE, '| load interval:', LOAD_INTERVAL_MS + 'ms', '| window:', WINDOW_MS + 'ms');
  const results = [];
  for (const mode of modes) {
    console.log(`[b13] ---- 模式 ${mode} ----`);
    const r = await runMode(mode, pingPort);
    console.log('[b13]', JSON.stringify(r));
    if (r) results.push(r);
  }
  console.log('[b13] ==== 汇总 ====');
  for (const r of results) {
    const flag = r.frontendUp === false ? '  ⚠ 前端未加载，数据不可用' : '';
    console.log(`  ${r.mode.padEnd(9)} CPU=${String(r.cpuPercent).padStart(6)}%  sent/s=${String(r.sentPerSec).padStart(6)}  events/s=${String(r.eventsPerSec).padStart(7)}  bytesIn/s=${String(r.bytesInPerSec).padStart(8)}  load=${String(r.loadCount).padStart(4)}${flag}`);
  }
  pingServer.close();
  process.exit(0);
})().catch((e) => { console.error('[b13] failed:', e.message); process.exit(1); });
