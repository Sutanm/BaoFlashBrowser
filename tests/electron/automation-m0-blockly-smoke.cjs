const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'tools', 'automation-probe', 'fixtures', 'blockly-target.html');
const OUTPUT_DIR = path.join(ROOT, 'release', 'automation-probe');
const timeout = setTimeout(() => { console.error('[automation-m0-blockly] FAIL: timed out'); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1000, height: 700,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await win.loadFile(FIXTURE);
  const result = await win.webContents.executeJavaScript('window.__blocklyProbe');
  if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Blockly probe did not initialize');
  if (result.blockType !== 'bao_wait_image') throw new Error(`unexpected restored block: ${result.blockType}`);
  if (result.asset !== 'login/button.png') throw new Error(`field did not survive JSON round trip: ${result.asset}`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUTPUT_DIR, 'blockly-workspace.png'), image.toPNG());
  fs.writeFileSync(path.join(OUTPUT_DIR, 'blockly-result.json'), JSON.stringify(result, null, 2));
  console.log('[automation-m0-blockly] PASS', JSON.stringify({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    blockly: result.blocklyVersion,
    blockType: result.blockType,
    jsonRoundTrip: true,
  }));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('[automation-m0-blockly] FAIL:', error && error.stack ? error.stack : error);
  app.exit(1);
});
