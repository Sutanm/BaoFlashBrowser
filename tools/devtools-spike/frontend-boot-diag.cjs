/**
 * 诊断：BrowserView 承载的前端为什么没启动起来（只有 40 个节点）。
 * 连它自己的 target，开 Runtime + Log，重载并收集异常。
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
const LOG = path.join(os.tmpdir(), 'bfb-fe-diag.log');
const FIXTURE = path.join(os.tmpdir(), 'bfb-fe-diag.html');

fs.writeFileSync(FIXTURE, '<!doctype html><html><head><meta charset="utf-8"><title>fediag</title></head><body><div id="mark">FE-DIAG</div></body></html>');

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

function cdp(url, onEvent) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method && onEvent) onEvent(m);
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
  if (r.result && r.result.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0, 150);
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
  await sleep(2000);

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
  await sleep(2000);

  await ev(sh, `(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (b) b.click(); return 1; })()`);
  await sleep(4000);

  const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const front = (list || []).find((t) => /devtools_app\.html/.test(t.url || ''));
  if (!front) { console.log('[diag] 没有前端 target'); child.kill(); process.exit(2); }

  const errors = [];
  const fc = cdp(front.webSocketDebuggerUrl, (m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      errors.push('EXC ' + String((d.exception && d.exception.description) || d.text || '').slice(0, 220));
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry || {};
      if (e.level === 'error') errors.push('LOG ' + String(e.text || '').slice(0, 200));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('CONSOLE ' + m.params.args.map((a) => String(a.value || a.description || '')).join(' ').slice(0, 200));
    }
  });
  await fc.ready;
  await fc.send('Runtime.enable');
  await fc.send('Log.enable');
  await fc.send('Page.enable');
  await fc.send('Page.reload', { ignoreCache: false });
  await sleep(6000);

  console.log('[diag] 前端状态:', await ev(fc, `JSON.stringify({
    title: document.title,
    ready: document.readyState,
    nodes: document.getElementsByTagName('*').length,
    w: window.innerWidth, h: window.innerHeight,
    bodyLen: document.body.innerHTML.length,
    head: document.body.innerHTML.replace(/\\s+/g, ' ').slice(0, 200),
  })`));
  console.log('[diag] 异常/错误数:', errors.length);
  errors.slice(0, 8).forEach((e) => console.log('   ' + e));

  const shot = await fc.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    const p = path.join(APP_ROOT, 'artifacts', 'devtools-embedded-view.png');
    fs.writeFileSync(p, Buffer.from(shot.result.data, 'base64'));
    console.log('[diag] 截图:', p);
  }

  fc.close();
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
