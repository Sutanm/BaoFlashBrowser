/**
 * v17 - Flash 截图根因诊断：验证 HTML 高度塌缩问题
 *
 * 问题：Chromium 87 加载 .swf 时生成的内部 HTML 有 body{height:100%}
 *       但缺少 html{height:100%}，导致 body 高度塌缩到 SWF stage 尺寸
 *       （如 150px），而不是 BrowserView 高度（720px）。
 *
 * 测试：
 *   T1: 诊断模式 - 检查 document.body.scrollHeight 等指标
 *   T2: 修复模式 - 通过 webFrame.executeJavaScript 注入 css 修复
 *   T3: 修复后截图验证
 */
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
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
const timeout = setTimeout(() => { console.error('[v17] timed out (60s)'); app.exit(1); }, 60000);

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

app.whenReady().then(async () => {
  ensureDir(OUTPUT_DIR);

  ipcMain.on('get-ruffle-mode', (e) => { e.returnValue = false; });

  if (!fs.existsSync(SWF_PATH)) {
    console.error(`[v17] SWF not found: ${SWF_PATH}`);
    app.exit(1);
  }

  const WIN_W = 1280, WIN_H = 720;

  const win = new BrowserWindow({
    show: true, width: WIN_W, height: WIN_H, x: 100, y: 100,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  // 关键：contextIsolation: false，这样才能通过 webFrame 注入 CSS
  const view = new BrowserView({
    webPreferences: {
      plugins: true,
      contextIsolation: false,  // 必须 false 才能用 webFrame
      nodeIntegration: false,
      partition: 'persist:v17',
    },
  });

  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: WIN_W, height: WIN_H });

  // ── T1: 诊断模式 ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  v17 Diagnostic — Flash HTML height collapse');
  console.log('═══════════════════════════════════════════════════════');

  await new Promise((resolve) => {
    view.webContents.once('did-finish-load', () => { resolve(); });
    view.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error(`[v17] Load failed: ${code} ${desc}`);
      resolve();
    });
    view.webContents.loadURL(`file:///${SWF_PATH.replace(/\\/g, '/')}`);
  });

  await delay(3000); // 等待 Flash 完全渲染

  // 诊断：读取页面 DOM 信息
  console.log('\n── T1: Diagnostic — inspect page DOM ──');
  try {
    const diag = await view.webContents.executeJavaScript(`
      (function() {
        return {
          htmlHeight: document.documentElement.scrollHeight,
          htmlClientHeight: document.documentElement.clientHeight,
          bodyHeight: document.body.scrollHeight,
          bodyClientHeight: document.body.clientHeight,
          bodyStyle: document.body.style.cssText,
          htmlStyle: document.documentElement.style.cssText,
          flashEmbedHeight: document.querySelectorAll('embed, object').length,
          bodyChildren: document.body.children.length,
          pageTitle: document.title,
          bodyBgColor: getComputedStyle(document.body).backgroundColor,
          bodyHeightComputed: getComputedStyle(document.body).height,
          htmlHeightComputed: getComputedStyle(document.documentElement).height,
        };
      })()
    `);
    console.log('  html.scrollHeight:', diag.htmlHeight);
    console.log('  html.clientHeight:', diag.htmlClientHeight);
    console.log('  body.scrollHeight:', diag.bodyHeight);
    console.log('  body.clientHeight:', diag.bodyClientHeight);
    console.log('  body.style.cssText:', diag.bodyStyle);
    console.log('  html.style.cssText:', diag.htmlStyle);
    console.log('  bodyChildren:', diag.bodyChildren);
    console.log('  pageTitle:', diag.pageTitle);
    console.log('  body bgColor:', diag.bodyBgColor);
    console.log('  body height computed:', diag.bodyHeightComputed);
    console.log('  html height computed:', diag.htmlHeightComputed);
    console.log('  flash embeds:', diag.flashEmbedHeight);
  } catch (e) {
    console.error('  diag error:', e.message);
  }

  // T1 截图
  const img1 = await view.webContents.capturePage();
  if (!img1.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v17-T1-diagnostic.png'), img1.toPNG());
    console.log('\n  T1 screenshot saved: v17-T1-diagnostic.png');
  }

  // ── T2: 修复模式 — 注入 CSS 强制 html{height:100%} ──
  console.log('\n── T2: Fix — inject CSS to force html{height:100%} ──');
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        var style = document.createElement('style');
        style.id = 'flash-fix-css';
        style.textContent = 'html { height: 100% !important; } body { height: 100% !important; margin: 0 !important; padding: 0 !important; }';
        document.head.appendChild(style);
        return 'CSS injected';
      })()
    `);
    console.log('  CSS injected successfully');
  } catch (e) {
    console.error('  CSS injection failed:', e.message);
  }

  await delay(1000);

  // T2 截图（修复后）
  const img2 = await view.webContents.capturePage();
  if (!img2.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v17-T2-fixed.png'), img2.toPNG());
    console.log('  T2 screenshot saved: v17-T2-fixed.png');
  }

  // T2 诊断（修复后 DOM）
  console.log('\n── T2: Diagnostic after CSS fix ──');
  try {
    const diag2 = await view.webContents.executeJavaScript(`
      (function() {
        return {
          bodyHeightComputed: getComputedStyle(document.body).height,
          htmlHeightComputed: getComputedStyle(document.documentElement).height,
          bodyBgColor: getComputedStyle(document.body).backgroundColor,
        };
      })()
    `);
    console.log('  body height computed:', diag2.bodyHeightComputed);
    console.log('  html height computed:', diag2.htmlHeightComputed);
    console.log('  body bgColor:', diag2.bodyBgColor);
  } catch (e) {
    console.error('  diag2 error:', e.message);
  }

  // ── T3: 最大化窗口 + 修复后截图 ──
  console.log('\n── T3: Maximized window + CSS fix ──');
  win.maximize();
  await delay(500);
  const img3 = await view.webContents.capturePage();
  if (!img3.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v17-T3-maximized-fixed.png'), img3.toPNG());
    console.log('  T3 screenshot saved: v17-T3-maximized-fixed.png');
  }

  // ── T4: 最小化 + 修复后截图 ──
  console.log('\n── T4: Minimized + CSS fix ──');
  win.minimize();
  await delay(500);
  const img4 = await view.webContents.capturePage();
  if (!img4.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v17-T4-minimized-fixed.png'), img4.toPNG());
    console.log('  T4 screenshot saved: v17-T4-minimized-fixed.png');
  }
  win.restore();

  // ── T5: 对比：无 CSS 修复，仅窗口最小化 ──
  console.log('\n── T5: Minimized without CSS fix (baseline comparison) ──');
  // 重新加载原始页面（清除 CSS 注入）
  await view.webContents.loadURL(`file:///${SWF_PATH.replace(/\\/g, '/')}`);
  await delay(3000);
  win.minimize();
  await delay(500);
  const img5 = await view.webContents.capturePage();
  if (!img5.isEmpty()) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'v17-T5-minimized-no-fix.png'), img5.toPNG());
    console.log('  T5 screenshot saved: v17-T5-minimized-no-fix.png');
  }
  win.restore();

  console.log('\n\n' + '═'.repeat(72));
  console.log('                              总结');
  console.log('═'.repeat(72));
  console.log('T1: 原始截图（应显示顶部一小条有内容）');
  console.log('T2: CSS 修复后截图（应显示完整 1280x720 内容）');
  console.log('T3: 最大化 + CSS 修复');
  console.log('T4: 最小化 + CSS 修复');
  console.log('T5: 最小化无 CSS 修复（对照）');
  console.log('');
  console.log('如果 T2 截图完整显示海浪，则确认根因为 HTML 高度塌缩。');

  clearTimeout(timeout);
  app.exit(0);
}).catch(e => { console.error('[v17] failed:', e); clearTimeout(timeout); app.exit(1); });
