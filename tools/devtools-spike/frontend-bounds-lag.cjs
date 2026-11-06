#!/usr/bin/env node
/**
 * 抽屉拖拽时「DevTools 前端视图」相对「占位 div」的滞后测量。
 *
 * 判据（两端都用 rAF 自采样，避免采样本身引入延迟）：
 *   shell 侧：`[data-devtools-host]` 的 getBoundingClientRect()（布局真相）
 *   front 侧：前端页面自己的 innerWidth/innerHeight（原生视图真相）
 *
 * 拖拽由脚本派发 pointerdown/move/up 驱动，每 16ms 一步。结束后把两条时间轴
 * 按 Date.now() 对齐（同一个 Chromium 实例，时钟一致），算每一帧的
 * `host.h - front.h`：
 *   - 拖拽中持续为正 = 视图落后布局（跟手延迟）
 *   - 拖拽结束后仍非 0 = 真正的错位（bounds 丢了/算错）
 *
 *   node tools/devtools-spike/frontend-bounds-lag.cjs
 *   BFB_DOCK=right node tools/devtools-spike/frontend-bounds-lag.cjs
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
const LOG = path.join(os.tmpdir(), 'bfb-lag.log');
const FIXTURE = path.join(os.tmpdir(), 'bfb-lag.html');
const DOCK = process.env.BFB_DOCK === 'right' ? 'right' : 'bottom';

fs.writeFileSync(FIXTURE, `<!doctype html><html><head><meta charset="utf-8"><title>lag</title>
<style>html,body{margin:0;background:#eef;font:13px sans-serif}</style></head>
<body><div style="padding:10px">LAG-FIXTURE</div></body></html>`);

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

const HOST_SAMPLER = `(() => {
  window.__bh = [];
  const loop = () => {
    const el = document.querySelector('[data-devtools-host]');
    if (el) {
      const r = el.getBoundingClientRect();
      window.__bh.push({ t: Date.now(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    }
    if (window.__bh.length < 6000) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return 'sampling';
})()`;

const FRONT_SAMPLER = `(() => {
  window.__bf = [];
  const loop = () => {
    window.__bf.push({ t: Date.now(), w: window.innerWidth, h: window.innerHeight });
    if (window.__bf.length < 6000) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return 'sampling';
})()`;

/** 拖拽：底部向上拉高 120px / 右侧向左拉宽 120px，每步 16ms。 */
function dragScript(dock, steps, delta) {
  return `(async () => {
  const handle = document.querySelector('[data-devtools-resize]');
  if (!handle) return 'no-handle';
  const r = handle.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2);
  const cy = Math.round(r.y + r.height / 2);
  const dock = ${JSON.stringify(dock)};
  handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true }));
  const step = ${delta} / ${steps};
  for (let i = 1; i <= ${steps}; i += 1) {
    const dx = dock === 'right' ? -step * i : 0;
    const dy = dock === 'bottom' ? -step * i : 0;
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: Math.round(cx + dx), clientY: Math.round(cy + dy), pointerId: 1, isPrimary: true }));
    await new Promise((res) => setTimeout(res, 16));
  }
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true }));
  return 'dragged';
})()`;
}

