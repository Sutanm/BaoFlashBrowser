/**
 * 拖拽撕裂（割裂）实测。
 *
 * 判据：拖拽过程中反复采样两侧——
 *   shell 侧：抽屉上方「页面区」的 DOM 矩形高度（布局已经算完的真相）
 *   page  侧：被调试页面自己的 window.innerHeight（原生视图实际高度）
 * 两者之差在拖拽中持续偏离静止时的基准值，就是撕裂，偏离越大/持续越久越明显。
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
const LOG = path.join(os.tmpdir(), 'bfb-tear.log');
const FIXTURE = path.join(os.tmpdir(), 'bfb-tear.html');

fs.writeFileSync(FIXTURE, `<!doctype html><html><head><meta charset="utf-8"><title>tear</title>
<style>html,body{margin:0;background:#eef;font:13px sans-serif}</style></head>
<body><div style="padding:10px">TEAR-FIXTURE</div></body></html>`);

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
  if (r.result && r.result.exceptionDetails) return 'EXC';
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
    pageT = (list || []).find((t) => /bfb-tear\.html/.test(t.url || ''));
    if (!pageT) await sleep(500);
  }
  if (!pageT) { console.error('页面 target 没出现'); child.kill(); process.exit(2); }

  const pg = cdp(pageT.webSocketDebuggerUrl);
  await pg.ready;
  await pg.send('Runtime.enable');
  await sleep(1200);

  // 打开抽屉
  await ev(sh, `(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (b) b.click(); return 1; })()`);
  await sleep(3000);

  // 找到抽屉上方的页面区矩形（BrowserView 的目标区域就是它）
  const areaExpr = `(() => {
    const sep = document.querySelector('[role="separator"][aria-orientation="horizontal"]');
    if (!sep) return JSON.stringify({ error: 'no-separator' });
    const drawer = sep.parentElement;
    const dr = drawer.getBoundingClientRect();
    const area = drawer.previousElementSibling;
    const ar = area ? area.getBoundingClientRect() : null;
    return JSON.stringify({
      dpr: window.devicePixelRatio,
      drawerH: Math.round(dr.height),
      sepTop: Math.round(dr.top),
      areaH: ar ? Math.round(ar.height) : null,
      areaBottom: ar ? Math.round(ar.bottom) : null,
      // 浮点精度：亚像素误差才是 hairline 缝的来源
      areaHf: ar ? Number(ar.height.toFixed(3)) : null,
      areaYf: ar ? Number(ar.top.toFixed(3)) : null,
      areaBottomf: ar ? Number(ar.bottom.toFixed(3)) : null,
      drawerTopf: Number(dr.top.toFixed(3)),
      cssBorderTop: getComputedStyle(drawer).borderTopWidth,
    });
  })()`;

  const sampleShell = async () => {
    const raw = await ev(sh, areaExpr);
    try { return JSON.parse(raw); } catch { return { error: String(raw) }; }
  };
  // visualViewport 是浮点，innerHeight 会被取整——亚像素问题只能看前者
  const samplePage = () => ev(pg, `JSON.stringify({ i: window.innerHeight, v: Number((window.visualViewport ? window.visualViewport.height : window.innerHeight).toFixed(3)) })`)
    .then((raw) => { try { return JSON.parse(raw); } catch { return { i: raw, v: raw }; } });

  const restShell = await sampleShell();
  const restPage = await samplePage();
  console.log('[tear] 静止时 shell:', JSON.stringify(restShell));
  console.log('[tear] 静止时 page :', JSON.stringify(restPage));
  console.log('[tear] 亚像素：areaBottomf=%s vs drawerTopf=%s → 缝 %s css px（=%s 设备 px）',
    restShell.areaBottomf, restShell.drawerTopf,
    Number((restShell.drawerTopf - restShell.areaBottomf).toFixed(3)),
    Number(((restShell.drawerTopf - restShell.areaBottomf) * (restShell.dpr || 1)).toFixed(3)));
  console.log('[tear] 亚像素：areaHf=%s vs 页面 visualViewport=%s → 差 %s css px',
    restShell.areaHf, restPage.v, Number(((restShell.areaHf || 0) - (restPage.v || 0)).toFixed(3)));
  const base = (restShell.areaH || 0) - (restPage.i || 0);
  console.log('[tear] 静止基准差 (areaH - innerH) =', base, 'px');

  // 开始拖拽：pointerdown 在分隔条，然后连续 pointermove 向上
  const startY = restShell.sepTop + 3;
  await ev(sh, `(() => {
    const sep = document.querySelector('[role="separator"][aria-orientation="horizontal"]');
    const r = sep.getBoundingClientRect();
    window.__dragY = Math.round(r.top + r.height / 2);
    window.__startDragY = window.__dragY;
    sep.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientY: window.__dragY, pointerId: 1 }));
    return window.__dragY;
  })()`);

  const samples = [];
  for (let i = 0; i < 24; i += 1) {
    const t0 = Date.now();
    // 每次上移 12px（把抽屉拉高）
    await ev(sh, `(() => {
      window.__dragY -= 12;
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientY: window.__dragY, pointerId: 1 }));
      return window.__dragY;
    })()`);
    const s = await sampleShell();
    const p = await samplePage();
    samples.push({ t: Date.now() - t0, areaH: s.areaH, areaHf: s.areaHf, innerH: p.i, vv: p.v, diff: (s.areaH || 0) - (p.i || 0), diffF: Number(((s.areaHf || 0) - (p.v || 0)).toFixed(3)) });
    await sleep(28);
  }

  // 松手
  await ev(sh, `(() => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientY: window.__dragY, pointerId: 1 })); return 1; })()`);

  // 观察收敛
  const settle = [];
  for (let i = 0; i < 12; i += 1) {
    const s = await sampleShell();
    const p = await samplePage();
    settle.push({ ms: i * 40, diff: (s.areaH || 0) - (p.i || 0) });
    await sleep(40);
  }

  console.log('[tear] --- 拖拽过程（diff 应恒等于基准 %d，偏离即撕裂）---', base);
  console.log('    ' + samples.map((s) => `${s.diff - base}`).join(' '));
  const dev = samples.map((s) => Math.abs(s.diff - base));
  console.log('[tear] 拖拽中最大偏离 =', Math.max(...dev), 'px | 平均 =',
    Math.round((dev.reduce((a, b) => a + b, 0) / dev.length) * 10) / 10, 'px');
  console.log('[tear] 前 6 帧明细:', JSON.stringify(samples.slice(0, 6)));
  console.log('[tear] --- 松手后收敛（diff 偏离基准）---');
  console.log('    ' + settle.map((s) => `${s.diff - base}`).join(' '));

  child.kill();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
