#!/usr/bin/env node
/**
 * 验证：抽屉里的 DevTools 是否已经跑成"停靠壳"（AdvancedApp），而不是
 * inspector.html 的 screencast 壳。
 *
 *   node tools/devtools-spike/dock-shell-check.cjs
 *
 * 断言项（打印成 JSON）：
 *   - frontendUrl 里含 devtools_app.html 与 can_dock=true
 *   - bodyClass 为 "right"（DockController 默认停靠侧），且不含 "undocked"
 *   - split-widget 的 main 区宽度为 0（构建期 patch 把 showBoth 改成 hideMain）
 *   - 无 screencast-view 节点
 *   - Elements 树有 span.webkit-html-* 节点（面板真在渲染）
 *   - 前端无未捕获异常
 * 另存整窗截图 artifacts/devtools-dock-shell.png。
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

const SHOT_PATH = path.join(APP_ROOT, 'artifacts', 'devtools-dock-shell.png');
// 应用现在自己 appendSwitch('remote-debugging-port', '0')（随机端口），从这里发现实际端口。
const ACTIVE_PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');
let debugPort = 0;

async function discoverDebugPort(startedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(ACTIVE_PORT_FILE).mtimeMs > startedAt) {
        const port = Number(String(fs.readFileSync(ACTIVE_PORT_FILE, 'utf8')).split('\n')[0]);
        if (Number.isFinite(port) && port > 0) {
          const ready = await getJson(`http://127.0.0.1:${port}/json/version`).then(() => true).catch(() => false);
          if (ready) return port;
        }
      }
    } catch { /* not yet */ }
    await sleep(500);
  }
  return null;
}

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>dock-shell fixture</title></head>
<body><div id="a">alpha</div><div id="b"><span>beta</span><span>gamma</span></div><button id="c">delta</button></body></html>`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

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

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    events.push(msg);
    if (events.length > 1200) events.shift();
  });
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    ready, events,
    send(method, params = {}) {
      const messageId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(messageId, { resolve, reject });
        socket.send(JSON.stringify({ id: messageId, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
    throw new Error(String(description || result.exceptionDetails.text));
  }
  return result.result && result.result.value;
}

async function waitForTarget(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await getJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    const hit = (list || []).find(predicate);
    if (hit) return hit;
    await sleep(500);
  }
  console.error(`[dock] 等不到目标：${label}`);
  return null;
}

const PROBE = `(() => {
  const deep = (selector) => {
    const acc = [];
    const visit = (root) => {
      root.querySelectorAll(selector).forEach((el) => acc.push(el));
      root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
    };
    visit(document);
    return acc;
  };
  const splits = deep('.split-widget').map((el) => {
    const main = el.querySelector(':scope > .main-widget');
    const side = el.querySelector(':scope > .sidebar-widget');
    return {
      width: Math.round(el.getBoundingClientRect().width),
      mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
      sideWidth: side ? Math.round(side.getBoundingClientRect().width) : null,
    };
  });
  return {
    bodyClass: document.body.className,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    splits,
    screencastViews: deep('.screencast-view').length,
    inspectorViews: deep('.vbox.flex-auto').length,
    htmlSpans: deep('span[class*="webkit-html"]').length,
    panels: deep('.panel').map((p) => p.getAttribute('aria-label') || p.id || '').filter(Boolean).slice(0, 10),
    textSample: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
  };
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1200);

  const { server, port: fixturePort } = await startFixtureServer();
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;
  console.log('[dock] fixture:', fixtureUrl);

  const logPath = path.join(os.tmpdir(), 'bfb-dock-shell.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.'], {
    cwd: APP_ROOT, stdio: ['ignore', out, out], env,
  });
  console.log('[dock] electron pid', child.pid, '| log:', logPath);

  debugPort = await discoverDebugPort(Date.now(), 40000);
  if (!debugPort) { console.error('[dock] DevToolsActivePort 没出现'); process.exit(2); }
  console.log('[dock] debug port (discovered):', debugPort);

  const shell = await waitForTarget((t) => /\/dist\/renderer\/index\.html$/.test(t.url || ''), 40000, 'shell');
  if (!shell) process.exit(2);

  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  let navigated = 'no-input';
  for (let i = 0; i < 40 && navigated === 'no-input'; i += 1) {
    navigated = await evaluate(client, `(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(fixtureUrl)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`).catch((e) => `error:${e.message}`);
    if (navigated === 'no-input') await sleep(500);
  }
  console.log('[dock] address-bar navigate:', navigated);

  const pageTarget = await waitForTarget(
    (t) => t.type === 'page' && (t.url || '').indexOf(`127.0.0.1:${fixturePort}`) !== -1,
    30000,
    'fixture page',
  );
  if (!pageTarget) process.exit(2);
  await sleep(3000);

  let clicked = 'no-button';
  for (let i = 0; i < 40 && clicked === 'no-button'; i += 1) {
    clicked = await evaluate(client, `(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (!b) return 'no-button'; b.click(); return 'clicked'; })()`).catch(() => 'no-button');
    if (clicked === 'no-button') await sleep(500);
  }
  console.log('[dock] toolbox toggle:', clicked);

  const front = await waitForTarget((t) => /devtools_app\.html\?ws=/.test(t.url || ''), 30000, 'devtools_app frontend');
  if (!front) {
    const anyFront = await waitForTarget((t) => /inspector\.html\?ws=/.test(t.url || ''), 2000, 'inspector frontend');
    console.log('[dock] 仍加载的是 inspector.html 入口:', Boolean(anyFront));
    process.exit(2);
  }
  console.log('[dock] frontend target:', front.url.slice(0, 130));

  const frontClient = cdp(front.webSocketDebuggerUrl);
  await frontClient.ready;
  await frontClient.send('Runtime.enable');
  await frontClient.send('Page.enable');

  await sleep(12000);

  const probe = await evaluate(frontClient, PROBE).catch((e) => ({ probeFailed: e.message }));
  const exceptions = frontClient.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => {
      const d = e.params && e.params.exceptionDetails;
      const text = (d && d.exception && (d.exception.description || d.exception.value)) || (d && d.text) || '';
      return String(text).slice(0, 200);
    });
  const consoleErrors = frontClient.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map((e) => (e.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 180));

  console.log('[dock] probe:', JSON.stringify(probe, null, 1));
  console.log('[dock] exceptions:', exceptions.length, JSON.stringify(exceptions.slice(0, 6)));
  console.log('[dock] console errors:', consoleErrors.length, JSON.stringify(consoleErrors.slice(0, 6)));

  const shot = await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot) {
    fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
    fs.writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));
    console.log('[dock] screenshot:', SHOT_PATH);
  }

  frontClient.close();
  client.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  server.close();
  process.exit(0);
})().catch((error) => {
  console.error('[dock] failed:', error && error.message);
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(1);
});
