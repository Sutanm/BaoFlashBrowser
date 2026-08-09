/**
 * v21 - 生产路径冒烟：复刻 captureTab 全链路，验证最小化窗口落盘
 * 链路：incrementCapturerCount → capturePage → isEmpty 检查 → sanitize 文件名 → 落盘
 * 场景：窗口最小化 + SWF（带 tabs.ts 同款 CSS 修复）+ 输出到真实默认目录
 */
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

const FLASH_PLUGIN_PATH = path.join(__dirname, '..', '..', 'plugins', 'win64', 'pepflashplayer64.dll');
app.commandLine.appendSwitch('ppapi-flash-path', FLASH_PLUGIN_PATH);
app.commandLine.appendSwitch('ppapi-flash-version', '34.0.0.330');

const SWF_PATH = path.join(__dirname, '..', 'sample-swf-files-sample_1280x720.swf');
const OUT_DIR = path.join(app.getPath('pictures'), 'BaoFlashBrowser');   // 与生产 getScreenshotDir 默认一致
const timeout = setTimeout(() => { console.error('[v21] timed out (60s)'); app.exit(1); }, 60000);

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 生产截图模块同款 sanitize（download-path.ts 逻辑内联）
function sanitize(name) {
  let safe = Array.from(name.replace(/\\/g, '/').split('/').pop(), (c) => c.charCodeAt(0) < 32 ? '_' : c)
    .join('').replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!safe) safe = 'download';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe)) safe = '_' + safe;
  return safe;
}

app.whenReady().then(async () => {
  ipcMain.on('get-ruffle-mode', (e) => { e.returnValue = false; });
  if (!fs.existsSync(SWF_PATH)) { console.error('[v21] SWF not found'); app.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({ show: true, width: 1280, height: 720, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const view = new BrowserView({ webPreferences: { plugins: true, contextIsolation: false, nodeIntegration: false, partition: 'persist:v21' } });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 720 });

  await new Promise((resolve) => {
    view.webContents.once('did-finish-load', resolve);
    view.webContents.once('did-fail-load', () => resolve());
    view.webContents.loadURL('file:///' + SWF_PATH.replace(/\\/g, '/'));
  });
  await delay(3000);

  // tabs.ts 同款 SWF CSS 修复（dom-ready insertCSS）
  try {
    await view.webContents.insertCSS(
      'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}' +
      'embed,object{width:100%!important;height:100%!important}');
  } catch (e) { console.error('css fix failed:', e.message); }
  await delay(800);

  console.log('\n[v21] minimizing window...');
  win.minimize();
  await delay(800);
  console.log('  isMinimized =', win.isMinimized());

  // ── captureTab 核心链路 ──
  const wc = view.webContents;
  wc.incrementCapturerCount();   // 生产：HIDDEN_CAPTURE_STAY_HIDDEN 变体；最小化 active 页为无参
  let image;
  try {
    image = await wc.capturePage();
  } finally {
    wc.decrementCapturerCount();
  }
  console.log('  captured empty =', image.isEmpty());

  if (image.isEmpty()) { console.error('[v21] FAIL: empty capture while minimized'); app.exit(1); }

  const size = image.getSize();
  console.log('  size =', size.width, 'x', size.height);

  // 生产同款默认文件名
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = sanitize(`screenshot-tab-demo-${ts}.png`);
  const filePath = path.join(OUT_DIR, fileName);
  await fs.promises.writeFile(filePath, image.toPNG());

  const stat = fs.statSync(filePath);
  console.log('  saved:', filePath);
  console.log('  file bytes =', stat.size);
  console.log('\n[v21] PASS: minimized capture + save to default dir (' + (stat.size > 50000 ? 'content present' : 'WARNING: tiny file') + ')');

  clearTimeout(timeout);
  app.exit(0);
}).catch((e) => { console.error('[v21] failed:', e); clearTimeout(timeout); app.exit(1); });
