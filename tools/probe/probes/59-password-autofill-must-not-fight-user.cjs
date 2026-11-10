// Probe 59 — 自动填充不能和用户抢输入（2026-11-10 真机投诉的核心）。
//
// 现象：点一次输入框就触发一次自动填充，把「旧账号 + 旧密码」塞回表单；
// 用户想改登新账号，清空表单又立刻被填回旧账号，提交上去捕获到的是旧账号 →
// 命中已保存条目 → 静默跳过 → 用户以为"捕获坏了、没有提示"。
//
// 期望行为（本探针断言）：
//   1. 页面加载时仍自动填充一次（保留既有的"出现即填"体验）；
//   2. 用户动过表单（打字/清空）之后，点击/聚焦不再触发填充，输入不被覆盖；
//   3. 用户提交的是**他自己输入**的新账号，捕获到的也是新账号。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { wait, waitFor } = require('../lib/timeout.cjs');

const SAVED = { username: 'saved-user', password: 'saved-pass-1' };
const USERNAME = 'brand-new-user';
const PASSWORD = 'brand-new-pass-9';

const PAGE = `<!doctype html><html><body>
  <form id="login">
    <input id="u" name="username" autocomplete="username">
    <input id="p" name="password" type="password">
    <button type="submit" id="go">登录</button>
  </form>
  <script>
    document.getElementById('login').addEventListener('submit', function (event) { event.preventDefault(); window.__submitted = 1; });
  </script>
</body></html>`;

