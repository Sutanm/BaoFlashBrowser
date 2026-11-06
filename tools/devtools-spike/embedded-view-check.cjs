/**
 * 诊断：抽屉内嵌（bottom）时，前端视图到底有没有被创建、有没有加载成功。
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
const LOG = path.join(os.tmpdir(), 'bfb-embview.log');
const FIXTURE = path.join(os.tmpdir(), 'bfb-embview.html');

fs.writeFileSync(FIXTURE, '<!doctype html><html><head><meta charset="utf-8"><title>emb</title>'
  + '<style>html,body{margin:0;background:#dde;font:13px sans-serif}</style></head>'
  + '<body><div style="padding:10px">EMB-FIXTURE</div></body></html>');

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
  const sh = cdp(shell.webSocketDebuggerUrl);
  await sh.ready;
  await sh.send('Runtime.enable');
  await sleep(2500);

  // 强制回到底部停靠
  await ev(sh, "(() => { localStorage.setItem('devtoolbox.dock','bottom'); return 1; })()");
  await ev(sh, 'location.reload()');
  await sleep(4500);
  await sh.send('Runtime.enable');

  const fixtureUrl = 'file:///' + FIXTURE.replace(/\\/g, '/');
  for (let i = 0; i < 15; i += 1) {
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
  await sleep(2500);

  // 打开抽屉
  await ev(sh, `(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (b) b.click(); return 1; })()`);
  await sleep(4000);

  console.log('[emb] 外壳 dock =', await ev(sh, "document.querySelector('.workspace-main').getAttribute('data-dock')"));
  console.log('[emb] 直接调 IPC attach →', await ev(sh,
    "window.electronAPI.devtoolbox.attachDevToolsView('page').then(function(r){return JSON.stringify(r)}).catch(function(e){return 'REJECT:'+e.message})", true));

  await sleep(2500);
  const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  console.log('[emb] targets:');
  (list || []).forEach((t) => console.log('   ', t.type, '|', String(t.url).slice(0, 74)));

  const front = (list || []).find((t) => /devtools_app\.html/.test(t.url || ''));
  if (front) {
    const fc = cdp(front.webSocketDebuggerUrl);
    await fc.ready;
    await fc.send('Runtime.enable');
    await sleep(1500);
    console.log('[emb] 前端页面:', await ev(fc, `JSON.stringify({
      href: location.href.slice(0, 60),
      title: document.title,
      nodes: document.getElementsByTagName('*').length,
      textLen: (document.body.innerText || '').length,
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
      w: window.innerWidth, h: window.innerHeight,
    })`));
    fc.close();
  } else {
    console.log('[emb] 没有 devtools_app target —— 视图没创建或已销毁');
  }

  // 主进程日志里有没有加载失败
  await sleep(500);
  console.log('[emb] --- 主进程日志（最近 DevToolbox 行）---');
  try {
    const logText = fs.readFileSync(path.join(process.env.APPDATA || '', 'bao-flash-browser', 'logs', 'main.log'), 'utf8');
    logText.split('\n').filter((l) => l.includes('DevToolbox') || l.includes('内嵌')).slice(-8).forEach((l) => console.log('   ' + l.slice(0, 160)));
  } catch { /* ignore */ }

  child.kill();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
