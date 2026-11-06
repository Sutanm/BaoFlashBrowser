#!/usr/bin/env node
/**
 * 驱动 file-origin-runner，产出 file:// 能力矩阵。
 *
 *   node tools/devtools-spike/file-origin-probe.cjs
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
const RUNNER = path.join(__dirname, 'file-origin-runner.cjs');
const USER_DATA = path.join(os.tmpdir(), 'bfb-file-probe', 'user-data');
const ACTIVE_PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e.resolve(msg); }
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    send(method, params = {}) {
      const i = ++id;
      socket.send(JSON.stringify({ id: i, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ error: { message: 'timeout' } }); } }, 8000);
        pending.set(i, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  const res = r && r.result;
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails;
    return `EXC ${(d.exception && d.exception.description) || d.text}`;
  }
  return res && res.result && res.result.value;
}

async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return null;
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1200);
  try { fs.unlinkSync(ACTIVE_PORT_FILE); } catch { /* none */ }

  const out = fs.openSync(path.join(os.tmpdir(), 'bfb-file.log'), 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const startedAt = Date.now();
  const child = spawn(ELECTRON, ['--remote-debugging-port=0', RUNNER], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  const port = await waitUntil(async () => {
    try {
      if (fs.statSync(ACTIVE_PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(ACTIVE_PORT_FILE, 'utf8')).split('\n')[0]);
        if (p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) return p;
      }
    } catch { /* not yet */ }
    return null;
  }, 30000);
  if (!port) { console.log('[file] 端口没发现'); process.exit(2); }

  const iframeMode = process.env.BFB_FILE_IFRAME === '1';
  const target = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const needle = iframeMode ? /iframe\.html/ : /page\.html/;
    return (list || []).find((t) => (t.url || '').indexOf('file://') === 0 && needle.test(t.url || '')) || null;
  }, 20000, 'file page');
  if (!target) { console.log('[file] page 没出现'); child.kill(); process.exit(2); }

  const client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await sleep(4000);

  if (iframeMode) {
    // file:// → file:// 同源同进程，不算 OOPIF，所以没有独立 target；
    // 直接读父页里 iframe 的内部状态（同源可访问）。
    console.log('[file] iframe internals:', await evaluate(client, `(() => {
      const f = document.querySelector('iframe');
      if (!f || !f.contentWindow) return 'no-iframe';
      const w = f.contentWindow, d = f.contentDocument;
      return JSON.stringify({
        href: w.location.href.slice(-46),
        origin: w.location.origin,
        nodes: d.getElementsByTagName('*').length,
        text: (d.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
        lang: d.documentElement.lang,
        storage: (() => { try { w.localStorage.setItem('probe', 'v1'); return 'ok:' + w.localStorage.getItem('probe'); } catch (e) { return 'DENIED'; } })(),
      });
    })()`));
    // 与父页共享 origin？localStorage 是否同一份
    console.log('[file] parent storage  :', await evaluate(client, `(() => { try { return 'ok:' + localStorage.getItem('probe'); } catch (e) { return 'DENIED'; } })()`));
  } else {
    console.log('[file] origin/href:', await evaluate(client, `JSON.stringify({ origin: location.origin, href: location.href.slice(-40), secure: window.isSecureContext })`));
    console.log('[file] C1 classic script:', await evaluate(client, `String(window.__classic || 'MISSING')`));
    console.log('[file] C2 module script :', await evaluate(client, `String(window.__module || 'MISSING')`));
    console.log('[file] C3 localStorage  :', await evaluate(client, `(() => {
      try { localStorage.setItem('probe', 'v1'); return 'ok:' + localStorage.getItem('probe'); }
      catch (e) { return 'DENIED:' + String(e.message).slice(0, 50); }
    })()`));
    console.log('[file] C4 fetch json    :', await evaluate(client, `fetch('./data.json').then(r => r.text()).then(t => 'ok:' + t).catch(e => 'FAIL:' + e.message)`, true));
  }

  client.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[file] failed:', e.message); process.exit(1); });
