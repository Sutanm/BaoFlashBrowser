// Debug script: load a local SWF file in a BrowserView, dump the internal
// HTML Chromium generates, and compare with/without CSS fix.
//
//   npx electron tests/electron/swf-render-debug.cjs
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

  view.webContents.on('dom-ready', async () => {
    // Dump the internal HTML Chromium generated for the SWF file
    const html = await view.webContents.executeJavaScript('document.documentElement.outerHTML');
    console.log('=== INTERNAL HTML ===');
    console.log(html);
    console.log('=== END ===');

    // Check body dimensions
    const dims = await view.webContents.executeJavaScript(`({
      bodyStyle: getComputedStyle(document.body).cssText,
      bodyWidth: document.body.offsetWidth,
      bodyHeight: document.body.offsetHeight,
      embedCount: document.querySelectorAll('embed').length,
      embedInfo: (function() {
        var e = document.querySelector('embed');
        if (!e) return null;
        var s = getComputedStyle(e);
        return { width: e.offsetWidth, height: e.offsetHeight, styleWidth: s.width, styleHeight: s.height };
      })(),
    })`);
    console.log('=== DIMENSIONS ===');
    console.log(JSON.stringify(dims, null, 2));
    console.log('=== END ===');

    // Now inject CSS fix and re-check
    await view.webContents.insertCSS(
      'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}' +
      'embed,object{width:100%!important;height:100%!important}'
    );

    setTimeout(async () => {
      const dimsAfter = await view.webContents.executeJavaScript(`({
        bodyWidth: document.body.offsetWidth,
        bodyHeight: document.body.offsetHeight,
        embedInfo: (function() {
          var e = document.querySelector('embed');
          if (!e) return null;
          var s = getComputedStyle(e);
          return { width: e.offsetWidth, height: e.offsetHeight, styleWidth: s.width, styleHeight: s.height };
        })(),
      })`);
      console.log('=== AFTER CSS FIX ===');
      console.log(JSON.stringify(dimsAfter, null, 2));
      console.log('=== END ===');

      app.quit();
    }, 1000);
  });

  view.webContents.loadURL(SWF_URL);
});

app.on('window-all-closed', () => app.quit());
