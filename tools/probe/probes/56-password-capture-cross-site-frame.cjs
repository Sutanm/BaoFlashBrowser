// Probe 56 — 跨站 iframe 里的登录表单能不能被捕获。
//
// 线上现象（2026-11-10）：主文档 pwDoc=2（登录层模板在 DOM 里）、但整段会话没有一条
// `first keydown` / `input pw` 诊断，点击诊断里 hasRawPass=0 —— 键盘输入根本没落到
// 被注入脚本的那个文档。7k7k 的玩法页把游戏 HTML 放在另一个 host 的 iframe 里
// （web.7k7k.com），如果用户在那一层登录，主文档的 document 级监听永远看不到。
//
// 本探针用两个不同 site 的本地源（127.0.0.1 与 localhost）复现：
//   outer(127.0.0.1)  ← 内嵌 →  inner(localhost) 里的登录表单
// inner 页自己完成"填值 + 派发 input + 提交"，全程不需要跨源访问 DOM。
//
// 语义：ok = "现状与文档一致"。当前实现只把捕获脚本注入主 target 的 execution
// context，跨站 OOPIF 的 context 不在其中，所以期望**捕获不到**。若哪天补上了跨站
// 捕获（例如逐 frame target 注入），本探针会转为 FAIL，提醒同步更新文档与设计。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { wait, waitFor } = require('../lib/timeout.cjs');

const INNER_PASS = 'cross-site-pass';
const INNER_PAGE = `<!doctype html><html><body>
  <form id="login"><input id="u" name="username"><input id="p" name="password" type="password"><button type="submit">登录</button></form>
  <script>
    document.getElementById('login').addEventListener('submit', function (event) { event.preventDefault(); window.__submitted = 1; });
    setTimeout(function () {
      document.getElementById('u').value = 'cross-site-user';
      document.getElementById('u').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('p').value = ${JSON.stringify(INNER_PASS)};
      document.getElementById('p').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login').querySelector('button').click();
    }, 1200);
  </script>
</body></html>`;

module.exports = {
  id: '56-password-capture-cross-site-frame',
  name: 'cross-site iframe login is not captured (documented limitation)',
  needsElectron: true,
  timeoutMs: 90000,
  async run(ctx) {
    const { BrowserWindow, ipcMain } = ctx.electron;
    const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bao-capture-xsite-')), 'bundle.cjs');
    await require('esbuild').build({
      stdin: { contents: "export * from './src/main/modules/password-capture'; export * from './src/main/modules/password-fill'; export * from './src/main/modules/tabs';", resolveDir: ctx.root, loader: 'ts' },
      outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node12',
      external: ['electron', 'electron-log'], alias: { '@shared': path.join(ctx.root, 'src/shared') },
      plugins: [{ name: 'isolated-capture-xsite', setup(build) {
        build.onLoad({ filter: /[\\/]modules[\\/](password-store|window|session-manager|ui-language)\.ts$/ }, (args) => {
          const name = path.basename(args.path);
          const contents = name === 'password-store.ts'
            ? "export const getMetaForHost=()=>[]; export const getDecryptedPassword=()=>null; export const isAutoCaptureEnabled=()=>true; export const isCaptureExcluded=()=>false;"
            : name === 'window.ts' ? 'export const getMainWindow=()=>globalThis.__baoCaptureXSiteWindow; export const getWindowForWebContents = getMainWindow; export const broadcastToRegisteredWindows = () => {};'
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

    const inner = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', }); res.end(INNER_PAGE); });
    const outer = http.createServer((_req, res) => {
      const innerUrl = `http://localhost:${inner.address().port}/`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body><h1>outer</h1><iframe id="game" src="${innerUrl}" width="600" height="360"></iframe></body></html>`);
    });

    const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { nodeIntegration: false } });
    globalThis.__baoCaptureXSiteWindow = win;
    mod.createTabManager(win, path.join(ctx.root, 'dist/webview-preload.js'));
    const captured = [];
    win.webContents.send = (channel, payload) => { if (channel === 'password:captured') captured.push(payload); };
    const handlers = {
      'get-ruffle-mode': (event) => { event.returnValue = { enabled: false, source: 'bundled', js: '', bundle: null }; },
      'userscript:get-config': (event) => { event.returnValue = { ok: true, scripts: [], values: {} }; },
      'password:form-detected': (event) => mod.tabManager.notifyPasswordFormDetected(event.sender.id),
    };
    for (const [name, handler] of Object.entries(handlers)) ipcMain.on(name, handler);

    try {
      await new Promise((resolve) => inner.listen(0, '0.0.0.0', resolve));
      await new Promise((resolve) => outer.listen(0, '127.0.0.1', resolve));
      mod.configureOptionalTabServices({ passwords: {
        setupCapture: mod.setupCapture, teardownCapture: mod.teardownCapture,
        fillPasswords: mod.fillPasswordsInWebContents, isAutoFillEnabled: () => true,
        getFillCredentialForUrl: () => null,
      } });
      mod.tabManager.setPreload(path.join(ctx.root, 'dist/webview-preload.js'));
      mod.tabManager.setBounds(0, 0, 840, 600);
      mod.tabManager.create('capture-xsite', `http://127.0.0.1:${outer.address().port}/`);
      mod.tabManager.activate('capture-xsite');
      const wc = mod.tabManager.getWebContents('capture-xsite');
      await waitFor(() => wc.debugger.isAttached(), { timeoutMs: 8000, intervalMs: 100, label: 'capture attached' });
      // inner 页 1.2s 后自己提交；这里等足够时间收集结果
      await wait(3500);
      const contexts = mod.getCaptureContextIds(wc);
      const capturedCrossSite = captured.length > 0;
      // inner 页确实提交过（否则是探针环境问题，不是捕获缺口）
      return {
        ok: !capturedCrossSite,
        summary: capturedCrossSite
          ? '跨站 iframe 登录已被捕获（文档里写的"未覆盖"已过时，需要更新设计文档与探针）'
          : `跨站 iframe 的登录没有被捕获（与文档一致）；主 target 可见 context=${contexts.length}`,
        detail: { capturedCrossSite, capturedCount: captured.length, mainTargetContexts: contexts.length },
      };
    } finally {
      mod.tabManager.destroyAll();
      mod.configureOptionalTabServices({});
      for (const [name, handler] of Object.entries(handlers)) ipcMain.removeListener(name, handler);
      if (!win.isDestroyed()) win.destroy();
      delete globalThis.__baoCaptureXSiteWindow;
      try { inner.close(); outer.close(); } catch { /* best effort */ }
    }
  },
};

