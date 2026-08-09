/**
 * v20 - 验证门：capturer size/stayHidden 变体 + 最小化首帧等待
 * T1   visible + capturer（基准）
 * T2a  hidden 1x1 + capturer（无参）
 * T2b  hidden 1x1 + capturer({size:1280x720})
 * T2c  hidden 1x1 + capturer({size:1280x720, stayHidden:true}) + visibilityState 侧证
 * T3a  minimized + visible + capturer（立即 capture）
 * T3b  minimized + visible + capturer（延迟 100ms）
 * T4   minimized + hidden（对照）
 */
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

const FLASH_PLUGIN_PATH = path.join(__dirname, '..', '..', 'plugins', 'win64', 'pepflashplayer64.dll');
app.commandLine.appendSwitch('ppapi-flash-path', FLASH_PLUGIN_PATH);
app.commandLine.appendSwitch('ppapi-flash-version', '34.0.0.330');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'release', 'screenshot-test');
const RESULTS_FILE = path.join(OUTPUT_DIR, 'v20-results.md');
const SWF_PATH = path.join(__dirname, '..', 'sample-swf-files-sample_1280x720.swf');
const timeout = setTimeout(() => { console.error('[v20] timed out (120s)'); app.exit(1); }, 120000);

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function capture(view, opts = {}) {
  const { size, stayHidden, waitMs = 0 } = opts;
  const wc = view.webContents;
  wc.incrementCapturerCount(size, stayHidden);
  try {
    if (waitMs > 0) await delay(waitMs);
    const image = await wc.capturePage();
    return image;
  } finally {
    wc.decrementCapturerCount(stayHidden);
  }
}

async function visibilityState(view) {
  try {
    const state = await view.webContents.executeJavaScript('document.visibilityState');
    return String(state);
  } catch (e) {
    return 'QUERY_FAILED: ' + e.message;
  }
}

function record(results, label, image, extra) {
  const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();
  const row = { label, empty: image.isEmpty(), width: size.width, height: size.height, ...extra };
  results.push(row);
  console.log(`  ${label}: empty=${row.empty} size=${row.width}x${row.height}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  if (!image.isEmpty()) {
    const safe = label.replace(/[^A-Za-z0-9_-]/g, '-');
    fs.writeFileSync(path.join(OUTPUT_DIR, `v20-${safe}.png`), image.toPNG());
  }
  return row;
}

app.whenReady().then(async () => {
  ensureDir(OUTPUT_DIR);
  ipcMain.on('get-ruffle-mode', (e) => { e.returnValue = false; });
  if (!fs.existsSync(SWF_PATH)) { console.error('[v20] SWF not found:', SWF_PATH); app.exit(1); }

  const WIN_W = 1280, WIN_H = 720;
  const win = new BrowserWindow({ show: true, width: WIN_W, height: WIN_H, x: 100, y: 100, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const view = new BrowserView({ webPreferences: { plugins: true, contextIsolation: false, nodeIntegration: false, partition: 'persist:v20' } });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: WIN_W, height: WIN_H });

  await new Promise((resolve) => {
    view.webContents.once('did-finish-load', resolve);
    view.webContents.once('did-fail-load', (_e, code, desc) => { console.error('[v20] load failed:', code, desc); resolve(); });
    view.webContents.loadURL('file:///' + SWF_PATH.replace(/\\/g, '/'));
  });
  await delay(3000);

  const results = [];
  const HIDDEN = { x: -9999, y: -9999, width: 1, height: 1 };

  console.log('\n[V20] T1 visible + capturer (baseline)');
  record(results, 'T1-visible', await capture(view), { note: 'baseline' });

  console.log('\n[V20] T2a hidden + capturer (no args)');
  view.setBounds(HIDDEN); await delay(500);
  record(results, 'T2a-hidden-noarg', await capture(view), { note: 'expected <=2x2 or empty' });

  console.log('\n[V20] T2b hidden + capturer(size)');
  record(results, 'T2b-hidden-size', await capture(view, { size: { width: WIN_W, height: WIN_H } }), { note: 'pass if >=1279x719' });

  console.log('\n[V20] T2c hidden + capturer(size, stayHidden)');
  const imgT2c = await capture(view, { size: { width: WIN_W, height: WIN_H }, stayHidden: true });
  record(results, 'T2c-hidden-size-stay', imgT2c, { note: 'pass if >=1279x719', visibilityState: await visibilityState(view) });

  view.setBounds({ x: 0, y: 0, width: WIN_W, height: WIN_H }); await delay(500);

  console.log('\n[V20] T3a minimized + visible + capturer (immediate)');
  win.minimize(); await delay(800);
  record(results, 'T3a-minimized-immediate', await capture(view), { note: 'no wait' });

  console.log('\n[V20] T3b minimized + visible + capturer (100ms wait)');
  record(results, 'T3b-minimized-wait100', await capture(view, { waitMs: 100 }), { note: 'first-frame wait' });
  win.restore(); await delay(500);

  console.log('\n[V20] T4 minimized + hidden (control)');
  win.minimize(); await delay(800);
  view.setBounds(HIDDEN); await delay(300);
  record(results, 'T4-minimized-hidden', await capture(view), { note: 'control: expected empty' });
  win.restore();

  const md = [
    '# v20 Verification Gate Results',
    '',
    'Run at: ' + new Date().toISOString(),
    '',
    '| case | empty | width | height | extra |',
    '|------|-------|-------|--------|-------|',
    ...results.map((r) => `| ${r.label} | ${r.empty} | ${r.width} | ${r.height} | ${JSON.stringify(r.extra || {})} |`),
    '',
    '## Verdicts (Task 7 回填依据)',
    '',
    '- T2b or T2c width>=1279 && height>=719 → HIDDEN_CAPTURE_ENABLED = true（T2c 通过则 HIDDEN_CAPTURE_STAY_HIDDEN = true，仅 T2b 通过则 false）',
    '- T3b (empty=false, size 全尺寸) 且 T3a empty=true → FIRST_FRAME_DELAY_MS = 100',
    '- T3b 与 T3a 同为 full → FIRST_FRAME_DELAY_MS = 0',
    '- T4 empty=true → MINIMIZED_INACTIVE 策略合理；若 T4 非空则需重新评估该策略',
    '',
  ];
  fs.writeFileSync(RESULTS_FILE, md.join('\n'));
  console.log('\n[V20] results written to:', RESULTS_FILE);
  console.log('\n[V20] FINAL VERDICT LINE (copy to Task 7):');
  const verdict = results.find((r) => r.label === 'T2b-hidden-size') || results[0];
  console.log('T2b full-size:', verdict.width >= 1279 && verdict.height >= 719, `(${verdict.width}x${verdict.height})`);

  clearTimeout(timeout);
  app.exit(0);
}).catch((e) => { console.error('[v20] failed:', e); clearTimeout(timeout); app.exit(1); });
