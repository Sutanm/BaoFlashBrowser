#!/usr/bin/env node
/**
 * 桥目标审计：一次看清 DevTools 面板到底连到了哪个 target。
 *
 *   node tools/devtools-spike/bridge-target-audit.cjs            # 本地 fixture
 *   BFB_SITE=https://www.7k7k.com/ node tools/devtools-spike/bridge-target-audit.cjs
 *
 * 判据：
 *   - 桥 stats.targetId 对应 /json/list 里的哪一条（外壳 / 页面 / 前端自己）
 *   - 前端 Elements 树里出现 `data-origin="bfb:` 或 `#root` = 连到了外壳（错）
 *   - 出现 fixture 标记 = 连到了页面（对）
 *   - localStorage.language 的实际值（解释界面为什么是英文）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');
const LOG = path.join(os.tmpdir(), 'bfb-audit.log');
const SITE = process.env.BFB_SITE || '';

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

function startFixture() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>audit-fixture</title></head><body><div id="audit-mark">AUDIT-PAGE-MARK</div></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function cdp(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) { const e = pending.get(m.id); pending.delete(m.id); e(m); }
  });
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return {
    ready,
    send(method, params = {}) {
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise((res) => {
        const t = setTimeout(() => { pending.delete(i); res({ error: { message: 'timeout' } }); }, 15000);
        pending.set(i, (m) => { clearTimeout(t); res(m); });
      });
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    return `EXC ${(d.exception && d.exception.description) || d.text}`;
  }
  return r && r.result && r.result.result && r.result.result.value;
}

const TREE_AUDIT = `(() => {
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
    sample: texts.slice(0, 8),
    looksLikeShell: texts.some((t) => t.indexOf('data-origin') !== -1 || t.indexOf('bfb:') !== -1 || t.indexOf('id="root"') !== -1),
    hasFixtureMark: texts.some((t) => t.indexOf('audit-mark') !== -1 || t.indexOf('AUDIT-PAGE-MARK') !== -1),
    locale: (() => { try { return localStorage.getItem('language'); } catch (e) { return 'ERR'; } })(),
    nav: navigator.language,
  });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1200);

  const { server: fixtureServer, port: fixturePort } = await startFixture();
  const targetUrl = SITE || `http://127.0.0.1:${fixturePort}/`;

  const out = fs.openSync(LOG, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BAO_DEVTOOLS_PAGE_WS;
  delete env.BAO_DEVTOOLS_LEGACY_HTTP;
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  const startedAt = Date.now();
  let port = 0;
  for (let i = 0; i < 80 && !port; i += 1) {
    try {
      if (fs.statSync(PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).split('\n')[0]);
        if (Number.isFinite(p) && p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) port = p;
      }
    } catch { /* not yet */ }
    if (!port) await sleep(500);
  }
  if (!port) { console.error('[audit] 端口没发现'); process.exit(2); }

  let shell = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { console.error('[audit] shell 没出现'); process.exit(2); }
  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;
  console.log('[audit] shell url:', shell.url.slice(0, 110));

  // 先开抽屉（模拟"先开面板再切页面"的顺序，这是用户最常走的路）
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`);
    if (state === 'clicked') break;
    await sleep(500);
  }
  console.log('[audit] drawer opened（此时还是新标签页，应当 no-target）');
  await sleep(2500);

  // 再导航到目标页
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(client, `(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(targetUrl)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (state === 'submitted') break;
    await sleep(500);
  }
  console.log('[audit] navigated to', targetUrl);
  await sleep(6000);

  let front = null;
  for (let i = 0; i < 60 && !front; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    front = (list || []).find((t) => /devtools_app\.html\?/.test(t.url || ''));
    if (!front) await sleep(500);
  }
  if (!front) { console.error('[audit] 前端 target 没出现'); client.close(); child.kill(); process.exit(2); }
  await sleep(7000);

  const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const targets = (list || []).map((t) => ({ id: t.id, type: t.type, url: String(t.url).slice(0, 100) }));
  console.log('[audit] targets:');
  for (const t of targets) console.log(`  ${t.id.slice(0, 8)} ${t.type.padEnd(10)} ${t.url}`);

  const statsRaw = await evaluate(client, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) { return JSON.stringify(s); })`, true);
  let stats = null;
  try { stats = JSON.parse(String(statsRaw)); } catch { /* ignore */ }
  console.log('[audit] stats:', stats ? JSON.stringify({ state: stats.state, targetId: stats.targetId, sent: stats.sent, events: stats.events, sinkCalls: stats.sinkCalls }) : String(statsRaw).slice(0, 200));
  if (stats && stats.targetId) {
    const bound = targets.find((t) => t.id === stats.targetId);
    console.log('[audit] 桥绑定的 target:', bound ? `${bound.id.slice(0, 8)} ${bound.type} ${bound.url}` : 'NOT FOUND');
    console.log('[audit] 是否等于外壳:', Boolean(bound && /dist\/renderer\/index\.html/.test(bound.url)));
    console.log('[audit] 是否等于前端自己:', Boolean(bound && /devtools_app\.html/.test(bound.url)));
  }

  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;
  const tree = await evaluate(fc, TREE_AUDIT);
  console.log('[audit] 前端树:', tree);

  fc.close();
  client.close();
  fixtureServer.close();
  child.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('[audit] failed:', e && e.message); process.exit(1); });
