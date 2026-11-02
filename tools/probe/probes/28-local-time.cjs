const path = require('path');

module.exports = {
  id: '28-local-time',
  name: 'BrowserView local timezone',
  needsElectron: true,
  timeoutMs: 20_000,
  async run(ctx) {
    const { BrowserWindow, BrowserView, ipcMain } = ctx.electron;
    const host = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const view = new BrowserView({ webPreferences: {
      preload: path.join(ctx.root, 'dist', 'webview-preload.js'),
      contextIsolation: true, nodeIntegration: false, plugins: true,
      partition: 'probe-local-time',
    } });
    host.addBrowserView(view);
    const mode = (event) => { if (event.sender.id === view.webContents.id) event.returnValue = { enabled: false }; };
    const scripts = (event) => {
      if (event.sender.id === view.webContents.id) event.returnValue = { ok: true, mode: 'ppapi', generation: 1, scripts: [], values: {} };
    };
    ipcMain.on('get-ruffle-mode', mode);
    ipcMain.on('userscript:get-config', scripts);
    const registered = [];
    for (const [channel, value] of [['userscript:automation-v3-list', []], ['userscript:automation-v3-status', { enabled: false, state: 'idle', executedSteps: 0, logs: [] }]]) {
      try { ipcMain.handle(channel, () => value); registered.push(channel); }
      catch { /* Another deep probe may already own this channel. */ }
    }
    try {
      await view.webContents.loadURL('data:text/html;charset=utf-8,<title>Local time probe</title>');
      const dates = ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z'];
      const main = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, offsets: dates.map((date) => new Date(date).getTimezoneOffset()) };
      const page = await view.webContents.executeJavaScript(`({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, offsets:${JSON.stringify(dates)}.map(date=>new Date(date).getTimezoneOffset()), language:navigator.language})`);
      const ok = main.timezone === page.timezone && main.offsets.every((offset, index) => page.offsets[index] === offset);
      return { ok, summary: `${page.timezone} · offsets ${page.offsets.join('/')} min · main/BrowserView ${ok ? 'agree' : 'MISMATCH'}`, detail: { main, page } };
    } finally {
      ipcMain.removeListener('get-ruffle-mode', mode);
      ipcMain.removeListener('userscript:get-config', scripts);
      for (const channel of registered) ipcMain.removeHandler(channel);
      host.destroy();
    }
  },
};
