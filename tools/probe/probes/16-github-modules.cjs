'use strict';

const http = require('http');
const path = require('path');
const Module = require('module');
const { waitFor } = require('../lib/timeout.cjs');

module.exports = {
  id: '16-github-modules',
  name: 'GitHub import map + dynamic modules (BrowserView)',
  needsElectron: true,
  timeoutMs: 30000,
  async run(ctx) {
    const built = require('esbuild').buildSync({
      entryPoints: [path.join(ctx.root, 'src/main/modules/github-module-transform.ts')],
      bundle: true, platform: 'node', format: 'cjs', target: 'node12', write: false, external: ['esbuild'],
    });
    const compiled = new Module(path.join(ctx.root, 'probe-github-module.cjs'), module);
    compiled.filename = path.join(ctx.root, 'probe-github-module.cjs');
    compiled.paths = Module._nodeModulePaths(ctx.root);
    compiled._compile(built.outputFiles[0].text, compiled.filename);
    const { githubModuleUrl, decodeGitHubModuleUrl, transformGitHubModule } = compiled.exports;
    const { BrowserWindow, BrowserView, ipcMain } = ctx.electron;
    const id = '0123456789abcdef';
    const origin = 'https://github.githubassets.com/assets/';
    const map = { react: origin + 'react-fixture.js' };
    const sources = {
      'entry.js': `import {value} from 'react'; import *as self from './entry.js'; export const token={};window.__moduleExecutions=(window.__moduleExecutions||0)+1; class X {static {this.value=value;}} const name='./lazy.js'; import(name).then(m=>{window.__moduleProbe={value:X.value+m.extra,asset:new URL('image.png',import.meta.url).href,sameIdentity:token===self.token,executions:window.__moduleExecutions};});`,
      'react-fixture.js': 'export const value=40;',
      'lazy.js': 'export const extra=2;',
    };
    const host = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
    const view = new BrowserView({ webPreferences: {
      contextIsolation: true, nodeIntegration: false, plugins: true,
      preload: path.join(ctx.root, 'release/tests/userscript-runtime-preload.cjs'),
      partition: 'probe-github-modules', spellcheck: false,
    } });
    host.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
    const noScripts = event => { event.returnValue = { ok: false, scripts: [], values: {} }; };
    const ruffle = event => { event.returnValue = { enabled: false }; };
    ipcMain.on('userscript:get-config', noScripts);
    ipcMain.on('get-ruffle-mode', ruffle);
    view.webContents.session.protocol.registerBufferProtocol('bfb-github-module', (request, callback) => {
      const decoded = decodeGitHubModuleUrl(request.url);
      const name = decoded && new URL(decoded.source).pathname.split('/').pop();
      if (!name || !sources[name]) { callback({ statusCode: 404, data: Buffer.from('missing') }); return; }
      transformGitHubModule(sources[name], decoded.source, id, map).then(text => callback({
        statusCode: 200, mimeType: 'application/javascript',
        headers: { 'access-control-allow-origin': '*', 'content-type': 'application/javascript' }, data: Buffer.from(text),
      })).catch(error => callback({ statusCode: 500, data: Buffer.from(String(error)) }));
    });
    const errors = [];
    view.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message.slice(0, 300)); });
    view.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback(details.url.startsWith(origin) && details.url.endsWith('.js') ? { redirectURL: githubModuleUrl(details.url,id) } : {});
    });
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src bfb-github-module: https://github.githubassets.com");
      res.end(`<html><script type="module" src="${origin + 'entry.js'}"></script></html>`);
    });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      await view.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
      const result = await waitFor(() => view.webContents.executeJavaScript('window.__moduleProbe'), { timeoutMs: 10000, label: 'ESM fixture' });
      return { ok: result.value === 42 && result.asset === origin + 'image.png' && result.sameIdentity && result.executions === 1, summary: `ESM ${result.value}, ${result.executions} executions, same identity ${result.sameIdentity}`, detail: { result, errors } };
    } finally {
      view.webContents.destroy(); host.destroy(); server.close();
      ipcMain.removeListener('userscript:get-config', noScripts);
      ipcMain.removeListener('get-ruffle-mode', ruffle);
    }
  },
};
