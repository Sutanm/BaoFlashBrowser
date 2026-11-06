/**
 * 回归验证：拦截器只挂在默认 session（外壳）时，标签页（persist:）里的
 * 本地 html / .swf 是否完全不受影响。
 *
 * 布局：
 *   <T>/app/        ← 白名单（模拟 dist）
 *   <T>/pages/      ← 用户本地页面（模拟"我自己的测试 html"）
 *       page.html  game.js  data.txt
 *   <T>/outside-tab.txt   ← 页面目录外（验证"目录外读取"这一既有行为不变）
 */
const { app, BrowserWindow, BrowserView, protocol } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const T = path.join(os.tmpdir(), 'bfb-tabtest');
try { fs.rmdirSync(T, { recursive: true }); } catch { /* 不存在 */ }
const APP_DIR = path.join(T, 'app');
const PAGE_DIR = path.join(T, 'pages');
fs.mkdirSync(APP_DIR, { recursive: true });
fs.mkdirSync(PAGE_DIR, { recursive: true });
app.setPath('userData', path.join(T, 'ud'));
app.commandLine.appendSwitch('remote-debugging-port', '0');

fs.writeFileSync(path.join(APP_DIR, 'preload.cjs'), [
  "const { contextBridge } = require('electron');",
  "contextBridge.exposeInMainWorld('electronAPI', { marker: 'SHELL-PRIVILEGE' });",
].join('\n'));
fs.writeFileSync(path.join(APP_DIR, 'probe.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>probe</body></html>');
fs.writeFileSync(path.join(APP_DIR, 'shell.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>SHELL</title></head>
<body><iframe id="f" src="./probe.html" width="200" height="80"></iframe></body></html>`);

// 用户自己的本地页面
fs.writeFileSync(path.join(PAGE_DIR, 'game.js'), 'window.__gameJs = "GAME-JS-OK";');
fs.writeFileSync(path.join(PAGE_DIR, 'data.txt'), 'PAGE-DATA');
fs.writeFileSync(path.join(T, 'outside-tab.txt'), 'TAB-OUTSIDE-SECRET');
fs.writeFileSync(path.join(PAGE_DIR, 'page.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>用户本地页</title>
<script src="./game.js"></script></head>
<body>local page</body></html>`);

const SWF = path.resolve(__dirname, '..', '..', '.packaging-worktrees', 'win32', 'tests',
  'sample-swf-files-sample_1280x720.swf');

function toLocal(u) {
  try { return path.normalize(decodeURIComponent(fileURLToPath(u))).toLowerCase(); } catch { return ''; }
}

app.whenReady().then(() => {
  // 白名单 = 应用目录 + 「用户当前打开文档所在目录」（模拟主进程在标签导航到
  // file:// 时动态登记该目录）。这样本地页面/游戏素材照常，磁盘其他位置仍封死。
  const allowRoots = [APP_DIR.toLowerCase(), PAGE_DIR.toLowerCase()];
  const hit = [];
  protocol.interceptFileProtocol('file', (request, callback) => {
    const local = toLocal(request.url);
    const ok = allowRoots.some((r) => local === r || local.startsWith(r + path.sep));
    hit.push((ok ? 'ALLOW ' : 'DENY  ') + local);
    if (ok) callback({ path: fileURLToPath(request.url) });
    else callback({ error: -10 });
  });

  const win = new BrowserWindow({
    width: 1000, height: 760, show: false,
    webPreferences: { preload: path.join(APP_DIR, 'preload.cjs'), contextIsolation: true },
  });
  win.loadFile(path.join(APP_DIR, 'shell.html'));

  // 标签：persist: 分区（和应用真实配置一致）
  const tab = new BrowserView({ webPreferences: { partition: 'persist:', contextIsolation: true, plugins: true } });
  win.addBrowserView(tab);
  tab.setBounds({ x: 0, y: 0, width: 1000, height: 360 });
  tab.webContents.loadFile(path.join(PAGE_DIR, 'page.html'));

  // 另一个标签：真实 .swf（PPAPI 插件 + file://）
  const swfView = new BrowserView({ webPreferences: { partition: 'persist:', plugin: true, plugins: true } });
  win.addBrowserView(swfView);
  swfView.setBounds({ x: 500, y: 360, width: 500, height: 380 });
  const swfState = { loaded: false, failed: null, url: '' };
  swfView.webContents.on('did-finish-load', () => { swfState.loaded = true; swfState.url = swfView.webContents.getURL().slice(0, 80); });
  swfView.webContents.on('did-fail-load', (_e, code, desc) => { swfState.failed = code + ' ' + desc; });
  if (fs.existsSync(SWF)) swfView.webContents.loadURL('file:///' + SWF.replace(/\\/g, '/'));

  win.webContents.on('did-finish-load', () => setTimeout(() => {
    console.log('[tab] --- 拦截器命中记录 ---');
    hit.forEach((h) => console.log('   ' + h));
    console.log('[tab] 命中总数=' + hit.length + ' | 含 pages 目录的=' + hit.filter((h) => h.includes('pages')).length);
    console.log('[tab] swf exists=' + fs.existsSync(SWF) + ' loaded=' + swfState.loaded + ' failed=' + swfState.failed + ' url=' + swfState.url);
  }, 5000));
});