module.exports = {
  id: '59-password-autofill-must-not-fight-user',
  name: 'autofill fills once, never overwrites what the user typed',
  needsElectron: true,
  timeoutMs: 90000,
  async run(ctx) {
    const { BrowserWindow, ipcMain } = ctx.electron;
    const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bao-fill-guard-')), 'bundle.cjs');
    await require('esbuild').build({
      stdin: { contents: "export * from './src/main/modules/password-capture'; export * from './src/main/modules/password-fill'; export * from './src/main/modules/tabs';", resolveDir: ctx.root, loader: 'ts' },
      outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node12',
      external: ['electron', 'electron-log'], alias: { '@shared': path.join(ctx.root, 'src/shared') },
      plugins: [{ name: 'isolated-fill-guard', setup(build) {
        build.onLoad({ filter: /[\\/]modules[\\/](password-store|window|session-manager|ui-language)\.ts$/ }, (args) => {
          const name = path.basename(args.path);
          const contents = name === 'password-store.ts'
            ? "export const getMetaForHost=()=>[]; export const getDecryptedPassword=()=>null; export const isAutoCaptureEnabled=()=>true; export const isCaptureExcluded=()=>false;"
            : name === 'window.ts' ? 'export const getMainWindow=()=>globalThis.__baoFillGuardWindow; export const getWindowForWebContents = getMainWindow; export const broadcastToRegisteredWindows = () => {};'
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
    globalThis.__baoFillGuardWindow = win;
    mod.createTabManager(win, path.join(ctx.root, 'dist/webview-preload.js'));
    const captured = [];
    win.webContents.send = (channel, payload) => { if (channel === 'password:captured') captured.push(payload); };
    const fillAttempts = [];
    const handlers = {
      'get-ruffle-mode': (event) => { event.returnValue = { enabled: false, source: 'bundled', js: '', bundle: null }; },
      'userscript:get-config': (event) => { event.returnValue = { ok: true, scripts: [], values: {} }; },
      'password:form-detected': (event, payload) => mod.tabManager.notifyPasswordFormDetected(event.sender.id, payload),
    };
    for (const [name, handler] of Object.entries(handlers)) ipcMain.on(name, handler);

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });

    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      mod.configureOptionalTabServices({ passwords: {
        setupCapture: mod.setupCapture, teardownCapture: mod.teardownCapture,
        fillPasswords: async (wc, resolve) => { fillAttempts.push(Date.now()); return mod.fillPasswordsInWebContents(wc, resolve); },
        isAutoFillEnabled: () => true,
        getFillCredentialForUrl: () => ({ username: SAVED.username, password: SAVED.password }),
      } });
      mod.tabManager.setPreload(path.join(ctx.root, 'dist/webview-preload.js'));
      mod.tabManager.setBounds(0, 0, 840, 600);
      mod.tabManager.create('fill-guard', origin + '/');
      mod.tabManager.activate('fill-guard');
      const wc = mod.tabManager.getWebContents('fill-guard');
      const read = (script) => wc.executeJavaScript(script).catch((error) => String(error));
      const values = () => read("({ u: document.getElementById('u').value, p: document.getElementById('p').value })");

      // 1) 加载后自动填充一次（既有体验）
      await waitFor(async () => (await values()).u === SAVED.username, { timeoutMs: 8000, intervalMs: 100, label: 'initial autofill' });
      const filledOnce = await values();

      // 2) 用户清空并输入新账号（真实用户顺序：先清空、再输入）
      await read(`(function(){
        var u = document.getElementById('u'); var p = document.getElementById('p');
        u.value = ''; u.dispatchEvent(new Event('input', { bubbles: true }));
        p.value = ''; p.dispatchEvent(new Event('input', { bubbles: true }));
        u.value = ${JSON.stringify(USERNAME)}; u.dispatchEvent(new Event('input', { bubbles: true }));
        p.value = ${JSON.stringify(PASSWORD)}; p.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      const typed = await values();

      // 3) 反复点击/聚焦登录框（此前每次点击都会触发填充 → 覆盖用户输入）
      const attemptsBefore = fillAttempts.length;
      for (let index = 0; index < 3; index += 1) {
        await read("document.getElementById('u').click()");
        await wait(250);
        await read("document.getElementById('p').click()");
        await wait(250);
      }
      await wait(600);
      const afterClicks = await values();

      // 4) 提交，确认捕获到的是用户输入的新账号
      await read("document.getElementById('go').click()");
      await waitFor(() => captured.length > 0, { timeoutMs: 6000, intervalMs: 100, label: 'capture arrived' });
      const pending = mod.getPendingCredential(captured[0].captureId);

      const noOverwrite = afterClicks.u === typed.u && afterClicks.p === typed.p;
      const capturedUserInput = pending?.username === USERNAME && pending?.password === PASSWORD;

      // 5) 退出登录那种场景：把表单清空后**应当很快**被填回来（不再是"等 3 秒"）。
      //    清空后点一下账号框（真实用户会这么做），期望 1.2s 内填回库里的账号。
      await read(`(function(){
        var u = document.getElementById('u'); var p = document.getElementById('p');
        u.value = ''; u.dispatchEvent(new Event('input', { bubbles: true }));
        p.value = ''; p.dispatchEvent(new Event('input', { bubbles: true }));
        u.click();
      })()`);
      const clearedAt = Date.now();
      let refillMs = null;
      try {
        await waitFor(async () => (await values()).u === SAVED.username, { timeoutMs: 3000, intervalMs: 50, label: 'refill after clearing' });
        refillMs = Date.now() - clearedAt;
      } catch { /* 未填回 → refillMs 保持 null */ }

      return {
        ok: noOverwrite && capturedUserInput && refillMs !== null && refillMs <= 1500,
        summary: noOverwrite
          ? (refillMs === null
            ? '清空表单后没有被填回（退化成"永不填充"了）'
            : `用户输入未被覆盖；清空后 ${refillMs}ms 填回库里的账号（fill 尝试 ${attemptsBefore} → ${fillAttempts.length}）`)
          : `自动填充覆盖了用户输入：期望 ${JSON.stringify(typed)} 实际 ${JSON.stringify(afterClicks)}`,
        detail: { filledOnce, typed, afterClicks, captured: pending, fillAttempts: fillAttempts.length },
      };
    } finally {
      mod.tabManager.destroyAll();
      mod.configureOptionalTabServices({});
      for (const [name, handler] of Object.entries(handlers)) ipcMain.removeListener(name, handler);
      if (!win.isDestroyed()) win.destroy();
      delete globalThis.__baoFillGuardWindow;
      try { server.close(); } catch { /* best effort */ }
    }
  },
};
