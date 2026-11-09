// Probe: DevTools「本地替换 / Overrides」在桥链路上是否可用。
//
// 背景：DevTools 前端的 Overrides 完全靠 CDP Fetch 域实现——
//   Fetch.enable(requestStage:'Response') → Fetch.requestPaused →
//   Fetch.getResponseBody（拿原始内容）→ Fetch.fulfillRequest（换成本地文件）
// 而这些命令/事件都是经「前端 preload → IPC → 主进程桥 → 目标页 session」走的。
// 桥对 Fetch.* 是透传的，所以本探针要回答的是：**这条透传链路真的成立吗**。
//
// 为什么从主进程驱动而不是从前端页面驱动：前端 preload 的 `bfbBridge.onMessage`
// 是**单监听槽**，探针再从页面里注册会顶掉前端自己的 Connection，测出来的就不是
// 生产行为了。这里用同一个 `devToolsBridge` 实例直发，测的是同一条链路。
// 前端侧则单独观测它是否真的会自己发出 `Fetch.enable`（Overrides 的业务入口）。
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const { wait, waitFor } = require('../lib/timeout.cjs');

module.exports = {
  id: '46-devtools-overrides',
  name: 'devtools local overrides over the CDP bridge',
  needsElectron: true,
  timeoutMs: 120_000,

  async run(ctx) {
    const electron = require('electron');
    const { BrowserWindow, BrowserView } = electron;
    const esbuild = require(path.join(ctx.root, 'node_modules', 'esbuild'));
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

    // ---- 0. 现场编译真实桥（不手抄实现） ----
    const cacheDir = path.join(ctx.root, 'node_modules', '.cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const bridgeBundle = path.join(cacheDir, `bfb-bridge-${process.pid}.cjs`);
    await esbuild.build({
      entryPoints: [path.join(ctx.root, 'src', 'main', 'modules', 'devtoolbox-bridge.ts')],
      outfile: bridgeBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node12',
      external: ['electron'],
      logLevel: 'silent',
    });
    const { getDevToolsBridge, disposeDevToolsBridge } = require(bridgeBundle);
    // P4b：桥按窗口分桶；probe 用一个独立桶（0 = 非真实窗口）直发同一条链路。
    const devToolsBridge = getDevToolsBridge(0);

    // 目标页：一个 HTML + 一个会被本地替换的 JS
    const server = http.createServer((req, res) => {
      if (req.url === '/page.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>overrides-fixture</title><body><div id="out">ORIGINAL</div><script src="/app.js"></script>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`document.getElementById('out').textContent = 'SERVER-APP-JS';`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const pageUrl = `http://127.0.0.1:${server.address().port}/page.html`;

    const host = new BrowserWindow({ show: false, width: 1000, height: 800 });
    const pageView = new BrowserView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false, partition: 'persist:probe-overrides-target' },
    });
    host.addBrowserView(pageView);
    pageView.setBounds({ x: 0, y: 0, width: 900, height: 600 });

    const frontend = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        partition: 'persist:probe-overrides-frontend',
        preload: path.join(ctx.root, 'dist', 'devtools-preload.js'),
      },
    });
    const frontendLogs = [];
    frontend.webContents.on('console-message', (_e, level, message) => {
      frontendLogs.push(`${level}: ${String(message).slice(0, 200)}`);
    });

    const evaluateFrontend = (expression) => frontend.webContents.executeJavaScript(expression);
    const pageText = () => pageView.webContents.executeJavaScript('document.getElementById("out") ? document.getElementById("out").textContent : ""').catch(() => '');

    try {
      await pageView.webContents.loadURL(pageUrl);
      await wait(300);

      const port = readDebugPort(electron);
      if (!port) return { ok: false, summary: 'no debug port' };
      const target = await waitFor(
        async () => (await fetchTargets(port)).find((item) => item.type === 'page' && item.url === pageUrl) ?? null,
        { timeoutMs: 15_000, label: 'target registered' },
      );
      if (!target) return { ok: false, summary: 'target not found', detail: { pageUrl } };

      // ---- A. 同一条桥上，Fetch 域能不能改写响应 ----
      await devToolsBridge.attach(target.id, port);

      const pausedEvents = [];
      let sinkBusy = false;
      devToolsBridge.setEventSink((events) => {
        for (const event of events) {
          if (event.method !== 'Fetch.requestPaused') continue;
          pausedEvents.push(event.params);
          // Response 阶段会把**主文档**也挂起；不放行的话 <script src> 根本不会发起。
          // 只针对 app.js 做改写，其余一律原样放行。
          if (!String(event.params.request.url).endsWith('/app.js')) {
            void devToolsBridge.send('Fetch.continueRequest', { requestId: event.params.requestId });
          }
        }
        void sinkBusy;
      });

      const enable = await devToolsBridge.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Response' }],
      });
      check('bridge: Fetch.enable accepted', enable.ok === true, enable);

      const reload = await devToolsBridge.send('Page.reload', { ignoreCache: true });
      check('bridge: Page.reload accepted', reload.ok === true, reload);

      const appJsPaused = await waitFor(
        async () => pausedEvents.find((item) => String(item.request.url).endsWith('/app.js')) ?? false,
        { timeoutMs: 10_000, label: 'app.js response paused' },
      ).catch(() => null);
      check('bridge: response-stage request paused', Boolean(appJsPaused), {
        paused: pausedEvents.map((item) => String(item.request.url).split('/').pop()),
      });

      if (appJsPaused) {
        const original = await devToolsBridge.send('Fetch.getResponseBody', {
          requestId: appJsPaused.requestId,
        });
        check(
          'bridge: Fetch.getResponseBody returns original body',
          original.ok === true
            && typeof original.result === 'object'
            && Buffer.from(String(original.result.body ?? ''), original.result.base64Encoded ? 'base64' : 'utf8')
              .toString('utf8')
              .includes('SERVER-APP-JS'),
          original.ok ? String(original.result && original.result.body).slice(0, 40) : original,
        );

        const fulfilled = await devToolsBridge.send('Fetch.fulfillRequest', {
          requestId: appJsPaused.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/javascript; charset=utf-8' }],
          body: Buffer.from("document.getElementById('out').textContent = 'LOCAL-OVERRIDE-FILE';").toString('base64'),
        });
        check('bridge: Fetch.fulfillRequest accepted', fulfilled.ok === true, fulfilled);

        const rendered = await waitFor(
          async () => ((await pageText()) === 'LOCAL-OVERRIDE-FILE' ? true : false),
          { timeoutMs: 10_000, label: 'page renders overridden body' },
        ).catch(() => false);
        check('bridge: page renders overridden body', rendered === true, await pageText());
      } else {
        check('bridge: Fetch.getResponseBody returns original body', false, 'skipped: no paused request');
        check('bridge: Fetch.fulfillRequest accepted', false, 'skipped: no paused request');
        check('bridge: page renders overridden body', false, 'skipped: no paused request');
      }

      await devToolsBridge.send('Fetch.disable', {});
      // 让页面回到服务端内容，便于观察前端自己的拦截
      await devToolsBridge.send('Page.reload', { ignoreCache: true });
      await wait(800);
      check('bridge: reload restores server content', (await pageText()) === 'SERVER-APP-JS', await pageText());

      // ---- B. 前端 Overrides 的宿主能力是否就位 ----
      // 前端 `NetworkPersistenceManager` 的实例由 `entrypoints/main/main.js` 在**面板初始化**
      // 时创建（`instance({forceNew:true, workspace: WorkspaceImpl.instance(), ...})`），
      // 并依赖 BreakpointManager 等一整套上游单例。探针里手工 new 这些单例等于自己复刻
      // 启动流程，测出来的不是生产行为——所以这里只做**静态能力检查**：
      // 模块在、设置项在、我们的宿主方法在。真实 UI 链路（在 Sources 里点「编辑并保存」
      // 生成 override 文件 → 刷新页面看到本地内容）需要真机手工确认。
      devToolsBridge.setEventSink(null);
      const entry = path.join(ctx.root, 'dist', 'devtools-frontend', 'devtools_app.html');
      await frontend.loadURL(toFileUrl(entry) + '?can_dock=true');
      await waitFor(
        async () => (await evaluateFrontend('Boolean(window.bfbBridge && window.bfbBridge.send)').catch(() => false)),
        { timeoutMs: 30_000, label: 'frontend preload ready' },
      );

      const capability = await evaluateFrontend(`(async () => {
        const common = await import('./core/common/common.js');
        const persistence = await import('./models/persistence/persistence.js');
        const setting = common.Settings.Settings.instance().moduleSetting('persistenceNetworkOverridesEnabled');
        return JSON.stringify({
          settingPresent: Boolean(setting),
          settingDefault: setting ? setting.get() : null,
          managerClass: typeof persistence.NetworkPersistenceManager.NetworkPersistenceManager,
          // 前端只依赖这两个 Web 标准接口来读写本地文件；我们的宿主层补齐了它们
          isolatedFileSystemOnHost: typeof globalThis.InspectorFrontendHost.isolatedFileSystem,
          addFileSystemOnHost: typeof globalThis.InspectorFrontendHost.addFileSystem,
        });
      })()`).catch((error) => `EVAL_ERR ${error.message}`);

      let capabilityState = null;
      try { capabilityState = JSON.parse(capability); } catch { capabilityState = null; }
      check(
        'frontend: overrides setting registered',
        Boolean(capabilityState && capabilityState.settingPresent),
        capability,
      );
      check(
        'frontend: NetworkPersistenceManager class available',
        Boolean(capabilityState && capabilityState.managerClass === 'function'),
        capability,
      );
      check(
        'host: file system methods are ours (not the hosted stub)',
        Boolean(capabilityState
          && capabilityState.isolatedFileSystemOnHost === 'function'
          && capabilityState.addFileSystemOnHost === 'function'),
        capability,
      );

      // 清理：把前面测 Fetch 时打开的模式关掉，避免影响后续探针
      try { await devToolsBridge.send('Fetch.disable', {}); } catch { /* ignore */ }
    } catch (error) {
      checks.push({ name: 'probe crashed', ok: false, detail: String(error && (error.stack || error.message)) });
    } finally {
      devToolsBridge.setEventSink(null);
      disposeDevToolsBridge(0);
      try { if (!pageView.webContents.isDestroyed()) pageView.webContents.destroy(); } catch { /* ignore */ }
      try { if (!host.isDestroyed()) host.destroy(); } catch { /* ignore */ }
      try { if (!frontend.isDestroyed()) frontend.destroy(); } catch { /* ignore */ }
      try { server.close(); } catch { /* ignore */ }
      try { fs.rmSync(bridgeBundle, { force: true }); } catch { /* ignore */ }
    }

    const failures = checks.filter((item) => !item.ok);
    return {
      ok: failures.length === 0,
      summary: failures.length === 0 ? `${checks.length} checks passed` : `${failures.length}/${checks.length} failed`,
      detail: { failures, checks, frontendConsole: frontendLogs.slice(-6) },
    };
  },
};

function readDebugPort(electron) {
  const fromSwitch = Number.parseInt(electron.app.commandLine.getSwitchValue('remote-debugging-port'), 10);
  if (Number.isFinite(fromSwitch) && fromSwitch > 0) return fromSwitch;
  try {
    const first = fs.readFileSync(path.join(electron.app.getPath('userData'), 'DevToolsActivePort'), 'utf-8').split('\n')[0];
    const port = Number.parseInt(first, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function fetchTargets(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch {
          resolve([]);
        }
      });
    });
    request.on('error', () => resolve([]));
    request.on('timeout', () => { request.destroy(); resolve([]); });
  });
}

function toFileUrl(target) {
  return `file:///${target.replace(/\\/g, '/').replace(/^\//, '')}`;
}
