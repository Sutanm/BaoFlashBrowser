#!/usr/bin/env node
/**
 * S11：桥模式端到端验证（B3）——前端走 BfbBridgeConnection → 外壳中继 → IPC → 桥。
 *   BAO_DEVTOOLS_BRIDGE=1 node tools/devtools-spike/bridge-mode-check.cjs
 *
 * 判定：
 *   1 iframe URL 不带 ws、带 bfb_target
 *   2 iframe 内 Elements 树渲染出 fixture 的 #mark 节点（说明 CDP 消息经桥往返成功）
 *   3 桥 stats：sent / events 增长
 *   4 前端无未捕获异常
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
  const tags = [].slice.call(document.querySelectorAll('.elements-tree-outline *[class*="webkit-html"]')).map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 40);
  return JSON.stringify({
    htmlSpans: texts.length,
    hasMark: texts.some((t) => t.indexOf('mark') !== -1),
    hasBridgeText: texts.some((t) => t.indexOf('BRIDGE') !== -1),
    sample: texts.slice(0, 10),
    tagList: tags,
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
  });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const { server: fixtureServer, port: fixturePort } = await startFixture();
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

  // BFB_NO_BRIDGE=1 → 走 page-ws 基线，用于对照（同一 fixture、同一探针）
  const baseline = process.env.BFB_NO_BRIDGE === '1';
  const logPath = path.join(os.tmpdir(), 'bfb-s11.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  if (!baseline) env.BAO_DEVTOOLS_BRIDGE = '1';
  else delete env.BAO_DEVTOOLS_BRIDGE;
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

  // 等前端 iframe target
  let front = null;
  for (let i = 0; i < 60 && !front; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    front = (list || []).find((t) => /devtools_app\.html\?can_dock=true/.test(t.url || ''));
    if (!front) await sleep(500);
  }
  console.log('[s11] frontend url:', front ? front.url.slice(0, 110) : 'NOT FOUND');
  if (!front) { console.log('[s11] 桥模式 URL 没出现'); client.close(); fixtureServer.close(); child.kill(); process.exit(2); }

  const fc = wsClient(front.webSocketDebuggerUrl);
  await fc.ready;
  await fc.send('Runtime.enable');
  await sleep(12000);

  const probe = await evaluate(fc, DEEP_PROBE);
  console.log('[s11] iframe probe:', probe);

  const exceptions = fc.events
    .filter((m) => m.method === 'Runtime.exceptionThrown')
    .map((m) => {
      const d = m.params && m.params.exceptionDetails;
      return String((d && d.exception && (d.exception.description || d.exception.value)) || (d && d.text) || '').slice(0, 200);
    });
  console.log('[s11] iframe exceptions:', exceptions.length, JSON.stringify(exceptions.slice(0, 4)));

  // 桥 stats（经外壳）
  const statsRaw = baseline ? JSON.stringify({ baseline: true }) : await evaluate(client, `window.electronAPI.devtoolbox.bridge.stats().then(function (s) { return JSON.stringify(s); })`, true);
  console.log('[s11] bridge stats:', statsRaw);
  try {
    fs.mkdirSync(path.join(APP_ROOT, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(APP_ROOT, 'artifacts', 'bridge-stats.json'), statsRaw);
  } catch { /* ignore */ }

  // 一锤定音：桥 attach 的 targetId 对应哪个 URL？当前活动标签是谁？
  try {
    const statsObj = JSON.parse(statsRaw);
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const bound = (list || []).find((t) => t.id === statsObj.targetId);
    console.log('[s11] bridge target url:', bound ? bound.url : 'NOT FOUND', '| type:', bound ? bound.type : '-');
    const pages = (list || []).filter((t) => t.type === 'page').map((t) => `${t.id.slice(0, 6)} ${t.url}`);
    console.log('[s11] all page targets:', JSON.stringify(pages, null, 0));
    const activeUrl = await evaluate(client, `(() => { const el = document.querySelector('.address-input'); return el ? el.value : null; })()`);
    console.log('[s11] address bar:', activeUrl);
  } catch (e) { console.log('[s11] target 对照失败:', e.message); }

  // 诊断：桥命令落到哪个文档
  const docInfo = await evaluate(client, `window.electronAPI.devtoolbox.bridge.send('DOM.getDocument', { depth: 2 }).then(function (r) {
    if (!r.ok) return 'err=' + JSON.stringify(r.error);
    var root = r.result && r.result.root;
    return JSON.stringify({
      nodeName: root && root.nodeName,
      childCount: root && root.childNodeCount,
      docUrl: root && root.documentURL,
      kids: root && (root.children || []).map(function (c) { return c.nodeName + '#' + c.childNodeCount; }),
    });
  })`, true);
  console.log('[s11] bridge DOM.getDocument:', docInfo);

  // 从 iframe 内部直接经中继发一条命令，验证"链路数据"本身是否正确
  await evaluate(fc, `(() => {
    window.__rawProbe = null;
    window.__rawEvents = [];
    if (!window.__rawHooked) {
      window.__rawHooked = true;
      window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || d.source !== 'bfb-devtools-bridge') return;
        if (d.kind === 'response' && d.id === 999) window.__rawProbe = JSON.stringify({ result: d.result, error: d.error }).slice(0, 260);
        if (d.kind === 'event') window.__rawEvents.push(d.method);
      });
    }
    window.parent.postMessage({ source: 'bfb-devtools-bridge', kind: 'cdp', payload: JSON.stringify({ id: 999, method: 'DOM.getDocument', params: { depth: 1 } }) }, '*');
    setTimeout(function () {
      var doc = window.__rawProbe ? JSON.parse(window.__rawProbe) : null;
      var rootId = doc && doc.result && doc.result.root && doc.result.root.nodeId;
      window.__rootId = rootId;
      if (rootId) window.parent.postMessage({ source: 'bfb-devtools-bridge', kind: 'cdp', payload: JSON.stringify({ id: 998, method: 'DOM.requestChildNodes', params: { nodeId: rootId, depth: 2 } }) }, '*');
    }, 400);
    return 'sent';
  })()`);
  await sleep(2500);
  const rawProbe = await evaluate(fc, `JSON.stringify({ probe: window.__rawProbe, events: window.__rawEvents.slice(0, 10), eventCount: window.__rawEvents.length })`);
  console.log('[s11] iframe raw probe:', rawProbe);
  // 外部直查 fixture 页面的真实 DOM（绕过桥，判断是页面本身还是桥数据的问题）
  try {
    const list2 = await getJson('http://127.0.0.1:' + port + '/json/list').catch(() => []);
    const pageT = (list2 || []).find((t) => t.type === 'page' && /127.0.0.1/.test(t.url || ''));
    if (pageT) {
      const pc = wsClient(pageT.webSocketDebuggerUrl);
      await pc.ready;
      const dom = await pc.send('Runtime.evaluate', { expression: 'document.body.innerHTML.replace(/s+/g, " ").slice(0, 200) + " ||CHILDREN=" + [].map.call(document.body.children, function(e){return e.tagName+"#"+e.id}).join(",") + " ||TOTAL=" + document.body.children.length', returnByValue: true });
      console.log('[s11] real page body (external CDP):', JSON.stringify(dom && dom.result && dom.result.result && dom.result.result.value));
      pc.close();
      const shellT = (list2 || []).find((t) => (t.url || '').indexOf('dist/renderer/index.html') !== -1);
      if (shellT) {
        const sc = wsClient(shellT.webSocketDebuggerUrl);
        await sc.ready;
        const sdom = await sc.send('Runtime.evaluate', { expression: '(document.body.innerHTML.replace(/s+/g, " ")).slice(0, 300)', returnByValue: true });
        console.log('[s11] shell body (external CDP):', JSON.stringify(sdom && sdom.result && sdom.result.result && sdom.result.result.value));
        sc.close();
      }
    }
  } catch (e) { console.log('[s11] external dom check failed:', e.message); }
  const relayCount = await evaluate(client, 'String(window.__bfbRelayEvents || 0)');
  console.log('[s11] relay events (renderer):', relayCount);
  const postStats = await evaluate(client, 'JSON.stringify({ ok: window.__bfbPostOk || 0, noSource: window.__bfbPostNoSource || 0, err: window.__bfbPostErr || 0 })');
  console.log('[s11] relay post stats:', postStats);

  // 抓前端实际收发：hook parent.postMessage 与 message 事件
  await evaluate(fc, `(() => {
    window.__sent = [];
    window.__recv = [];
    if (!window.__origPost) {
      window.__origPost = window.parent.postMessage.bind(window.parent);
      window.parent.postMessage = function (msg, origin) {
        try { window.__sent.push(msg.kind + (msg.kind === 'cdp' ? ':' + JSON.parse(msg.payload).method : '')); } catch (e) { window.__sent.push('?'); }
        return window.__origPost(msg, origin);
      };
      window.addEventListener('message', function (e) {
        var d = e.data;
        if (d && d.source === 'bfb-devtools-bridge') window.__recv.push(d.kind + (d.method ? ':' + d.method : '') + (d.error ? ':ERR' : ''));
      });
    }
    return 'hooked';
  })()`);
  await sleep(4000);
  const flow = await evaluate(fc, `JSON.stringify({
    sent: window.__sent.slice(-14),
    recv: window.__recv.slice(-14),
    sentCount: window.__sent.length,
    recvCount: window.__recv.length,
  })`);
  console.log('[s11] iframe flow:', flow);

  const shot = await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot) {
    fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
    fs.writeFileSync(SHOT_PATH, Buffer.from(shot.result.data, 'base64'));
    console.log('[s11] screenshot:', SHOT_PATH);
  }

  fc.close();
  client.close();
  fixtureServer.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
