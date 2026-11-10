// Probe 55 — 7k7k 形态的密码捕获：隐藏登录层 → 点「登录」显示 → 输入 → 提交。
//
// 背景（2026-11-10 用户报告"登录新账号没有捕获弹窗"）：线上日志里主文档
// pwDoc=2（登录层模板在 DOM 里）但 hasRawPass=0、且从没有 input/keydown 诊断，
// 说明要么输入事件没进这个文档，要么捕获脚本早已不在该上下文。
// 本探针用真实 password-capture / tabs / password-fill + 生产 preload，把用户操作
// 顺序原样走一遍，断言 captureId 与凭据真能到达主进程——同时也覆盖"点击很频繁"
// （新观察器每次点击都会 form-detected）会不会把捕获重新武装搞坏。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { wait, waitFor } = require('../lib/timeout.cjs');

const HINT = '用户名/邮箱/KK号';
const PASSWORD = 'capture-pass-1';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>7k7k 形态捕获页</title>
<style>
  #union { display: none; position: fixed; left: 40px; top: 40px; padding: 12px; background: #fff; }
  #union.bao-shown { display: block; }
</style></head>
<body>
  <nav id="bar"><a href="javascript:;" id="open-login">登录</a><a href="javascript:;">注册</a></nav>
  <main><canvas width="320" height="200"></canvas></main>
  <div id="union">
    <form id="login">
      <input id="un_name" value="${HINT}" placeholder="${HINT}">
      <input id="un_pass" type="password">
      <div id="repass" style="display:none"><input id="un_repass" type="password"></div>
      <button type="submit" id="login-btn">登 录</button>
    </form>
  </div>
  <script>
    window.loginCount = 0;
    document.getElementById('open-login').addEventListener('click', function () {
      document.getElementById('union').classList.add('bao-shown');
      document.getElementById('un_name').focus();
    });
    // 与 7k7k 一致：提示文字在点击时才清空
    document.getElementById('un_name').addEventListener('click', function () {
      if (this.value === ${JSON.stringify(HINT)}) this.value = '';
    });
    // 第二阶段用：XHR 提交，body 里只有密码（模拟 7k7k 的 xhr 登录）
    window.submitViaXhr = function () {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/xhr-login');
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.send('password=' + encodeURIComponent(document.getElementById('un_pass').value));
    };
    document.getElementById('login').addEventListener('submit', function (event) {
      event.preventDefault();
      // JSONP 式提交：插 script，回调后算成功
      var form = event.target;
      var script = document.createElement('script');
      script.src = '/jsonp?username=' + encodeURIComponent(form.un_name.value) + '&password=' + encodeURIComponent(form.un_pass.value);
      script.onload = function () { window.loginCount += 1; script.remove(); };
      document.head.appendChild(script);
    });
  </script>
