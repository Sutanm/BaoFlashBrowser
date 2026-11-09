/**
 * 端到端验证「重开抽屉后 Styles 不再转圈」：
 *   建标签开 pkt 页 → 第一次开抽屉（检查）→ 关抽屉 → 第二次开抽屉（原失败场景，检查）。
 * 每次检查读前端 stylesWidget 的 hasMatchedStyles、CSSModel 头部数量、styles 窗格文本。
 * 用法：node tools/devtools-spike/live-reopen-check.cjs
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');
const readPort = () => Number(fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]);

function httpJson(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(new Error(String(b).slice(0, 200)));
          }
        });
      })
      .on('error', reject);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    let seq = 0;
    const pending = new Map();
    ws.on('open', () => resolve({ call, close: () => ws.close() }));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    ws.on('error', reject);
    function call(method, params) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      return new Promise((ok, fail) => {
        pending.set(id, { resolve: ok, reject: fail });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            fail(new Error(`timeout ${method}`));
          }
        }, 30000);
      });
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withShell(port, fn) {
  const targets = await httpJson(port, '/json/list');
  const shell = targets.find((t) => (t.url || '').includes('/dist/renderer/index.html'));
  if (!shell) throw new Error('no shell target');
  const client = await connect(shell.webSocketDebuggerUrl);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function withFrontend(port, fn) {
  const targets = await httpJson(port, '/json/list');
  const front = targets.find((t) => (t.url || '').includes('devtools-frontend'));
  if (!front) return { open: false };
  const client = await connect(front.webSocketDebuggerUrl);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

const CHECK_EXPR = `(async () => {
  const out = {};
  try {
    const sw = self.UI.panels.elements.stylesWidget;
    out.hasMatchedStyles = sw.hasMatchedStyles;
    const node = sw.node();
    out.node = node ? { id: node.id, name: node.nodeName && node.nodeName() } : null;
    if (node) {
      const css = node.domModel().cssModel();
      out.cssEnabled = css.isEnabled();
      const headers = css.styleSheetHeaders ? css.styleSheetHeaders() : null;
      out.knownHeaderCount = headers ? (headers.size !== undefined ? headers.size : Object.keys(headers).length) : 'n/a';
      const fn = css.getMatchedStylesPromise || css.getMatchedStyles;
      out.race = await Promise.race([
        fn.call(css, node.id).then((r) => ({ resolved: true, rules: r && r.matchedCSSRules ? r.matchedCSSRules.length : 0 }))
          .catch((e) => ({ threw: String(e && e.message || e).slice(0, 120) })),
        new Promise((r) => setTimeout(() => r({ PENDING: true }), 8000)),
      ]);
    }
  } catch (e) { out.err = String(e && e.message || e).slice(0, 160); }
  return out;
})()`;

async function check(tag, port) {
  const res = await withFrontend(port, (client) =>
    client.call('Runtime.evaluate', { expression: CHECK_EXPR, awaitPromise: true, returnByValue: true }),
  );
  const value = res && res.result && res.result.value;
  console.log(`[${tag}]`, JSON.stringify(value));
  return value;
}

async function main() {
  const port = readPort();
  const url = process.argv[2] || 'https://news.7k7k.com/pkt/?lt';
  const tabId = 'probe-' + Date.now().toString(36);

  await withShell(port, async (client) => {
    await client.call('Runtime.evaluate', {
      expression: `window.electronAPI.tab.create(${JSON.stringify(tabId)}, ${JSON.stringify(url)})`,
      awaitPromise: true,
      returnByValue: true,
    });
  });
  console.log('tab created:', tabId);
  await sleep(9000);
  await withShell(port, async (client) => {
    await client.call('Runtime.evaluate', {
      expression: `window.electronAPI.tab.activate(${JSON.stringify(tabId)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    await sleep(300);
    await client.call('Runtime.evaluate', {
      expression: `(async()=>{const d=window.electronAPI.devtoolbox;await d.attachDevToolsView('page',${JSON.stringify(
        tabId,
      )});try{await d.setDevToolsBounds({x:0,y:420,width:1280,height:300})}catch(e){}return 1;})()`,
      awaitPromise: true,
      returnByValue: true,
    });
  });
  console.log('drawer open #1');
  await sleep(6000);
  await check('第一次打开', port);

  await withShell(port, async (client) => {
    await client.call('Runtime.evaluate', {
      expression: `window.electronAPI.devtoolbox.detachDevToolsView()`,
      awaitPromise: true,
      returnByValue: true,
    });
  });
  console.log('drawer closed');
  await sleep(2500);

  await withShell(port, async (client) => {
    await client.call('Runtime.evaluate', {
      expression: `(async()=>{const d=window.electronAPI.devtoolbox;await d.attachDevToolsView('page',${JSON.stringify(
        tabId,
      )});try{await d.setDevToolsBounds({x:0,y:420,width:1280,height:300})}catch(e){}return 1;})()`,
      awaitPromise: true,
      returnByValue: true,
    });
  });
  console.log('drawer open #2 (原失败场景)');
  await sleep(6000);
  await check('第二次打开', port);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
