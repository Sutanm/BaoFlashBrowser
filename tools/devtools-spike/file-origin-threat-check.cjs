/**
 * 驱动器：枚举外壳页里的所有执行上下文，从 file:// iframe 与 http://127.0.0.1 iframe
 * 内部各跑一遍越界探测，输出可比对的表格。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNNER = path.join(__dirname, 'file-origin-threat-runner.cjs');
const PORT_FILE = path.join(os.tmpdir(), 'bfb-threat', 'ud', 'DevToolsActivePort');
const LOG = path.join(os.tmpdir(), 'bfb-threat.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
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
  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === 'Runtime.executionContextCreated' && m.params) contexts.push(m.params.context);
    if (typeof m.id === 'number' && pending.has(m.id)) {
      const resolve = pending.get(m.id);
      pending.delete(m.id);
      resolve(m);
    }
  });
  const send = (method, params) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    return new Promise((resolve) => pending.set(i, resolve));
  };
  return { ws, ready, send, contexts, close: () => ws.close() };
}

/** 在指定执行上下文里求值；awaitPromise 支持 async 表达式。 */
async function evalIn(client, contextId, expression, awaitPromise) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: Boolean(awaitPromise),
  });
  if (r.error) return 'CDP-ERR:' + r.error.message;
  const res = r.result || {};
  if (res.exceptionDetails) {
    const ex = res.exceptionDetails.exception || {};
    return 'EXC:' + (ex.description || res.exceptionDetails.text || '?').toString().slice(0, 90);
  }
  return res.result ? res.result.value : undefined;
}

const SYNC_TESTS = `(() => {
  const out = {};
  try { out.parentApi = typeof parent.electronAPI; } catch (e) { out.parentApi = 'THROW:' + e.name; }
  try { out.apiMarker = parent.electronAPI ? String(parent.electronAPI.marker) : 'n/a'; } catch (e) { out.apiMarker = 'THROW:' + e.name; }
  try { out.parentTitle = String(parent.document.title); } catch (e) { out.parentTitle = 'THROW:' + e.name; }
  try {
    const keys = Object.keys(parent.localStorage);
    out.parentStorage = keys.length + ' keys / token=' + String(parent.localStorage.getItem('shell-token'));
  } catch (e) { out.parentStorage = 'THROW:' + e.name; }
  try { localStorage.setItem('probe-write', '1'); out.ownStorage = 'ok'; } catch (e) { out.ownStorage = 'THROW:' + e.name; }
  try { out.origin = location.origin; } catch (e) { out.origin = '?'; }
  return JSON.stringify(out);
})()`;