</body></html>`;

module.exports = {
  id: '55-password-capture-hidden-popup',
  name: 'capture still fires for hidden-then-shown login popup (7k7k shape)',
  needsElectron: true,
  timeoutMs: 90000,
  async run(ctx) {
    const { BrowserWindow, ipcMain } = ctx.electron;
    const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bao-capture-popup-')), 'bundle.cjs');
    await require('esbuild').build({
      stdin: { contents: "export * from './src/main/modules/password-capture'; export * from './src/main/modules/password-fill'; export * from './src/main/modules/tabs';", resolveDir: ctx.root, loader: 'ts' },
      outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node12',
      external: ['electron', 'electron-log'], alias: { '@shared': path.join(ctx.root, 'src/shared') },
      plugins: [{ name: 'isolated-capture-ports', setup(build) {
        build.onLoad({ filter: /[\\/]modules[\\/](password-store|window|session-manager|ui-language)\.ts$/ }, (args) => {
          const name = path.basename(args.path);
          const contents = name === 'password-store.ts'
            ? "export const getMetaForHost=()=>[]; export const getDecryptedPassword=()=>null; export const isAutoCaptureEnabled=()=>true; export const isCaptureExcluded=()=>false;"
            : name === 'window.ts' ? 'export const getMainWindow=()=>globalThis.__baoCapturePopupWindow;'
              : name === 'ui-language.ts' ? 'export const uiText=(zh)=>zh;'
                : 'export const setupSessionOnce=()=>{};';
          return { contents, loader: 'ts' };
        });
      } }],
    });
    const Module = require('module');
    const bundled = new Module(outfile, module);
    bundled.filename = outfile; bundled.paths = Module._nodeModulePaths(ctx.root);
    bundled._compile(fs.readFileSync(outfile, 'utf8'), outfile);
    const mod = bundled.exports;

    const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { nodeIntegration: false } });
    globalThis.__baoCapturePopupWindow = win;
    mod.createTabManager(win, path.join(ctx.root, 'dist/webview-preload.js'));
    const captured = [];
    win.webContents.send = (channel, payload) => { if (channel === 'password:captured') captured.push(payload); };
    const formDetected = [];
    const handlers = {
      'get-ruffle-mode': (event) => { event.returnValue = { enabled: false, source: 'bundled', js: '', bundle: null }; },
      'userscript:get-config': (event) => { event.returnValue = { ok: true, scripts: [], values: {} }; },
      'password:form-detected': (event) => { formDetected.push(event.sender.id); mod.tabManager.notifyPasswordFormDetected(event.sender.id); },
    };
    for (const [name, handler] of Object.entries(handlers)) ipcMain.on(name, handler);

    const server = http.createServer((req, res) => {
      if (String(req.url).startsWith('/jsonp')) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('window.jsonpDelivered = true;'); return; }
      if (String(req.url).startsWith('/xhr-login')) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });

    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      mod.configureOptionalTabServices({ passwords: {
        setupCapture: mod.setupCapture, teardownCapture: mod.teardownCapture,
        fillPasswords: mod.fillPasswordsInWebContents, isAutoFillEnabled: () => true,
        getFillCredentialForUrl: () => null,
      } });
      mod.tabManager.setPreload(path.join(ctx.root, 'dist/webview-preload.js'));
      mod.tabManager.setBounds(0, 0, 840, 600);
      mod.tabManager.create('capture-popup', origin + '/');
      mod.tabManager.activate('capture-popup');
      const wc = mod.tabManager.getWebContents('capture-popup');
      const read = (script) => wc.executeJavaScript(script).catch((error) => String(error));

      await waitFor(() => read("document.readyState === 'complete'"), { timeoutMs: 8000, intervalMs: 100, label: 'page ready' });
      // 捕获在 did-stop-loading 挂上；等注入完成（DIAG 无法在本探针里读，用诊断探针代替）
      await waitFor(() => wc.debugger.isAttached(), { timeoutMs: 8000, intervalMs: 100, label: 'capture attached' });
      await wait(300);

      // 1) 点「登录」把隐藏的登录层显示出来（等同 7k7k 的 $().show()）
      await read("document.getElementById('open-login').click()");
      await waitFor(() => read("document.getElementById('union').getBoundingClientRect().height > 0"), { timeoutMs: 4000, intervalMs: 100, label: 'popup visible' });

      // 2) 输入账号密码（模拟真实输入：设置 value 并派发 input 事件），再用真实点击提交
      await read(`(function(){
        var name = document.getElementById('un_name');
        name.value = 'new-account';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        var pass = document.getElementById('un_pass');
        pass.value = ${JSON.stringify(PASSWORD)};
        pass.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await wait(200);
      await read("document.getElementById('login-btn').click()");

      await waitFor(() => read('window.loginCount === 1'), { timeoutMs: 6000, intervalMs: 100, label: 'JSONP login completed' });
      await waitFor(() => captured.length > 0, { timeoutMs: 6000, intervalMs: 100, label: 'password:captured arrived' });

      const first = captured[0];
      const pending = mod.getPendingCredential(first.captureId);
      const credentialsMatch = pending?.password === PASSWORD && pending?.username === 'new-account';

      // 第二阶段：复现 7k7k 的账号名缺失场景 —— 站点先把密码填进 DOM、账号框
      // 由脚本后补（不发 input 事件），再走 XHR 提交。若捕获只认 _rawUser，
      // 这里会存下"空账号"；修复后应从 DOM 回读账号名。
      //
      // 注意：第一次捕获后 capture 会 detach（防止阻塞站点的 JSONP 回调），
      // 页面侧脚本的 __baopReport 随之失效。所以先用一次真实点击把捕获重新挂上，
      // 否则第二阶段根本报不出来 —— 这也正是线上"登录第二次就没有捕获"的机制。
      await read("document.getElementById('un_pass').click()");
      await waitFor(() => wc.debugger.isAttached(), { timeoutMs: 8000, intervalMs: 100, label: 'capture re-armed after detach' });
      await wait(300);
      await read(`(function(){
        document.getElementById('un_name').value = '';
        var pass = document.getElementById('un_pass');
        pass.value = ${JSON.stringify(PASSWORD + '-2')};
        pass.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('un_name').value = 'late-user';
        window.submitViaXhr();
      })()`);
      await waitFor(() => captured.length > 1, { timeoutMs: 8000, intervalMs: 100, label: 'xhr capture arrived' });
      const xhrCapture = mod.getPendingCredential(captured[captured.length - 1].captureId);
      const xhrUsernameOk = xhrCapture?.username === 'late-user' && xhrCapture?.password === PASSWORD + '-2';
      return {
        ok: credentialsMatch && xhrUsernameOk,
        summary: credentialsMatch && xhrUsernameOk
          ? '隐藏登录层→点开→输入→提交捕获到新账号；账号框不发 input 事件的 XHR 登录也能从 DOM 回读账号名'
          : `capture mismatch: ${JSON.stringify({ username: pending?.username, xhr: xhrCapture?.username, captured: captured.length })}`,
        detail: { captured, pending, xhrCapture, formDetected, debuggerAttached: wc.debugger.isAttached() },
      };
    } finally {
      mod.tabManager.destroyAll();
      mod.configureOptionalTabServices({});
      for (const [name, handler] of Object.entries(handlers)) ipcMain.removeListener(name, handler);
      if (!win.isDestroyed()) win.destroy();
      delete globalThis.__baoCapturePopupWindow;
      try { server.close(); } catch { /* best effort: keep-alive 连接不应拖住探针 */ }
    }
  },
};




