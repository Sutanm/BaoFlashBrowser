#!/usr/bin/env node
/**
 * DevTools 语言来源实测。
 *
 *   node tools/devtools-spike/devtools-locale-probe.cjs
 *
 * 前端代码里语言只看两处：
 *   DevToolsLocale: "browserLanguage" === settingLanguage ? navigator.language : settingLanguage
 *   setting 定义：settingName "language"，defaultValue "en-US"
 * 所以要分清：navigator.language 到底是啥？localStorage 里的 language 是啥？
 * 页面最终是不是中文？
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
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
        const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ error: { message: 'timeout' } }); } }, 12000);
        pending.set(i, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true });
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
    await sleep(500);
  }
  console.log('[locale] 等待超时:', label);
  return null;
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1500);

  const out = fs.openSync(path.join(os.tmpdir(), 'bfb-locale.log'), 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const startedAt = Date.now();
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  const port = await waitUntil(async () => {
    try {
      if (fs.statSync(ACTIVE_PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(ACTIVE_PORT_FILE, 'utf8')).split('\n')[0]);
        if (p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) return p;
      }
    } catch { /* not yet */ }
    return null;
  }, 45000, 'debug port');
  if (!port) process.exit(2);

  const shellT = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || '')) || null;
  }, 30000, 'shell');
  if (!shellT) process.exit(2);
  const shell = cdp(shellT.webSocketDebuggerUrl);
  await shell.ready;

  // 外壳侧：Electron 的 locale 决定 navigator.language
  console.log('[locale] shell navigator:', await evaluate(shell, `JSON.stringify({
    language: navigator.language,
    languages: navigator.languages,
    intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
  })`));

  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(shell, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`).catch(() => 'no-button');
    if (state === 'clicked') break;
    await sleep(500);
  }
  await sleep(1500);
  await evaluate(shell, `(() => {
    const btns = [].slice.call(document.querySelectorAll('button'));
    const t = btns.find(function (b) { return (b.textContent || '').trim() === '外壳界面'; });
    if (!t) return 'no-target-btn';
    t.click(); return 'clicked';
  })()`);

  const front = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /devtools_app\.html/.test(t.url || '')) || null;
  }, 30000, 'frontend iframe');
  if (!front) { shell.close(); child.kill(); process.exit(2); }

  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;
  await sleep(8000);

  // BFB_FORCE_LANG=en-US：模拟"用户在设置里显式选了英文"（写 localStorage 后重载），
  // 用来验证「显式选择」不会被"默认跟随浏览器"的补丁吃掉。
  const forceLang = process.env.BFB_FORCE_LANG;
  if (forceLang) {
    await evaluate(fc, `localStorage.setItem('language', JSON.stringify(${JSON.stringify(forceLang)}))`);
    await evaluate(fc, `location.reload()`);
    await sleep(10000);
  }

  console.log('[locale] frontend:', await evaluate(fc, `JSON.stringify({
    origin: location.origin,
    language: navigator.language,
    intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    storedLanguage: (() => { try { return localStorage.getItem('language'); } catch (e) { return 'DENIED'; } })(),
    htmlLang: document.documentElement.lang,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 70),
    hasChinese: /[\\u4e00-\\u9fa5]/.test(document.body.innerText || ''),
    // 语言横幅是否还在（三类关键词：标题 / "不再显示" / 切换按钮）
    bannerVisible: /现已支持中文|available in Chinese|Switch DevTools|切换为中文|始终以 Chrome/.test(document.body.innerText || ''),
    bannerSnippet: (function () {
      var t = (document.body.innerText || '').replace(/\\s+/g, ' ');
      var i = t.search(/现已支持中文|available in Chinese|切换为中文|始终以 Chrome/);
      return i < 0 ? '' : t.slice(Math.max(0, i - 10), i + 60);
    })(),
  })`));

  // 谁注册了 language 设置？看运行时到底加载了哪些 *-meta.js
  console.log('[locale] loaded meta:', await evaluate(fc, `JSON.stringify(
    performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => n.indexOf('-meta') !== -1)
      .map((n) => n.slice(n.lastIndexOf('/') + 1))
  )`));

  fc.close();
  shell.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[locale] failed:', e.message); process.exit(1); });
