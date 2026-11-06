/**
 * B2 验收：去端口后的四项硬指标
 *   1) 前端从 file:// 加载（不再有静态服务端口）
 *   2) 隔离生效：拿不到 parent API、读不到磁盘、但自己的资源能读
 *   3) 设置跨启动保留（本次验证：显式选英文 → 重启仍是英文）
 *   4) 本地文件不受影响（默认 session 无拦截器）
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
const MAIN_LOG = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'logs', 'main.log');
const OUT_DIR = path.join(os.tmpdir(), 'bfb-b2');
const FIXTURE = path.join(OUT_DIR, 'fixture.html');
const LOCAL_PAGE = path.join(OUT_DIR, 'local-page.html');
const LOCAL_ASSET = path.join(OUT_DIR, 'local-asset.txt');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(FIXTURE, '<!doctype html><html><head><meta charset="utf-8"><title>b2fix</title></head><body><div id="mark">B2-FIXTURE</div></body></html>');
fs.writeFileSync(LOCAL_ASSET, 'LOCAL-ASSET-OK');
fs.writeFileSync(LOCAL_PAGE, `<!doctype html><html><head><meta charset="utf-8"><title>local</title></head>
<body><div id="v">LOCAL</div>
<script>
  fetch('./local-asset.txt').then(function (r) { return r.text(); })
    .then(function (t) { window.__asset = t; })
    .catch(function (e) { window.__asset = 'FAIL:' + e.message; });
</script></body></html>`);

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

async function ev(c, expr, awaitPromise) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: Boolean(awaitPromise) });
  if (r.result && r.result.exceptionDetails) return 'EXC';
  return r.result && r.result.result ? r.result.result.value : undefined;
}

async function boot() {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  await sleep(900);
  try { fs.unlinkSync(PORT_FILE); } catch { /* ignore */ }
  const logPath = path.join(os.tmpdir(), 'bfb-b2.log');
  const out = fs.openSync(logPath, 'w');
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
  if (!port) throw new Error('调试端口没出现');

  let shell = null;
  for (let i = 0; i < 50 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  const sh = cdp(shell.webSocketDebuggerUrl);
  await sh.ready;
  await sh.send('Runtime.enable');
  await sleep(2500);
  return { child, port, sh };
}

