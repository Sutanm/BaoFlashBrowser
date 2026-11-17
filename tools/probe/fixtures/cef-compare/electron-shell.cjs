'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { wait, waitFor } = require('../../lib/timeout.cjs');

const [mappingName, profile, output, modules] = process.argv.slice(2);
app.setPath('userData', profile);

const koffi = require(path.join(modules, 'koffi'));
const kernel = koffi.load('kernel32.dll');
const open = kernel.func('void* OpenFileMappingW(uint32_t, int, str16)');
const map = kernel.func('void* MapViewOfFile(void*, uint32_t, uint32_t, uint32_t, size_t)');
const unmap = kernel.func('int UnmapViewOfFile(void*)');
const close = kernel.func('int CloseHandle(void*)');
const frameBytes = 550 * 420 * 4;
const headerBytes = 4; // SharedFrame::generation
const report = { electron: process.versions.electron, chrome: process.versions.chrome, centers: [] };

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 600, height: 570, show: false,
    webPreferences: { preload: path.join(__dirname, 'electron-preload.cjs'), backgroundThrottling: false },
  });
  ipcMain.on('cef-drawn', (event, color) => {
    if (event.sender === win.webContents) report.centers.push(color);
  });
  await win.loadFile(path.join(__dirname, 'shell.html'));
  win.showInactive();
  report.modernCss = await win.webContents.executeJavaScript(
    "getComputedStyle(document.querySelector('header')).backgroundColor === 'rgb(23, 111, 55)'",
  );
  if (!report.modernCss) throw new Error('modern CSS fixture failed');
  fs.writeFileSync(path.join(output, 'ready'), '1');
  const handle = await waitFor(() => open(4, 0, mappingName), { timeoutMs: 12_000, intervalMs: 10, label: 'Flash frame mapping' });
  const pointer = map(handle, 4, 0, 0, frameBytes + headerBytes);
  try {
    if (!pointer) throw new Error('MapViewOfFile failed');
    let last = 0;
    const deadline = Date.now() + 12_000;
    while (report.centers.length < 4 && Date.now() < deadline) {
      const generation = koffi.decode(pointer, 'uint32_t');
      if (generation !== last && !(generation & 1)) {
        const pixels = koffi.decode(pointer + BigInt(headerBytes), 'uint8_t', frameBytes);
        if (generation === koffi.decode(pointer, 'uint32_t')) {
          last = generation;
          win.webContents.send('cef-frame', pixels);
        }
      }
      await wait(5);
    }
    report.drawn = report.centers.length === 4;
  } finally {
    if (pointer) unmap(pointer);
    close(handle);
  }
}

main().catch((error) => { report.error = error.message; }).finally(() => {
  fs.writeFileSync(path.join(output, 'shell.json'), JSON.stringify(report, null, 2) + '\n');
  app.exit();
});
