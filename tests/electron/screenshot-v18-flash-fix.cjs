/**
 * v18 - Flash 截图修复：验证 html height:100% 修复方案
 *
 * 根因确认：
 *   Chromium 87 加载 .swf 时生成的内部 HTML 有 body{height:100%}
 *   但缺少 html{height:100%}，导致 body 高度塌缩到 SWF stage 尺寸（154px）
 *   而不是 BrowserView 高度（720px）。
 *
 * 修复方案：通过 webFrame.executeJavaScript 在主世界注入 CSS
 *   或者在 did-finish-load 后通过 CDP 注入样式
 *
 * 测试场景：
 *   T1: 原始截图（基准）
 *   T2: contextIsolation:false + webFrame.executeJavaScript 注入 CSS
 *   T3: contextIsolation:false + webFrame 注入后截图
 *   T4: contextIsolation:false + 最小化 + 截图
 *   T5: contextIsolation:true + 无法注入（对照）
 */
const { app, BrowserView, BrowserWindow, ipcMain, webFrame } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

// ── Flash 插件配置 ──
const FLASH_PLUGIN_PATH = path.join(__dirname, '..', '..', 'plugins', 'win64', 'pepflashplayer64.dll');
const FLASH_VERSION = '34.0.0.330';
app.commandLine.appendSwitch('ppapi-flash-path', FLASH_PLUGIN_PATH);
app.commandLine.appendSwitch('ppapi-flash-version', FLASH_VERSION);

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'release', 'screenshot-test');
const SWF_PATH = path.join(__dirname, '..', 'sample-swf-files-sample_1280x720.swf');
const timeout = setTimeout(() => { console.error('[v18] timed out (60s)'); app.exit(1); }, 60000);

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

