/**
 * 直连“正在运行”的应用，走外壳渲染层调 DevTools 桥，手动重放 Elements→Styles 的 CDP 流水。
 * 用途：当 UI 转圈但日志无异常时，取出 CSS.getMatchedStylesForNode 的真实返回/错误文本。
 *
 * 用法：node tools/devtools-spike/live-bridge-probe.cjs
 * 依赖：应用已通过 npm start 启动（DevToolsActivePort 可读）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');

function readPort() {
  const raw = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/);
  return Number(raw[0]);
}

function httpJson(port, pathName) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: pathName, timeout: 6000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`bad json: ${body.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    let seq = 0;
    const pending = new Map();
    ws.on('open', () => resolve({ call, close }));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(JSON.stringify(msg.error)));
        else ok(msg.result);
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
            fail(new Error(`timeout: ${method}`));
          }
        }, 30000);
      });
    }
    function close() {
      ws.close();
    }
  });
}

async function main() {
  const port = readPort();
  const targets = await httpJson(port, '/json/list');
  const shell = targets.find((t) => (t.url || '').includes('/dist/renderer/index.html'));
  if (!shell) throw new Error('找不到外壳渲染层 target');
  console.log('shell target =', shell.id.slice(0, 12));

  const client = await connect(shell.webSocketDebuggerUrl);
  await client.call('Runtime.enable');

  const script = `(async () => {
    const b = window.electronAPI.devtoolbox.bridge;
    const brief = (label, r) => {
      if (!r) return { label, r: 'undefined' };
      const err = r.error ? (typeof r.error === 'string' ? r.error : (r.error.message || JSON.stringify(r.error))) : null;
      const res = r.result || null;
      const shape = res && typeof res === 'object' ? Object.keys(res).slice(0, 8) : typeof res;
      const sample = res && res.matchedCSSRules ? { rules: res.matchedCSSRules.length }
        : res && res.root ? { nodeId: res.root.nodeId, childCount: res.root.childNodeCount }
        : res && res.computedStyle ? { computed: res.computedStyle.length } : null;
      return { label, ok: r.ok, err, keys: shape, sample };
    };
    const out = { steps: [] };
    const att = await b.attach('page');
    out.steps.push(brief('attach', att));
    out.steps.push(brief('DOM.enable', await b.send('DOM.enable')));
    out.steps.push(brief('CSS.enable', await b.send('CSS.enable')));
    const doc = await b.send('DOM.getDocument', { depth: 1 });
    out.steps.push(brief('DOM.getDocument', doc));
    const rootId = doc && doc.result && doc.result.root ? doc.result.root.nodeId : null;
    if (rootId) out.steps.push(brief('CSS.getMatchedStyles(root)', await b.send('CSS.getMatchedStylesForNode', { nodeId: rootId })));
    const body = await b.send('DOM.querySelector', { nodeId: rootId, selector: 'body' });
    out.steps.push(brief('DOM.querySelector(body)', body));
    const bodyId = body && body.result ? body.result.nodeId : null;
    if (bodyId) {
      out.steps.push(brief('CSS.getMatchedStyles(body)', await b.send('CSS.getMatchedStylesForNode', { nodeId: bodyId })));
      out.steps.push(brief('CSS.getComputedStyle(body)', await b.send('CSS.getComputedStyleForNode', { nodeId: bodyId })));
      out.steps.push(brief('CSS.getInlineStyles(body)', await b.send('CSS.getInlineStylesForNode', { nodeId: bodyId })));
    }
    if (rootId) out.steps.push(brief('CSS.getComputedStyle(root)', await b.send('CSS.getComputedStyleForNode', { nodeId: rootId })));
    out.bodyId = bodyId;
    return out;
  })()`;

  const res = await client.call('Runtime.evaluate', {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    console.log('EXCEPTION', JSON.stringify(res.exceptionDetails, null, 2).slice(0, 2000));
  }
  const value = res.result && res.result.value;
  console.log(JSON.stringify(value, null, 2).slice(0, 8000));
  await client.call('Runtime.evaluate', {
    expression: 'window.electronAPI.devtoolbox.bridge.detach()',
    awaitPromise: true,
    returnByValue: true,
  });
  client.close();
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
