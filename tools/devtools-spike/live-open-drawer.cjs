/**
 * 在运行中的应用里模拟按 F12，打开 DevTools 抽屉（走主进程 before-input-event）。
 * 用法：node tools/devtools-spike/live-open-drawer.cjs
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');

function readPort() {
  return Number(fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]);
}

function httpJson(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(String(body).slice(0, 200)));
          }
        });
      })
      .on('error', reject);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
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
        }, 20000);
      });
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const port = readPort();
  const targets = await httpJson(port, '/json/list');
  const shell = targets.find((t) => (t.url || '').includes('/dist/renderer/index.html'));
  if (!shell) throw new Error('no shell target');
  const client = await connect(shell.webSocketDebuggerUrl);
  const key = { key: 'F12', code: 'F12', windowsVirtualKeyCode: 123, nativeVirtualKeyCode: 123, modifiers: 0 };
  await client.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await client.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  console.log('F12 dispatched');
  client.close();
  await sleep(4000);
  const after = await httpJson(port, '/json/list');
  console.log('--- targets after ---');
  for (const t of after) console.log(t.type.padEnd(8), t.id.slice(0, 12), '|', (t.url || '').slice(0, 80));
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
