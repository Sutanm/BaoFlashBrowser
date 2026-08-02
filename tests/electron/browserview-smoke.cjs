const { app, BrowserView, BrowserWindow } = require('electron');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

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
  const preferences = { plugins: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:smoke' };
  const first = new BrowserView({ webPreferences: preferences });
  const second = new BrowserView({ webPreferences: preferences });

  try {
    window.addBrowserView(first);
    window.addBrowserView(second);
    first.setBounds({ x: 0, y: 0, width: 640, height: 480 });
    second.setBounds({ x: -9999, y: -9999, width: 1, height: 1 });
    await Promise.all([load(first, 'first'), load(second, 'second')]);

    const firstProcess = first.webContents.getOSProcessId();
    const secondProcess = second.webContents.getOSProcessId();
    if (!firstProcess || !secondProcess || firstProcess === secondProcess) {
      throw new Error(`BrowserViews are not isolated: ${firstProcess}/${secondProcess}`);
    }

    first.setBounds({ x: -9999, y: -9999, width: 1, height: 1 });
    second.setBounds({ x: 0, y: 0, width: 640, height: 480 });
    await second.webContents.reload();
    console.log('[smoke] BrowserView isolation, hidden bounds and reload passed');
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
