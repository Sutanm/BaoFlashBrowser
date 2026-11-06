#!/usr/bin/env node
/**
 * 复现「Styles 面板一直转圈」并抓桥的 CDP 流水。
 *
 *   node tools/devtools-spike/styles-spin-check.cjs
 *   BFB_CROSS=1 node tools/devtools-spike/styles-spin-check.cjs   # 页面带跨域 iframe（会触发 CDP 深探）
 *
 * 判据：
 * - Styles 面板是否出现规则内容（`element.style` / `body {` / `color`）；
 * - 桥的 flow 里 `CSS.getMatchedStylesForNode` 的请求(>) 与响应(<) 是否配平；
 * - stats.failed 是否增长（兜底超时在打）。
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
const PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');
const CROSS = process.env.BFB_CROSS === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(5000, () => req.destroy(new Error('timeout')));
});

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e(msg); return; }
    for (const listener of listeners) listener(msg);
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    onEvent(listener) { listeners.push(listener); },
    send(method, params = {}) {
      const i = ++id;
      socket.send(JSON.stringify({ id: i, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ error: { message: 'timeout' } }); } }, 15000);
        pending.set(i, (m) => { clearTimeout(timer); resolve(m); });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression, awaitPromise = true) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) return `EXC ${r.exceptionDetails.text}`;
  return r && r.result && r.result.result && r.result.result.value;
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(400);
  }
  console.log('[spin] 等待超时:', label);
  return null;
}

function startFixture() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.startsWith('/game')) {
      res.end('<!doctype html><html><head><title>game</title></head><body><div id="inner">inner</div></body></html>');
      return;
    }
    const port = server.address().port;
    res.end(`<!doctype html><html><head><title>spin</title>
      <style>
        body { margin: 0; font: 16px system-ui; }
        #target { color: rgb(220, 30, 60); padding: 12px; border: 2px solid #36c; }
      </style></head><body>
      <div id="target">STYLED-NODE</div>
      ${CROSS ? `<iframe src="http://localhost:${port}/game" width="420" height="260"></iframe>` : ''}
    </body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Elements 树是否有内容（判断面板整体是不是活的） */
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
  const tags = deep('span[class*="webkit-html-tag"]').map((el) => (el.textContent || '').trim());
  const crumbs = deep('.crumbs-widget-item').map((el) => (el.textContent || '').trim());
  return JSON.stringify({ tags: tags.length, first: tags.slice(0, 4), crumbs: crumbs.slice(0, 5) });
})()`;

/** 穿透 shadow DOM 找 Styles 面板的文本与转圈标志 */
const STYLES_PROBE = `(() => {
  const deep = (sel) => {
    const acc = [];
    const visit = (root) => {
      root.querySelectorAll(sel).forEach((el) => acc.push(el));
      root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
    };
    visit(document);
    return acc;
  };
  const panes = deep('.styles-pane');
  const text = panes.map((el) => String(el.innerText || '')).join('\\n');
  const spinners = deep('.spinner-container, .spinner').filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  return JSON.stringify({
    paneCount: panes.length,
    textLen: text.length,
    hasRules: text.indexOf('element.style') !== -1 || text.indexOf('#target') !== -1 || text.indexOf('body {') !== -1 || text.indexOf('color') !== -1,
    hasSpinner: spinners.length > 0,
    head: text.replace(/\\n{2,}/g, '\\n').slice(0, 300),
  });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const { server: fixture, port: fixturePort } = await startFixture();
  const pageUrl = process.env.BFB_URL || `http://127.0.0.1:${fixturePort}/page`;
  console.log('[spin] page:', pageUrl, '| 跨域 iframe:', CROSS);

  const logPath = path.join(os.tmpdir(), 'bfb-stylespin.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BAO_DEVTOOLS_PAGE_WS;
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  const startedAt = Date.now();
  const port = await waitUntil(async () => {
    try {
      if (fs.statSync(PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).split('\n')[0]);
        if (p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) return p;
      }
    } catch { /* not yet */ }
    return null;
  }, 40000, 'debug port');
  if (!port) { fixture.close(); process.exit(2); }

  const shell = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || '')) || null;
  }, 30000, 'shell');
  if (!shell) { fixture.close(); process.exit(2); }
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
  })()`, false);

  for (let i = 0; i < 40; i += 1) {
    if (await navigate(pageUrl) === 'submitted') break;
    await sleep(500);
  }
  await sleep(3000);

  for (let i = 0; i < 40; i += 1) {
    const st = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`, false).catch(() => 'no-button');
    if (st === 'clicked') break;
    await sleep(500);
  }

  const front = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /devtools_app\.html/.test(t.url || '')) || null;
  }, 30000, 'frontend');
  if (!front) { client.close(); fixture.close(); process.exit(2); }
  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;
  // 收集前端 console（含我们临时埋的 BFB 标记）
  const frontLogs = [];
  const frontEvents = [];
  fc.onEvent((m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => String(a.value === undefined ? a.description : a.value)).join(' ');
      frontLogs.push(text.slice(0, 160));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails;
      frontEvents.push(String((d && d.text) || '').slice(0, 160));
    }
  });
  await fc.send('Runtime.enable');

  for (const at of [2000, 6000, 12000, 20000]) {
    await sleep(at === 2000 ? 2000 : 4000);
    console.log(`[spin] T+${at}ms:`, await evaluate(fc, STYLES_PROBE));
  }

  // 在 Elements 树里点节点：用户的实际动作，会触发新的 CSS.getMatchedStylesForNode
  const CLICK_NODE = (tag) => `(() => {
    const deep = (sel) => {
      const acc = [];
      const visit = (root) => {
        root.querySelectorAll(sel).forEach((el) => acc.push(el));
        root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
      };
      visit(document);
      return acc;
    };
    const spans = deep('span[class*="webkit-html-tag"]');
    const hit = spans.find((el) => (el.textContent || '').trim().toLowerCase().indexOf('${tag}') === 0)
      || spans[spans.length - 1];
    if (!hit) return 'no-node';
    const r = hit.getBoundingClientRect();
    const opts = { bubbles: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) };
    hit.dispatchEvent(new MouseEvent('mousedown', opts));
    hit.dispatchEvent(new MouseEvent('mouseup', opts));
    hit.dispatchEvent(new MouseEvent('click', opts));
    return 'clicked:' + String(hit.textContent || '').trim().slice(0, 20);
  })()`;

  if (process.env.BFB_CLICK === '1') {
    for (const tag of ['body', 'div', 'html']) {
      console.log(`[spin] 点击 ${tag}:`, await evaluate(fc, CLICK_NODE(tag)));
      await sleep(2500);
      console.log(`[spin] 点击 ${tag} 后样式:`, await evaluate(fc, STYLES_PROBE));
    }
  }

  // 在工具箱页签之间来回切：DevTools 容器会被销毁再重建，前端重新启动。
  if (process.env.BFB_REOPEN === '1') {
    const clickTab = (label) => evaluate(client, `(() => {
      const drawer = document.querySelector('[data-devtools-drawer]');
      if (!drawer) return 'no-drawer';
      const btn = [].slice.call(drawer.querySelectorAll('button')).find((b) => (b.textContent || '').trim().indexOf(${JSON.stringify(label)}) === 0);
      if (!btn) return 'no-tab:' + ${JSON.stringify(label)};
      btn.click();
      return 'clicked:' + ${JSON.stringify(label)};
    })()`, false);
    console.log('[spin] 切到 Flash:', await clickTab('Flash'));
    await sleep(2000);
    console.log('[spin] 切回 DevTools:', await clickTab('DevTools'));
    // 容器重建 = 新的前端 target，旧连接作废
    const reopened = await waitUntil(async () => {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      return (list || []).find((t) => /devtools_app\.html/.test(t.url || '')) || null;
    }, 30000, 'reopened frontend');
    if (reopened) {
      const fc2 = cdp(reopened.webSocketDebuggerUrl);
      await fc2.ready;
      for (const at of [2000, 6000, 12000]) {
        await sleep(at === 2000 ? 2000 : 4000);
        console.log(`[spin] 重开容器后 +${at}ms:`, await evaluate(fc2, STYLES_PROBE));
        console.log(`[spin] 重开容器后 +${at}ms 树:`, await evaluate(fc2, TREE_PROBE));
      }
      // 手动点一下 html：如果样式立刻出来，说明面板是活的，只是"初始选中"丢了
      console.log('[spin] 重开后点 html:', await evaluate(fc2, CLICK_NODE('html')));
      await sleep(2500);
      console.log('[spin] 点了 html 后的样式:', await evaluate(fc2, STYLES_PROBE));
      fc2.close();
    }
  }

  // 探后端是否支持 DOM.pushNodeByPathToFrontend（前端刷新后靠它恢复选中）
  if (process.env.BFB_CDP_PROBE === '1') {
    const pageTarget = await waitUntil(async () => {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      return (list || []).find((t) => t.type === 'page' && !/devtools_app|dist\/renderer/.test(t.url || '')) || null;
    }, 20000, 'page target');
    if (pageTarget) {
      const pc = cdp(pageTarget.webSocketDebuggerUrl);
      await pc.ready;
      console.log('[spin] DOM.enable:', JSON.stringify(await pc.send('DOM.enable')));
      console.log('[spin] pushNodeByPathToFrontend:', JSON.stringify(await pc.send('DOM.pushNodeByPathToFrontend', { path: 'html,body' })));
      console.log('[spin] pushNodesByBackendIdsToFrontend:', JSON.stringify(await pc.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [1] })));
      pc.close();
    }
  }

  // 抓后端在导航时发出的 DOM 事件：87 是否真的会发 DOM.documentUpdated？
  if (process.env.BFB_DOM_EVENTS === '1') {
    const pageTarget = await waitUntil(async () => {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      return (list || []).find((t) => t.type === 'page' && !/devtools_app|dist\/renderer/.test(t.url || '')) || null;
    }, 20000, 'page target');
    if (pageTarget) {
      const events = [];
      const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
      const pendingSends = new Map();
      let seq = 0;
      socket.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.id && pendingSends.has(m.id)) { pendingSends.get(m.id)(m); pendingSends.delete(m.id); return; }
        if (m.method) events.push(m.method);
      });
      await new Promise((res) => socket.once('open', res));
      const send = (method, params = {}) => new Promise((res) => {
        const id = ++seq;
        pendingSends.set(id, res);
        socket.send(JSON.stringify({ id, method, params }));
      });
      await send('Page.enable');
      await send('DOM.enable');
      await send('Runtime.enable');
      events.length = 0;
      await send('Page.reload', { ignoreCache: false });
      await sleep(6000);
      const counts = {};
      for (const name of events) counts[name] = (counts[name] || 0) + 1;
      console.log('[spin] 导航期间后端事件:', JSON.stringify(counts));
      try { socket.close(); } catch { /* ignore */ }
    }
  }

  // 刷新当前页面（不切标签）：前端会收到 documentUpdated 并重建树，
  // 选中节点在新文档里已不存在——这正是"刷新一下样式就空了"的场景。
  if (process.env.BFB_RELOAD === '1') {
    const pageTarget = await waitUntil(async () => {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      return (list || []).find((t) => t.type === 'page' && !/devtools_app|dist\/renderer/.test(t.url || '')) || null;
    }, 20000, 'page target');
    if (pageTarget) {
      const pc = cdp(pageTarget.webSocketDebuggerUrl);
      await pc.ready;
      await pc.send('Page.reload', { ignoreCache: false });
      pc.close();
      console.log('[spin] 已触发页面刷新:', String(pageTarget.url).slice(0, 60));
    }
    for (const at of [1500, 4000, 8000]) {
      await sleep(at === 1500 ? 1500 : 2500);
      console.log(`[spin] 刷新后 +${at}ms:`, await evaluate(fc, STYLES_PROBE));
      console.log(`[spin] 刷新后 +${at}ms 树:`, await evaluate(fc, TREE_PROBE));
    }
    const flow = await evaluate(client, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) {
      var list = (s.flow || []).filter(function (f) { return String(f.m).indexOf('DOM.') === 0 || String(f.m).indexOf('CSS.') === 0; });
      return JSON.stringify({ flow: list.slice(-10), lastDoc: s.lastDoc, docEvents: (s.trace || []).filter(function (t) { return String(t.m).indexOf('documentUpdated') >= 0 || String(t.m).indexOf('frameNavigated') >= 0; }).slice(-10) });
    })`);
    console.log('[spin] 刷新后的 DOM/CSS 流水:', flow);
  }

  // 切标签：桥会 detach/attach 换 session，这正是「请求发出去了、响应再也没回来」的窗口。
  if (process.env.BFB_SWITCH === '1') {
    await evaluate(client, `(() => { const b = document.querySelector('.btn-tab.no-drag'); if (b) b.click(); return 'ok'; })()`, false);
    await waitUntil(async () => {
      const v = await evaluate(client, `(() => { const el = document.querySelector('.address-input'); return el ? 'v:' + el.value : null; })()`, false);
      return typeof v === 'string' && v.indexOf('/page') === -1 ? v : null;
    }, 15000, 'new tab active');
    await sleep(600);
    await navigate(pageUrl);
    await sleep(1500);
    for (const at of [1500, 5000, 12000, 20000]) {
      await sleep(at === 1500 ? 1500 : 4000);
      console.log(`[spin] 切标签后 +${at}ms:`, await evaluate(fc, STYLES_PROBE));
    }
    // 切回原标签
    await evaluate(client, `(() => {
      const items = document.querySelectorAll('.tab-inner');
      if (!items[0]) return 'no-tab';
      const r = items[0].getBoundingClientRect();
      const opts = { bubbles: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) };
      items[0].dispatchEvent(new MouseEvent('mousedown', opts));
      items[0].dispatchEvent(new MouseEvent('mouseup', opts));
      items[0].dispatchEvent(new MouseEvent('click', opts));
      return 'clicked';
    })()`, false);
    await sleep(4000);
    console.log('[spin] 切回后:', await evaluate(fc, STYLES_PROBE));
  }

  const stats = await evaluate(client, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) {
    var css = (s.flow || []).filter(function (f) { return String(f.m).indexOf('CSS.') === 0; });
    return JSON.stringify({
      state: s.state, failed: s.failed,
      cssReq: css.filter(function (f) { return f.d === '>'; }).length,
      cssResp: css.filter(function (f) { return f.d === '<'; }).length,
      cssFlow: css.slice(-8),
    });
  })`);
  console.log('[spin] bridge CSS 流水:', stats);

  console.log('[spin] 前端 console:', frontLogs.length, JSON.stringify(frontLogs.slice(-8)));
  console.log('[spin] BFB 标记:', JSON.stringify(frontLogs.filter((line) => line.indexOf('BFB') === 0).slice(-10)));
  console.log('[spin] 前端异常:', frontEvents.length, JSON.stringify(frontEvents.slice(-4)));
  fc.close();
  client.close();
  fixture.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[spin] failed:', e && e.message); process.exit(1); });
