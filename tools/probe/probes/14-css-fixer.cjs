'use strict';

// Opt-in real-site check; the default deep probe stays offline.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { wait, withTimeout } = require('../lib/timeout.cjs');

module.exports = {
  id: '14-css-fixer',
  name: 'CSS fixer (opt-in GitHub BrowserView)',
  needsElectron: true,
  timeoutMs: 85000,
  async run(ctx) {
    if (!process.env.BAO_PROBE_GITHUB) return { ok: true, summary: 'set BAO_PROBE_GITHUB=1 to check the live homepage' };
    const { BrowserWindow, BrowserView, ipcMain } = ctx.electron;
    const mod = require(path.join(ctx.root, 'release/tests/userscripts-admin-module.cjs'));
    const manager = mod.initUserscriptManager();
    const fixer = mod.listUserscripts().find(s => s.metadata.name === 'BaoFlash Modern CSS Fixer');
    let nativeModules;
    const mapFrames = [];
    const noteMap = event => mapFrames.push(event.frameId);
    if (process.env.BAO_PROBE_NATIVE_MODULES) {
      const built = require('esbuild').buildSync({
        stdin: { contents: "export * from './src/main/modules/github-module-service';export * from './src/main/modules/session-manager';", resolveDir: ctx.root, loader: 'ts' },
        bundle: true, platform: 'node', format: 'cjs', target: 'node12', write: false,
        external: ['electron','electron-log','electron-store','esbuild'], alias: { '@shared': path.join(ctx.root,'src/shared') },
        define: { MODULE_DOWNLOAD: 'true', MODULE_USERSCRIPTS: 'true', MODULE_AUTOMATION: 'true' },
      });
      const Module = require('module');
      const compiled = new Module(path.join(ctx.root,'probe-github-native.cjs'), module);
      compiled.filename = path.join(ctx.root,'probe-github-native.cjs'); compiled.paths = Module._nodeModulePaths(ctx.root);
      compiled._compile(built.outputFiles[0].text, compiled.filename);
      nativeModules = compiled.exports;
      ipcMain.on('github-module:map', noteMap);
      nativeModules.setupGitHubModules();
      nativeModules.configureOptionalSessionServices({ githubModules: {
        register: nativeModules.registerGitHubModuleSession,
        redirect: nativeModules.githubModuleRedirect,
        patchCsp: nativeModules.patchGitHubModuleCsp,
      } });
      // Prove native hydration without the userscript's reveal fallback.
      const source = fs.readFileSync(path.join(ctx.root,'src/main/modules/userscripts/bundled-scripts/css-fixer.user.js'),'utf8');
      mod.updateUserscriptSource(fixer.id, source.replace('installGitHubContentFallback();','installGitHubContentFallback(true);'));
    }
    // Snapshot mode reproduces the complete public HTML/CSS without network
    // variability. Assets are captured separately in artifacts/.
    let server;
    let url = 'https://github.com/';
    if (process.env.BAO_PROBE_GITHUB === 'snapshot') {
      let html = fs.readFileSync(path.join(ctx.root, 'artifacts/css-fixer-github.html'), 'utf8');
      html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/https:\/\/github\.githubassets\.com\/assets\/([^"'\s<>]+\.css)/g, '/assets/$1');
      server = http.createServer((req, res) => {
        if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
        const name = path.basename(new URL(req.url, 'http://localhost').pathname);
        const file = path.join(ctx.root, 'artifacts', name);
        if (name.endsWith('.css') && fs.existsSync(file)) { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(file)); }
        else { res.writeHead(404); res.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${server.address().port}/`;
      let source = fs.readFileSync(path.join(ctx.root, 'src/main/modules/userscripts/bundled-scripts/css-fixer.user.js'), 'utf8');
      if (process.env.BAO_PROBE_CSS_SOURCE) source = fs.readFileSync(process.env.BAO_PROBE_CSS_SOURCE, 'utf8');
      mod.updateUserscriptSource(fixer.id, source.replace('*://*.github.com/*', '*://127.0.0.1:*/*'));
      for (const script of mod.listUserscripts()) if (script.id !== fixer.id) mod.setUserscriptEnabled(script.id, false);
    }
    const config = (event, payload) => { event.returnValue = manager.snapshotFor(event.sender.id, payload?.url || '', Boolean(payload?.isMainFrame)); };
    const mode = (event) => { event.returnValue = { enabled: false }; };
    const report = (event, payload) => manager.acceptReport(event.sender.id, payload);
    ipcMain.handle('userscript:automation-v3-list', async () => []);
    ipcMain.handle('userscript:automation-v3-status', async () => ({ enabled: true, state: 'idle', executedSteps: 0, logs: [] }));
    ipcMain.on('get-ruffle-mode', mode);
    ipcMain.on('userscript:get-config', config);
    ipcMain.on('userscript:report', report);
    const host = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { contextIsolation: true } });
    let preload = path.join(ctx.root, 'release/tests/userscript-runtime-preload.cjs');
    if (nativeModules) {
      const instrument = `(() => {
        const state=window.__bfNativeGl={calls:0,byCanvas:new WeakMap()};
        for(const Context of [window.WebGLRenderingContext,window.WebGL2RenderingContext]){
          if(!Context)continue;for(const name of ['clear','drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){
            const original=Context.prototype[name];if(typeof original!=='function')continue;
            Context.prototype[name]=function(...args){state.calls++;if(this.canvas)state.byCanvas.set(this.canvas,(state.byCanvas.get(this.canvas)||0)+1);return original.apply(this,args);};
          }
        }
      })()`;
      const production = fs.readFileSync(preload,'utf8');
      preload = path.join(ctx.userData,'github-native-probe-preload.cjs');
      fs.writeFileSync(preload, `require('electron').webFrame.executeJavaScript(${JSON.stringify(instrument)}).catch(()=>{});\n`+production);
    }
    const view = new BrowserView({ webPreferences: {
      preload,
      contextIsolation: true, nodeIntegration: false, plugins: true,
      backgroundThrottling: false,
      partition: 'persist:probe-css-fixer', spellcheck: false,
    } });
    // A real tab is hosted by a loaded shell window. Leaving its host at the
    // initial uncommitted about:blank keeps document.visibilityState hidden
    // in Electron 11 and pauses GitHub's native animation loop.
    await host.loadURL('data:text/html,<title>GitHub compatibility probe</title>');
    host.addBrowserView(view);
    host.setTopBrowserView(view);
    host.show();
    view.setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
    manager.registerView(view.webContents.id, { mode: 'ppapi', generation: 1, token: 'probe-css-fixer' });
    const scriptErrors = [];
    const networkErrors = [];
    view.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3 && scriptErrors.length < 30) scriptErrors.push(message.replace(/https?:\/\/[^\s)]+/g, value => { try { const u = new URL(value); return u.origin + u.pathname; } catch { return '[url]'; } }).slice(0, 500));
    });
    view.webContents.session.webRequest.onErrorOccurred(details => {
      if (networkErrors.length < 40) { const u = new URL(details.url); networkErrors.push({ url: u.origin + u.pathname, type: details.resourceType, error: details.error }); }
    });
    try {
      if (process.env.BAO_PROBE_PROXY) await view.webContents.session.setProxy({ proxyRules: process.env.BAO_PROBE_PROXY });
      // Snapshot mode is a CSS control; live mode leaves site scripts enabled.
      if (nativeModules) nativeModules.applyCompatibilitySessionConfig(view.webContents.session);
      else view.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: Boolean(server && (details.resourceType === 'script' || !details.url.startsWith(url))) }));
      await withTimeout(view.webContents.loadURL(url), 25000, 'GitHub load').catch(() => {});
      host.show();
      host.focus();
      await wait(server ? 5000 : (nativeModules ? 25000 : 15000));
      const detail = await withTimeout(view.webContents.executeJavaScript(`(async () => {
        const nav = document.querySelector('[data-marketing-header]') || document.querySelector('.HeaderMenu');
        const rect = nav && nav.getBoundingClientRect();
        const sheets = Array.from(document.querySelectorAll('link[rel~=stylesheet]'));
        return {
          title: document.title, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          ready: document.readyState, visibility: document.visibilityState,
          apps: Array.from(document.querySelectorAll('react-app')).map(el => ({ name: el.getAttribute('app-name'), attrs: el.getAttributeNames().map(name=>[name,el.getAttribute(name)]), keys: Object.keys(el).filter(k=>k.startsWith('__react')).slice(0,4) })),
          canvases: Array.from(document.querySelectorAll('canvas')).map(el => ({width:el.width,height:el.height})),
          canvasLayout: Array.from(document.querySelectorAll('canvas')).map(el=>({engine:el.getAttribute('data-engine'),class:el.className,rect:JSON.stringify(el.getBoundingClientRect()),parents:[el.parentElement?.className,el.parentElement?.parentElement?.className,el.parentElement?.parentElement?.parentElement?.className]})),
          nav: nav ? { height: rect.height, width: rect.width, top: rect.top, display: getComputedStyle(nav).display } : null,
          bannerBottom: document.querySelector('react-partial[partial-name="marketing-global-banner"] [data-target="react-partial.reactRoot"]')?.getBoundingClientRect().bottom || 0,
          fixed: document.querySelectorAll('style[data-bf-css-fix-source]').length,
          overrides: Array.from(document.querySelectorAll('style[data-bf-css-fix-source]')).map(s => ({ source: s.getAttribute('data-bf-css-fix-source'), bytes: s.textContent.length, ranges: (s.textContent.match(/width[<>]=/g)||[]).length, minWidth: (s.textContent.match(/min-width:/g)||[]).length })),
          headerMarkup: nav?.outerHTML.slice(0, 1200),
          headerChildren: nav ? Array.from(nav.querySelectorAll('nav, ul, [class*=bar__], [class*=menu__], [class*=panel__]')).map(el => ({ class: el.className, height: el.getBoundingClientRect().height, display: getComputedStyle(el).display, position: getComputedStyle(el).position })) : [],
          sheets: await Promise.all(sheets.map(async l => {
            const fixed = Array.from(document.querySelectorAll('style[data-bf-css-fix-source]')).find(s => s.getAttribute('data-bf-css-fix-source') === l.href);
            if (${Boolean(nativeModules)}) return {url:l.href.split('?')[0],fixed:!!fixed};
            let text = ''; let error = '';
            try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 5000); try { text = await (await fetch(l.href, { signal: c.signal })).text(); } finally { clearTimeout(t); } } catch(e) { error = String(e); }
            return { url: l.href.split('?')[0], fixed: !!fixed, bytes: text.length, error,
              media: (text.match(/@media[^{}]+/g)||[]).slice(0,12),
              header: text.includes('HeaderMenu') ? text.slice(Math.max(0,text.indexOf('HeaderMenu')-100),text.indexOf('HeaderMenu')+500) : '' };
          }))
        };
      })()`), 15000, 'GitHub style report');
      const out = path.join(ctx.root, 'artifacts', 'css-fixer-github.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, (await view.webContents.capturePage()).toPNG());
      if (nativeModules) {
        detail.animationControl = await view.webContents.executeJavaScript(`(() => {
          const buttons=Array.from(document.querySelectorAll('#hero button[aria-label]'));
          const play=buttons.find(el=>/^play animation$/i.test(el.getAttribute('aria-label')));
          const result={reduced:matchMedia('(prefers-reduced-motion:reduce)').matches,labels:buttons.map(el=>el.getAttribute('aria-label')),started:!!play};
          if(play)play.click();return result;
        })()`);
        await wait(700);
        detail.nativeAnimation = await withTimeout(view.webContents.executeJavaScript(`new Promise(resolve => {
          const canvas=Array.from(document.querySelectorAll('canvas')).find(el=>el.width>800&&el.height>800);
          if(!canvas){resolve({found:false});return;}
          let draws=0;const restores=[];
          for(const Context of [window.WebGLRenderingContext,window.WebGL2RenderingContext]){
            if(!Context)continue;for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){
              const original=Context.prototype[name];if(typeof original!=='function')continue;
              Context.prototype[name]=function(...args){if(this.canvas===canvas)draws++;return original.apply(this,args);};
              restores.push(()=>{Context.prototype[name]=original;});
            }
          }
          requestAnimationFrame(()=>{
            const before=window.__bfNativeGl?.byCanvas.get(canvas)||0;
            let first;try{first=canvas.toDataURL();}catch{restores.forEach(fn=>fn());resolve({found:true,readable:false,draws});return;}
            setTimeout(()=>requestAnimationFrame(()=>{const second=canvas.toDataURL();restores.forEach(fn=>fn());resolve({found:true,readable:true,changed:first!==second,bytes:second.length,draws,nativeDraws:(window.__bfNativeGl?.byCanvas.get(canvas)||0)-before,totalNativeCalls:window.__bfNativeGl?.calls});}),400);
          });
        })`), 5000, 'native animation frames');
        detail.interactionBefore = await view.webContents.executeJavaScript(`(() => {
          const button=Array.from(document.querySelectorAll('.Toggle-button')).find(el=>el.textContent.trim()==='Plan');
          if(!button)return {found:false}; button.click();return {found:true};
        })()`);
        await wait(1000);
        detail.interactionAfter = await view.webContents.executeJavaScript(`(() => {
          const button=Array.from(document.querySelectorAll('.Toggle-button')).find(el=>el.textContent.trim()==='Plan');
          return {selected:!!button&&button.classList.contains('Toggle-button--selected'),description:document.getElementById('heroCarouselDescription')?.textContent.slice(0,180)};
        })()`);
      }
      if (process.env.BAO_PROBE_SCROLL) {
        detail.scrollSamples = [];
        const height = await view.webContents.executeJavaScript('document.documentElement.scrollHeight');
        for (let y = 800; y < height; y += 1200) {
          await view.webContents.executeJavaScript(`scrollTo(0, ${y})`);
          await wait(nativeModules ? 750 : 350);
          const sample = await view.webContents.executeJavaScript(`(() => ({ y:scrollY, visibility:document.visibilityState,
            hiddenText:Array.from(document.querySelectorAll('.lp-Home h2,.lp-Home p')).filter(el=>{const r=el.getBoundingClientRect();return r.top>120&&r.top<innerHeight-80&&r.height>0&&getComputedStyle(el).opacity==='0';}).map(el=>el.textContent.slice(0,80)) }))()`);
          detail.scrollSamples.push(sample);
        }
        await wait(1500);
        detail.belowFold = await view.webContents.executeJavaScript(`(() => {
          const hidden = Array.from(document.querySelectorAll('h1,h2,h3,p,section,video,canvas,[class*=lp-]')).filter(el => { const r=el.getBoundingClientRect(); return r.width>50 && r.height>10 && getComputedStyle(el).opacity==='0'; }).slice(0,40).map(el => ({tag:el.tagName, class:el.className, text:el.textContent.slice(0,100)}));
          return { height:document.documentElement.scrollHeight, visibleSections:document.querySelectorAll('.is-visible').length, hidden,
            images:Array.from(document.images).filter(el=>el.width>40).map(el=>({loaded:el.complete&&el.naturalWidth>0,lazy:el.loading,src:(el.currentSrc||el.src).split('?')[0]})).slice(-30),
            videos:Array.from(document.querySelectorAll('video')).map(el=>({ready:el.readyState,error:el.error?.code,paused:el.paused})),
            animations:document.getAnimations().length };
        })()`);
        await view.webContents.executeJavaScript('scrollTo(0, Math.min(2500, document.documentElement.scrollHeight-innerHeight))');
        await wait(300);
        fs.writeFileSync(path.join(ctx.root, 'artifacts/css-fixer-github-below.png'), (await view.webContents.capturePage()).toPNG());
      }
      detail.scriptErrors = scriptErrors;
      detail.nativeModules = nativeModules ? { ...nativeModules.githubModuleDiagnostics(), mapFrames } : null;
      detail.networkErrors = networkErrors;
      const scrollOk = !process.env.BAO_PROBE_SCROLL || (detail.belowFold.visibleSections > 0
        && (nativeModules ? detail.scrollSamples.every(sample=>sample.hiddenText.length===0) : !detail.belowFold.hidden.some(el => el.tag === 'H2' || el.tag === 'P'))
        && detail.belowFold.videos.some(video => video.ready >= 2));
      const fatalErrors = scriptErrors.filter(error => !/^Uncaught \(in promise\) AbortError: The play\(\) request was interrupted by a new load request\./.test(error));
      const nativeOk = !nativeModules || (detail.apps.some(app=>app.attrs.some(([key,value])=>key==='class'&&value.includes('loaded')))
        && detail.canvases.length>0 && detail.nativeAnimation?.totalNativeCalls>0 && detail.interactionAfter?.selected && fatalErrors.length===0);
      return { ok: !!detail.nav && detail.nav.height < 160 && detail.nav.top >= detail.bannerBottom - 1 && scrollOk && nativeOk, summary: `GitHub menu height ${detail.nav?.height}, ${detail.fixed} rewritten sheets${detail.belowFold ? `, ${detail.belowFold.visibleSections} revealed sections, scroll ${scrollOk ? 'OK' : 'FAIL'}` : ''}${nativeModules ? `, native interaction ${nativeOk ? 'OK' : 'FAIL'}` : ''}`, detail };
    } catch (error) {
      return { ok: false, summary: String(error), detail: { nativeModules: nativeModules ? { ...nativeModules.githubModuleDiagnostics(), mapFrames } : null, scriptErrors, networkErrors } };
    } finally {
      manager.unregisterView(view.webContents.id);
      view.webContents.destroy();
      host.destroy();
      server?.close();
      ipcMain.removeListener('get-ruffle-mode', mode);
      ipcMain.removeListener('userscript:get-config', config);
      ipcMain.removeListener('userscript:report', report);
      ipcMain.removeHandler('userscript:automation-v3-list');
      ipcMain.removeHandler('userscript:automation-v3-status');
      if (nativeModules) ipcMain.removeListener('github-module:map', noteMap);
    }
  },
};
