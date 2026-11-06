#!/usr/bin/env node
/**
 * 定位「侧边栏第一次打开」那 ~75ms 停在哪。
 *
 * 做法：CDP Tracing 录 1.5s（点侧边栏开关前后），然后
 *   1) 在主渲染线程上找最长的若干 slice（Layout / Paint / RasterTask / Layerize…）
 *   2) 找相邻 BeginMainFrame 之间的最大空档，看空档里到底在跑什么
 *
 *   node tools/devtools-spike/sidebar-jank-trace.cjs
 *   BFB_NO_DEVTOOLS=1 node tools/devtools-spike/sidebar-jank-trace.cjs   # 不开抽屉
 *
 * 产物：artifacts/sidebar-jank-trace.json（原始 trace，可拖进 chrome://tracing）
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
const LOG = path.join(os.tmpdir(), 'bfb-jank.log');
const FIXTURE = path.join(os.tmpdir(), 'bfb-jank.html');
const TRACE_OUT = path.join(APP_ROOT, 'artifacts', 'sidebar-jank-trace.json');
const NO_DEVTOOLS = process.env.BFB_NO_DEVTOOLS === '1';

fs.writeFileSync(FIXTURE, `<!doctype html><html><head><meta charset="utf-8"><title>jank</title>
<style>html,body{margin:0;background:#eef;font:13px sans-serif}</style></head>
<body><div style="padding:10px">JANK-FIXTURE</div></body></html>`);

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
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) { const e = pending.get(m.id); pending.delete(m.id); e(m); return; }
    listeners.forEach((fn) => fn(m));
  });
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return {
    ready,
    onEvent(fn) { listeners.push(fn); },
    send(method, params = {}) {
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise((res) => {
        const t = setTimeout(() => { pending.delete(i); res({ error: { message: 'timeout' } }); }, 30000);
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
  if (!port) { console.error('[jank] 端口没发现'); process.exit(2); }

  const waitTarget = async (test, label, tries = 60) => {
    for (let i = 0; i < tries; i += 1) {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      const hit = (list || []).find(test);
      if (hit) return hit;
      await sleep(500);
    }
    console.error('[jank] 等不到', label);
    return null;
  };

  const shell = await waitTarget((t) => /dist\/renderer\/index\.html$/.test(t.url || ''), 'shell');
  if (!shell) { child.kill(); process.exit(2); }

  // 先看这块机器的 GPU 是什么：软件光栅和独显的绝对值差一个数量级，
  // 组里的人看到的"多少 ms"必须先对上这个前提。
  try {
    const ver = await getJson(`http://127.0.0.1:${port}/json/version`);
    const bc = cdp(ver.webSocketDebuggerUrl);
    await bc.ready;
    const info = await bc.send('SystemInfo.getInfo');
    const gpu = info && info.result && info.result.gpu;
    const dev = gpu && gpu.devices && gpu.devices[0];
    console.log('[jank] GPU device:', dev ? `${dev.vendorString || '?'} / ${dev.deviceString || '?'}` : 'unknown');
    console.log('[jank] GL renderer:', (gpu && gpu.auxAttributes && gpu.auxAttributes.glRenderer) || 'unknown');
    bc.close();
  } catch (e) {
    console.log('[jank] GPU 信息读取失败:', e && e.message);
  }

  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;

  const fixtureUrl = `file:///${FIXTURE.replace(/\\/g, '/')}`;
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
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

  if (!NO_DEVTOOLS) {
    for (let i = 0; i < 40; i += 1) {
      const state = await evaluate(client, `(() => {
        const b = document.querySelector('[data-devtoolbox-toggle]');
        if (!b) return 'no-button';
        b.click(); return 'clicked';
      })()`);
      if (state === 'clicked') break;
      await sleep(500);
    }
    await waitTarget((t) => /devtools_app\.html\?/.test(t.url || ''), 'frontend');
    await sleep(8000);
  }

  // ---- 开始录 ----
  const events = [];
  client.onEvent((m) => {
    if (m.method === 'Tracing.dataCollected') events.push(...(m.params.value || []));
  });
  const done = new Promise((resolve) => {
    client.onEvent((m) => { if (m.method === 'Tracing.tracingComplete') resolve(); });
  });

  const started = await client.send('Tracing.start', {
    categories: [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'blink',
      'cc',
      'gpu',
      'viz',
      'toplevel',
      'benchmark',
    ].join(','),
    options: 'record-as-much-as-possible',
    transferMode: 'ReportEvents',
  });
  console.log('[jank] tracing start:', JSON.stringify(started.error || 'ok'));
  await sleep(250);

  await evaluate(client, `(() => {
    console.timeStamp('BFB_SIDEBAR_CLICK');
    const b = document.querySelector('.sidebar-toggle-button');
    if (b) b.click();
    return 'clicked';
  })()`);
  await sleep(900);
  await client.send('Tracing.end');
  await Promise.race([done, sleep(8000)]);
  console.log('[jank] 采集事件数:', events.length);

  fs.mkdirSync(path.dirname(TRACE_OUT), { recursive: true });
  fs.writeFileSync(TRACE_OUT, JSON.stringify({ traceEvents: events }));

  // ---- 分析 ----
  const threads = new Map();
  const procNames = new Map();
  for (const e of events) {
    if (e.name === 'thread_name' && e.ph === 'M') threads.set(`${e.pid}:${e.tid}`, e.args && e.args.name);
    if (e.name === 'process_name' && e.ph === 'M') procNames.set(String(e.pid), e.args && e.args.name);
  }
  // shell 渲染进程的主线程
  const mainTids = [...threads.entries()].filter(([, name]) => name === 'CrRendererMain').map(([k]) => k);
  const clickEvent = events.find((e) => e.name === 'TimeStamp' || (e.args && JSON.stringify(e.args).indexOf('BFB_SIDEBAR_CLICK') !== -1));
  const clickTs = clickEvent ? clickEvent.ts : null;
  console.log('[jank] 主渲染线程:', mainTids.join(', '), '| click ts =', clickTs);

  const inWindow = (e) => clickTs === null || (e.ts >= clickTs - 60000 && e.ts <= clickTs + 400000);

  // 1) 最长 slice（X 阶段，主线程）
  const slices = events
    .filter((e) => e.ph === 'X' && typeof e.dur === 'number' && mainTids.includes(`${e.pid}:${e.tid}`))
    .filter(inWindow)
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 18);
  console.log('\n[jank] === 主线程最长 slice（点击前后 600ms 内）===');
  for (const e of slices) {
    const start = clickTs === null ? 0 : Math.round((e.ts - clickTs) / 1000);
    console.log(`  ${(e.dur / 1000).toFixed(1).padStart(7)}ms  @${String(start).padStart(5)}ms  ${e.name}${e.args && e.args.data && e.args.data.type ? ` [${e.args.data.type}]` : ''}`);
  }

  // 2) 相邻 BeginMainFrame 的最大空档
  const frames = events
    .filter((e) => mainTids.includes(`${e.pid}:${e.tid}`) && (e.name === 'BeginMainFrame' || e.name === 'BeginFrame' || e.name === 'DrawFrame'))
    .filter(inWindow)
    .sort((a, b) => a.ts - b.ts);
  let worstGap = null;
  for (let i = 1; i < frames.length; i += 1) {
    const gap = frames[i].ts - frames[i - 1].ts;
    if (!worstGap || gap > worstGap.gap) worstGap = { gap, from: frames[i - 1].ts, to: frames[i].ts, name: frames[i].name };
  }
  if (worstGap) {
    console.log(`\n[jank] === 最大帧间隔 ${(worstGap.gap / 1000).toFixed(1)}ms（${worstGap.name}）@${clickTs ? Math.round((worstGap.to - clickTs) / 1000) : '?'}ms ===`);
    // 空档内所有主线程 slice，按开始时间
    const inside = events
      .filter((e) => e.ph === 'X' && typeof e.dur === 'number' && mainTids.includes(`${e.pid}:${e.tid}`))
      .filter((e) => e.ts + (e.dur || 0) > worstGap.from && e.ts < worstGap.to)
      .sort((a, b) => a.ts - b.ts);
    let sum = 0;
    for (const e of inside.slice(0, 40)) {
      sum += e.dur;
      console.log(`  +${((e.ts - worstGap.from) / 1000).toFixed(1).padStart(6)}ms  ${(e.dur / 1000).toFixed(1).padStart(6)}ms  ${e.name}`);
    }
    console.log(`  （共 ${inside.length} 个 slice，累计 ${(sum / 1000).toFixed(1)}ms）`);
  } else {
    console.log('\n[jank] 没找到帧事件，改用"点击后 200ms 窗口"分析');
  }

  // 3) 不依赖帧事件：直接看点击后 200ms 内，**所有进程/线程**上 >3ms 的 slice
  if (clickTs !== null) {
    const winFrom = clickTs;
    const winTo = clickTs + 200000;
    const busy = events
      .filter((e) => e.ph === 'X' && typeof e.dur === 'number' && e.dur > 3000)
      .filter((e) => e.ts + (e.dur || 0) > winFrom && e.ts < winTo)
      .sort((a, b) => b.dur - a.dur);
    const byThread = new Map();
    for (const e of busy) {
      const key = `${e.pid}:${e.tid}`;
      const cur = byThread.get(key) || { total: 0, count: 0, top: [] };
      cur.total += e.dur;
      cur.count += 1;
      if (cur.top.length < 3) cur.top.push(`${e.name} ${(e.dur / 1000).toFixed(1)}ms`);
      byThread.set(key, cur);
    }
    const rows = [...byThread.entries()]
      .map(([k, v]) => ({ k, ...v, name: threads.get(k) || k, proc: procNames.get(k.split(':')[0]) || '' }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);
    console.log('\n[jank] === 点击后 200ms 内最忙的线程（>3ms 的 slice）===');
    for (const r of rows) {
      console.log(`  ${(r.total / 1000).toFixed(0).padStart(6)}ms 共${String(r.count).padStart(3)}个  [${r.proc} / ${r.name}]  ${r.top.join(' | ')}`);
    }
  }

  if (worstGap) {
    // 同一空档里其它线程/进程在干什么（光栅、GPU）
    const others = events
      .filter((e) => e.ph === 'X' && typeof e.dur === 'number' && !mainTids.includes(`${e.pid}:${e.tid}`))
      .filter((e) => e.ts + (e.dur || 0) > worstGap.from && e.ts < worstGap.to && e.dur > 2000)
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 12);
    console.log('  其他线程（>2ms）:');
    for (const e of others) {
      const tname = threads.get(`${e.pid}:${e.tid}`) || `${e.pid}:${e.tid}`;
      console.log(`    ${(e.dur / 1000).toFixed(1).padStart(6)}ms  [${tname}] ${e.name}`);
    }
  }

  // 4) 最长的那条 GPU 主线程 slice 里到底在干什么
  const gpuKey = [...threads.entries()].find(([, n]) => n === 'CrGpuMain');
  if (gpuKey) {
    const [gk] = gpuKey;
    const gpuSlices = events
      .filter((e) => e.ph === 'X' && typeof e.dur === 'number' && `${e.pid}:${e.tid}` === gk)
      .filter((e) => clickTs === null || (e.ts + (e.dur || 0) > clickTs && e.ts < clickTs + 300000))
      .sort((a, b) => b.dur - a.dur);
    const top = gpuSlices[0];
    if (top) {
      console.log(`\n[jank] === 最长的 GPU 主线程 slice: ${top.name} ${(top.dur / 1000).toFixed(1)}ms ===`);
      const kids = events
        .filter((e) => e.ph === 'X' && typeof e.dur === 'number' && e !== top)
        .filter((e) => e.ts >= top.ts && e.ts + (e.dur || 0) <= top.ts + top.dur && e.dur > 500)
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 16);
      for (const e of kids) {
        console.log(`  ${(e.dur / 1000).toFixed(1).padStart(7)}ms  ${e.name}`);
      }
      if (top.args && top.args.data) {
        const s = JSON.stringify(top.args.data);
        console.log('  args:', s.length > 300 ? `${s.slice(0, 300)}…` : s);
      }
    }
  }

  console.log('\n[jank] trace 已存:', TRACE_OUT);
  client.close();
  child.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('[jank] failed:', e && e.message); process.exit(1); });
