/**
 * 帧级撕裂检测。
 *
 * 之前那版每次移动后 sleep 28ms 再采样，一帧（16ms）级的滞后会被掩盖。
 * 这版让两侧各自在 rAF 里逐帧记录 (时间戳, 高度)：
 *   shell 侧：抽屉上方"页面区"的 DOM 高度（布局真相）
 *   page  侧：被调试页面的 window.innerHeight（原生视图真相）
 * 然后按时间轴对齐，算出「页面比布局晚多少 ms / 多少帧」。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');
const LOG = path.join(os.tmpdir(), 'bfb-frames.log');
const FIXTURE = path.join(os.tmpdir(), 'bfb-frames.html');

fs.writeFileSync(FIXTURE, `<!doctype html><html><head><meta charset="utf-8"><title>frames</title>
<style>html,body{margin:0;background:#eef;font:13px sans-serif}</style></head>
<body><div style="padding:10px">FRAMES-FIXTURE</div></body></html>`);

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
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (typeof m.id === 'number' && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
  });
  const send = (method, params) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    return new Promise((r) => pending.set(i, r));
  };
  return { ready, send, close: () => ws.close() };
}

async function ev(client, expr) {
  const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0, 120);
  return r.result && r.result.result ? r.result.result.value : undefined;
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  await sleep(900);
  try { fs.unlinkSync(PORT_FILE); } catch { /* ignore */ }

  const out = fs.openSync(LOG, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  let port = 0;
  for (let i = 0; i < 60 && !port; i += 1) {
    await sleep(500);
    try {
      const p = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).split('\n')[0]);
      if (p > 0) { await getJson(`http://127.0.0.1:${p}/json/version`); port = p; }
    } catch { /* 等 */ }
  }
  if (!port) { console.error('端口没出现'); child.kill(); process.exit(2); }

  let shell = null;
  for (let i = 0; i < 50 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { console.error('外壳没出现'); child.kill(); process.exit(2); }

  const sh = cdp(shell.webSocketDebuggerUrl);
  await sh.ready;
  await sh.send('Runtime.enable');
  await sleep(2500);

  const fixtureUrl = 'file:///' + FIXTURE.replace(/\\/g, '/');
  for (let i = 0; i < 20; i += 1) {
    const r = await ev(sh, `(() => {
      const el = document.querySelector('.address-input');
      if (!el) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(fixtureUrl)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (r === 'submitted') break;
    await sleep(500);
  }

  let pageT = null;
  for (let i = 0; i < 40 && !pageT; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    pageT = (list || []).find((t) => /bfb-frames\.html/.test(t.url || ''));
    if (!pageT) await sleep(500);
  }
  if (!pageT) { console.error('页面 target 没出现'); child.kill(); process.exit(2); }

  const pg = cdp(pageT.webSocketDebuggerUrl);
  await pg.ready;
  await pg.send('Runtime.enable');
  await sleep(1200);

  await ev(sh, `(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (b) b.click(); return 1; })()`);
  await sleep(3000);

  // 两侧各装一个逐帧记录器（用 Date.now 以便跨进程对齐）
  await ev(sh, `(() => {
    window.__rec = [];
    const sep = document.querySelector('[role="separator"][aria-orientation="horizontal"]');
    window.__sep = sep;
    const area = sep.parentElement.previousElementSibling;
    (function loop() {
      window.__rec.push([Date.now(), Math.round(area.getBoundingClientRect().height)]);
      window.__raf = requestAnimationFrame(loop);
    })();
    return 'ok';
  })()`);
  await ev(pg, `(() => {
    window.__rec = [];
    (function loop() {
      window.__rec.push([Date.now(), window.innerHeight]);
      window.__raf = requestAnimationFrame(loop);
    })();
    return 'ok';
  })()`);
  await sleep(300);

  // 由探针自己拉起抓屏（前面的 taskkill 会杀掉其他 electron 进程）
  const grabber = (() => {
    const { spawn: sp } = require('child_process');
    const env2 = { ...process.env, BFB_GRAB_MS: '4500' };
    delete env2.ELECTRON_RUN_AS_NODE;
    const go = fs.openSync(path.join(os.tmpdir(), 'bfb-grab2.log'), 'w');
    return sp(ELECTRON, [path.join(__dirname, 'screen-grab-runner.cjs')], { cwd: APP_ROOT, stdio: ['ignore', go, go], env: env2 });
  })();
  console.log("[fr] grabber pid", grabber.pid);
  await sleep(600);
  console.log("[fr] drag window start", Date.now());
  // 快速拖拽：每 10ms 上移 8px，共 40 次（≈400ms）
  await ev(sh, `(() => {
    const sep = window.__sep;
    const r = sep.getBoundingClientRect();
    window.__dragY = Math.round(r.top + r.height / 2);
    sep.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientY: window.__dragY, pointerId: 1 }));
    return 1;
  })()`);
  for (let i = 0; i < 40; i += 1) {
    await ev(sh, `(() => { window.__dragY -= 8; window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientY: window.__dragY, pointerId: 1 })); return 1; })()`);
    await sleep(10);
  }
  await ev(sh, `(() => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientY: window.__dragY, pointerId: 1 })); return 1; })()`);
  console.log('[fr] drag window end', Date.now());
  await sleep(3800);
  try { grabber.kill(); } catch {}

  const shellRec = JSON.parse(await ev(sh, 'JSON.stringify(window.__rec)') || '[]');
  const pageRec = JSON.parse(await ev(pg, 'JSON.stringify(window.__rec)') || '[]');
  console.log('[fr] 采样帧数：shell =', shellRec.length, '| page =', pageRec.length);

  // 找 shell 侧每次高度变化，看 page 侧多久才跟上
  const lags = [];
  const detail = [];
  for (let i = 1; i < shellRec.length; i += 1) {
    const [t, h] = shellRec[i];
    const prev = shellRec[i - 1][1];
    if (h === prev) continue;
    // page 侧在该时刻之后第一次达到 h 的时间
    const hit = pageRec.find(([pt, ph]) => pt >= t && ph === h);
    if (hit) {
      const lag = hit[0] - t;
      lags.push(lag);
      if (detail.length < 10) detail.push({ t: h, lag });
    }
  }
  if (lags.length) {
    const sorted = [...lags].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log('[fr] 高度变化次数 =', lags.length);
    console.log('[fr] 页面跟上布局的延迟：中位 %dms | 最大 %dms | 最小 %dms | ≈ %d 帧',
      median, sorted[sorted.length - 1], sorted[0], Math.round(median / 16.7));
    console.log('[fr] 前 10 次明细（目标高度 → 延迟ms）:', JSON.stringify(detail));
  } else {
    console.log('[fr] 没抓到高度变化（拖拽可能没生效）');
  }

  // 结尾状态是否一致
  const lastShell = shellRec[shellRec.length - 1][1];
  const lastPage = pageRec[pageRec.length - 1][1];
  console.log('[fr] 结束时 shell=%d page=%d → 一致=%s', lastShell, lastPage, lastShell === lastPage);

  child.kill();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