const ASYNC_TESTS = `(async () => {
  const out = {};
  try { const r = await fetch('file:///C:/Windows/win.ini'); out.fetchWinIni = (await r.text()).trim().slice(0, 24); }
  catch (e) { out.fetchWinIni = 'BLOCKED:' + String(e.message).slice(0, 48); }
  try { const r = await fetch('../bfb-threat-outside.txt'); out.fetchEscape = (await r.text()).trim().slice(0, 24); }
  catch (e) { out.fetchEscape = 'BLOCKED:' + String(e.message).slice(0, 48); }
  try {
    const x = new XMLHttpRequest();
    x.open('GET', 'file:///C:/Windows/win.ini', false);
    x.send();
    out.xhrWinIni = String(x.responseText || '').replace(/\\s+/g, ' ').trim().slice(0, 24);
  } catch (e) { out.xhrWinIni = 'BLOCKED:' + String(e.message).slice(0, 48); }
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
  console.log('[threat] electron pid', child.pid, '| log', LOG);

  let port = 0;
  for (let i = 0; i < 60 && !port; i += 1) {
    await sleep(500);
    try {
      const p = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).split('\n')[0]);
      if (p > 0) { await getJson(`http://127.0.0.1:${p}/json/version`); port = p; }
    } catch { /* 还没写出来 */ }
  }
  if (!port) { console.error('[threat] 端口没出现'); child.kill(); process.exit(2); }

  let shell = null;
  for (let i = 0; i < 40 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /shell\.html/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { console.error('[threat] 外壳页没出现'); child.kill(); process.exit(2); }
  console.log('[threat] shell:', shell.url.slice(0, 60));

  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await sleep(3000); // 等两个 iframe 都加载完

  // 认帧：按 executionContext 的 origin + 文档特征区分
  const frames = [];
  for (const ctx of client.contexts) {
    if (!ctx.auxData || !ctx.auxData.isDefault) continue;
    const href = await evalIn(client, ctx.id, 'String(location.href)');
    const isShell = /shell\.html/.test(String(href));
    frames.push({ id: ctx.id, origin: ctx.origin, href: String(href), isShell });
  }
  console.log('[threat] frames:');
  frames.forEach((f) => console.log('   ', f.isShell ? 'SHELL' : 'IFRAME', '|', f.origin, '|', f.href.slice(0, 60)));

  for (const f of frames.filter((x) => !x.isShell)) {
    const label = /127\.0\.0\.1/.test(f.href) ? 'http-ifram' : 'file-ifram';
    console.log(`\n=== ${label} (${f.origin}) ===`);
    const sync = await evalIn(client, f.id, SYNC_TESTS);
    const async_ = await evalIn(client, f.id, ASYNC_TESTS, true);
    let s = {}; let a = {};
    try { s = JSON.parse(sync); } catch { s = { raw: sync }; }
    try { a = JSON.parse(async_); } catch { a = { raw: async_ }; }
    for (const [k, v] of Object.entries({ ...s, ...a })) console.log(`   ${k.padEnd(14)} = ${v}`);
  }

  // http://127.0.0.1 的 iframe 是跨源 → OOPIF（独立 target），外壳进程里读不到它的上下文，
  // 这本身就是跨源隔离的证据。单独连它自己的 target 跑同一套探测。
  const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const httpFrame = (list || []).find((t) => /127\.0\.0\.1/.test(t.url || '') && /probe\.html/.test(t.url || ''));
  if (httpFrame) {
    console.log(`\n=== http-ifram (${httpFrame.type}) ===`);
    const hc = cdp(httpFrame.webSocketDebuggerUrl);
    await hc.ready;
    await hc.send('Runtime.enable');
    await sleep(1200);
    const ctx = hc.contexts.find((c) => c.auxData && c.auxData.isDefault) || hc.contexts[0];
    const sync = await evalIn(hc, ctx.id, SYNC_TESTS);
    const async_ = await evalIn(hc, ctx.id, ASYNC_TESTS, true);
    let s = {}; let a = {};
    try { s = JSON.parse(sync); } catch { s = { raw: sync }; }
    try { a = JSON.parse(async_); } catch { a = { raw: async_ }; }
    for (const [k, v] of Object.entries({ ...s, ...a })) console.log(`   ${k.padEnd(14)} = ${v}`);
    hc.close();
  } else {
    console.log('\n=== http-ifram: 没找到独立 target（异常） ===');
  }

  // 决定性一组：从 file:// 子帧读真实的敏感文件（密码库/密钥/Cookie/应用源码）
  const SECRET_PATHS = [
    path.join(process.env.APPDATA || '', 'bao-flash-browser', 'password-store.json'),
    path.join(process.env.APPDATA || '', 'bao-flash-browser', 'password-autofill-key.json'),
    path.join(process.env.APPDATA || '', 'bao-flash-browser', 'Cookies'),
    path.join(process.env.APPDATA || '', 'bao-flash-browser', 'userscripts.json'),
    path.join(APP_ROOT, 'package.json'),
  ];
  const fileFrame = frames.find((x) => !x.isShell && /^file:/.test(String(x.origin)));
  if (fileFrame) {
    console.log('\n=== 从 file:// 子帧读真实敏感文件 ===');
    const expr = `(async () => {
      const paths = ${JSON.stringify(SECRET_PATHS)};
      const out = [];
      for (const p of paths) {
        const label = p.split(/[\\\\/]/).pop();
        try {
          const r = await fetch('file:///' + p.replace(/\\\\/g, '/'));
          const t = await r.text();
          out.push(label + '  → 读到 ' + t.length + ' 字符 | ' + t.replace(/\\s+/g, ' ').slice(0, 46));
        } catch (e) {
          out.push(label + '  → BLOCKED:' + String(e.message).slice(0, 40));
        }
      }
      return out.join('\\n');
    })()`;
    const r = await evalIn(client, fileFrame.id, expr, true);
    console.log(String(r).split('\n').map((l) => '   ' + l).join('\n'));
  }

  child.kill();
  process.exit(0);
})().catch((e) => { console.error('[threat] failed:', e.message); process.exit(1); });
