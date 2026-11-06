#!/usr/bin/env node
/**
 * P0 方案 A 可行性驱动：自定义 scheme 是否给出稳定 origin、模块能否加载、设置能否跨启动保留。
 *
 *   node tools/devtools-spike/scheme-feasibility.cjs
 *
 * 判据（全通过才值得改造）：
 *   F1 https 化的 scheme 页面在 file:// 父页的 iframe 里能加载（不是 chrome-error）
 *   F2 ES module 正常执行（polyfill 生效 = 模块链跑通）
 *   F3 origin 恒定（不随启动变化）
 *   F4 localStorage 跨两次启动保留
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
const RUNNER = path.join(__dirname, 'devtools-scheme-runner.cjs');
const USER_DATA = path.join(os.tmpdir(), 'bfb-scheme-probe');
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

function cdp(wsUrl, onEvent) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e.resolve(msg); return; }
    if (msg.method && onEvent) onEvent(msg);
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    send(method, params = {}) {
      const i = ++id;
      socket.send(JSON.stringify({ id: i, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ error: { message: 'timeout' } }); } }, 12000);
        pending.set(i, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  // CDP 把异常放在 result.exceptionDetails 里（不是顶层）
  const res = r && r.result;
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails;
    return `EXC ${(d.exception && d.exception.description) || d.text}`;
  }
  return res && res.result && res.result.value;
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(400);
  }
  console.log('[scheme] 等待超时:', label);
  return null;
}

async function launch() {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1200);
  try { fs.unlinkSync(ACTIVE_PORT_FILE); } catch { /* none */ }

  const out = fs.openSync(path.join(os.tmpdir(), 'bfb-scheme.log'), 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const startedAt = Date.now();
  const child = spawn(ELECTRON, ['--remote-debugging-port=0', RUNNER], {
    cwd: APP_ROOT, stdio: ['ignore', out, out], env,
  });

  const port = await waitUntil(async () => {
    try {
      if (fs.statSync(ACTIVE_PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(ACTIVE_PORT_FILE, 'utf8')).split('\n')[0]);
        if (p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) return p;
      }
    } catch { /* not yet */ }
    return null;
  }, 30000, 'debug port');
  if (!port) return null;

  const target = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => (t.url || '').indexOf('bfbdevtools://') === 0) || null;
  }, 25000, 'scheme iframe target');

  return { child, port, target };
}

(async () => {
  const run = async (label) => {
    const session = await launch();
    if (!session) { console.log(`[scheme] ${label}: 启动失败`); return null; }
    if (!session.target) {
      console.log(`[scheme] ${label}: F1 失败 —— iframe 里没有出现 bfbdevtools:// 的 target`);
      const list = await getJson(`http://127.0.0.1:${session.port}/json/list`).catch(() => []);
      for (const t of list || []) console.log('   target:', t.type, '|', String(t.url).slice(0, 90));
      session.child.kill();
      return null;
    }
    console.log(`[scheme] ${label}: F1 通过，iframe target url = ${session.target.url.slice(0, 90)}`);

    const client = cdp(session.target.webSocketDebuggerUrl, (m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params && m.params.exceptionDetails;
        console.log('   [exception]', String((d && d.exception && d.exception.description) || (d && d.text) || '').slice(0, 200));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error') {
        console.log('   [console.error]', JSON.stringify(m.params.args && m.params.args.map((a) => a.value)).slice(0, 200));
      }
    });
    await client.ready;
    await client.send('Runtime.enable');
    await sleep(4000); // 等模块链跑完（前端有几百个 ES module）

    const info = await evaluate(client, `JSON.stringify({
      origin: location.origin,
      href: location.href.slice(0, 70),
      isSecureContext: window.isSecureContext,
      polyfilledCanParse: typeof URL.canParse,
      nodes: document.getElementsByTagName('*').length,
      storageError: (() => { try { localStorage.length; return null; } catch (e) { return String(e.message).slice(0, 60); } })(),
      lsKeys: (() => { try { return Object.keys(localStorage).length; } catch (e) { return -1; } })(),
      marker: (() => { try { return localStorage.getItem('bfb-scheme-marker'); } catch (e) { return 'DENIED'; } })(),
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
    })`);
    console.log(`[scheme] ${label}: info =`, info);

    // 落一个标记，供下一次启动检查 localStorage 是否跨启动保留
    const parsed = info ? JSON.parse(info) : null;
    if (parsed && parsed.marker !== 'DENIED' && !parsed.marker) {
      const written = await evaluate(client, `(() => {
        try { localStorage.setItem('bfb-scheme-marker', 'm' + Date.now()); return localStorage.getItem('bfb-scheme-marker'); }
        catch (e) { return 'DENIED'; }
      })()`);
      console.log(`[scheme] ${label}: 写入 marker =`, written);
      if (written && String(written).indexOf('DENIED') === -1) parsed.marker = String(written);
    }

    session.child.kill();
    await sleep(800);
    return { info: parsed, client };
  };

  console.log('[scheme] ---- 第一次启动 ----');
  const first = await run('run1');
  if (!first || !first.info) { console.log('[scheme] 无法继续'); process.exit(2); }

  // 写入标记（若第一次还没 marker）
  console.log('[scheme] ---- 第二次启动（验证 origin 与 localStorage） ----');
  const second = await run('run2');

  if (second && second.info) {
    console.log('[scheme] ==== 判定 ====');
    console.log('  F1 iframe 加载自定义 scheme      :', '通过');
    console.log('  F2 模块链执行（polyfill 生效）   :', second.info.polyfilledCanParse === 'function' ? '通过' : '失败');
    console.log('  F3 origin 恒定                   :', second.info.origin === first.info.origin
      ? `通过（${second.info.origin}）` : `失败（${first.info.origin} → ${second.info.origin}）`);
    console.log('  F4 localStorage 跨启动保留       :', second.info.marker ? '通过' : '失败（marker 丢失）');
  }
  process.exit(0);
})().catch((e) => { console.error('[scheme] failed:', e.message); process.exit(1); });
