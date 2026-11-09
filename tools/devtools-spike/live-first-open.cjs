/**
 * 在运行中的应用里：建标签 → 打开 pkt 页 → 等加载 → 模拟 F12（首次打开抽屉）。
 * 用法：node tools/devtools-spike/live-first-open.cjs [url]
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

async function main() {
  const url = process.argv[2] || 'https://news.7k7k.com/pkt/?lt';
  const port = readPort();
  const targets = await httpJson(port, '/json/list');
  const shell = targets.find((t) => (t.url || '').includes('/dist/renderer/index.html'));
  if (!shell) throw new Error('no shell target');
  const client = await connect(shell.webSocketDebuggerUrl);

  const tabId = 'probe-' + Date.now().toString(36);
  const created = await client.call('Runtime.evaluate', {
    expression: `window.electronAPI.tab.create(${JSON.stringify(tabId)}, ${JSON.stringify(url)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('tab.create →', JSON.stringify(created.result && created.result.value ? created.result.value : null));
  await sleep(9000);

  await client.call('Runtime.evaluate', {
    expression: `window.electronAPI.tab.activate(${JSON.stringify(tabId)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  await sleep(1000);

  const opened = await client.call('Runtime.evaluate', {
    expression: `window.electronAPI.tab.devtools(${JSON.stringify(tabId)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('tab.devtools →', JSON.stringify(opened.result && opened.result.value ? opened.result.value : null));
  client.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
