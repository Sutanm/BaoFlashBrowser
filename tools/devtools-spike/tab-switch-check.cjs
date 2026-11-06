#!/usr/bin/env node
/**
 * 复现：打开抽屉 DevTools 后切换标签页，前端 iframe 是否跟随新标签的 page target。
 *
 *   node tools/devtools-spike/tab-switch-check.cjs
 *
 * 流程：fixture /one → 打开抽屉 → 记录 iframe 连的 page id
 *      → 新建标签 → 导航 /two → 再读 iframe 连的 page id + 截图。
 * 期望：page id 变成 /two 的 target；实际若不变即为"切标签不刷新"。
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
const SHOT_PATH = path.join(APP_ROOT, 'artifacts', 'devtools-tab-switch.png');
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

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      const map = {
        '/one': page('fixture-one', '<h1 id="mark">ONE</h1>'),
        '/two': page('fixture-two', '<h1 id="mark">TWO</h1>'),
      };
      const body = map[url] || page('fixture-root', '<p>root</p>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
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
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    ready,
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

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn().catch(() => null);
    if (last) return last;
    await sleep(500);
  }
  console.error(`[switch] 等不到：${label}（最后值 ${JSON.stringify(last)}）`);
  return null;
}

function frontendWsPageId() {
  return getJson(`http://127.0.0.1:${debugPort}/json/list`).then((list) => {

    const front = (list || []).find((t) => /devtools_app\.html\?ws=/.test(t.url || ''));
    if (!front) return null;
    const match = /\/devtools\/page\/([0-9A-F]+)/i.exec(front.url);
    return match ? { pageId: match[1], targetUrl: front.url.slice(0, 130) } : { pageId: null, targetUrl: front.url.slice(0, 130) };
  });
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1200);

  const { server, port: fixturePort } = await startFixtureServer();
  const oneUrl = `http://127.0.0.1:${fixturePort}/one`;
  const twoUrl = `http://127.0.0.1:${fixturePort}/two`;

  const logPath = path.join(os.tmpdir(), 'bfb-tab-switch.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.'], {
    cwd: APP_ROOT, stdio: ['ignore', out, out], env,
  });
  console.log('[switch] electron pid', child.pid, '| log:', logPath);

  debugPort = await discoverDebugPort(Date.now(), 40000);
  if (!debugPort) { console.error('[switch] DevToolsActivePort 没出现'); process.exit(2); }
  console.log('[switch] debug port (discovered):', debugPort);

  const shell = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    return (list || []).find((t) => /\/dist\/renderer\/index\.html$/.test(t.url || '')) || null;
  }, 40000, 'shell');
  if (!shell) process.exit(2);

  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  const navigate = (url) => evaluate(client, `(() => {
    const input = document.querySelector('.address-input');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(url)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return 'submitted';
  })()`);

  // 标签 1：/one
  for (let i = 0; i < 40; i += 1) {
    const state = await navigate(oneUrl).catch(() => 'no-input');
    if (state === 'submitted') break;
    await sleep(500);
  }
  const oneTarget = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    return (list || []).find((t) => t.type === 'page' && /\/one$/.test((t.url || '').split('?')[0])) || null;
  }, 30000, '/one target');
  console.log('[switch] tab1 target:', oneTarget && oneTarget.id, oneTarget && oneTarget.url);
  await sleep(2000);

  // 打开抽屉
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`).catch(() => 'no-button');
    if (state === 'clicked') break;
    await sleep(500);
  }
  const front1 = await waitUntil(frontendWsPageId, 30000, 'frontend iframe');
  console.log('[switch] tab1 iframe pageId:', front1 && front1.pageId, '| match:', front1 && front1.pageId === (oneTarget && oneTarget.id));
  await sleep(3000);

  // 新建标签（顶部 + 按钮），等 about:newtab
  const newTab = await evaluate(client, `(() => {
    const btn = document.querySelector('.btn-tab.no-drag');
    if (!btn) return 'no-button';
    btn.click(); return 'clicked';
  })()`).catch(() => 'error');
  console.log('[switch] new-tab click:', newTab);
  await sleep(1500);

  // 标签 2：/two
  for (let i = 0; i < 40; i += 1) {
    const state = await navigate(twoUrl).catch(() => 'no-input');
    if (state === 'submitted') break;
    await sleep(500);
  }
  const twoTarget = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    return (list || []).find((t) => t.type === 'page' && /\/two$/.test((t.url || '').split('?')[0])) || null;
  }, 30000, '/two target');
  console.log('[switch] tab2 target:', twoTarget && twoTarget.id, twoTarget && twoTarget.url);
  await sleep(6000);

  const front2 = await waitUntil(frontendWsPageId, 5000, 'frontend iframe (after switch)');
  console.log('[switch] tab2 iframe pageId:', front2 && front2.pageId, '| follows tab2:', front2 && front2.pageId === (twoTarget && twoTarget.id));

  // 同标签内导航：targetId 应保持不变（不重连），面板内容跟随新页面
  for (let i = 0; i < 40; i += 1) {
    const state = await navigate(oneUrl).catch(() => 'no-input');
    if (state === 'submitted') break;
    await sleep(500);
  }
  await sleep(6000);
  const front3 = await waitUntil(frontendWsPageId, 5000, 'frontend iframe (same-tab nav)');
  console.log('[switch] same-tab nav: pageId unchanged:', front3 && front3.pageId === (twoTarget && twoTarget.id),
    '| panel title now:', front3 && front3.targetUrl);

  // iframe 内部证据：当前连接的 target 标题（/one 或 /two）
  let innerTitle = null;
  const frontList = await getJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
  const frontT = (frontList || []).find((t) => /devtools_app\.html\?ws=/.test(t.url || ''));
  if (frontT) {
    const frontClient = cdp(frontT.webSocketDebuggerUrl);
    await frontClient.ready;
    innerTitle = await evaluate(frontClient, 'document.title').catch((e) => `error:${e.message}`);
    frontClient.close();
  }
  console.log('[switch] iframe document.title:', innerTitle);

  const shot = await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot) {
    fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
    fs.writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));
    console.log('[switch] screenshot:', SHOT_PATH);
  }

  client.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  server.close();
  process.exit(0);
})().catch((error) => {
  console.error('[switch] failed:', error && error.message);
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(1);
});
