#!/usr/bin/env node
/**
 * 侧边栏开合时，底部 DevTools（原生视图）是否逐帧跟随挤压。
 *
 * 侧边栏用 width/flex-basis 做 240ms 动画（styles.css 的 sidebar-panel-enter），
 * 期间工作区宽度每帧都在变。原生 BrowserView 只能靠 IPC 改 bounds，量的是：
 *   - shell 侧：占位 div 的宽度序列（布局真相）
 *   - front 侧：前端自己的 innerWidth 序列（原生视图真相）
 *
 * 判据：
 *   - front 的「不同宽度个数」应该接近 host 的台阶数；远小于 = 跳变
 *   - 两个相邻 front 宽度之间的最大差值 = 单帧最大跳变像素
 *
 *   node tools/devtools-spike/sidebar-squeeze-check.cjs
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
const LOG = path.join(os.tmpdir(), 'bfb-sidebar.log');
const FIXTURE = path.join(os.tmpdir(), 'bfb-sidebar.html');

const NO_DEVTOOLS = process.env.BFB_NO_DEVTOOLS === '1';

fs.writeFileSync(FIXTURE, `<!doctype html><html><head><meta charset="utf-8"><title>sidebar</title>
<style>html,body{margin:0;background:#eef;font:13px sans-serif}</style></head>
<body><div style="padding:10px">SIDEBAR-FIXTURE</div></body></html>`);

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

/** shell 侧自采样：原生视图占位（DevTools 占位 div 或页面区）宽度 + 抽屉宽度 + 侧边栏宽度 */
const SHELL_SAMPLER = `(() => {
  window.__bs = [];
  const loop = () => {
    const host = document.querySelector('[data-devtools-host]')
      || document.querySelector('#browserview-area')
      || document.querySelector('.workspace-view');
    const drawer = document.querySelector('[data-devtools-drawer]');
    const side = document.querySelector('.library-sidebar');
    window.__bs.push({
      t: Math.round(performance.now()),
      hw: host ? Math.round(host.getBoundingClientRect().width) : -1,
      dw: drawer ? Math.round(drawer.getBoundingClientRect().width) : -1,
      sw: side ? Math.round(side.getBoundingClientRect().width) : 0,
    });
    if (window.__bs.length < 4000) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return 'sampling';
})()`;

const FRONT_SAMPLER = `(() => {
  window.__bs = [];
  const loop = () => {
    window.__bs.push({ t: Math.round(performance.now()), w: window.innerWidth });
    if (window.__bs.length < 4000) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return 'sampling';
})()`;

/** 把序列压成「台阶」：连续相同值只留一个，记 (t, value) */
function steps(series, key) {
  const out = [];
  for (const row of series) {
    const v = row[key];
    if (!out.length || out[out.length - 1].v !== v) out.push({ t: row.t, v });
  }
  return out;
}

