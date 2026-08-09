const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');

const timeout = setTimeout(() => {
  console.error('[smoke] timed out');
  app.exit(1);
}, 15000);

async function load(view, marker) {
  await view.webContents.loadURL(`data:text/html,<title>${marker}</title><main id="marker">${marker}</main>`);
  const value = await view.webContents.executeJavaScript('document.querySelector("#marker").textContent');
  if (value !== marker) throw new Error(`expected ${marker}, received ${value}`);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const preferences = {
    plugins: true,
    contextIsolation: true,
    nodeIntegration: false,
    partition: 'persist:smoke',
    preload: path.join(__dirname, '..', '..', 'dist', 'webview-preload.js'),
  };
  const first = new BrowserView({ webPreferences: preferences });
  const second = new BrowserView({ webPreferences: preferences });

  try {
    window.addBrowserView(first);
    window.addBrowserView(second);
    first.setBounds({ x: 0, y: 0, width: 640, height: 480 });
    second.setBounds({ x: -9999, y: -9999, width: 1, height: 1 });

    // Opening the library sidebar moves the fixed-size page viewport instead
    // of narrowing it. The right edge is clipped by the native window.
    first.setBounds({ x: 316, y: 0, width: 640, height: 480 });
    const sidebarBounds = first.getBounds();
    if (sidebarBounds.x !== 316 || sidebarBounds.width !== 640) {
      throw new Error(`fixed viewport changed after sidebar shift: ${JSON.stringify(sidebarBounds)}`);
    }
    await Promise.all([load(first, 'first'), load(second, 'second')]);

    const passwordFormDetected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dynamic password form signal timed out')), 3000);
      ipcMain.once('password:form-detected', (event) => {
        clearTimeout(timer);
        resolve(event.sender.id);
      });
    });
    await first.webContents.executeJavaScript(
      `setTimeout(function(){var input=document.createElement('input');input.type='password';document.body.appendChild(input);},50)`,
    );
    const detectedWebContentsId = await passwordFormDetected;
    if (detectedWebContentsId !== first.webContents.id) {
      throw new Error(`password form signal came from unexpected view: ${detectedWebContentsId}`);
    }

    first.webContents.debugger.attach('1.3');
    const bindingPayload = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP binding signal timed out')), 3000);
      first.webContents.debugger.on('message', (_event, method, params) => {
        if (method === 'Runtime.bindingCalled' && params.name === '__baopSmokeReport') {
          clearTimeout(timer);
          resolve(params.payload);
        }
      });
    });
    await first.webContents.debugger.sendCommand('Runtime.addBinding', { name: '__baopSmokeReport' });
    await first.webContents.debugger.sendCommand('Runtime.enable');
    await first.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: `window.__baopSmokeReport('binding-ok')`,
    });
    if ((await bindingPayload) !== 'binding-ok') throw new Error('unexpected CDP binding payload');
    first.webContents.debugger.detach();

    const firstProcess = first.webContents.getOSProcessId();
    const secondProcess = second.webContents.getOSProcessId();
    if (!firstProcess || !secondProcess || firstProcess === secondProcess) {
      throw new Error(`BrowserViews are not isolated: ${firstProcess}/${secondProcess}`);
    }

    first.setBounds({ x: -9999, y: -9999, width: 1, height: 1 });
    second.setBounds({ x: 0, y: 0, width: 640, height: 480 });
    await second.webContents.reload();
    console.log('[smoke] BrowserView isolation, fixed viewport, hidden bounds, password signals and reload passed');
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error('[smoke] failed:', error);
    clearTimeout(timeout);
    app.exit(1);
  }
}).catch((error) => {
  console.error('[smoke] startup failed:', error);
  clearTimeout(timeout);
  app.exit(1);
});
