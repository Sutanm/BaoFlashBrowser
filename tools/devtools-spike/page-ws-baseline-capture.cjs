#!/usr/bin/env node
/**
 * S14：page-ws 真实基线抓取——用 ws 代理夹在 M97 前端与真实 CDP 端点之间，
 * 录下「page-ws 模式下前端到底发什么、收到什么（带不带 sessionId）」。
 *
 * 目的：桥模式与 page-ws 的所有对比此前都是推理；这里拿硬数据当标尺。
 *
 *   node tools/devtools-spike/page-ws-baseline-capture.cjs
 *
 * 输出：
 *   [s14] flow       前 60 条消息（cmd / resp / evt，含 sessionId 前缀）
 *   [s14] summary    各 domain 命令计数、事件是否带 sessionId、有无 Target.* 命令
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ACTIVE_PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

function startFixture() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>s14-fixture</title></head><body><div id="mark">BASELINE</div><p class="deep">inner</p></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function wsClient(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = [];
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e.resolve(msg); return; }
    events.push(msg);
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    events,
    send(method, params = {}) {
      const i = ++id;
      socket.send(JSON.stringify({ id: i, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { const e = pending.get(i); if (e) { pending.delete(i); resolve({ error: { message: 'timeout' } }); } }, 12000);
        pending.set(i, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expr, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    return `EXC ${(d.exception && d.exception.description) || d.text}`;
  }
  return r && r.result && r.result.result && r.result.result.value;
}

/**
 * ws 代理：前端 → 代理 → 真实 CDP 端点，双向记录。
 * 只记录 method / id / sessionId 前缀，不落 params（避免大对象）；
 * 但 DOM/Parget 相关方法额外记关键参数（这是本轮要对比的重点）。
 */
function summarise(m) {
  const p = m.params || {};
  const isResp = typeof m.id === 'number' && !m.method;
  // 响应与请求的摘要不同，必须先判别（否则响应会被当成请求摘要打印）。
  if (isResp) {
    const r = m.result || {};
    const root = r.root;
    if (root && root.nodeName) return `root=${root.nodeName} kids=${root.childNodeCount} inline=${(root.children || []).length} url=${String(root.documentURL || '').slice(0, 30)}`;
    const ti = r.targetInfo;
    if (ti) return `type=${ti.type} attached=${ti.attached} url=${String(ti.url || '').slice(0, 30)}`;
    return undefined;
  }
  if (m.method === 'DOM.getDocument') return `depth=${p.depth} pierce=${p.pierce}`;
  if (m.method === 'DOM.requestChildNodes') return `nodeId=${p.nodeId} depth=${p.depth}`;
  if (m.method === 'DOM.setChildNodes') return `parentId=${p.parentId} n=${(p.nodes || []).length}`;
  if (m.method === 'Target.setAutoAttach') return `autoAttach=${p.autoAttach} flatten=${p.flatten} wait=${p.waitForDebuggerOnStart}`;
  if (m.method === 'Target.setDiscoverTargets') return `discover=${p.discover}`;
  if (m.method === 'Target.targetCreated') return `type=${p.targetInfo && p.targetInfo.type} attached=${p.targetInfo && p.targetInfo.attached} url=${String(p.targetInfo && p.targetInfo.url).slice(0, 30)}`;
  if (m.method === 'Target.attachedToTarget') return `sid=${String(p.sessionId || '').slice(0, 6)} waiting=${p.waitingForDebugger}`;
  return undefined;
}

