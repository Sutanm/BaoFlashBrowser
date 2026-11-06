#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

function getJson(url) {
  return new Promise((res, rej) => {
    const r = http.get(url, (x) => {
      let b = '';
      x.on('data', (c) => { b += c; });
      x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    r.on('error', rej);
    r.setTimeout(3000, () => r.destroy(new Error('timeout')));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const APP_ROOT = path.resolve(__dirname, '..', '..');
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);
  const startedAt = Date.now();
  const out = fs.openSync(path.join(os.tmpdir(), 'bfb-s8b.log'), 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(APP_ROOT, 'node_modules/electron/dist/electron.exe'), ['.'], {
    cwd: APP_ROOT, stdio: ['ignore', out, out], env,
  });
  const APP = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) {
    try {
      if (fs.statSync(APP).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(APP, 'utf8')).split('\n')[0]);
        if (p > 0) { await getJson(`http://127.0.0.1:${p}/json/version`); port = p; }
      }
    } catch { /* not yet */ }
    if (!port) await sleep(500);
  }
  console.log('port:', port);
  let shell = null;
  for (let i = 0; i < 60 && !shell; i++) {
    const l = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (l || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  console.log('shell:', shell && shell.url);
  const WebSocket = require('ws');
  const ws = new WebSocket(shell.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const pend = new Map();
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id && pend.has(m.id)) { const entry = pend.get(m.id); pend.delete(m.id); entry.resolve(m.result); }
  });
  const ev = (expr, awaitPromise) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: Boolean(awaitPromise), timeout: 8000 } }));
    return new Promise((res) => pend.set(i, { resolve: res }));
  };
  await ev('1');
  await sleep(4000);
  {
    const r0 = await ev(`(function () {
      var root = document.querySelector('#root');
      var ds = {};
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length && i < 1500; i++) {
        var el = all[i];
        for (var j = 0; j < el.attributes.length; j++) {
          var a = el.attributes[j];
          if (a.name.indexOf('data-') === 0) ds[a.name] = (ds[a.name] || 0) + 1;
        }
      }
      return JSON.stringify({
        rootChildren: root ? root.children.length : -1,
        bodyLen: document.body.innerHTML.length,
        dataAttrs: ds,
        first300: document.body.innerHTML.slice(0, 300),
      });
    })()`);
    console.log('dom debug:', r0 && r0.result && r0.result.value);
  }
  let clicked = 'no';
  const consoleErrors = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 160));
    }
  });
  ws.send(JSON.stringify({ id: 90000, method: "Runtime.enable", params: {} }));
  for (let i = 0; i < 40 && clicked === 'no'; i++) {
    const r = await ev(`(() => {      const b = document.querySelector("[data-devtoolbox-toggle]");
      if (!b) return "no-button";
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return "pressed=" + b.getAttribute("aria-pressed");
    })()`);
    clicked = (r && r.result && r.result.value) || 'null';
    if (clicked === 'no-button') await sleep(500);
    else break;
  }
  console.log('toggle:', clicked, '| consoleErrors:', JSON.stringify(consoleErrors.slice(0, 5)));

  // F12 键盘事件（真实用户路径）
  const sendRaw = (obj) => {
    const i = 91000 + Math.floor(Math.random() * 900);
    ws.send(JSON.stringify(Object.assign({ id: i }, obj)));
    return new Promise((res) => pend.set(i, { resolve: res }));
  };
  await sendRaw({ method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', windowsVirtualKeyCode: 123, code: 'F12', key: 'F12' } });
  await sendRaw({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', windowsVirtualKeyCode: 123, code: 'F12', key: 'F12' } });
  await sleep(8000);
  const r2 = await ev(`(function () {
    var btn = document.querySelector('[data-devtoolbox-toggle]');
    var sep = document.querySelectorAll('[role="separator"]');
    var main = document.querySelector('.workspace-main');
    var mainHtml = main ? main.innerHTML : '';
    return JSON.stringify({
      iframes: [].slice.call(document.querySelectorAll('iframe')).map(function (f) { return f.src.slice(0, 90); }),
      separators: sep.length,
      pressed: btn ? btn.getAttribute('aria-pressed') : 'no-btn',
      mainTail: mainHtml.slice(-700),
    });
  })()`);
  console.log('after F12:', r2 && r2.result && r2.result.value);

  // 导航到真实页面（产生 page target）后再开抽屉
  const http2 = require('http');
  let fixturePort = 0;
  const fx = http2.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>s8-fixture</title></head><body><h1 id="mark">S8</h1></body></html>');
  });
  await new Promise((res) => fx.listen(0, '127.0.0.1', () => { fixturePort = fx.address().port; res(); }));
  console.log('fixture:', fixturePort);

  let urlForNav = null;
  for (let i = 0; i < 20; i += 1) {
    const r = await ev(`(() => {
      const input = document.querySelector('.address-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'http://127.0.0.1:${fixturePort}/');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'submitted';
    })()`);
    urlForNav = (r && r.result && r.result.value) || 'null';
    if (urlForNav === 'submitted') break;
    await sleep(500);
  }
  console.log('navigate:', urlForNav);
  await sleep(4000);

  const r5 = await ev(`window.electronAPI.devtoolbox.devtoolsUrl('page')
    .then(function (v) { return 'url=' + String(v).slice(0, 90); })
    .catch(function (e) { return 'err=' + (e && e.message); })`, true);
  console.log('ipc devtoolsUrl after nav:', r5 && r5.result && r5.result.value);

  // 若 iframe 出现，测 contextBridge 注入
  const r6 = await ev(`(function () {
    var f = document.querySelector('iframe');
    return JSON.stringify({ iframeSrc: f ? f.src.slice(0, 90) : null });
  })()`);
  console.log('iframe after nav:', r6 && r6.result && r6.result.value);

  const front = await (async () => {
    const dl = Date.now() + 15000;
    while (Date.now() < dl) {
      const l = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      const hit = (l || []).find((t) => /devtools_app\.html\?ws=/.test(t.url || ''));
      if (hit) return hit;
      await sleep(500);
    }
    return null;
  })();
  if (!front) { console.log('[s8] 前端 target 没出现，contextBridge 验证跳过'); }
  else {
    const ws2 = new WebSocket(front.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws2.once('open', res); ws2.once('error', rej); });
    let id2 = 0;
    const pend2 = new Map();
    ws2.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id && pend2.has(m.id)) { const e = pend2.get(m.id); pend2.delete(m.id); e.resolve(m.result); }
    });
    const send2 = (method, params) => {
      const i = ++id2;
      ws2.send(JSON.stringify({ id: i, method, params }));
      return new Promise((res) => pend2.set(i, { resolve: res }));
    };
    await send2('Runtime.enable', {});
    await sleep(5000);
    const pr = await send2('Runtime.evaluate', {
      expression: "JSON.stringify((function () { var ea = typeof window.electronAPI === 'undefined' ? null : window.electronAPI; return { electronAPI: typeof window.electronAPI, devtoolboxKeys: ea && ea.devtoolbox ? Object.keys(ea.devtoolbox).length : -1, electronNames: Object.getOwnPropertyNames(window).filter(function (n) { return n.indexOf('electron') !== -1; }).join(','), hasRequire: typeof window.require }; })())",
      returnByValue: true,
    });
    console.log('[s8] iframe contextBridge raw:', JSON.stringify(pr).slice(0, 600));
    ws2.close();
  }
  fx.close();
  await sleep(8000);
  {
    const r1 = await ev(`(function () {
      var iframes = [].slice.call(document.querySelectorAll('iframe')).map(function (f) { return f.src.slice(0, 100); });
      var main = document.querySelector('.workspace-main');
      var mainKids = main ? [].slice.call(main.children).map(function (c) { return (c.className || '').toString().slice(0, 60) + ' h=' + c.offsetHeight; }) : null;
      var devEls = [].slice.call(document.querySelectorAll('[class*="devtool" i], [id*="devtool" i]')).slice(0, 6).map(function (c) { return (c.className || '').toString().slice(0, 50); });
      return JSON.stringify({
        iframes: iframes,
        mainFound: Boolean(main),
        mainKids: mainKids,
        devEls: devEls,
        bodyLen: document.body.innerHTML.length,
      });
    })()`);
    console.log('iframe debug:', r1 && r1.result && r1.result.value);
  }
  const l = await getJson(`http://127.0.0.1:${port}/json/list`);
  for (const t of l) console.log(' -', t.type, '|', String(t.url).slice(0, 120));
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
