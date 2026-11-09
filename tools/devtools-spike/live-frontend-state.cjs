/**
 * 检查运行中 DevTools 前端（devtools_app.html）的 SDK 状态：
 * target/model 是否就绪、CSS 模型能否取到 matched styles、以及控制台异常。
 * 用法：先 node tools/devtools-spike/live-open-drawer.cjs，再跑本脚本。
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
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
    let seq = 0;
    const pending = new Map();
    const events = [];
    ws.on('open', () => resolve({ call, close: () => ws.close(), events }));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method) {
        events.push(m);
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
        }, 25000);
      });
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPR = `(async () => {
  const out = {};
  const TM = self.SDK && self.SDK.targetManager;
  out.hasSDK = !!TM;
  const targets = TM ? TM.targets() : [];
  out.targets = targets.map(t => ({ id: t.id(), type: t.type(), name: t.name(), url: (t.inspectedURL && t.inspectedURL()) || '', hasDom: !!t.model(self.SDK.DOMModel.DOMModel), hasCss: !!t.model(self.SDK.CSSModel.CSSModel) }));
  const main = TM && TM.mainTarget();
  out.main = main ? { id: main.id(), url: main.inspectedURL && main.inspectedURL() } : null;
  const view = self.UI && self.UI.InspectorView && self.UI.InspectorView.InspectorView.instance();
  out.panel = view && view.currentPanel ? view.currentPanel().name : null;
  out.drawer = view && view.drawerTabbedPane ? 'ok' : 'n/a';
  const dom = main && main.model(self.SDK.DOMModel.DOMModel);
  const css = main && main.model(self.SDK.CSSModel.CSSModel);
  out.cssEnabled = css ? css.isEnabled && css.isEnabled() : null;
  if (dom) {
    const doc = dom.existingDocument();
    out.doc = doc ? { id: doc.id, hasBody: !!doc.body } : null;
    const body = doc && doc.body ? doc.body() : null;
    out.body = body ? { id: body.id, name: body.nodeName && body.nodeName() } : null;
  }
  if (dom && css) {
    try {
      const doc = await dom.requestDocument();
      const body = doc.body();
      out.requestDocument = { id: doc.id, bodyId: body ? body.id : null };
      const ms = await css.getMatchedStylesForNode(body.id);
      out.matched = ms ? { inline: !!ms.inlineStyle, rules: ms.matchedCSSRules ? ms.matchedCSSRules.length : 0 } : 'null';
      const cs = await css.getComputedStyleForNode(body.id);
      out.computed = cs ? cs.length : 'null';
    } catch (e) {
      out.err = String(e && e.message ? e.message : e);
    }
  }
  out.bfbBridge = typeof self.bfbBridge;
  return out;
})()`;

async function main() {
  const port = readPort();
  const targets = await httpJson(port, '/json/list');
  const front = targets.find((t) => (t.url || '').includes('devtools-frontend'));
  if (!front) throw new Error('devtools 前端未打开');
  const client = await connect(front.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Log.enable');
  await sleep(1200);
  const res = await client.call('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) console.log('EXC', JSON.stringify(res.exceptionDetails).slice(0, 1200));
  console.log(JSON.stringify(res.result && res.result.value, null, 2));

  const interesting = client.events.filter(
    (e) =>
      e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) ||
      e.method === 'Log.entryAdded',
  );
  const buckets = new Map();
  for (const e of interesting) {
    const args = e.params && e.params.args ? e.params.args.map((a) => a.value || a.description || '').join(' ') : '';
    const text = String(e.params && e.params.entry ? e.params.entry.text : args);
    const key = text.replace(/\{.*$/, '').slice(0, 140);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  console.log('--- 聚合错误 (' + interesting.length + ' 条 / ' + buckets.size + ' 种) ---');
  for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), k);
  const nodeErrs = interesting.filter((e) => JSON.stringify(e.params).includes('node'));
  console.log('--- 含 node 的错误: ' + nodeErrs.length + ' ---');
  for (const e of nodeErrs.slice(-6)) console.log(JSON.stringify(e.params).slice(0, 400));
  client.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
