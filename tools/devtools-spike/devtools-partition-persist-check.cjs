/**
 * 验证前端分区的 localStorage 是否跨启动保留（在真实应用里）。
 * 用非默认语言值（zh）+ 一个中性探针键，避开"等于默认值被剪掉"的干扰。
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
const FIXTURE = path.join(os.tmpdir(), 'bfb-persist.html');

fs.writeFileSync(FIXTURE, '<!doctype html><html><head><meta charset="utf-8"><title>persist</title></head><body>p</body></html>');

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

async function ev(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return 'EXC';
  return r.result && r.result.result ? r.result.result.value : undefined;
}

async function launch() {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  await sleep(900);
  try { fs.unlinkSync(PORT_FILE); } catch { /* ignore */ }
  const out = fs.openSync(path.join(os.tmpdir(), 'bfb-persist.log'), 'w');
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
  if (!port) throw new Error('无端口');
  let shell = null;
  for (let i = 0; i < 50 && !shell; i += 1) {
    const l = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (l || []).find((t) => /dist\/renderer\/index\.html/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  const sh = cdp(shell.webSocketDebuggerUrl);
  await sh.ready;
  await sh.send('Runtime.enable');
  await sleep(2200);

  for (let i = 0; i < 15; i += 1) {
    const r = await ev(sh, `(() => {
      const el = document.querySelector('.address-input');
      if (!el) return 'no';
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(el, ${JSON.stringify('file:///' + FIXTURE.replace(/\\/g, '/'))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return 'ok';
    })()`);
    if (r === 'ok') break;
    await sleep(500);
  }
  await sleep(2000);
  await ev(sh, `(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (b) b.click(); return 1; })()`);
  await sleep(3500);

  const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const front = (list || []).find((t) => /devtools_app\.html/.test(t.url || ''));
  if (!front) throw new Error('无前端 target');
  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;
  await fc.send('Runtime.enable');
  await sleep(2000);
  return { child, fc, port };
}

(async () => {
  // --- 第一轮：写入 ---
  const a = await launch();
  console.log('[p] 写入前 keys =', await ev(a.fc, "Object.keys(localStorage).length + ' | ' + Object.keys(localStorage).slice(0,6).join(',')"));
  await ev(a.fc, `localStorage.setItem('language', JSON.stringify('zh')); localStorage.setItem('bfb-probe','v1'); 'ok'`);
  console.log('[p] 写入后 language =', await ev(a.fc, "String(localStorage.getItem('language'))"), '| probe =', await ev(a.fc, "String(localStorage.getItem('bfb-probe'))"));
  await a.fc.send('Page.reload');
  await sleep(6000);
  console.log('[p] reload 后 language =', await ev(a.fc, "String(localStorage.getItem('language'))"));
  await sleep(3000);
  a.fc.close();
  // 优雅退出：taskkill 不带 /F 会发 WM_CLOSE，让 Chromium 正常 flush 存储
  try { spawn('taskkill', ['/IM', 'electron.exe'], { stdio: 'ignore' }); } catch {}
  await sleep(4000);
  try { a.child.kill(); } catch {}
  await sleep(1500);

  // --- 第二轮：读回 ---
  const b = await launch();
  console.log('[p] 重启后 language =', await ev(b.fc, "String(localStorage.getItem('language'))"));
  console.log('[p] 重启后 probe   =', await ev(b.fc, "String(localStorage.getItem('bfb-probe'))"));
  console.log('[p] 重启后 keys    =', await ev(b.fc, "Object.keys(localStorage).length + ' | ' + Object.keys(localStorage).slice(0,8).join(',')"));
  b.fc.close();
  b.child.kill();
  process.exit(0);
})().catch((e) => { console.error('[p] failed:', e.message); process.exit(1); });
