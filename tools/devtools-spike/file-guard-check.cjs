/**
 * 驱动器：验证白名单拦截后，file:// 子帧能读到什么、读不到什么。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNNER = path.join(__dirname, 'file-guard-runner.cjs');
const PORT_FILE = path.join(os.tmpdir(), 'bfb-guard', 'ud', 'DevToolsActivePort');
const LOG = path.join(os.tmpdir(), 'bfb-guard.log');

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
  const contexts = [];
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === 'Runtime.executionContextCreated' && m.params) contexts.push(m.params.context);
    if (typeof m.id === 'number' && pending.has(m.id)) {
      const r = pending.get(m.id);
      pending.delete(m.id);
      r(m);
    }
  });
  const send = (method, params) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    return new Promise((r) => pending.set(i, r));
  };
  return { ready, send, contexts, close: () => ws.close() };
}

async function evalIn(client, ctxId, expr, awaitPromise) {
  const r = await client.send('Runtime.evaluate', {
    expression: expr, contextId: ctxId, returnByValue: true, awaitPromise: Boolean(awaitPromise),
  });
  if (r.error) return 'CDP-ERR:' + r.error.message;
  const res = r.result || {};
  if (res.exceptionDetails) return 'EXC:' + String((res.exceptionDetails.exception || {}).description || '').slice(0, 80);
  return res.result ? res.result.value : undefined;
}

const APPDATA = process.env.APPDATA || '';
const SECRETS = [
  path.join(APPDATA, 'bao-flash-browser', 'password-store.json'),
  path.join(APPDATA, 'bao-flash-browser', 'password-autofill-key.json'),
];
const OUTSIDE_TXT = path.join(os.tmpdir(), 'bfb-guard', 'outside.txt');

const BATTERY = `(async () => {
  const out = {};
  out.ownAsset = String(window.__assetLoaded || 'MISSING');
  out.outsideScriptLeaked = String(window.__outsideLoaded || 'blocked');
  out.parentApi = typeof parent.electronAPI;
  try { const r = await fetch('./asset.js'); out.ownFetch = 'ok(' + (await r.text()).length + ')'; }
  catch (e) { out.ownFetch = 'BLOCKED:' + String(e.message).slice(0, 40); }
  for (const [k, u] of ${JSON.stringify([['outsideTxt', OUTSIDE_TXT], ['winIni', 'C:\\\\Windows\\\\win.ini'], ['passwordStore', SECRETS[0]], ['passwordKey', SECRETS[1]]])}) {
    try {
      const r = await fetch('file:///' + u.replace(/\\\\/g, '/'));
      const t = await r.text();
      out[k] = 'LEAK(' + t.length + '):' + t.replace(/\\s+/g, ' ').slice(0, 26);
    } catch (e) { out[k] = 'blocked'; }
  }
  return JSON.stringify(out);
})()`;

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

  let shell = null;
  for (let i = 0; i < 40 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /shell\.html/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { console.error('外壳没出现'); child.kill(); process.exit(2); }

  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await sleep(2500);

  const frames = [];
  for (const ctx of client.contexts) {
    if (!ctx.auxData || !ctx.auxData.isDefault) continue;
    const href = String(await evalIn(client, ctx.id, 'String(location.href)'));
    frames.push({ id: ctx.id, href });
  }
  const shellFrame = frames.find((f) => /shell\.html/.test(f.href));
  const probeFrame = frames.find((f) => /probe\.html/.test(f.href));

  console.log('\n=== 外壳自己（白名单内） ===');
  if (shellFrame) {
    const r = await evalIn(client, shellFrame.id, `JSON.stringify({
      title: document.title,
      nodes: document.getElementsByTagName('*').length,
      outsideScript: String(window.__outsideLoaded || 'blocked'),
      storage: (() => { try { return localStorage.getItem('shell-token'); } catch (e) { return 'THROW'; } })(),
    })`);
    console.log('   ', r);
  }

  console.log('\n=== file:// 子帧（白名单生效后） ===');
  if (probeFrame) {
    const r = await evalIn(client, probeFrame.id, BATTERY, true);
    let o = {};
    try { o = JSON.parse(r); } catch { o = { raw: r }; }
    for (const [k, v] of Object.entries(o)) console.log(`    ${k.padEnd(20)} = ${v}`);
  } else {
    console.log('    子帧没找到（可能被拦截器拦掉了 index）');
  }

  console.log('\n=== 第二层：IPC 来源帧校验 ===');
  if (shellFrame) {
    const r = await evalIn(client, shellFrame.id,
      `window.electronAPI.ping().then(function (v) { return 'main-frame call → ' + JSON.stringify(v); })`, true);
    console.log('    主帧自己调用: ', r);
  }
  if (probeFrame) {
    const r = await evalIn(client, probeFrame.id,
      `parent.electronAPI.ping().then(function (v) { return 'iframe call → ' + JSON.stringify(v); })
        .catch(function (e) { return 'iframe call → rejected: ' + e.message; })`, true);
    console.log('    子帧越权调用: ', r);
  }

  child.kill();
  await sleep(300);
  const logText = fs.readFileSync(LOG, 'utf8');
  console.log('\n=== 拦截器日志 ===');
  console.log(logText.split('\n').filter((l) => l.indexOf('[guard]') !== -1).slice(0, 24).join('\n'));
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