function report(hostSteps, frontSteps, label) {
  const h = hostSteps.filter((s) => s.v > 0);
  console.log(`[sidebar] ${label}: host 宽度台阶 ${h.length} 个 → ${h.map((s) => s.v).join(',')}`);
  console.log(`[sidebar] ${label}: front 宽度台阶 ${frontSteps.length} 个 → ${frontSteps.map((s) => s.v).join(',')}`);

  let maxJump = 0;
  for (let i = 1; i < frontSteps.length; i += 1) {
    maxJump = Math.max(maxJump, Math.abs(frontSteps[i].v - frontSteps[i - 1].v));
  }
  console.log(`[sidebar] ${label}: front 相邻台阶最大跳变 ${maxJump}px`);

  // 每个 host 台阶等到 front 到达同宽度需要多久
  const lags = [];
  for (const s of h) {
    const hit = frontSteps.find((f) => f.t >= s.t && Math.abs(f.v - s.v) <= 1);
    if (hit) lags.push({ ms: hit.t - s.t, v: s.v });
  }
  if (lags.length) {
    const sorted = lags.slice().sort((a, b) => a.ms - b.ms);
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].ms;
    console.log(`[sidebar] ${label}: 跟手滞后 中位 ${pick(0.5)}ms / p90 ${pick(0.9)}ms / 最大 ${sorted[sorted.length - 1].ms}ms（${lags.length}/${h.length} 个台阶可测）`);
  } else {
    console.log(`[sidebar] ${label}: 跟手滞后不可测（front 从未到过 host 的宽度）`);
  }

  const first = frontSteps[0];
  const last = frontSteps[frontSteps.length - 1];
  console.log(`[sidebar] ${label}: front ${first ? first.v : '-'} → ${last ? last.v : '-'}，末值 ${last && Math.abs(last.v - h[h.length - 1].v) <= 1 ? '已对齐' : '未对齐'}`);
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1200);

  const out = fs.openSync(LOG, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BAO_DEVTOOLS_PAGE_WS;
  delete env.BAO_DEVTOOLS_LEGACY_HTTP;
  delete env.BAO_DEVTOOLS_BRIDGE;
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
  if (!port) { console.error('[sidebar] 端口没发现'); process.exit(2); }

  const waitTarget = async (test, label, tries = 60) => {
    for (let i = 0; i < tries; i += 1) {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      const hit = (list || []).find(test);
      if (hit) return hit;
      await sleep(500);
    }
    console.error('[sidebar] 等不到', label);
    return null;
  };

  const shell = await waitTarget((t) => /dist\/renderer\/index\.html$/.test(t.url || ''), 'shell');
  if (!shell) { child.kill(); process.exit(2); }
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

  for (let i = 0; i < 40 && !NO_DEVTOOLS; i += 1) {
    const state = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`);
    if (state === 'clicked') break;
    await sleep(500);
  }

  // BFB_NO_DEVTOOLS=1 时改测「页面视图」，用来区分这是 DevTools 特有问题还是通用问题
  const front = NO_DEVTOOLS
    ? await waitTarget((t) => String(t.url || '').indexOf('bfb-sidebar.html') !== -1, '页面 target')
    : await waitTarget((t) => /devtools_app\.html\?/.test(t.url || ''), 'frontend');
  if (!front) { client.close(); child.kill(); process.exit(2); }
  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;
  await sleep(8000);

  // 空闲 rAF 间隔基线：用来区分后面的"掉帧"是环境噪音（窗口被遮挡会限帧）还是真卡
  const IDLE_SAMPLER = `new Promise((resolve) => {
    const ts = [];
    const loop = () => {
      ts.push(performance.now());
      if (ts.length < 60) { requestAnimationFrame(loop); return; }
      const gaps = [];
      for (let i = 1; i < ts.length; i += 1) gaps.push(Math.round(ts[i] - ts[i - 1]));
      gaps.sort((a, b) => a - b);
      resolve(JSON.stringify({ median: gaps[gaps.length >> 1], p90: gaps[Math.floor(gaps.length * 0.9)], max: gaps[gaps.length - 1] }));
    };
    requestAnimationFrame(loop);
  })`;
  console.log('[sidebar] 空闲 rAF 间隔:', await evaluate(client, IDLE_SAMPLER, true));

  // 打开侧边栏
  await evaluate(client, SHELL_SAMPLER);
  await evaluate(fc, FRONT_SAMPLER);
  await sleep(400);
  const clicked = await evaluate(client, `(() => {
    const b = document.querySelector('.sidebar-toggle-button');
    if (!b) return 'no-btn';
    window.__lt = [];
    try {
      new PerformanceObserver((l) => { l.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration))); }).observe({ entryTypes: ['longtask'] });
    } catch (e) { /* ignore */ }
    const t0 = performance.now();
    b.click();
    const t1 = performance.now();
    window.__clickSync = Math.round(t1 - t0);
    return 'clicked';
  })()`);
  await sleep(1200);
  console.log('[sidebar] 打开:', clicked);

  const shellOpen = JSON.parse(await evaluate(client, 'JSON.stringify(window.__bs || [])'));
  const frontOpen = JSON.parse(await evaluate(fc, 'JSON.stringify(window.__bs || [])'));
  console.log('[sidebar] 打开点击耗时(同步):' , await evaluate(client, 'window.__clickSync'), 'ms，长任务:', await evaluate(client, 'JSON.stringify(window.__lt || [])'));
  report(steps(shellOpen, 'hw'), steps(frontOpen, 'w'), '打开侧边栏');
  console.log('[sidebar] 打开时侧边栏自身宽度台阶: ' + steps(shellOpen, 'sw').map((s) => s.v + '@' + s.t + 'ms').join(','));

  // 关闭侧边栏
  await evaluate(client, SHELL_SAMPLER);
  await evaluate(fc, FRONT_SAMPLER);
  await sleep(400);
  const clicked2 = await evaluate(client, `(() => {
    const b = document.querySelector('.sidebar-toggle-button');
    if (!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  await sleep(1200);
  console.log('[sidebar] 关闭:', clicked2);

  const shellClose = JSON.parse(await evaluate(client, 'JSON.stringify(window.__bs || [])'));
  const frontClose = JSON.parse(await evaluate(fc, 'JSON.stringify(window.__bs || [])'));
  report(steps(shellClose, 'hw'), steps(frontClose, 'w'), '关闭侧边栏');
  const sideSteps = steps(shellClose, 'sw');
  console.log(`[sidebar] 侧边栏自身宽度台阶: ${sideSteps.map((s) => s.v).join(',')}`);

  // 第二次打开（收起动画早已结束、进入 collapsed）：用来区分"首绘成本只付一次"还是每次都付
  await evaluate(client, SHELL_SAMPLER);
  await sleep(2000);
  await evaluate(client, `(() => { document.querySelector('.sidebar-toggle-button').click(); return 'reopen'; })()`);
  await sleep(1200);
  const shellRapid = JSON.parse(await evaluate(client, 'JSON.stringify(window.__bs || [])'));
  const rapidSteps = steps(shellRapid, 'sw').filter((s) => s.v > 0);
  console.log('[sidebar] 第二次打开（collapsed→open）宽度台阶: ' + rapidSteps.map((s) => s.v + '@' + s.t + 'ms').join(','));
  let maxGapRapid = 0;
  for (let i = 1; i < rapidSteps.length; i += 1) maxGapRapid = Math.max(maxGapRapid, rapidSteps[i].t - rapidSteps[i - 1].t);
  console.log('[sidebar] 第二次打开最大相邻台阶间隔: ' + maxGapRapid + 'ms（对比首次打开 ~75ms）');

  // 最终状态快照（DOM 侧，原生视图不在里面但侧边栏是 DOM）
  await client.send('Page.enable').catch(() => null);
  const rects = await evaluate(client, `(() => {
    const side = document.querySelector('.library-sidebar');
    const inner = document.querySelector('.library-sidebar-inner');
    const r = (el) => (el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), vis: getComputedStyle(el).visibility } : null);
    return JSON.stringify({ side: r(side), inner: r(inner), text: side ? String(side.innerText || '').slice(0, 40) : null });
  })()`);
  console.log('[sidebar] 打开后侧栏几何:', rects);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot && shot.result) {
    const out = path.join(APP_ROOT, 'artifacts', 'sidebar-open.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('[sidebar] 截图:', out);
  }

  client.close();
  fc.close();
  child.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('[sidebar] failed:', e && e.message); process.exit(1); });
