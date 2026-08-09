// Verify the SWF render fix: main-process insertCSS on dom-ready.
// This mirrors the fix in tabs.ts _wireBrowserViewEvents.
//
//   npx electron tests/electron/swf-render-verify.cjs
//
const { app, BrowserView, BrowserWindow } = require('electron');
const path = require('path');

const SWF_PATH = path.join(__dirname, '..', 'sample-swf-files-sample_1280x720.swf');
const SWF_URL = 'file:///' + SWF_PATH.replace(/\\/g, '/');

app.commandLine.appendSwitch('ppapi-flash-path', path.join(__dirname, '..', '..', 'plugins', 'win64', 'pepflashplayer.dll'));
app.commandLine.appendSwitch('ppapi-flash-version', '29.0.0.171');
app.commandLine.appendSwitch('ignore-gpu-blacklist');

let win, view;

app.whenReady().then(() => {
  win = new BrowserWindow({ width: 1200, height: 800 });

  view = new BrowserView({
    webPreferences: {
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });

  // Mirror the fix from tabs.ts: insert CSS on dom-ready for SWF files
  view.webContents.on('dom-ready', () => {
    try {
      const url = view.webContents.getURL();
      if (/\.swf(\?|#|$)/i.test(url)) {
        view.webContents.insertCSS(
          'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}' +
          'embed,object{width:100%!important;height:100%!important}',
        ).then(({ key }) => {
          console.log('insertCSS key:', key);
        });
      }
    } catch (e) { console.error('insertCSS failed:', e); }
  });

  view.webContents.on('dom-ready', () => {
    setTimeout(async () => {
      const dims = await view.webContents.executeJavaScript(`({
        htmlHeight: getComputedStyle(document.documentElement).height,
        bodyHeight: document.body.offsetHeight,
        embedInfo: (function() {
          var e = document.querySelector('embed');
          if (!e) return null;
          return { width: e.offsetWidth, height: e.offsetHeight };
        })(),
        viewportHeight: window.innerHeight,
      })`);
      console.log('=== AFTER FIX ===');
      console.log(JSON.stringify(dims, null, 2));

      const ok = dims.bodyHeight >= 700 && dims.embedInfo && dims.embedInfo.height >= 700;
      console.log(ok ? 'PASS: Flash fills the viewport' : 'FAIL: Flash does NOT fill the viewport');
      app.quit();
    }, 500);
  });

  view.webContents.loadURL(SWF_URL);
});

app.on('window-all-closed', () => app.quit());
