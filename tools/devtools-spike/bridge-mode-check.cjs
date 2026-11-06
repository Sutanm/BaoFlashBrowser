#!/usr/bin/env node
/**
 * S11（B3 形态）：桥模式端到端验证——前端走 preload 的 `bfbBridge` → IPC → 主进程桥。
 *
 *   node tools/devtools-spike/bridge-mode-check.cjs              # 桥模式（默认）
 *   BFB_PAGE_WS=1 node tools/devtools-spike/bridge-mode-check.cjs # page-ws 对照基线
 *
 * 与 B3 之前的差别：前端不再跑在 iframe 里，`window.parent` / postMessage 探针
 * 全部失效，改判：
 *   1 前端 target 是 file:// 的 `devtools_app.html?can_dock=true`，**不带 ws**
 *   2 前端内 `typeof window.bfbBridge === 'object'`，且 `window.electronAPI` 不存在
 *     （隔离成立：前端拿不到密码/tab 特权）
 *   3 Elements 树渲染出 fixture 的 #mark 节点（CDP 消息经桥往返成功）
 *   4 桥 stats：目标 url 与活动标签一致
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
const SHOT_PATH = path.join(APP_ROOT, 'artifacts', 'devtools-bridge-mode.png');

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
    res.end('<!doctype html><html><head><title>bridge-mode-fixture</title></head><body><div id="mark">BRIDGE</div></body></html>');
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

const DEEP_PROBE = `(() => {
  const deep = (selector) => {
    const acc = [];
    const visit = (root) => {
      root.querySelectorAll(selector).forEach((el) => acc.push(el));
      root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
    };
    visit(document);
    return acc;
  };
  const texts = deep('span[class*="webkit-html"]').map((el) => (el.textContent || '').slice(0, 40));
  return JSON.stringify({
    htmlSpans: texts.length,
    hasMark: texts.some((t) => t.indexOf('mark') !== -1),
    hasBridgeText: texts.some((t) => t.indexOf('BRIDGE') !== -1),
    sample: texts.slice(0, 10),
    bridgeApi: typeof window.bfbBridge,
    hasElectronAPI: typeof window.electronAPI !== 'undefined',
    hasParent: window.parent !== window,
    localeSaved: (() => { try { return localStorage.getItem('language'); } catch (e) { return 'ERR'; } })(),
    localeNav: navigator.language,
    localeActive: (() => { try { return window.localStorage.getItem('language') || '(unset)'; } catch (e) { return 'ERR'; } })(),
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
  });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const { server: fixtureServer, port: fixturePort } = await startFixture();
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

  // BFB_PAGE_WS=1 → 走 page-ws 回退路径做对照（同一 fixture、同一探针）
  const baseline = process.env.BFB_PAGE_WS === '1';
  const logPath = path.join(os.tmpdir(), 'bfb-s11.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  if (baseline) env.BAO_DEVTOOLS_PAGE_WS = '1';
  else delete env.BAO_DEVTOOLS_PAGE_WS;
  delete env.BAO_DEVTOOLS_BRIDGE;
  delete env.BAO_DEVTOOLS_LEGACY_HTTP;
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
  if (!port) { console.error('[s11] 端口没发现'); process.exit(2); }

  let shell = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { console.error('[s11] shell 没出现'); process.exit(2); }
  const client = wsClient(shell.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');

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
  console.log('[s11] navigated to fixture');
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
  console.log('[s11] drawer toggled');

  // 等前端 target。B3 之后它是独立 WebContents（file://），不再是 iframe。
  // 查询串两种形态：桥模式 `?can_dock=true`，page-ws 回退 `?ws=…&can_dock=true`。
  let front = null;
  for (let i = 0; i < 60 && !front; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    front = (list || []).find((t) => /devtools_app\.html\?/.test(t.url || ''));
    if (!front) await sleep(500);
  }
  console.log('[s11] frontend url:', front ? front.url.slice(0, 130) : 'NOT FOUND');
  if (!front) { console.log('[s11] 前端 target 没出现'); client.close(); fixtureServer.close(); child.kill(); process.exit(2); }
  console.log('[s11] frontend url has ws param:', /\bws=/.test(front.url));

  const fc = wsClient(front.webSocketDebuggerUrl);
  await fc.ready;
  await fc.send('Runtime.enable');
  await sleep(12000);

  const probe = await evaluate(fc, DEEP_PROBE);
  console.log('[s11] frontend probe:', probe);

  const exceptions = fc.events
    .filter((m) => m.method === 'Runtime.exceptionThrown')
    .map((m) => {
      const d = m.params && m.params.exceptionDetails;
      return String((d && d.exception && (d.exception.description || d.exception.value)) || (d && d.text) || '').slice(0, 200);
    });
  console.log('[s11] frontend exceptions:', exceptions.length, JSON.stringify(exceptions.slice(0, 4)));

  // BFB_RESET_LOCALE=1：清掉持久化的 language，确认"没存过就跟随系统"仍然成立
  // （B2 的 file:// 让 origin 恒定、设置得以持久，副作用是曾经选过的英文会留下）
  if (process.env.BFB_RESET_LOCALE === '1') {
    await evaluate(fc, `(() => { try { localStorage.removeItem('language'); } catch (e) {} location.reload(); return 'reloaded'; })()`);
    await sleep(10000);
    const after = await evaluate(fc, `JSON.stringify({
      saved: (() => { try { return localStorage.getItem('language'); } catch (e) { return 'ERR'; } })(),
      nav: navigator.language,
      tabText: (document.querySelector('.tabbed-pane-header-tab') || {}).textContent,
      body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 80),
    })`);
    console.log('[s11] locale after reset:', after);
  }

  // 桥 stats（经外壳渲染层；这条 API 在 B3 后保留，用于诊断与探针）
  const statsRaw = baseline ? JSON.stringify({ baseline: true }) : await evaluate(client, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) { return JSON.stringify(s); })`, true);
  console.log('[s11] bridge stats:', String(statsRaw).slice(0, 400));
  try {
    fs.mkdirSync(path.join(APP_ROOT, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(APP_ROOT, 'artifacts', 'bridge-stats.json'), String(statsRaw));
  } catch { /* ignore */ }

  try {
    const statsObj = JSON.parse(String(statsRaw));
    if (statsObj && statsObj.targetId) {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      const bound = (list || []).find((t) => t.id === statsObj.targetId);
      console.log('[s11] bridge target url:', bound ? bound.url : 'NOT FOUND', '| type:', bound ? bound.type : '-');
    }
    const pages = ((await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => [])) || [])
      .filter((t) => t.type === 'page')
      .map((t) => `${t.id.slice(0, 6)} ${String(t.url).slice(0, 90)}`);
    console.log('[s11] all page targets:', JSON.stringify(pages));
  } catch (e) { console.log('[s11] target 对照失败:', e.message); }

  const shot = await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot) {
    fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
    fs.writeFileSync(SHOT_PATH, Buffer.from(shot.result.data, 'base64'));
    console.log('[s11] screenshot:', SHOT_PATH);
  }

  // 前端自己的画面：BrowserView 是原生视图，外壳截图里永远是空白，
  // 必须连前端 target 单独截图才能看到面板实际长什么样。
  const frontShot = await fc.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (frontShot) {
    const frontPath = path.join(APP_ROOT, 'artifacts', 'devtools-bridge-frontend.png');
    fs.writeFileSync(frontPath, Buffer.from(frontShot.result.data, 'base64'));
    console.log('[s11] frontend screenshot:', frontPath);
  }

  fc.close();
  client.close();
  fixtureServer.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
