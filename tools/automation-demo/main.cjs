const { app, BrowserWindow } = require('electron');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#eef3fa',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, 'workbench.html'));
});
