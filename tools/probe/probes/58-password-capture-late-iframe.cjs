// Probe 58 — attach 之后才创建的子 iframe，捕获脚本能不能真正上报。
//
// 线上证据（2026-11-10，7k7k 玩法页）：主文档 attach 后能收到 DIAG；随后
// `context created: 58..53`（新文档/新帧）却**一条 DIAG 都没有**，接着用户报告的
// "在子 iframe 里登录没有保存提示"。
//
// 怀疑点：`Runtime.addBinding` 在 attach 时安装；此后新建的帧/context 里
// `window.__baopReport` 可能并不存在。脚本所有上报都走它，于是"脚本注入了、
// 却什么都说不出" —— 表现就是完全没有 DIAG、也没有 capture。
//
// 本探针分两段对比（同一站点、不同端口的子帧 = 同站跨源、非 OOPIF）：
//   A. 页面加载时就带 iframe（attach 时 context 已存在）
//   B. attach 之后再用 JS 创建 iframe
// 期望：两段都能上报（能捕获 / 至少 DIAG 里有该帧）；若 B 段完全静默，即命中怀疑点。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { wait, waitFor } = require('../lib/timeout.cjs');

const PASS_A = 'existing-frame-pass';
const PASS_B = 'late-frame-pass';

function formPage(password, submitFlag, username) {
  return `<!doctype html><html><body>
  <form id="login"><input id="u" name="username" value=""><input id="p" name="password" type="password"><button type="submit">登录</button></form>
  <script>
    document.getElementById('login').addEventListener('submit', function (event) { event.preventDefault(); window.${submitFlag} = 1; });
    // 探针通过 postMessage 触发填写与提交（跨源同站，父页不能直接摸 DOM）
    window.addEventListener('message', function (event) {
      if (!event.data || event.data.action !== 'fill') return;
      // 先账号后密码（真实输入顺序）：capture 的 _rawUser 由"密码 input 事件"顺带读取，
      // 反过来写会得到空用户名，从而被"同 host+同账号已提示过"的去重挡住。
      document.getElementById('u').value = ${JSON.stringify(username)}${''};
      document.getElementById('u').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('p').value = ${JSON.stringify(password)};
      document.getElementById('p').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login').querySelector('button').click();
      event.source.postMessage({ action: 'done' }, '*');
    });
  </script>
</body></html>`;
}

