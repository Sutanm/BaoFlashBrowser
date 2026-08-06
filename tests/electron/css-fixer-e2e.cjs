// Manual E2E verification for the CSS Fixer against the real ruffle.rs
// downloads page: loads the page with the production preload + auto-installed
// built-in fixer and reports computed styles + a screenshot.
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'css-fixer-e2e-'));
app.setPath('userData', USER_DATA);

app.whenReady().then(async () => {
  ipcMain.on('get-ruffle-mode', (event) => { event.returnValue = { enabled: false }; });
  ipcMain.on('userscript:get-config', (event, payload) => {
    event.returnValue = mod.getUserscriptManager()
      ? mod.getUserscriptManager().snapshotFor(event.sender.id, payload?.url ?? '', Boolean(payload?.isMainFrame))
      : { ok: false, scripts: [], values: {} };
  });
  ipcMain.on('userscript:report', () => {});

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();
  const fixer = mod.listUserscripts().find((s) => s.metadata.name === 'BaoFlash Modern CSS Fixer');
  console.log('[css-fixer-e2e] fixer installed:', fixer ? fixer.id + ' enabled=' + fixer.enabled : 'MISSING');
  console.log('[css-fixer-e2e] matches:', JSON.stringify(fixer?.metadata?.match));

  const preloadPath = path.join(__dirname, '..', '..', 'release', 'tests', 'userscript-runtime-preload.cjs');
  const host = new BrowserWindow({ show: true, width: 1280, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true, spellcheck: false } });
  const view = new BrowserView({
    webPreferences: {
      preload: preloadPath,
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      spellcheck: false,
      partition: 'persist:css-fixer-e2e',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  mod.getUserscriptManager().registerView(view.webContents.id, { mode: 'ppapi', generation: 1, token: 'css-fixer-e2e' });

  await view.webContents.loadURL('https://ruffle.rs/downloads');
  await new Promise((resolve) => setTimeout(resolve, 12000));

  const report = await view.webContents.executeJavaScript(`(() => {
    const containers = [];
    const els = document.querySelectorAll('.m_7485cace[data-strategy=block]');
    for (let i = 0; i < els.length && i < 5; i++) {
      const s = getComputedStyle(els[i]);
      containers.push({ maxWidth: s.maxWidth, marginLeft: s.marginLeft, marginRight: s.marginRight });
    }
    const pre = document.querySelector('pre');
    const preStyle = pre ? getComputedStyle(pre) : null;
    const fixedStyles = [];
    const styles = document.querySelectorAll('style[data-bf-css-fixed]');
    for (let i = 0; i < styles.length && i < 10; i++) fixedStyles.push((styles[i].getAttribute('data-bf-css-fix-source') || '(inline)').replace(/^https?:\\/\\//, ''));
    return {
      title: document.title,
      url: location.href,
      containers,
      preBackground: preStyle ? preStyle.backgroundColor : null,
      prePadding: preStyle ? preStyle.padding : null,
      bodyOverflowX: document.documentElement.scrollWidth > window.innerWidth,
      fixedStyles,
    };
  })()`);

  console.log('[css-fixer-e2e] REPORT:', JSON.stringify(report, null, 2));

  const image = await view.webContents.capturePage();
  const out = path.join(os.tmpdir(), 'css-fixer-e2e.png');
  fs.writeFileSync(out, image.toPNG());
  console.log('[css-fixer-e2e] screenshot saved:', out);

  host.destroy();
  app.exit(0);
});