function analyze(hostSamples, frontSamples, label) {
  if (!hostSamples.length || !frontSamples.length) {
    console.log(`[lag] ${label}: 采样为空`, hostSamples.length, frontSamples.length);
    return;
  }
  const frontAt = (t) => {
    let lo = 0; let hi = frontSamples.length - 1; let ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frontSamples[mid].t <= t) { ans = frontSamples[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };
  const rows = [];
  for (const h of hostSamples) {
    const f = frontAt(h.t);
    if (f) rows.push({ t: h.t, hh: h.h, fh: f.h, hw: h.w, fw: f.w, dh: h.h - f.h, dw: h.w - f.w });
  }
  if (!rows.length) { console.log(`[lag] ${label}: 无法对齐`); return; }

  // 台阶法：host 的尺寸每跳一次算一个台阶，看 front 多久之后才到达同一尺寸。
  // 这比"逐帧差值"更接近手感——差值只说明某帧差多少，台阶滞后说明"跟手慢多久"。
  const steps = [];
  let prev = rows[0];
  for (const r of rows) {
    if (Math.abs(r.hh - prev.hh) > 1 || Math.abs(r.hw - prev.hw) > 1) {
      steps.push({ t: r.t, h: r.hh, w: r.hw });
      prev = r;
    }
  }
  const lags = [];
  for (const s of steps) {
    const hit = frontSamples.find((f) => f.t >= s.t && Math.abs(f.h - s.h) <= 1 && Math.abs(f.w - s.w) <= 2);
    if (hit) lags.push({ ms: hit.t - s.t, h: s.h });
  }
  lags.sort((a, b) => a.ms - b.ms);

  const abs = rows.map((r) => Math.abs(r.dh));
  const maxDev = Math.max(...abs);
  const meanDev = abs.reduce((a, b) => a + b, 0) / abs.length;
  const last = rows[rows.length - 1];

  console.log(`[lag] ${label}: 采样 ${rows.length} 帧，尺寸 ${rows[0].hw}x${rows[0].hh} → ${last.hw}x${last.hh}，台阶 ${steps.length} 次`);
  console.log(`[lag] ${label}: |host.h - front.h| 最大 ${maxDev}px、均值 ${meanDev.toFixed(1)}px`);
  if (lags.length) {
    const p = (q) => lags[Math.min(lags.length - 1, Math.floor(lags.length * q))].ms;
    console.log(`[lag] ${label}: 台阶滞后 中位 ${p(0.5)}ms / p90 ${p(0.9)}ms / 最大 ${lags[lags.length - 1].ms}ms（${lags.length} 次可测）`);
    console.log(`[lag] ${label}: 最慢三次 ${lags.slice(-3).reverse().map((l) => `${l.ms}ms@h${l.h}`).join(', ')}`);
  } else {
    console.log(`[lag] ${label}: 台阶滞后不可测（front 从未到达 host 尺寸）`);
  }
  console.log(`[lag] ${label}: 末帧 host=${last.hw}x${last.hh} front=${last.fw}x${last.fh} → ${last.dh === 0 && last.dw === 0 ? '已对齐' : '未对齐(错位)'}`);
  console.log(`[lag] ${label}: 逐帧 dh: ${rows.slice(0, 40).map((r) => r.dh).join(',')}`);
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
  if (!port) { console.error('[lag] 端口没发现'); process.exit(2); }

  const waitTarget = async (test, label, tries = 60) => {
    for (let i = 0; i < tries; i += 1) {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      const hit = (list || []).find(test);
      if (hit) return hit;
      await sleep(500);
    }
    console.error('[lag] 等不到', label);
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
  await sleep(3500);

  // 停靠位置
  if (DOCK === 'right') {
    for (let i = 0; i < 30; i += 1) {
      const state = await evaluate(client, `(() => {
        const btn = [].slice.call(document.querySelectorAll('button')).find((b) => (b.getAttribute('title') || b.textContent || '').indexOf('停靠到右侧') !== -1);
        if (!btn) return 'no-btn';
        btn.click(); return 'clicked';
      })()`);
      if (state === 'clicked') break;
      await sleep(300);
    }
    await sleep(1500);
  }

  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`);
    if (state === 'clicked') break;
    await sleep(500);
  }

  const front = await waitTarget((t) => /devtools_app\.html\?/.test(t.url || ''), 'frontend');
  if (!front) { client.close(); child.kill(); process.exit(2); }
  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;
  await sleep(8000);

  // 先让 host 稳定，再起采样
  await evaluate(client, HOST_SAMPLER);
  await evaluate(fc, FRONT_SAMPLER);
  await sleep(600);
  // 先往下缩 100px（离开高度上限，否则第一轮就被 clamp，测不到真实拖拽），再往上放回。
  const shrink = await evaluate(client, dragScript(DOCK, 25, -100), true);
  await sleep(700);
  const grow = await evaluate(client, dragScript(DOCK, 25, 100), true);
  console.log('[lag] drag:', shrink, grow);
  await sleep(1200);

  const hostSamples = await evaluate(client, 'JSON.stringify(window.__bh || [])');
  const frontSamples = await evaluate(fc, 'JSON.stringify(window.__bf || [])');
  let hs = []; let fss = [];
  try { hs = JSON.parse(hostSamples); } catch { /* ignore */ }
  try { fss = JSON.parse(frontSamples); } catch { /* ignore */ }
  analyze(hs, fss, DOCK);

  client.close();
  fc.close();
  child.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('[lag] failed:', e && e.message); process.exit(1); });
