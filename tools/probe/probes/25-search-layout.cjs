'use strict';

// Opt-in public-page diagnosis. Never reuse the user's cookies or scripts.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { wait, withTimeout } = require('../lib/timeout.cjs');

module.exports = {
  id: '25-search-layout',
  name: 'search page layout comparison (opt-in)',
  needsElectron: true,
  timeoutMs: 85000,
  async run(ctx) {
    if (!process.env.BAO_PROBE_SEARCH) return { ok: true, summary: 'set BAO_PROBE_SEARCH=1 for isolated Bing comparisons' };
    const { BrowserWindow, BrowserView, ipcMain } = ctx.electron;
    const out = path.join(ctx.root, 'artifacts/search-layout');
    fs.mkdirSync(out, { recursive: true });
    const product = path.join(ctx.userData, 'search-session.cjs');
    execFileSync('node', ['-e', `require('esbuild').buildSync({entryPoints:['src/main/modules/session-manager.ts'],outfile:${JSON.stringify(product)},bundle:true,platform:'node',format:'cjs',target:'node12',external:['electron','electron-log']})`], { cwd: ctx.root, windowsHide: true, timeout: 15000 });
    const Module = require('module');
    const compiled = new Module(product, module);
    compiled.filename = product;
    compiled.paths = Module._nodeModulePaths(ctx.root);
    compiled._compile(fs.readFileSync(product, 'utf8'), product);
    const { applyCompatibilitySessionConfig } = compiled.exports;
    const oldUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36';
    const cases = [
      { id: 'cn-old', domain: 'cn.bing.com' },
      { id: 'www-old', domain: 'www.bing.com' },
      { id: 'www-modern-ua', domain: 'www.bing.com', modern: true },
      { id: 'cn-project-policy', domain: 'cn.bing.com', policy: true },
      { id: 'cn-project-runtime', domain: 'cn.bing.com', policy: true, runtime: true },
      { id: 'www-project-runtime', domain: 'www.bing.com', policy: true, runtime: true },
    ];
    const mod = require(path.join(ctx.root, 'release/tests/userscripts-admin-module.cjs'));
    const manager = mod.initUserscriptManager();
    const config = (event, payload) => { event.returnValue = manager.snapshotFor(event.sender.id, payload?.url || '', Boolean(payload?.isMainFrame)); };
    const mode = event => { event.returnValue = { enabled: false }; };
    const report = (event, payload) => manager.acceptReport(event.sender.id, payload);
    const menu = (event, payload) => manager.registerMenuCommand(event.sender.id, payload.scriptId, payload.documentId, payload.title, payload.commandId, Boolean(payload.isMainFrame));
    ipcMain.on('get-ruffle-mode', mode);
    ipcMain.on('userscript:get-config', config);
    ipcMain.on('userscript:report', report);
    ipcMain.on('userscript:menu-register', menu);
    ipcMain.handle('userscript:automation-v3-list', async () => []);
    ipcMain.handle('userscript:automation-v3-status', async () => ({ enabled: true, state: 'idle', executedSteps: 0, logs: [] }));
    const host = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    const rows = [];
    try {
      await host.loadURL('about:blank');
      host.showInactive();
      for (const item of cases) {
        const view = new BrowserView({ webPreferences: { ...(item.runtime ? { preload: path.join(ctx.root, 'release/tests/userscript-runtime-preload.cjs') } : {}), partition: `search-probe-${item.id}-${Date.now()}`, plugins: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        host.addBrowserView(view);
        view.setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
        const wc = view.webContents;
        if (item.policy) applyCompatibilitySessionConfig(wc.session);
        wc.session.setUserAgent(item.modern ? oldUA.replace('Chrome/87.0.4280.141', 'Chrome/142.0.0.0') + ' Edg/142.0.0.0' : oldUA);
        wc.setUserAgent(wc.session.getUserAgent());
        wc.setZoomFactor(1);
        if (item.runtime) manager.registerView(wc.id, { mode: 'ppapi', generation: 1, token: 'search-probe' });
        const failures = [];
        wc.on('did-fail-load', (_e, code, description, url, main) => {
          try { failures.push({ code, description, host: new URL(url).hostname, main }); } catch { /* invalid URL */ }
        });
        wc.session.webRequest.onErrorOccurred({ urls: ['https://*/*'] }, details => {
          try { failures.push({ error: details.error, type: details.resourceType, host: new URL(details.url).hostname }); } catch { /* invalid URL */ }
        });
        try {
          await withTimeout(wc.loadURL(`https://${item.domain}/search?q=redis`), 12000, item.id + ' load').catch(error => failures.push({ load: String(error).replace(/https?:\/\/\S+/g, '[url]') }));
          await wait(2000);
          const page = await withTimeout(wc.executeJavaScript(`(() => {
            const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { x:r.x,y:r.y,width:r.width,height:r.height,font:s.font,fontSize:s.fontSize,display:s.display }; };
            return { host:location.hostname,path:location.pathname,title:document.title,ua:navigator.userAgent,viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,
              nav:Array.from(document.querySelectorAll('#b_header nav a, .b_scopebar a')).map(e=>e.textContent.trim()),
              results:document.querySelectorAll('#b_results > .b_algo').length,ads:document.querySelectorAll('#b_results > .b_ad').length,
              box:rect(document.querySelector('#b_results')),firstResult:rect(document.querySelector('#b_results > .b_algo')),firstAd:rect(document.querySelector('#b_results > .b_ad')),
              heading:rect(document.querySelector('#b_results h2')), horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
              css:{has:CSS.supports('selector(:has(a))'),where:CSS.supports('selector(:where(a))'),layers:typeof CSSLayerBlockRule!=='undefined'},
              sheets:document.styleSheets.length, firstTitles:Array.from(document.querySelectorAll('#b_results > .b_algo h2')).slice(0,4).map(e=>e.textContent),
              bodyPreview:document.body.innerText.slice(0,350) };
          })()`), 3000, item.id + ' snapshot');
          const screenshot = path.join(out, item.id + '.png');
          const png = (await withTimeout(wc.capturePage(), 3000, 'capture')).toPNG();
          if (!png.length) throw new Error('empty screenshot');
          fs.writeFileSync(screenshot, png);
          rows.push({ id: item.id, page, failures: failures.slice(0,20), screenshot });
        } finally {
          if (item.runtime) manager.unregisterView(wc.id);
          wc.session.webRequest.onErrorOccurred(null);
          host.removeBrowserView(view);
          wc.destroy();
        }
      }
    } finally {
      host.destroy();
      ipcMain.removeListener('get-ruffle-mode', mode);
      ipcMain.removeListener('userscript:get-config', config);
      ipcMain.removeListener('userscript:report', report);
      ipcMain.removeListener('userscript:menu-register', menu);
      ipcMain.removeHandler('userscript:automation-v3-list');
      ipcMain.removeHandler('userscript:automation-v3-status');
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(rows, null, 2));
    const ok = rows.length === cases.length && rows.every(row => row.page.results > 0);
    return { ok, summary: ok ? 'isolated Bing comparisons captured' : 'some pages have no organic results; inspect report', detail: rows };
  },
};