async function openDrawerOn(sh, url) {
  for (let i = 0; i < 15; i += 1) {
    const r = await ev(sh, `(() => {
      const el = document.querySelector('.address-input');
      if (!el) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(url)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (r === 'submitted') break;
    await sleep(500);
  }
  await sleep(2500);
  // 若停在 undocked，先关掉窗口回内嵌
  await ev(sh, `(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (b) b.click(); return 1; })()`);
  await sleep(3000);
}

function findFrontend(list) {
  return (list || []).find((t) => /devtools_app\.html/.test(t.url || ''));
}

(async () => {
  // ---------- 第一次启动：验隔离 + 写入显式英文 ----------
  const a = await boot();
  await openDrawerOn(a.sh, 'file:///' + FIXTURE.replace(/\\/g, '/'));
  let list = await getJson(`http://127.0.0.1:${a.port}/json/list`).catch(() => []);
  let front = findFrontend(list);
  if (!front) { console.log('[b2] 前端 target 缺失'); a.child.kill(); process.exit(2); }

  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;
  await fc.send('Runtime.enable');
  await sleep(2500);

  console.log('[b2] href =', await ev(fc, 'location.href.slice(0, 90)'));
  console.log('[b2] 隔离 =', await ev(fc, `(async () => {
    const out = {};
    out.origin = String(location.origin);
    out.parentApi = (() => { try { return typeof window.parent + '/' + typeof window.parent.electronAPI; } catch (e) { return 'THROW:' + e.name; } })();
    try { await fetch('file:///C:/Windows/win.ini').then(r => r.text()); out.disk = 'LEAK'; } catch (e) { out.disk = 'blocked'; }
    try {
      const r = await fetch('file:///' + ${JSON.stringify(path.join(APP_ROOT, 'dist', 'devtools-frontend', 'devtools_app.html').replace(/\\/g, '/'))});
      out.ownAsset = r.ok ? 'ok' : 'status=' + r.status;
    } catch (e) { out.ownAsset = 'blocked'; }
    return JSON.stringify(out);
  })()`, true));

  // 写入显式英文（模拟用户在设置里改语言）
  await ev(fc, `localStorage.setItem('language', JSON.stringify('en-US'))`);
  await sleep(9000);
  await fc.send('Page.reload');
  await sleep(6000);
  const uiEn = await ev(fc, `(document.body.innerText || '').includes('DevTools is docked to right') ? 'EN' : 'OTHER'`);
  console.log('[b2] 写入 en-US 后界面 =', uiEn);

  // 等 localStorage 落盘（Chromium 的提交是延迟的，别立刻杀进程）
  await sleep(12000);
  console.log('[b2] 落盘前自检 =', await ev(fc, "String(localStorage.getItem('language'))"));

  // 本地文件（默认 session）——同一次运行里换到本地页面验一次
  await fc.close();
  // 优雅退出（不带 /F）：否则 Chromium 来不及把 localStorage 刷盘，会误判成"设置未持久"
  try { spawn('taskkill', ['/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  await sleep(4000);
  try { a.child.kill(); } catch { /* ignore */ }
  await sleep(800);

  // ---------- 第二次启动：验持久 + 本地文件 ----------
  const b = await boot();
  await openDrawerOn(b.sh, 'file:///' + LOCAL_PAGE.replace(/\\/g, '/'));
  list = await getJson(`http://127.0.0.1:${b.port}/json/list`).catch(() => []);
  front = findFrontend(list);
  if (front) {
    const fc2 = cdp(front.webSocketDebuggerUrl);
    await fc2.ready;
    await fc2.send('Runtime.enable');
    await sleep(2500);
    console.log('[b2] 重启后界面 =', await ev(fc2, `(document.body.innerText || '').includes('DevTools is docked to right') ? 'EN（设置已持久）' : 'OTHER（未持久）'`));
    console.log('[b2] 重启后 href =', await ev(fc2, 'location.href.slice(0, 60)'));
    console.log('[b2] 重启后 stored =', await ev(fc2, "(() => { try { return String(localStorage.getItem('language')); } catch (e) { return 'DENIED'; } })()"));
    console.log('[b2] 重启后 text =', await ev(fc2, "(document.body.innerText || '').replace(/\s+/g,' ').slice(0, 60)"));
    fc2.close();
  }
  const localT = (list || []).find((t) => /local-page\.html/.test(t.url || ''));
  if (localT) {
    const lc = cdp(localT.webSocketDebuggerUrl);
    await lc.ready;
    await lc.send('Runtime.enable');
    await sleep(800);
    console.log('[b2] 本地页面（默认 session）=', await ev(lc, `JSON.stringify({ asset: String(window.__asset || ''),
      disk: 'n/a' })`));
    lc.close();
  } else {
    console.log('[b2] 本地页面 target 缺失');
  }

  // 日志证据
  await sleep(300);
  try {
    const text = fs.readFileSync(MAIN_LOG, 'utf8');
    const served = text.split('\n').filter((l) => l.includes('devtools frontend served')).slice(-1);
    const guard = text.split('\n').filter((l) => l.includes('file guard on')).slice(-1);
    console.log('[b2] 静态服务日志（应为空）=', served.length ? served[0].slice(0, 90) : '(无)');
    console.log('[b2] 白名单日志 =', guard.length ? guard[0].slice(0, 120) : '(无)');
  } catch { /* ignore */ }

  try { spawn('taskkill', ['/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  await sleep(2500);
  b.child.kill();
  process.exit(0);
})().catch((e) => { console.error('[b2] failed:', e.message); process.exit(1); });
