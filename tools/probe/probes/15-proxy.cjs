'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert').strict;

module.exports = {
  id: '15-proxy',
  name: 'proxy routing (BrowserView + Electron 11)',
  needsElectron: true,
  timeoutMs: 45000,
  async run(ctx) {
    const { BrowserView, BrowserWindow, ipcMain } = ctx.electron;
    const { session } = require('electron');
    const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bao-proxy-probe-')), 'proxy.cjs');
    require('esbuild').buildSync({
      stdin: {
        contents: "export * from './src/main/modules/proxy'; export * from './src/main/modules/session-manager'; export * from './src/shared/types/proxy';",
        resolveDir: ctx.root, loader: 'ts',
      },
      outfile, bundle: true, platform: 'node', format: 'cjs',
      external: ['electron', 'electron-log'],
      nodePaths: [path.join(ctx.root, 'node_modules')],
      alias: { '@shared': path.join(ctx.root, 'src/shared') },
    });
    // The bundle is temporary; resolve external packages from the workspace.
    const Module = require('module');
    const bundled = new Module(outfile, module);
    bundled.filename = outfile;
    bundled.paths = Module._nodeModulePaths(ctx.root);
    bundled._compile(fs.readFileSync(outfile, 'utf8'), outfile);
    const mod = bundled.exports;
    let hits = 0;
    const proxy = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>proxy-ok</title><p>proxied</p>');
    });
    const origin = http.createServer((req, res) => {
      if (req.url === '/proxy.pac') {
        res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
        res.end(`function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${proxy.address().port}"; }`);
      } else { res.end('<!doctype html><title>direct-ok</title>direct'); }
    });
    const sockets = new Set();
    const socks = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.setTimeout(10000, () => socket.destroy());
      let buffer = Buffer.alloc(0);
      let stage = 0;
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 0) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          buffer = buffer.slice(2 + buffer[1]);
          socket.write(Buffer.from([5, 0]));
          stage = 1;
        }
        if (stage === 1) {
          if (buffer.length < 5) return;
          const length = buffer[3] === 3 ? 7 + buffer[4] : buffer[3] === 1 ? 10 : 22;
          if (buffer.length < length) return;
          assert.equal(buffer[1], 1); // CONNECT
          buffer = buffer.slice(length);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          stage = 2;
        }
        if (stage === 2 && buffer.includes(Buffer.from('\r\n\r\n'))) {
          stage = 3;
          socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
        }
      });
    });
    const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const ruffle = (event) => { event.returnValue = { enabled: false }; };
    const scripts = (event) => { event.returnValue = { ok: false }; };
    const ignore = () => {};
    let host;
    let view;
    try {
      await listen(proxy);
      await listen(origin);
      await listen(socks);
      const settings = { ...mod.DEFAULT_PROXY, mode: 'manual', host: '127.0.0.1', port: proxy.address().port };
      await mod.initializeProxy(settings);
      assert.equal(mod.usesBrowserDownloads(), true);
      mod.initSession();
      const target = 'http://bao-proxy-probe.invalid/page';
      for (const sess of [session.defaultSession, session.fromPartition('persist:')]) {
        assert.match(await sess.resolveProxy(target), /PROXY 127\.0\.0\.1:/);
      }
      ipcMain.on('get-ruffle-mode', ruffle);
      ipcMain.on('userscript:get-config', scripts);
      for (const channel of ['userscript:report', 'userscript:menu-register', 'userscript:menu-unregister', 'password:form-detected']) ipcMain.on(channel, ignore);
      host = new BrowserWindow({ show: false, webPreferences: { spellcheck: false } });
      view = new BrowserView({ webPreferences: {
        partition: 'persist:', contextIsolation: true, plugins: true, nodeIntegration: false,
        spellcheck: false, preload: path.join(ctx.root, 'dist', 'webview-preload.js'),
      } });
      host.addBrowserView(view);
      await view.webContents.loadURL(target);
      assert.equal(await view.webContents.executeJavaScript('document.title'), 'proxy-ok');
      assert.ok(hits > 0);
      assert.equal((await mod.testProxy(settings, target)).ok, true);
      const socksResult = await mod.testProxy({ ...settings, protocol: 'socks5', port: socks.address().port }, target);
      assert.equal(socksResult.ok, true, JSON.stringify(socksResult));
      assert.match(socksResult.route, /SOCKS5 127\.0\.0\.1:/);
      const bypassSession = session.fromPartition('proxy-probe-bypass');
      await bypassSession.setProxy(mod.toElectronProxy({ ...settings, bypass: '*.invalid' }));
      assert.equal(await bypassSession.resolveProxy(target), 'DIRECT');
      const pacUrl = `http://127.0.0.1:${origin.address().port}/proxy.pac`;
      const pac = await mod.testProxy({ ...settings, mode: 'pac', pacUrl }, target);
      assert.equal(pac.ok, true, JSON.stringify(pac));
      assert.match(pac.route, /PROXY 127\.0\.0\.1:/);
      const direct = await mod.testProxy({ ...settings, mode: 'direct' }, `http://127.0.0.1:${origin.address().port}/direct`);
      assert.equal(direct.ok, true);
      assert.equal(direct.route, 'DIRECT');
      const failed = await mod.testProxy({ ...settings, port: 1 }, target);
      assert.equal(failed.ok, false);
      return { ok: true, summary: 'both sessions, production BrowserView preload, HTTP, SOCKS5, bypass, PAC, direct and unavailable proxy verified' };
    } finally {
      view?.webContents.destroy();
      host?.destroy();
      ipcMain.removeListener('get-ruffle-mode', ruffle);
      ipcMain.removeListener('userscript:get-config', scripts);
      for (const channel of ['userscript:report', 'userscript:menu-register', 'userscript:menu-unregister', 'password:form-detected']) ipcMain.removeListener(channel, ignore);
      proxy.close();
      origin.close();
      for (const socket of sockets) socket.destroy();
      socks.close();
    }
  },
};