app.whenReady().then(async () => {
  ensureDir(OUTPUT_DIR);

  ipcMain.on('get-ruffle-mode', (e) => { e.returnValue = false; });

  if (!fs.existsSync(SWF_PATH)) {
    console.error(`[v18] SWF not found: ${SWF_PATH}`);
    app.exit(1);
  }

  const WIN_W = 1280, WIN_H = 720;

  const win = new BrowserWindow({
    show: true, width: WIN_W, height: WIN_H, x: 100, y: 100,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  // contextIsolation: false 才能通过 webFrame 在主世界注入 JS
  const view = new BrowserView({
    webPreferences: {
      plugins: true,
      contextIsolation: false,
      nodeIntegration: false,
      partition: 'persist:v18',
    },
  });

  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: WIN_W, height: WIN_H });

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  v18 Fix Test — Flash HTML height collapse fix');
  console.log('═══════════════════════════════════════════════════════');

  // ── 加载 SWF ──
  await new Promise((resolve) => {
    view.webContents.once('did-finish-load', () => { resolve(); });
    view.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error(`[v18] Load failed: ${code} ${desc}`);
      resolve();
    });
    view.webContents.loadURL(`file:///${SWF_PATH.replace(/\\/g, '/')}`);
  });

  await delay(3000);

  // ── T1: 原始截图（基准）──
  console.log('\n── T1: Original (baseline) ──');
  // 先诊断
  try {
    const diag = await view.webContents.executeJavaScript(`
      (function() {
        return {
          htmlH: document.documentElement.scrollHeight,
          bodyH: document.body.scrollHeight,
          bodyCH: document.body.clientHeight,
          bodyStyle: document.body.style.cssText,
          htmlStyle: document.documentElement.style.cssText,
        };
      })()
    `);
    console.log(`  html.scrollHeight: ${diag.htmlH}`);
    console.log(`  body.scrollHeight: ${diag.bodyH}`);
    console.log(`  body computed height: ${getComputedStyle(document.body).height}`);
    console.log(`  html computed height: ${getComputedStyle(document.documentElement).height}`);
  } catch (e) {
    console.error('  diag error:', e.message);
  }
  const img1 = await view.webContents.capturePage();
  if (!img1.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v18-T1-original.png'), img1.toPNG());
    console.log('  Saved: v18-T1-original.png');
  }

  // ── T2: 通过 webFrame 在主世界注入 CSS ──
  console.log('\n── T2: Inject CSS via webFrame (main world) ──');
  try {
    // webFrame 在主世界执行，可以直接修改 DOM
    await view.webContents.executeJavaScript(`
      (function() {
        var style = document.createElement('style');
        style.id = 'flash-fix-css';
        style.textContent = 'html { height: 100% !important; } body { height: 100% !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; }';
        if (document.head) document.head.appendChild(style);
        else document.documentElement.appendChild(style);
        return 'CSS injected: html height=' + document.documentElement.style.height
          + ' body height=' + document.body.style.height;
      })()
    `);
    await delay(500);
    // 验证注入
    try {
      const check = await view.webContents.executeJavaScript(`
        (function() {
          var s = document.getElementById('flash-fix-css');
          return {
            styleExists: !!s,
            styleText: s ? s.textContent.substring(0, 80) : 'none',
            htmlH: document.documentElement.scrollHeight,
            bodyH: document.body.scrollHeight,
          };
        })()
      `);
      console.log(`  styleExists: ${check.styleExists}`);
      console.log(`  styleText: ${check.styleText}`);
      console.log(`  html.scrollHeight after fix: ${check.htmlH}`);
      console.log(`  body.scrollHeight after fix: ${check.bodyH}`);
    } catch (e2) {
      console.error('  post-inject check error:', e2.message);
    }
  } catch (e) {
    console.error('  CSS injection failed:', e.message);
  }

  const img2 = await view.webContents.capturePage();
  if (!img2.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v18-T2-fixed.png'), img2.toPNG());
    console.log('  Saved: v18-T2-fixed.png');
  }

  // ── T3: 最大化窗口 + 修复截图 ──
  console.log('\n── T3: Maximized + fixed ──');
  win.maximize();
  await delay(500);
  const img3 = await view.webContents.capturePage();
  if (!img3.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v18-T3-maximized-fixed.png'), img3.toPNG());
    console.log('  Saved: v18-T3-maximized-fixed.png');
  }
  win.restore();
  await delay(300);

  // ── T4: 最小化 + 修复截图 ──
  console.log('\n── T4: Minimized + fixed ──');
  win.minimize();
  await delay(500);
  const img4 = await view.webContents.capturePage();
  if (!img4.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v18-T4-minimized-fixed.png'), img4.toPNG());
    console.log('  Saved: v18-T4-minimized-fixed.png');
  }
  win.restore();

  // ── T5: 导航到新页面后验证 CSS 是否保留 ──
  console.log('\n── T5: Navigate to new page, verify CSS persists ──');
  await view.webContents.loadURL('data:text/html,<h1>Test</h1>');
  await delay(1000);
  // 重新注入 CSS
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        var style = document.createElement('style');
        style.id = 'flash-fix-css';
        style.textContent = 'html { height: 100% !important; } body { height: 100% !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; }';
        if (document.head) document.head.appendChild(style);
        return 're-injected';
      })()
    `);
  } catch (e) {
    console.error('  re-inject failed:', e.message);
  }
  const img5 = await view.webContents.capturePage();
  if (!img5.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v18-T5-nav-test.png'), img5.toPNG());
    console.log('  Saved: v18-T5-nav-test.png');
  }

  // ── 返回 Flash 页面 ──
  console.log('\n── Returning to Flash page ──');
  await view.webContents.loadURL(`file:///${SWF_PATH.replace(/\\/g, '/')}`);
  await delay(3000);
  // 重新注入 CSS
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        var style = document.createElement('style');
        style.id = 'flash-fix-css';
        style.textContent = 'html { height: 100% !important; } body { height: 100% !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; }';
        if (document.head) document.head.appendChild(style);
        return 're-injected on flash page';
      })()
    `);
  } catch (e) {
    console.error('  re-inject on flash failed:', e.message);
  }
  await delay(1000);
  const img6 = await view.webContents.capturePage();
  if (!img6.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v18-T6-flash-after-nav.png'), img6.toPNG());
    console.log('  Saved: v18-T6-flash-after-nav.png');
  }

  console.log('\n\n' + '═'.repeat(72));
  console.log('                              总结');
  console.log('═'.repeat(72));
  console.log('T1: 原始截图（body 塌缩到 154px，顶部一小条有内容）');
  console.log('T2: CSS 修复后截图（应完整显示 1280x720）');
  console.log('T3: 最大化 + CSS 修复');
  console.log('T4: 最小化 + CSS 修复');
  console.log('T5: 导航到新页面后验证 CSS 保留');
  console.log('T6: 返回 Flash 页面后重新注入 CSS');
  console.log('');
  console.log('如果 T2 截图完整显示海浪，则确认根因为 HTML 高度塌缩，修复方案有效。');

  clearTimeout(timeout);
  app.exit(0);
}).catch(e => { console.error('[v18] failed:', e); clearTimeout(timeout); app.exit(1); });
