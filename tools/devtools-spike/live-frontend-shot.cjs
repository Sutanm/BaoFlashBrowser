/**
 * 截取运行中 DevTools 前端的画面，并定位所有 devtools-spinner 的宿主元素。
 * 用法：先打开抽屉，再 node tools/devtools-spike/live-frontend-shot.cjs
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');

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
        }, 25000);
      });
    }
  });
}

const SPINNER_EXPR = `(() => {
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const spinners = [];
  for (const s of all) {
    if (s.tagName.toLowerCase() !== 'devtools-spinner') continue;
    const r = s.getBoundingClientRect();
    let pane = null;
    for (let n = s; n; n = n.parentNode || n.host) {
      if (n.nodeType === 1 && n.className && typeof n.className === 'string' &&
          (n.className.includes('styles-pane') || n.className.includes('elements-panel') || n.className.includes('computed-style'))) {
        pane = n.className.slice(0, 60);
        break;
      }
    }
    spinners.push({ w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), pane,
      hostCls: s.parentElement ? String(s.parentElement.className).slice(0, 60) : null });
  }
  const pick = (cls) => {
    const el = all.find((e) => typeof e.className === 'string' && e.className.includes(cls));
    return el ? el.innerText.replace(/\\n{2,}/g, ' | ').slice(0, 300) : null;
  };
  return {
    spinners,
    roots: all.filter((e) => e.className === 'styles-pane' || e.className === 'elements-panel').length,
    stylesPaneText: pick('styles-pane'),
    elementsText: pick('elements-panel'),
    breadcrumb: pick('crumbs'),
    globalNamespaces: Object.keys(self).filter((k) => /^(SDK|UI|Elements|Common|ProtocolClient|Root)$/.test(k)),
  };
})()`;

async function main() {
  const port = readPort();
  const targets = await httpJson(port, '/json/list');
  const front = targets.find((t) => (t.url || '').includes('devtools-frontend'));
  if (!front) throw new Error('devtools 前端未打开');
  const client = await connect(front.webSocketDebuggerUrl);
  await client.call('Page.enable');
  const info = await client.call('Runtime.evaluate', { expression: SPINNER_EXPR, returnByValue: true });
  console.log(JSON.stringify(info.result && info.result.value, null, 2));
  try {
    const shot = await client.call('Page.captureScreenshot', { format: 'png', fromSurface: false });
    const file = path.join(os.tmpdir(), 'bfb-devtools-shot.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('screenshot:', file);
  } catch (e) {
    console.log('screenshot skipped:', e.message);
  }
  client.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
