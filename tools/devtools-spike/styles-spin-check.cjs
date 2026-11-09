#!/usr/bin/env node
/**
 * 复现「Styles 面板一直转圈」并抓桥的 CDP 流水。
 *
 *   node tools/devtools-spike/styles-spin-check.cjs
 *   BFB_CROSS=1 node tools/devtools-spike/styles-spin-check.cjs   # 页面带跨域 iframe（会触发 CDP 深探）
 *   BFB_RELOAD=1 BFB_CLICK=1 BFB_URL=https://news.7k7k.com/pkt/ node tools/devtools-spike/styles-spin-check.cjs
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bfb-styles-'));
const PORT_FILE = path.join(profile, 'DevToolsActivePort');
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
  let documentNumber = 0;
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.startsWith('/game')) {
      res.end('<!doctype html><html><head><title>game</title></head><body><div id="inner">inner</div></body></html>');
      return;
    }
    const port = server.address().port;
    if (url === '/page') documentNumber += 1;
    res.end(`<!doctype html><html><head><title>spin</title>
      <style>
        body { margin: 0; font: 16px system-ui; }
        #target { color: rgb(220, 30, 60); padding: 12px; border: 2px solid #36c; }
        .document-${documentNumber} { background-color: white; }
      </style></head><body>
      <div id="target" class="document-${documentNumber}">STYLED-NODE</div>
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
  const { server: fixture, port: fixturePort } = await startFixture();
  const pageUrl = process.env.BFB_URL || `http://127.0.0.1:${fixturePort}/page`;
  console.log('[spin] page:', pageUrl, '| 跨域 iframe:', CROSS);

  const logPath = path.join(profile, 'styles-spin.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${profile}`], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });
  process.once('exit', () => child.kill());

  const port = await waitUntil(async () => {
    try {
      const p = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).split('\n')[0]);
      if (p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) return p;
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
  const shellReady = await waitUntil(() => evaluate(client, `(() => {
    if (document.querySelector('.address-input')) return true;
    const button = document.querySelector('.first-run-dialog button[type="submit"]:enabled');
    if (button) button.click();
    return false;
  })()`, false), 20000, 'first-run language and address bar');
  if (!shellReady) throw new Error('Browser shell unavailable after language selection');
  console.log('[spin] 浏览器外壳已就绪');

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
  // BFB_OPEN_EARLY=1：页面还在加载时就开抽屉（用户的真实习惯）。默认等 3s。
  if (process.env.BFB_OPEN_EARLY !== '1') await sleep(3000);

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

  for (const at of process.env.BFB_RELOAD === '1' ? [2000] : [2000, 6000, 12000, 20000]) {
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
    const selection = `(async () => {
      const [sdk, ui] = await Promise.all([import('./core/sdk/sdk.js'), import('./ui/legacy/legacy.js')]);
      const node = ui.Context.Context.instance().flavor(sdk.DOMModel.DOMNode);
      const model = node && node.domModel();
      return JSON.stringify({
        node: node && node.id,
        name: node && node.nodeName(),
        document: model && model.existingDocument()?.id,
        loader: model && model.target().model(sdk.ResourceTreeModel.ResourceTreeModel)?.mainFrame?.loaderId,
        current: !!node && model.nodeForId(node.id) === node,
      });
    })()`;
    if (!process.env.BFB_URL) {
      await evaluate(fc, CLICK_NODE('<div'));
      const before = await waitUntil(async () => {
        const styles = JSON.parse(await evaluate(fc, STYLES_PROBE));
        return styles.head.includes('.document-1');
      }, 5000, 'initial fixture selector');
      if (!before) throw new Error('Styles did not show the selected fixture node');
    }
    const before = JSON.parse(await evaluate(fc, selection));
    console.log('[spin] 刷新前选中节点:', before);
    if (!before.current || !before.loader) throw new Error('No selected node before reload');
    const refreshed = await evaluate(client, `(() => {
      const button = document.querySelector('button[title$="(F5)"]');
      if (!button) return false;
      button.click();
      return true;
    })()`, false);
    if (!refreshed) throw new Error('Page reload button unavailable');
    for (const at of [1500, 4000, 8000]) {
      await sleep(at === 1500 ? 1500 : at === 4000 ? 2500 : 4000);
      console.log(`[spin] 刷新后 +${at}ms:`, await evaluate(fc, STYLES_PROBE));
      console.log(`[spin] 刷新后 +${at}ms 树:`, await evaluate(fc, TREE_PROBE));
      console.log(`[spin] 刷新后 +${at}ms 选中节点:`, await evaluate(fc, selection));
    }
    const flow = await evaluate(client, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) {
      var list = (s.flow || []).filter(function (f) { return String(f.m).indexOf('DOM.') === 0 || String(f.m).indexOf('CSS.') === 0; });
      var keep = { 'DOM.getDocument': 1, 'DOM.documentUpdated': 1, 'Page.frameNavigated': 1, 'CSS.getMatchedStylesForNode': 1, 'CSS.enable': 1, 'DOM.enable': 1 };
      var seq = (s.flow || []).filter(function (f) { return keep[f.m]; }).map(function (f) { return f.d + ' ' + f.m + (f.x ? ' [' + f.x + ']' : ''); });
      return JSON.stringify({ seq: seq, total: seq.length, lastDoc: s.lastDoc });
    })`);
    console.log('[spin] 刷新后的 DOM/CSS 流水:', flow);
    const after = JSON.parse(await evaluate(fc, selection));
    const styles = JSON.parse(await evaluate(fc, STYLES_PROBE));
    if (!after.current || !after.loader || after.loader === before.loader) throw new Error('Selection did not reach the reloaded document');
    if (!styles.hasRules || (!process.env.BFB_URL && !styles.head.includes('.document-2'))) {
      throw new Error('Styles did not show rules for the reloaded document');
    }
  }

  // 新标签页（没有 BrowserView）→ 占位出现要快；再切回来要能出样式
  if (process.env.BFB_NEWTAB === '1') {
    const startAt = Date.now();
    await evaluate(client, `(() => { const b = document.querySelector('.btn-tab.no-drag'); if (b) b.click(); return 'ok'; })()`, false);
    const placeholderAt = await waitUntil(async () => {
      const text = await evaluate(client, `(() => {
        const drawer = document.querySelector('[data-devtools-drawer]');
        return drawer ? String(drawer.innerText || '') : '';
      })()`, false);
      return typeof text === 'string' && text.indexOf('没有可调试的页面') !== -1 ? Date.now() - startAt : null;
    }, 20000, 'no-target placeholder');
    console.log('[spin] 新标签页占位耗时:', placeholderAt === null ? '未出现' : `${placeholderAt}ms`);

    await sleep(800);
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
    for (const at of [1200, 4000, 9000]) {
      await sleep(at === 1200 ? 1200 : 2800);
      // 容器是新建的：旧的前端 target 已销毁，重新取一个
      const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      const front = (list || []).find((t) => /devtools_app\.html/.test(t.url || ''));
      if (!front) { console.log(`[spin] 切回后 +${at}ms: 没有前端 target`); continue; }
      const fc2 = cdp(front.webSocketDebuggerUrl);
      await fc2.ready;
      console.log(`[spin] 切回后 +${at}ms:`, await evaluate(fc2, STYLES_PROBE));
      console.log(`[spin] 切回后 +${at}ms 树:`, await evaluate(fc2, TREE_PROBE));
      fc2.close();
    }
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

  // 会话轮换（87 号 bug 的自动恢复路径）：rotate 后 session 必须变化、样式必须存活
  if (process.env.BFB_ROTATE === '1') {
    const before = JSON.parse(await evaluate(client, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) {
      return JSON.stringify({ session: s.sessionId, target: s.targetId });
    })`));
    console.log('[spin] 轮换前 session:', before.session, '| 样式:', await evaluate(fc, STYLES_PROBE));
    console.log('[spin] 调用 rotate:', await evaluate(fc, `(() => { window.bfbBridge.rotate(); return 'called'; })()`, false));
    await sleep(2500);
    const after = JSON.parse(await evaluate(client, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) {
      return JSON.stringify({ session: s.sessionId, target: s.targetId });
    })`));
    console.log('[spin] 轮换后 session:', after.session, '| session 变化:', before.session !== after.session);
    console.log('[spin] 轮换后样式:', await evaluate(fc, STYLES_PROBE));
    console.log('[spin] 轮换后点 div:', await evaluate(fc, CLICK_NODE('<div')));
    await sleep(2500);
    const afterStyles = JSON.parse(await evaluate(fc, STYLES_PROBE));
    console.log('[spin] 点后样式:', await evaluate(fc, STYLES_PROBE));
    if (before.session === after.session) throw new Error('session did not rotate');
    if (!afterStyles.hasRules) throw new Error('styles lost after rotation');
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
