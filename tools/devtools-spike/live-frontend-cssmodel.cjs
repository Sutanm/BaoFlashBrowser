/**
 * 在运行中的 DevTools 前端里直接探测 CSS 模型：
 * 选中节点的 cssModel 是否 enabled、手动调 getMatchedStyles 是否会 resolve、
 * 以及 Elements 面板当前状态。用于诊断“Styles 窗格永远 spinner”。
 * 用法：node tools/devtools-spike/live-frontend-cssmodel.cjs
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
    const events = [];
    ws.on('open', () => resolve({ call, close: () => ws.close(), events }));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p({ error: m.error }) : p(m);
      } else if (m.method) {
        events.push(m);
      }
    });
    ws.on('error', reject);
    function call(method, params) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      return new Promise((ok) => {
        pending.set(id, ok);
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            ok({ timeout: true });
          }
        }, 30000);
      });
    }
  });
}

const EXPR = `(async () => {
  const out = {};
  const PanelCtor = self.Elements && self.Elements.ElementsPanel && self.Elements.ElementsPanel.ElementsPanel;
  out.hasPanel = !!PanelCtor;
  const panel = PanelCtor ? PanelCtor.instance() : null;
  if (!panel) return out;
  const node = panel.selectedNode ? panel.selectedNode() : null;
  out.selected = node ? { id: node.id, name: node.nodeName && node.nodeName(), hasDom: !!node.domModel() } : null;
  if (!node) return out;
  const css = node.domModel().cssModel();
  out.cssEnabled = css.isEnabled();
  out.cssAgentSession = css.target() ? 'has-target' : 'no-target';
  // 手动调一次，10s 竞速
  const race = await Promise.race([
    css.getMatchedStylesPromise ? css.getMatchedStylesPromise(node.id) : css.getMatchedStyles(node.id)
      .then((r) => ({ ok: !!r, rules: r && r.matchedCSSRules ? r.matchedCSSRules.length : 0 }))
      .catch((e) => ({ threw: String(e && e.message || e) })),
    new Promise((r) => setTimeout(() => r({ pending: true }), 10000)),
  ]);
  out.manualCall = race;
  // 看看 Elements 树的 document 状态
  const dom = node.domModel();
  out.hasDocument = !!dom.existingDocument();
  return out;
})()`;

async function main() {
  const port = readPort();
  const targets = await httpJson(port, '/json/list');
  const front = targets.find((t) => (t.url || '').includes('devtools-frontend'));
  if (!front) throw new Error('devtools 前端未打开');
  const client = await connect(front.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  const res = await client.call('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(res, null, 1).slice(0, 3000));
  client.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