function startProxy(targetWsUrl) {
  const log = [];
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (client) => {
    const upstream = new WebSocket(targetWsUrl, { perMessageDeflate: false });
    const queue = [];
    upstream.on('open', () => { while (queue.length) upstream.send(queue.shift()); });
    client.on('message', (raw) => {
      const text = raw.toString();
      let m; try { m = JSON.parse(text); } catch { return; }
      log.push({ dir: 'out', method: m.method || ('#resp:' + m.id), id: m.id, sid: m.sessionId, extra: summarise(m) });
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else queue.push(text);
    });
    upstream.on('message', (raw) => {
      const text = raw.toString();
      let m; try { m = JSON.parse(text); } catch { return; }
      const isResp = typeof m.id === 'number' && !m.method;
      log.push({
        dir: 'in',
        method: m.method || (isResp ? '#resp:' + m.id : '?'),
        id: m.id,
        sid: m.sessionId,
        err: m.error ? (m.error.message || 'err') : undefined,
        extra: (() => {
          if (!isResp) return summarise(m);
          // 响应体：DOM.getDocument 的树规模是判断「内联返回」还是「懒加载」的关键
          const root = m.result && m.result.root;
          if (root && root.nodeName) return `root=${root.nodeName} kids=${root.childNodeCount} inline=${(root.children || []).length} url=${String(root.documentURL || '').slice(0, 30)}`;
          const ti = m.result && m.result.targetInfo;
          if (ti) return `type=${ti.type} attached=${ti.attached} url=${String(ti.url || '').slice(0, 30)}`;
          return undefined;
        })(),
      });
      if (client.readyState === WebSocket.OPEN) client.send(text);
    });
    const closeBoth = () => {
      try { client.close(); } catch { /* ignore */ }
      try { upstream.close(); } catch { /* ignore */ }
    };
    client.on('close', closeBoth);
    upstream.on('close', closeBoth);
    client.on('error', closeBoth);
    upstream.on('error', closeBoth);
  });
  return new Promise((resolve) => {
    wss.on('listening', () => resolve({ wss, port: wss.address().port, log }));
  });
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const { server: fixtureServer, port: fixturePort } = await startFixture();
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

  const logPath = path.join(os.tmpdir(), 'bfb-s14.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.BAO_DEVTOOLS_BRIDGE; // 强制 page-ws 模式
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  let port = 0;
  {
    const startedAt = Date.now();
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      try {
        if (fs.statSync(ACTIVE_PORT_FILE).mtimeMs > startedAt) {
          const p = Number(String(fs.readFileSync(ACTIVE_PORT_FILE, 'utf8')).split('\n')[0]);
          if (Number.isFinite(p) && p > 0) {
            const ok = await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false);
            if (ok) { port = p; break; }
          }
        }
      } catch { /* not yet */ }
      await sleep(500);
    }
  }
  if (!port) { console.error('[s14] 端口没发现'); process.exit(2); }

  let shell = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { console.error('[s14] shell 没出现'); process.exit(2); }
  const client = wsClient(shell.webSocketDebuggerUrl);
  await client.ready;

  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(fixtureUrl)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (state === 'submitted') break;
    await sleep(500);
  }
  await sleep(4000);

  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`);
    if (state === 'clicked') break;
    await sleep(500);
  }

  let front = null;
  for (let i = 0; i < 60 && !front; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    front = (list || []).find((t) => /devtools_app\.html\?ws=/.test(t.url || ''));
    if (!front) await sleep(500);
  }
  if (!front) { console.error('[s14] 前端 iframe 没出现'); client.close(); fixtureServer.close(); child.kill(); process.exit(2); }
  console.log('[s14] frontend url:', front.url.slice(0, 130));

  // 解析静态服务端口与真实 CDP 端点
  const parsed = new URL(front.url);
  const staticPort = parsed.port;
  // 前端拿到的 ws 参数不带 scheme（它自己补 ws://），代理侧要补全。
  const wsParam = parsed.searchParams.get('ws');
  const realWs = /^wss?:\/\//.test(wsParam) ? wsParam : `ws://${wsParam}`;
  console.log('[s14] static port:', staticPort, '| real ws:', realWs);

  // 起代理，然后把 iframe 导航到指向代理的 URL
  const proxy = await startProxy(realWs);
  console.log('[s14] proxy listening on', proxy.port);

  const proxyUrl = `http://127.0.0.1:${staticPort}/devtools_app.html?ws=127.0.0.1:${proxy.port}/devtools/page/${realWs.split('/').pop()}&can_dock=true`;
  console.log('[s14] navigating iframe to proxy url…');

  const fc = wsClient(front.webSocketDebuggerUrl);
  await fc.ready;
  await fc.send('Page.enable');
  await fc.send('Page.navigate', { url: proxyUrl });

  await sleep(14000);

  const { log } = proxy;
  console.log('[s14] captured messages:', log.length);

  console.log('[s14] flow:');
  for (const m of log.slice(0, 70)) {
    const tag = m.dir === 'out' ? '→' : '←';
    const sid = m.sid ? ' sid=' + String(m.sid).slice(0, 6) : '';
    const err = m.err ? ' ERR=' + String(m.err).slice(0, 60) : '';
    const extra = m.extra ? '  [' + m.extra + ']' : '';
    console.log(`  ${tag} ${m.method}${sid}${err}${extra}`);
  }

  // DOM 关键序列（判断树是不是靠 getDocument 内联返回的）
  console.log('[s14] DOM/target key sequence:');
  for (const m of log) {
    if (!/^(DOM\.(getDocument|requestChildNodes|setChildNodes|enable)|Target\.(setAutoAttach|setDiscoverTargets|targetCreated|attachedToTarget))$/.test(m.method)) continue;
    if (m.method.startsWith('#resp')) continue;
    const tag = m.dir === 'out' ? '→' : '←';
    console.log(`  ${tag} ${m.method}${m.extra ? '  [' + m.extra + ']' : ''}`);
  }

  const cmds = log.filter((m) => m.dir === 'out' && !m.method.startsWith('#resp'));
  const evts = log.filter((m) => m.dir === 'in' && !m.method.startsWith('#resp'));
  const byDomain = {};
  for (const m of cmds) {
    const d = m.method.split('.')[0];
    byDomain[d] = (byDomain[d] || 0) + 1;
  }
  console.log('[s14] cmd domains:', JSON.stringify(byDomain));
  console.log('[s14] target cmds:', JSON.stringify(cmds.filter((m) => m.method.startsWith('Target.')).map((m) => m.method)));
  console.log('[s14] evt count:', evts.length, '| with sid:', evts.filter((m) => m.sid).length);
  console.log('[s14] evt domains:', JSON.stringify(Object.fromEntries(
    Object.entries(evts.reduce((acc, m) => { const d = m.method.split('.')[0]; acc[d] = (acc[d] || 0) + 1; return acc; }, {})),
  )));

  // 前端树是否正常（代理等价 page-ws，应当正常）
  const probe = await evaluate(fc, `(() => {
    const deep = (sel) => { const acc = []; const visit = (r) => { r.querySelectorAll(sel).forEach((el) => acc.push(el)); r.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); }); }; visit(document); return acc; };
    const texts = deep('span[class*="webkit-html"]').map((el) => (el.textContent || '').slice(0, 40));
    return JSON.stringify({ spans: texts.length, hasMark: texts.some((t) => t.indexOf('mark') !== -1), hasDeep: texts.some((t) => t.indexOf('deep') !== -1) });
  })()`);
  console.log('[s14] iframe tree via proxy:', probe);

  fc.close();
  client.close();
  try { proxy.wss.close(); } catch { /* ignore */ }
  fixtureServer.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[s14] failed:', e.message); process.exit(1); });