module.exports = {
  id: '58-password-capture-late-iframe',
  name: 'capture in sub-iframes: existing at attach vs created after attach',
  needsElectron: true,
  timeoutMs: 90000,
  async run(ctx) {
    const { BrowserWindow, ipcMain } = ctx.electron;
    const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bao-capture-late-')), 'bundle.cjs');
    await require('esbuild').build({
      stdin: { contents: "export * from './src/main/modules/password-capture';", resolveDir: ctx.root, loader: 'ts' },
      outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node12',
      external: ['electron', 'electron-log'], alias: { '@shared': path.join(ctx.root, 'src/shared') },
      plugins: [{ name: 'isolated-capture-late', setup(build) {
        build.onLoad({ filter: /[\\/]modules[\\/](password-store|window|ui-language)\.ts$/ }, (args) => {
          const name = path.basename(args.path);
          const contents = name === 'password-store.ts'
            ? "export const getMetaForHost=()=>[]; export const getDecryptedPassword=()=>null; export const isAutoCaptureEnabled=()=>true; export const isCaptureExcluded=()=>false;"
            : name === 'window.ts' ? 'export const getMainWindow=()=>globalThis.__baoLateFrameWindow; export const getWindowForWebContents = getMainWindow; export const broadcastToRegisteredWindows = () => {};'
              : 'export const uiText=(zh)=>zh;';
          return { contents, loader: 'ts' };
        });
      } }],
    });
    const Module = require('module');
    const bundled = new Module(outfile, module);
    bundled.filename = outfile; bundled.paths = Module._nodeModulePaths(ctx.root);
    bundled._compile(fs.readFileSync(outfile, 'utf8'), outfile);
    const mod = bundled.exports;

    // 两个本地源：主页面 127.0.0.1:P1，子帧 127.0.0.1:P2（同站、跨源、非 OOPIF）
    const frameServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(String(req.url).startsWith('/b') ? formPage(PASS_B, 'submittedB', 'frame-user-b') : formPage(PASS_A, 'submittedA', 'frame-user-a'));
    });
    const mainServer = http.createServer((req, res) => {
      const frame = `http://127.0.0.1:${frameServer.address().port}`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      // A 段的 iframe 在文档里就存在；B 段用 JS 之后创建
      res.end(`<!doctype html><html><body><h1>main</h1><div id="host">${String(req.url).startsWith('/a') ? `<iframe id="f" src="${frame}/a"></iframe>` : ''}</div></body></html>`);
    });

    const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { nodeIntegration: false } });
    globalThis.__baoLateFrameWindow = win;
    const captured = [];
    win.webContents.send = (channel, payload) => { if (channel === 'password:captured') captured.push(payload); };
    ipcMain.on('userscript:get-config', (e) => { e.returnValue = { ok: true, scripts: [], values: {}, resources: {} }; });
    ipcMain.on('get-ruffle-mode', (e) => { e.returnValue = { enabled: false }; });

    const view = new (require('electron').BrowserView)({ webPreferences: { preload: path.join(ctx.root, 'dist/webview-preload.js'), nodeIntegration: false, partition: 'persist:probe-late-frame' } });
    win.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 880, height: 660 });
    const read = (script) => view.webContents.executeJavaScript(script);
    const fill = (path0) => `(function(){
      var f = document.getElementById('f');
      f.contentWindow.postMessage({ action: 'fill' }, '*');
      return true;
    })()`;

    try {
      await new Promise((resolve) => frameServer.listen(0, '127.0.0.1', resolve));
      await new Promise((resolve) => mainServer.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${mainServer.address().port}`;

      // --- A：iframe 在 attach 前已存在 ---
      await view.webContents.loadURL(`${base}/a`);
      await wait(600);
      mod.setupCapture(view.webContents);
      await wait(1200);
      const contextsA = mod.getCaptureContextIds(view.webContents);
      await read(fill('a'));
      await waitFor(() => read('Boolean(document.getElementById("f"))'), { timeoutMs: 3000, intervalMs: 100, label: 'A iframe present' });
      await wait(1500);
      const capturedA = captured.length;

      // --- B：attach 之后再创建 iframe ---
      mod.teardownCapture(view.webContents);
      await view.webContents.loadURL(`${base}/b`);
      await wait(600);
      mod.setupCapture(view.webContents);
      await wait(800);
      await read(`(function(){
        var f = document.createElement('iframe');
        f.id = 'f';
        f.src = 'http://127.0.0.1:${frameServer.address().port}/b';
        document.getElementById('host').appendChild(f);
        return true;
      })()`);
      await waitFor(() => read("document.getElementById('f') && document.getElementById('f').contentWindow.length === undefined"), { timeoutMs: 3000, intervalMs: 100, label: 'B iframe created' }).catch(() => {});
      await wait(1500);
      const contextsB = mod.getCaptureContextIds(view.webContents);
      await read(fill('b'));
      await wait(2000);
      const capturedB = captured.length - capturedA;

      return {
        ok: capturedA > 0 && capturedB > 0,
        summary: `attach 前已存在的子帧 captured=${capturedA}；attach 后新建的子帧 captured=${capturedB}`
          + `（contexts: A=${contextsA.length} B=${contextsB.length}）`,
        detail: { capturedA, capturedB, contextsA, contextsB, capturedNames: captured.map((c) => c.username) },
      };
    } finally {
      try { mod.teardownCapture(view.webContents); } catch { /* gone */ }
      try { view.webContents.destroy(); } catch { /* gone */ }
      if (!win.isDestroyed()) win.destroy();
      delete globalThis.__baoLateFrameWindow;
      try { frameServer.close(); mainServer.close(); } catch { /* best effort */ }
    }
  },
};



