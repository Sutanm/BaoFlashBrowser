/**
 * v19 - Flash 截图测试：验证最小化状态下的截图效果（修复后）
 *
 * 验证场景：
 *   T1: 原始窗口状态 + CSS修复
 *   T2: 最小化状态 + CSS修复
 *   T3: 恢复后截图
 *   T4: 最大化状态 + CSS修复
 *   T5: 最小化后截图（无CSS修复，对照）
 */
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

const FLASH_PLUGIN_PATH = path.join(__dirname, '..', '..', 'plugins', 'win64', 'pepflashplayer64.dll');
const FLASH_VERSION = '34.0.0.330';
app.commandLine.appendSwitch('ppapi-flash-path', FLASH_PLUGIN_PATH);
app.commandLine.appendSwitch('ppapi-flash-version', FLASH_VERSION);

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'release', 'screenshot-test');
const SWF_PATH = path.join(__dirname, '..', 'sample-swf-files-sample_1280x720.swf');
const timeout = setTimeout(() => { console.error('[v19] timed out (60s)'); app.exit(1); }, 60000);

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// 注入 CSS 修复函数
async function injectFlashCSS(view) {
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        var style = document.createElement('style');
        style.id = 'flash-fix-css';
        style.textContent = 'html { height: 100% !important; } body { height: 100% !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; }';
        if (document.head) document.head.appendChild(style);
        else document.documentElement.appendChild(style);
        return 'ok';
      })()
    `);
    return true;
  } catch (e) {
    console.error('  CSS injection failed:', e.message);
    return false;
  }
}

// 诊断页面高度
async function diagnose(view, label) {
  try {
    const diag = await view.webContents.executeJavaScript(`
      (function() {
        return {
          htmlH: document.documentElement.scrollHeight,
          bodyH: document.body.scrollHeight,
        };
      })()
    `);
    console.log(`  ${label}: html=${diag.htmlH}px, body=${diag.bodyH}px`);
    return diag;
  } catch (e) {
    console.error(`  ${label} diag error:`, e.message);
    return null;
  }
}

app.whenReady().then(async () => {
  ensureDir(OUTPUT_DIR);
  ipcMain.on('get-ruffle-mode', (e) => { e.returnValue = false; });

  if (!fs.existsSync(SWF_PATH)) {
    console.error(`[v19] SWF not found: ${SWF_PATH}`);
    app.exit(1);
  }

  const WIN_W = 1280, WIN_H = 720;

  const win = new BrowserWindow({
    show: true, width: WIN_W, height: WIN_H, x: 100, y: 100,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const view = new BrowserView({
    webPreferences: {
      plugins: true,
      contextIsolation: false,
      nodeIntegration: false,
      partition: 'persist:v19',
    },
  });

  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: WIN_W, height: WIN_H });

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  v19 Minimize Test — Flash screenshot after minimize');
  console.log('═══════════════════════════════════════════════════════');

  // ── 加载 SWF ──
  await new Promise((resolve) => {
    view.webContents.once('did-finish-load', () => { resolve(); });
    view.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error(`[v19] Load failed: ${code} ${desc}`);
      resolve();
    });
    view.webContents.loadURL(`file:///${SWF_PATH.replace(/\\/g, '/')}`);
  });

  await delay(3000);

  // ── T1: 原始窗口 + CSS 修复 ──
  console.log('\n── T1: Normal window + CSS fix ──');
  await injectFlashCSS(view);
  await delay(500);
  await diagnose(view, 'After fix');
  const img1 = await view.webContents.capturePage();
  if (!img1.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v19-T1-normal-fixed.png'), img1.toPNG());
    console.log('  Saved: v19-T1-normal-fixed.png');
  }

  // ── T2: 最小化 + CSS 修复 ──
  console.log('\n── T2: Minimized + CSS fix ──');
  win.minimize();
  await delay(1000);
  // 最小化后可能需要重新注入 CSS
  await injectFlashCSS(view);
  await delay(500);
  await diagnose(view, 'After minimize+fix');
  const img2 = await view.webContents.capturePage();
  if (!img2.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v19-T2-minimized-fixed.png'), img2.toPNG());
    console.log('  Saved: v19-T2-minimized-fixed.png');
  }

  // ── T3: 恢复后截图 ──
  console.log('\n── T3: Restored + screenshot ──');
  win.restore();
  await delay(500);
  const img3 = await view.webContents.capturePage();
  if (!img3.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v19-T3-restored.png'), img3.toPNG());
    console.log('  Saved: v19-T3-restored.png');
  }

  // ── T4: 最大化 + CSS 修复 ──
  console.log('\n── T4: Maximized + CSS fix ──');
  win.maximize();
  await delay(500);
  await injectFlashCSS(view);
  await delay(500);
  await diagnose(view, 'After maximize+fix');
  const img4 = await view.webContents.capturePage();
  if (!img4.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v19-T4-maximized-fixed.png'), img4.toPNG());
    console.log('  Saved: v19-T4-maximized-fixed.png');
  }
  win.restore();
  await delay(300);

  // ── T5: 最小化 + 无 CSS 修复（对照）──
  console.log('\n── T5: Minimized WITHOUT CSS fix (baseline) ──');
  // 重新加载 SWF 清除 CSS
  await view.webContents.loadURL(`file:///${SWF_PATH.replace(/\\/g, '/')}`);
  await delay(3000);
  await diagnose(view, 'Before minimize (no fix)');
  win.minimize();
  await delay(1000);
  const img5 = await view.webContents.capturePage();
  if (!img5.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v19-T5-minimized-no-fix.png'), img5.toPNG());
    console.log('  Saved: v19-T5-minimized-no-fix.png');
  }
  win.restore();

  console.log('\n\n' + '═'.repeat(72));
  console.log('                              总结');
  console.log('═'.repeat(72));
  console.log('T1: 正常窗口 + CSS修复（基准）');
  console.log('T2: 最小化 + CSS修复');
  console.log('T3: 恢复后截图');
  console.log('T4: 最大化 + CSS修复');
  console.log('T5: 最小化 + 无CSS修复（对照）');
  console.log('');
  console.log('对比 T2 和 T5 验证 CSS 修复对最小化截图的有效性。');

  clearTimeout(timeout);
  app.exit(0);
}).catch(e => { console.error('[v19] failed:', e); clearTimeout(timeout); app.exit(1); });
