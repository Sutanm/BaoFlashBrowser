#!/usr/bin/env node
/**
 * 检查「外壳界面」target 时的自引用反馈环验证。
 *
 *   node tools/devtools-spike/shell-target-loop-check.cjs
 *
 * 背景：about:newtab 不创建 BrowserView（tabs.ts 的 needsBrowserView），新标签页
 * 就是外壳 React 渲染的。抽屉里的 DevTools iframe 也在外壳 DOM 里。所以
 * 「调试外壳」= 让 DevTools 调试包含它自己的那个页面。
 *
 * 判定（抽屉开着、target=外壳、无人操作）：
 *   1 外壳 DOM 事件速率 —— 若持续 >5/s 且无用户输入，说明 DevTools 自身的渲染
 *     在反向驱动外壳 DOM（自引用反馈环）
 *   2 外壳 JS 堆是否单调增长（Runtime.getHeapUsage 两次采样）
 *   3 对照：同一时刻目标页（7k7k）的 DOM 事件速率
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
const SHOT_PATH = path.join(APP_ROOT, 'artifacts', 'shell-target-overlap.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

function cdp(wsUrl, onEvent) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e.resolve(msg); return; }
    if (msg.method && onEvent) onEvent(msg);
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

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) return `EXC ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`;
  return r && r.result && r.result.result && r.result.result.value;
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  console.log('[loop] 等待超时:', label);
  return null;
}

const DEEP_TEXT = `(() => {
  const acc = [];
  const visit = (root) => {
    root.querySelectorAll('span[class*="webkit-html"]').forEach((el) => acc.push((el.textContent || '').trim()));
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
  };
  visit(document);
  return JSON.stringify({ spans: acc.length, sample: acc.slice(0, 8) });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1500);

  const out = fs.openSync(path.join(os.tmpdir(), 'bfb-loop.log'), 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BAO_DEVTOOLS_BRIDGE;

  const startedAt = Date.now();
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  const port = await waitUntil(async () => {
    try {
      if (fs.statSync(ACTIVE_PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(ACTIVE_PORT_FILE, 'utf8')).split('\n')[0]);
        if (p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) return p;
      }
    } catch { /* not yet */ }
    return null;
  }, 45000, 'debug port');
  if (!port) process.exit(2);

  const shellT = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || '')) || null;
  }, 30000, 'shell');
  if (!shellT) process.exit(2);
  const shell = cdp(shellT.webSocketDebuggerUrl);
  await shell.ready;

  // 开抽屉
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(shell, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`).catch(() => 'no-button');
    if (state === 'clicked') break;
    await sleep(500);
  }
  await sleep(2000);

  // 点「外壳界面」
  const clickShell = await evaluate(shell, `(() => {
    const btns = [].slice.call(document.querySelectorAll('button'));
    const t = btns.find(function (b) { return (b.textContent || '').trim() === '外壳界面'; });
    if (!t) return 'no-target-btn';
    t.click(); return 'clicked';
  })()`);
  console.log('[loop] click 外壳界面:', clickShell);

  const front = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /devtools_app\.html/.test(t.url || '')) || null;
  }, 30000, 'frontend iframe');
  console.log('[loop] frontend url:', front && front.url.slice(0, 110));
  if (!front) { shell.close(); child.kill(); process.exit(2); }

  await sleep(12000);

  // 采样外壳：DOM 事件速率 + 堆
  let domEvents = 0;
  const detail = {};
  const probe = cdp(shellT.webSocketDebuggerUrl, (m) => {
    if (m.method && m.method.startsWith('DOM.')) {
      domEvents += 1;
      detail[m.method] = (detail[m.method] || 0) + 1;
    }
  });
  await probe.ready;
  await probe.send('DOM.enable');
  await probe.send('Runtime.enable');

  const heap0 = await probe.send('Runtime.getHeapUsage');
  const heapBefore = heap0 && heap0.result && heap0.result.usedSize;
  await sleep(15000);
  const heap1 = await probe.send('Runtime.getHeapUsage');
  const heapAfter = heap1 && heap1.result && heap1.result.usedSize;

  console.log('[loop] 15s 内外壳 DOM 事件:', domEvents, JSON.stringify(detail));
  console.log('[loop] 外壳 JS 堆: %s → %s KB (Δ %s KB)',
    Math.round((heapBefore || 0) / 1024), Math.round((heapAfter || 0) / 1024),
    Math.round(((heapAfter || 0) - (heapBefore || 0)) / 1024));

  // 前端树规模
  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;
  const tree = await evaluate(fc, DEEP_TEXT);
  console.log('[loop] elements 树:', tree);

  // 外壳 DOM 规模 + 抽屉 iframe 内部的 DOM 规模（展开 iframe 节点时前端要把
  // 这一整棵树拉出来——而它正是 DevTools 自己）
  const sizes = await evaluate(shell, `(() => {
    const frame = document.querySelector('iframe[title="DevTools"]');
    return JSON.stringify({
      shellNodes: document.getElementsByTagName('*').length,
      shellText: document.body.innerText.length,
      iframePresent: Boolean(frame),
      iframeSrc: frame ? frame.src.slice(0, 60) : null,
    });
  })()`);
  console.log('[loop] sizes:', sizes);

  const iframeSizes = await evaluate(fc, `(() => {
    let n = document.getElementsByTagName('*').length;
    let shadow = 0;
    document.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) { shadow += 1; n += el.shadowRoot.getElementsByTagName('*').length; } });
    return JSON.stringify({ iframeNodes: n, shadowRoots: shadow });
  })()`);
  console.log('[loop] iframe sizes:', iframeSizes);

  // 对照：切到「当前页面」需要 BrowserView；这里只记录外壳侧状态即可
  const layout = await evaluate(shell, `(() => {
    const r = document.querySelector('.address-input');
    const bar = r ? r.getBoundingClientRect() : null;
    const sheet = document.querySelector('[class*="newtab"], [class*="NewTab"]');
    const sr = sheet ? sheet.getBoundingClientRect() : null;
    return JSON.stringify({
      addressBar: bar ? { top: Math.round(bar.top), bottom: Math.round(bar.bottom) } : null,
      newtab: sr ? { top: Math.round(sr.top), bottom: Math.round(sr.bottom), height: Math.round(sr.height) } : null,
      innerHeight: window.innerHeight,
      drawer: (() => { const d = document.querySelector('[role="separator"]'); return d ? Math.round(d.getBoundingClientRect().top) : null; })(),
    });
  })()`);
  console.log('[loop] layout:', layout);

  const shot = await shell.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot && shot.result && shot.result.data) {
    fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
    fs.writeFileSync(SHOT_PATH, Buffer.from(shot.result.data, 'base64'));
    console.log('[loop] screenshot:', SHOT_PATH);
  }

  fc.close();
  probe.close();
  shell.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[loop] failed:', e.message); process.exit(1); });
