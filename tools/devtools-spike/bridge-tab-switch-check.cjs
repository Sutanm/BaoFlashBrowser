#!/usr/bin/env node
/**
 * S16：桥模式下的切标签验证。
 *
 *   BAO_DEVTOOLS_BRIDGE=1 node tools/devtools-spike/bridge-tab-switch-check.cjs
 *
 * 判定三件事：
 *   1 标签 1（/one）→ Elements 树里出现 ONE 的标记
 *   2 切到标签 2（/two）→ 树里出现 TWO 的标记，且不再出现 ONE
 *   3 切标签时 iframe 是否重载（pageId 是否变化 / URL 是否变化）
 *
 * 第 3 项目前是「已知会重载」的现状记录：桥模式的 URL 带了 bfb_target，
 * 切标签换 URL → iframe key 变 → 重载。要做到"不重载"，需要桥在重新 attach
 * 后重建域状态并向前端发 documentUpdated，属于后续 B4 增强。
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
const SHOT_PATH = path.join(APP_ROOT, 'artifacts', 'devtools-bridge-tab-switch.png');

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

function page(title, body) {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if ((req.url || '/').startsWith('/one')) {
      res.end(page('one', '<div id="page-one">ONE-MARKER</div>'));
      return;
    }
    if ((req.url || '/').startsWith('/two')) {
      res.end(page('two', '<div id="page-two">TWO-MARKER</div>'));
      return;
    }
    res.end(page('root', '<div id="root-page">ROOT</div>'));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e.resolve(msg); }
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    send(method, params = {}) {
      const i = ++id;
      socket.send(JSON.stringify({ id: i, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ error: { message: 'timeout' } }); } }, 15000);
        pending.set(i, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) return `EXC ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`;
  return r && r.result && r.result.result && r.result.result.value;
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(500);
  }
  console.log('[btab] 等待超时:', label);
  return null;
}

/** 读前端 Elements 树的可见文本（穿透 shadow DOM）。 */
const TREE_PROBE = `(() => {
  const deep = (sel) => {
    const acc = [];
    const visit = (root) => {
      root.querySelectorAll(sel).forEach((el) => acc.push(el));
      root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
    };
    visit(document);
    return acc;
  };
  const texts = deep('span[class*="webkit-html"]').map((el) => (el.textContent || '').trim());
  return JSON.stringify({
    spans: texts.length,
    hasOne: texts.some((t) => t.indexOf('page-one') !== -1 || t.indexOf('ONE-MARKER') !== -1),
    hasTwo: texts.some((t) => t.indexOf('page-two') !== -1 || t.indexOf('TWO-MARKER') !== -1),
  });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const { server: fixtureServer, port: fixturePort } = await startFixtureServer();
  const oneUrl = `http://127.0.0.1:${fixturePort}/one`;
  const twoUrl = `http://127.0.0.1:${fixturePort}/two`;

  const logPath = path.join(os.tmpdir(), 'bfb-s16.log');
  const out = fs.openSync(logPath, 'w');
  // B3 之后桥是默认传输，不需要再注入 BAO_DEVTOOLS_BRIDGE。
  const env = { ...process.env };
  delete env.BAO_DEVTOOLS_BRIDGE;
  delete env.BAO_DEVTOOLS_PAGE_WS;
  delete env.BAO_DEVTOOLS_LEGACY_HTTP;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  const startedAt = Date.now();
  const port = await waitUntil(async () => {
    try {
      if (fs.statSync(ACTIVE_PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(ACTIVE_PORT_FILE, 'utf8')).split('\n')[0]);
        if (p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) return p;
      }
    } catch { /* not yet */ }
    return null;
  }, 40000, 'debug port');
  if (!port) { process.exit(2); }

  const shell = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || '')) || null;
  }, 30000, 'shell');
  if (!shell) { process.exit(2); }
  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;

  const navigate = (url) => evaluate(client, `(() => {
    const input = document.querySelector('.address-input');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(url)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return 'submitted';
  })()`);

  // 标签 1 → /one
  for (let i = 0; i < 40; i += 1) {
    if (await navigate(oneUrl).catch(() => 'no-input') === 'submitted') break;
    await sleep(500);
  }
  const oneTarget = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => t.type === 'page' && /\/one$/.test(t.url || '')) || null;
  }, 30000, '/one target');
  console.log('[btab] tab1 target:', oneTarget && oneTarget.id);
  await sleep(2500);

  // 开抽屉
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`).catch(() => 'no-button');
    if (state === 'clicked') break;
    await sleep(500);
  }

  const frontUrl = (t) => /devtools_app\.html/.test(t.url || '');
  const front1 = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => frontUrl(t)) || null;
  }, 30000, 'frontend view');
  console.log('[btab] frontend url:', front1 && front1.url.slice(0, 120));
  await sleep(9000);

  const fc1 = cdp(front1.webSocketDebuggerUrl);
  await fc1.ready;
  const tree1 = await evaluate(fc1, TREE_PROBE);
  console.log('[btab] tab1 tree:', tree1);
  // 埋一个时间戳：只要容器没重建，切完标签它还在。
  const stamp1 = await evaluate(fc1, 'window.__bfbStamp = String(Date.now())');
  console.log('[btab] stamp written:', stamp1);
  fc1.close();

  // 新标签 → /two
  await evaluate(client, `(() => { const b = document.querySelector('.btn-tab.no-drag'); if (b) b.click(); return 'ok'; })()`);
  // 等新标签真正成为活动标签（地址栏不再是 /one），否则导航会打在旧标签上。
  const switched = await waitUntil(async () => {
    const value = await evaluate(client, `(() => { const el = document.querySelector('.address-input'); return el ? 'v:' + el.value : null; })()`);
    return typeof value === 'string' && value.indexOf('/one') === -1 ? value : null;
  }, 15000, 'new tab active');
  console.log('[btab] active tab address after new-tab:', JSON.stringify(switched));
  await sleep(1200);
  for (let i = 0; i < 40; i += 1) {
    if (await navigate(twoUrl).catch(() => 'no-input') === 'submitted') break;
    await sleep(500);
  }
  const twoTarget = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => t.type === 'page' && /\/two$/.test(t.url || '')) || null;
  }, 30000, '/two target');
  console.log('[btab] tab2 target:', twoTarget && twoTarget.id);
  await sleep(9000);

  const front2 = (await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []))
    .find((t) => frontUrl(t));
  console.log('[btab] container rebuilt:', front2 && front2.id !== front1.id, '| url changed:',
    Boolean(front2 && front1 && front2.url !== front1.url));
  if (front2) {
    const fc2 = cdp(front2.webSocketDebuggerUrl);
    await fc2.ready;
    const tree2 = await evaluate(fc2, TREE_PROBE);
    console.log('[btab] tab2 tree:', tree2);
    const stamp2 = await evaluate(fc2, 'String(window.__bfbStamp || "LOST")');
    console.log('[btab] stamp after switch:', stamp2, '| same:', stamp2 === stamp1);
    fc2.close();
  }

  // ---- 切回标签 1（用户路径：点标签项）----
  // 这是「慢了一步」最容易出现的地方：只有切回去，才能看出面板有没有一直停在上一份文档。
  const clickTab = (i) => evaluate(client, `(() => {
    const items = document.querySelectorAll('.tab-inner');
    if (!items[${i}]) return 'no-tab';
    const r = items[${i}].getBoundingClientRect();
    const opts = { bubbles: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) };
    items[${i}].dispatchEvent(new MouseEvent('mousedown', opts));
    items[${i}].dispatchEvent(new MouseEvent('mouseup', opts));
    items[${i}].dispatchEvent(new MouseEvent('click', opts));
    return 'clicked';
  })()`);

  const frontNow = () => getJson(`http://127.0.0.1:${port}/json/list`)
    .catch(() => []).then((list) => (list || []).find((t) => frontUrl(t)) || null);

  console.log('[btab] switch back → tab0:', await clickTab(0));
  const t0 = Date.now();
  let followed = null;
  for (let i = 0; i < 30; i += 1) {
    const f = await frontNow();
    if (f) {
      const fc = cdp(f.webSocketDebuggerUrl);
      await fc.ready;
      const tree = await evaluate(fc, TREE_PROBE);
      fc.close();
      let parsed = null;
      try { parsed = JSON.parse(String(tree)); } catch { /* ignore */ }
      if (parsed && parsed.hasOne && !parsed.hasTwo) { followed = Date.now() - t0; break; }
    }
    await sleep(500);
  }
  console.log('[btab] 切回后面板跟随耗时:', followed === null ? `未跟随（>${Date.now() - t0}ms，需要重开面板）` : `${followed}ms`);

  const stats = await evaluate(client, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) {
    return JSON.stringify({ state: s.state, sent: s.sent, failed: s.failed, target: s.targetId });
  })`).catch(() => 'n/a');
  console.log('[btab] bridge stats:', stats);

  const shot = await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);  if (shot && shot.result && shot.result.data) {
    fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
    fs.writeFileSync(SHOT_PATH, Buffer.from(shot.result.data, 'base64'));
    console.log('[btab] screenshot:', SHOT_PATH);
  }

  client.close();
  fixtureServer.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[btab] failed:', e.message); process.exit(1); });
