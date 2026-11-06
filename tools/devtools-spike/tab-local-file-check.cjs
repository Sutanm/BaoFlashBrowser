/**
 * 驱动器：标签页（persist:）里的本地页面能做什么，外壳子帧能做什么。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNNER = path.join(__dirname, 'tab-local-file-runner.cjs');
const PORT_FILE = path.join(os.tmpdir(), 'bfb-tabtest', 'ud', 'DevToolsActivePort');
const LOG = path.join(os.tmpdir(), 'bfb-tabtest.log');
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
  const contexts = [];
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === 'Runtime.executionContextCreated' && m.params) contexts.push(m.params.context);
    if (typeof m.id === 'number' && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
  });
  const send = (method, params) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    return new Promise((r) => pending.set(i, r));
  };
  return { ready, send, contexts, close: () => ws.close() };
}

async function evalIn(client, ctxId, expr, awaitPromise) {
  const r = await client.send('Runtime.evaluate', { expression: expr, contextId: ctxId, returnByValue: true, awaitPromise: Boolean(awaitPromise) });
  const res = r.result || {};
  if (res.exceptionDetails) return 'EXC';
  return res.result ? res.result.value : undefined;
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  await sleep(800);
  try { fs.unlinkSync(PORT_FILE); } catch { /* ignore */ }
  const out = fs.openSync(LOG, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [RUNNER], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  let port = 0;
  for (let i = 0; i < 60 && !port; i += 1) {
    await sleep(500);
    try {
      const p = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).split('\n')[0]);
      if (p > 0) { await getJson(`http://127.0.0.1:${p}/json/version`); port = p; }
    } catch { /* 等 */ }
  }
  if (!port) { console.error('端口没出现'); child.kill(); process.exit(2); }
  await sleep(3000);

  const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const pageTarget = (list || []).find((t) => /page\.html/.test(t.url || ''));

  console.log('\n=== 标签页里的本地 HTML（persist: 分区） ===');
  if (pageTarget) {
    const c = cdp(pageTarget.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Runtime.enable');
    await sleep(1200);
    const ctx = c.contexts.find((x) => x.auxData && x.auxData.isDefault) || c.contexts[0];
    const r = await evalIn(c, ctx.id, `(async () => {
      const out = {};
      out.origin = String(location.origin);
      out.siblingScript = String(window.__gameJs || 'MISSING');
      try { const r1 = await fetch('./data.txt'); out.siblingFetch = 'ok:' + (await r1.text()); }
      catch (e) { out.siblingFetch = 'BLOCKED'; }
      try { const r2 = await fetch('../outside-tab.txt'); out.outsideFetch = 'ok:' + (await r2.text()); }
      catch (e) { out.outsideFetch = 'BLOCKED'; }
      out.storage = (() => { try { localStorage.setItem('t','1'); return 'ok'; } catch (e) { return 'THROW'; } })();
      return JSON.stringify(out);
    })()`, true);
    let o = {};
    try { o = JSON.parse(r); } catch { o = { raw: r }; }
    for (const [k, v] of Object.entries(o)) console.log(`    ${k.padEnd(16)} = ${v}`);
    c.close();
  } else {
    console.log('    没找到本地页面 target');
  }

  child.kill();
  await sleep(400);
  const text = fs.readFileSync(LOG, 'utf8');
  console.log('\n=== runner 日志（拦截器只该看到 app 目录） ===');
  console.log(text.split('\n').filter((l) => l.indexOf('[tab]') !== -1).map((l) => '   ' + l).slice(0, 30).join('\n'));
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
