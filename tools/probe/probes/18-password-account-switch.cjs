'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { wait, waitFor } = require('../lib/timeout.cjs');

module.exports = {
  id: '18-password-account-switch',
  name: 'autofill then JSONP account switch (synthetic credentials)',
  needsElectron: true,
  timeoutMs: 30000,
  async run(ctx) {
    const { BrowserWindow, ipcMain } = ctx.electron;
    const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bao-password-switch-')), 'capture.cjs');
    // Keep the production capture/fill/TabManager code. Only replace the vault,
    // host window lookup and unrelated network policy with isolated fixture ports.
    await require('esbuild').build({
      stdin: { contents: "export * from './src/main/modules/password-capture'; export * from './src/main/modules/password-fill'; export * from './src/main/modules/tabs';", resolveDir: ctx.root, loader: 'ts' },
      outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node12',
      external: ['electron', 'electron-log'], alias: { '@shared': path.join(ctx.root, 'src/shared') },
      plugins: [{ name: 'isolated-password-ports', setup(build) {
        build.onLoad({ filter: /[\\/]modules[\\/](password-store|window|session-manager)\.ts$/ }, (args) => {
          const name = path.basename(args.path);
          const contents = name === 'password-store.ts'
            ? "export const getMetaForHost=()=>[{id:'fixture-a',username:'fixture-a'}]; export const getDecryptedPassword=()=> 'fixture-pass-a'; export const isAutoCaptureEnabled=()=>true; export const isCaptureExcluded=()=>false;"
            : name === 'window.ts' ? 'export const getMainWindow=()=>globalThis.__baoPasswordSwitchWindow;'
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
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { nodeIntegration: false } });
    global.__baoPasswordSwitchWindow = win;
    const events = [];
    win.webContents.send = (channel, payload) => { if (channel === 'password:captured') events.push(payload); };
    const server = http.createServer((req, res) => {
      // Never log requests: even fixture credentials stay off diagnostics.
      if (req.url.startsWith('/jsonp?')) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('window.jsonpDelivered = true;'); }
      else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(ctx.root, 'tests/electron/fixtures/password-account-switch.html'))); }
    });
    const handlers = {
      'get-ruffle-mode': (event) => { event.returnValue = { enabled: false, source: 'bundled', js: '', bundle: null }; },
      'userscript:get-config': (event) => { event.returnValue = { ok: true, scripts: [], values: {} }; },
      'password:form-detected': (event) => mod.tabManager.notifyPasswordFormDetected(event.sender.id),
    };
    for (const [name, handler] of Object.entries(handlers)) ipcMain.on(name, handler);
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      mod.configureOptionalTabServices({ passwords: {
        setupCapture: mod.setupCapture, teardownCapture: mod.teardownCapture,
        fillPasswords: mod.fillPasswordsInWebContents, isAutoFillEnabled: () => true,
        getFillCredentialForUrl: (url) => url.startsWith(origin) ? { username: 'fixture-a', password: 'fixture-pass-a' } : null,
      } });
      mod.tabManager.setPreload(path.join(ctx.root, 'dist/webview-preload.js'));
      mod.tabManager.setBounds(0, 0, 720, 480);
      mod.tabManager.create('switch-probe', origin);
      mod.tabManager.activate('switch-probe');
      const wc = mod.tabManager.getWebContents('switch-probe');
      const evaluate = (script) => wc.executeJavaScript(script);
      await waitFor(() => evaluate("!!document.querySelector('input[type=password]') && document.querySelector('input[type=password]').value.length > 0"), { timeoutMs: 8000, intervalMs: 50, label: 'autofill fixture A' });
      await evaluate("document.querySelector('button[type=submit]').click()");
      await waitFor(() => evaluate('window.loginCount === 1'), { timeoutMs: 5000, intervalMs: 50, label: 'JSONP callback A' });
      const detachedAfterA = !wc.debugger.isAttached();
      await wait(350);
      await evaluate('window.showLogin()');
      await wait(350);
      const attachedOnSecondForm = wc.debugger.isAttached();
      await evaluate("var f=document.getElementById('login'); f.username.value='fixture-b'; f.password.value='fixture-pass-b'; f.password.dispatchEvent(new Event('input',{bubbles:true})); f.querySelector('button').click();");
      await waitFor(() => evaluate('window.loginCount === 2'), { timeoutMs: 5000, intervalMs: 50, label: 'JSONP callback B' });
      await wait(200);
      const capturedB = events.some((event) => event.username === 'fixture-b');
      const credentialsMatch = events.filter((event) => event.username === 'fixture-b').every((event) => {
        const credential = mod.getPendingCredential(event.captureId);
        return credential?.password === 'fixture-pass-b';
      });
      const detail = { detachedAfterA, attachedOnSecondForm, savedAccountPrompts: events.filter((event) => event.username === 'fixture-a').length, newAccountPrompts: events.filter((event) => event.username === 'fixture-b').length, credentialsMatch };
      return { ok: capturedB && credentialsMatch && detail.savedAccountPrompts === 0, summary: capturedB ? 'second account captured on its first login' : 'second account NOT captured on its first login', detail };
    } finally {
      mod.tabManager.destroyAll(); mod.configureOptionalTabServices({});
      for (const [name, handler] of Object.entries(handlers)) ipcMain.removeListener(name, handler);
      if (!win.isDestroyed()) win.destroy();
      delete global.__baoPasswordSwitchWindow;
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
