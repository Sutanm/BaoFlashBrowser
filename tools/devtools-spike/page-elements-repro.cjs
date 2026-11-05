#!/usr/bin/env node
/**
 * 复现：抽屉 DevTools 在真实页面（7k7k）上 Elements 树为空、但元素抓取可用。
 *
 *   node tools/devtools-spike/page-elements-repro.cjs [url]
 *
 * 三个证据源：
 *   1. 直接对页面目标发 DOM.getDocument（后端到底返不返 DOM 树）
 *   2. 前端 iframe 目标的 Runtime.exceptionThrown / console 错误（前端渲染挂没挂）
 *   3. 整窗截图（Elements 树到底画没画出来）
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
const DEBUG_PORT = Number(process.env.BFB_SPIKE_DEBUG_PORT || 19222);
const PAGE_URL = process.argv[2] || 'http://www.7k7k.com/';

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

async function waitForShell(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const shell = (list || []).find((t) => /\/dist\/renderer\/index\.html$/.test(t.url || ''));
      if (shell) return shell;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
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
    if (events.length > 800) events.shift();
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

async function evalIn(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.result && result.result.value;
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await new Promise((r) => setTimeout(r, 1500));

  const logPath = path.join(os.tmpdir(), 'bfb-repro-page.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [`--remote-debugging-port=${DEBUG_PORT}`, '.'], {
    cwd: APP_ROOT, stdio: ['ignore', out, out], env,
  });
  console.log('[repro] electron pid', child.pid);

  const shell = await waitForShell(30000);
  if (!shell) { console.error('[repro] shell 目标没出现'); process.exit(2); }

  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  // 1. 用地址栏导航到目标页（模拟真实用户操作，让 tab 管理器全程知情）
  let navigated = 'no-input';
  for (let attempt = 0; attempt < 40 && navigated === 'no-input'; attempt += 1) {
    navigated = await evalIn(client, `(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(PAGE_URL)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (navigated === 'no-input') await new Promise((r) => setTimeout(r, 500));
  }
  console.log('[repro] address-bar navigate:', navigated);

  // 2. 等页面 target 出现并完成初步加载
  let pageTarget = null;
  for (let attempt = 0; attempt < 60 && !pageTarget; attempt += 1) {
    const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`).catch(() => []);
    pageTarget = (list || []).find((t) => t.type === 'page' && /7k7k\.com/.test(t.url || ''));
    if (!pageTarget) await new Promise((r) => setTimeout(r, 500));
  }
  if (!pageTarget) { console.error('[repro] 页面 target 没出现'); process.exit(2); }
  console.log('[repro] page target:', pageTarget.url);

  await new Promise((r) => setTimeout(r, 8000));

  // 3. 证据一：后端 DOM 树。直接对页面目标发 DOM.getDocument。
  const pageClient = cdp(pageTarget.webSocketDebuggerUrl);
  await pageClient.ready;
  await pageClient.send('DOM.enable');
  const doc = await pageClient.send('DOM.getDocument', { depth: 2 }).catch((e) => ({ error: e.message }));
  const docRoot = doc && doc.root;
  console.log('[repro] DOM.getDocument:', docRoot
    ? `root=${docRoot.nodeName} childCount=${docRoot.childNodeCount} nodeType=${docRoot.nodeType}`
    : JSON.stringify(doc).slice(0, 300));
  const nodeCount = await evalIn(pageClient, `document.querySelectorAll('*').length`).catch(() => 'eval-failed');
  console.log('[repro] page node count:', nodeCount);
  pageClient.close();

  // 4. 打开工具箱抽屉（默认落在 DevTools 标签、目标=当前页面）
  let clicked = 'no-button';
  for (let attempt = 0; attempt < 40 && clicked === 'no-button'; attempt += 1) {
    clicked = await evalIn(client, `(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (!b) return 'no-button'; b.click(); return 'clicked'; })()`);
    if (clicked === 'no-button') await new Promise((r) => setTimeout(r, 500));
  }
  console.log('[repro] toolbar click:', clicked);

  // 5. 证据二：尽早连上前端 iframe target，收集异常（错过头几秒就抓不到启动错误）
  let front = null;
  for (let attempt = 0; attempt < 30 && !front; attempt += 1) {
    const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`).catch(() => []);
    front = (list || []).find((t) => /127\.0\.0\.1:\d+\/inspector\.html\?ws=/.test(t.url || ''));
    if (!front) await new Promise((r) => setTimeout(r, 500));
  }
  let frontClient = null;
  if (front) {
    frontClient = cdp(front.webSocketDebuggerUrl);
    await frontClient.ready;
    await frontClient.send('Runtime.enable');
    console.log('[repro] frontend iframe target:', front.url.slice(0, 110));
  } else {
    console.log('[repro] frontend iframe target 未出现（抽屉里可能显示占位）');
  }

  await new Promise((r) => setTimeout(r, 12000));

  if (frontClient) {
    // CDP 的 DOM.getDocument(pierce) 能穿透闭合 shadow root——直接数
    // Elements 树渲染出来的文本节点（树里的 html/head/body/div 都是 #text）。
    try {
      await frontClient.send('DOM.enable');
      const composed = await frontClient.send('DOM.getDocument', { depth: -1, pierce: true });
      let htmlClasses = 0;
      let bracketTexts = 0;
      let tagTexts = 0;
      const samples = [];
      (function walkNode(node) {
        const attrs = (node.attributes || []).join(' ');
        if (attrs.indexOf('webkit-html-') !== -1) {
          htmlClasses += 1;
          if (samples.length < 8) samples.push(String(node.nodeName) + ' | ' + attrs.slice(0, 110));
        }
        if (node.nodeName === '#text' && node.nodeValue) {
          const v = node.nodeValue.trim();
          if (v.indexOf('<') === 0 || v.indexOf('>') === 0) bracketTexts += 1;
          if (/^(<)?(html|head|body|div|span|a|script|meta|link)(>)?$/.test(v)) tagTexts += 1;
        }
        const kids = (node.children || []).concat(node.shadowRoot ? [node.shadowRoot] : []);
        const pseudo = (node.pseudoElements || []);
        for (const child of kids.concat(pseudo)) walkNode(child);
      })(composed.root);
      console.log('[repro] composed tree => webkit-html spans:', htmlClasses, '| tag texts:', tagTexts, '| bracket texts:', bracketTexts);
      console.log('[repro] samples:', JSON.stringify(samples, null, 1));
    } catch (error) {
      console.log('[repro] composed tree probe failed:', error.message);
    }
    const errors = frontClient.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => {
        const d = e.params && e.params.exceptionDetails;
        const text = d && d.exception && (d.exception.description || d.exception.value) || (d && d.text) || '';
        return String(text).slice(0, 220);
      });
    const consoleErrors = frontClient.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map((e) => (e.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 200));
    console.log('[repro] frontend exceptions:', errors.length, JSON.stringify(errors.slice(0, 8), null, 1));
    console.log('[repro] frontend console errors:', consoleErrors.length, JSON.stringify(consoleErrors.slice(0, 8), null, 1));
    frontClient.close();
  }

  // 6. 证据三：整窗截图
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(APP_ROOT, 'artifacts', 'devtools-page-elements-repro.png');
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('[repro] screenshot:', shotPath);

  client.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((error) => {
  console.error('[repro] failed:', error);
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(1);
});
