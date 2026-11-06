/**
 * 「挤压 vs 裁剪」实测。
 *
 * 判据：抽屉打开后，被调试页面自己的 window.innerHeight 有没有变小。
 *   变小   → 页面视口真的变矮了（挤压，页面会 reflow）
 *   不变   → 页面视口没变，只是底部被抽屉盖住（裁剪/遮挡）
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
const LOG = path.join(os.tmpdir(), 'bfb-squeeze.log');
const FIXTURE = path.join(os.tmpdir(), 'bfb-squeeze.html');

fs.writeFileSync(FIXTURE, `<!doctype html>
<html><head><meta charset="utf-8"><title>squeeze-fixture</title>
<style>html,body{margin:0;font:13px sans-serif}
#top{padding:12px;background:#eef}
#bottom{position:fixed;left:0;bottom:0;right:0;height:40px;background:#fdd;text-align:center;line-height:40px}
#tall{height:2000px;background:linear-gradient(#fff,#ccc)}</style></head>
<body><div id="top">TOP-MARKER</div><div id="tall"></div>
<div id="bottom">BOTTOM-MARKER</div></body></html>`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

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

  const shellMetrics = () => ev(sh, `(() => {
    const area = document.querySelector('[data-bv-area]') || null;
    return JSON.stringify({
      win: { w: window.innerWidth, h: window.innerHeight },
      areaRect: area ? (function(r){return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};})(area.getBoundingClientRect()) : null,
    });
  })()`);

  // 导航到 fixture
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

  // 等页面 target
  let pageT = null;
  for (let i = 0; i < 40 && !pageT; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    pageT = (list || []).find((t) => /bfb-squeeze\.html/.test(t.url || ''));
    if (!pageT) await sleep(500);
  }
  if (!pageT) { console.error('页面 target 没出现'); child.kill(); process.exit(2); }

  const pg = cdp(pageT.webSocketDebuggerUrl);
  await pg.ready;
  await pg.send('Runtime.enable');
  await sleep(1500);

  const pageMetrics = () => ev(pg, `JSON.stringify({
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    scrollH: document.documentElement.scrollHeight,
    bottomVisible: (function () {
      const el = document.getElementById('bottom');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), inViewport: r.bottom <= window.innerHeight + 1 };
    })(),
  })`);

  const before = await pageMetrics();
  const shellBefore = await shellMetrics();

  // 打开抽屉
  await ev(sh, `(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (b) b.click(); return 'clicked'; })()`);
  await sleep(3500);

  const after = await pageMetrics();
  const shellAfter = await shellMetrics();

  console.log('[sq] --- 抽屉打开前 ---');
  console.log('[sq]   页面:', before);
  console.log('[sq]   外壳:', shellBefore);
  console.log('[sq] --- 抽屉打开后 ---');
  console.log('[sq]   页面:', after);
  console.log('[sq]   外壳:', shellAfter);

  const b = JSON.parse(before || '{}');
  const a = JSON.parse(after || '{}');
  console.log('[sq] 页面视口高度变化 =', (a.innerH || 0) - (b.innerH || 0), 'px');
  console.log('[sq] 结论:', (a.innerH || 0) < (b.innerH || 0) ? '挤压（视口真的变矮，页面会 reflow）' : '裁剪/遮挡（视口没变）');

  child.kill();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
