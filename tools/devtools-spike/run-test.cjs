#!/usr/bin/env node
/**
 * 一次性端到端探针：Electron 11（Chromium 87）后端 × chii 自带的 DevTools 前端。
 *
 * 做的事：
 *  1. 用 --remote-debugging-port=9222 启动本应用
 *  2. 在 9300 上静态托管 front_end
 *  3. 用 Playwright Chromium 打开 inspector.html?ws=<target>，等它连上
 *  4. 收集控制台报错、检查 Elements/Console/Network 面板是否真的有内容
 *
 * 必须在沙箱外跑（沙箱禁止监听本地端口，EACCES）。
 *   node tools/devtools-spike/run-test.cjs
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const STATIC_PORT = Number(process.env.BFB_SPIKE_STATIC_PORT || 18080);
const DEBUG_PORT = Number(process.env.BFB_SPIKE_DEBUG_PORT || 19222);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.avif': 'image/avif', '.webp': 'image/webp', '.wasm': 'application/wasm',
  '.ico': 'image/x-icon', '.map': 'application/json; charset=utf-8',
};

function log(...args) { console.log('[spike]', ...args); }

function resolveFrontend() {
  const candidates = [
    process.env.BFB_DEVTOOLS_FRONTEND,
    path.join(__dirname, 'front_end'),
    path.join(os.tmpdir(), 'chii-spike', 'package', 'public', 'front_end'),
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'inspector.html'))) || null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

async function waitForTargets(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (Array.isArray(targets) && targets.length > 0) return targets;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function startStatic(root) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${STATIC_PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/inspector.html';
    const target = path.resolve(root, `.${pathname}`);
    if (!target.startsWith(path.resolve(root))) { res.writeHead(403).end(); return; }
    fs.stat(target, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(target).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(STATIC_PORT, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const root = resolveFrontend();
  if (!root) { console.error('[spike] 找不到 front_end，先 npm pack chii 并解压'); process.exit(1); }
  log('frontend:', root);
  if (!fs.existsSync(ELECTRON)) { console.error('[spike] 找不到 electron.exe'); process.exit(1); }

  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await new Promise((r) => setTimeout(r, 1500));

  const appLog = path.join(os.tmpdir(), 'bfb-spike-app.log');
  const out = fs.openSync(appLog, 'w');
  const child = spawn(ELECTRON, [`--remote-debugging-port=${DEBUG_PORT}`, '.'], {
    cwd: APP_ROOT, stdio: ['ignore', out, out], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  log('electron pid', child.pid, 'log', appLog);

  const targets = await waitForTargets(30000);
  if (!targets) {
    console.error('[spike] 调试端口 30s 内没有目标，应用可能没起来或端口被占');
    try { child.kill(); } catch { /* ignore */ }
    process.exit(2);
  }
  log('targets:', targets.map((t) => `${t.type}:${t.title}`).join(' | '));

  const page = targets.find((t) => t.type === 'page' && t.url && t.url.startsWith('file:')) || targets[0];
  log('attach target:', page.id, page.url);

  const server = await startStatic(root);
  log('static server on', STATIC_PORT);

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const probe = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  probe.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  probe.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));

  const url = `http://127.0.0.1:${STATIC_PORT}/inspector.html?ws=127.0.0.1:${DEBUG_PORT}/devtools/page/${page.id}`;
  log('open', url);
  await probe.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await probe.waitForTimeout(9000);

  const report = await probe.evaluate(() => {
    const text = (document.body && document.body.innerText) || '';
    const tabs = Array.from(document.querySelectorAll('.tabbed-pane-header-tab, .tabbed-pane-header-tab-title'))
      .map((el) => (el.textContent || '').trim()).filter(Boolean);
    const app = document.querySelector('devtools-app');
    const shadow = app && app.shadowRoot ? app.shadowRoot : null;
    return {
      title: document.title,
      tabCount: tabs.length,
      tabs: tabs.slice(0, 12),
      bodyLength: text.length,
      bodySample: text.slice(0, 400),
      hasErrorBanner: /Something went wrong|Error:|Cannot read|undefined is not/i.test(text),
      rootHtmlLength: document.body ? document.body.innerHTML.length : 0,
      hasApp: Boolean(app),
      shadowTabs: shadow
        ? Array.from(shadow.querySelectorAll('.tabbed-pane-header-tab-title')).map((el) => (el.textContent || '').trim()).slice(0, 15)
        : [],
      shadowText: shadow ? (shadow.textContent || '').slice(0, 400) : '',
    };
  });

  const shot = path.join(os.tmpdir(), 'devtools-spike.png');
  await probe.screenshot({ path: shot });
  log('screenshot:', shot);

  // 再点一次 Console 面板，看有没有真输出
  const consoleProbe = await probe.evaluate(async () => {
    const tabs = Array.from(document.querySelectorAll('.tabbed-pane-header-tab'));
    const target = tabs.find((el) => /Console|控制台/i.test(el.textContent || ''));
    if (target) target.click();
    await new Promise((r) => setTimeout(r, 1500));
    const view = document.querySelector('.console-view, .console-message, .console-group');
    return {
      clicked: Boolean(target),
      hasConsoleView: Boolean(view),
      text: (view && view.textContent || '').slice(0, 300),
    };
  });

  console.log(JSON.stringify({
    ok: report.bodyLength > 0 && !report.hasErrorBanner,
    report,
    consoleProbe,
    consoleErrors: consoleErrors.slice(0, 15),
    pageErrors: pageErrors.slice(0, 15),
  }, null, 2));

  await browser.close();
  server.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((error) => {
  console.error('[spike] failed:', error);
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(1);
});
