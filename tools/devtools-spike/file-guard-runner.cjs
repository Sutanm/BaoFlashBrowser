/**
 * 白名单拦截可行性验证。
 *
 * 假设：在默认 session 上 interceptFileProtocol('file')，按路径白名单放行，
 * 就能让 file:// 前端的越界读取全部失败，而它自己的资源照常加载。
 *
 * 目录布局：
 *   <DIR>/app/           ← 白名单（模拟 dist/devtools-frontend + dist/renderer）
 *     shell.html  probe.html  asset.js
 *   <DIR>/outside.txt    ← 白名单外（模拟用户数据）
 *   %APPDATA%/bao-flash-browser/password-store.json  ← 真实敏感文件
 */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const DIR = path.join(os.tmpdir(), 'bfb-guard');
try { fs.rmdirSync(DIR, { recursive: true }); } catch { /* 不存在 */ }
const APP_DIR = path.join(DIR, 'app');
fs.mkdirSync(APP_DIR, { recursive: true });
app.setPath('userData', path.join(DIR, 'ud'));
app.commandLine.appendSwitch('remote-debugging-port', '0');

fs.writeFileSync(path.join(APP_DIR, 'preload.cjs'), [
  "const { contextBridge, ipcRenderer } = require('electron');",
  "contextBridge.exposeInMainWorld('electronAPI', {",
  "  marker: 'SHELL-PRIVILEGE',",
  "  ping: () => ipcRenderer.invoke('probe:ping'),",
  "});",
  "ipcRenderer.send('probe:hello');",
].join('\n'));
fs.writeFileSync(path.join(APP_DIR, 'asset.js'), 'window.__assetLoaded = "ASSET-OK";');
fs.writeFileSync(path.join(DIR, 'outside.js'), 'window.__outsideLoaded = "OUTSIDE-JS-LEAKED";');
fs.writeFileSync(path.join(DIR, 'outside.txt'), 'OUTSIDE-SECRET');

fs.writeFileSync(path.join(APP_DIR, 'probe.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>probe</title></head>
<body><script src="./asset.js"></script>probe-frame</body></html>`);

fs.writeFileSync(path.join(APP_DIR, 'shell.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>SHELL-APP</title></head>
<body>
<script>localStorage.setItem('shell-token','SHELL-STORAGE-SECRET');</script>
<!-- 越界子资源：白名单应当拦住 -->
<script src="../outside.js"></script>
<iframe id="f" src="./probe.html" width="200" height="80"></iframe>
</body></html>`);

/** Windows 下 file URL → 本地路径，统一小写并归一化，便于前缀比较。 */
function toLocalPath(url) {
  try {
    const p = fileURLToPath(url);
    return path.normalize(decodeURIComponent(p)).toLowerCase();
  } catch {
    return '';
  }
}

app.whenReady().then(() => {
  // 第二层：把"谁在调用 IPC"记下来。preload 只在主帧跑，所以第一条 hello 的
  // frameId 就是主帧；之后任何来自其他 frameId 的调用都能被识别出来。
  const mainFrameId = { value: null };
  ipcMain.on('probe:hello', (event) => {
    if (mainFrameId.value === null) mainFrameId.value = event.frameId;
    console.log('[guard] hello frameId=' + event.frameId + ' (pinned main=' + mainFrameId.value + ')');
  });
  ipcMain.handle('probe:ping', (event) => {
    const allowed = mainFrameId.value !== null && event.frameId === mainFrameId.value;
    console.log('[guard] ping frameId=' + event.frameId + ' | pinned=' + mainFrameId.value + ' | allowed=' + allowed);
    return { frameId: event.frameId, pinned: mainFrameId.value, allowed };
  });

  const allowRoots = [APP_DIR.toLowerCase()];
  const log = [];

  const registered = protocol.interceptFileProtocol('file', (request, callback) => {
    const local = toLocalPath(request.url);
    const ok = allowRoots.some((root) => local === root || local.startsWith(root + path.sep));
    log.push((ok ? 'ALLOW ' : 'DENY  ') + local + (request.referrer ? '   ← ' + request.referrer.slice(0, 60) : ''));
    if (ok) callback({ path: fileURLToPath(request.url) });
    else callback({ error: -10 }); // net::ERR_ACCESS_DENIED
  });
  console.log('[guard] interceptFileProtocol registered:', registered);

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(APP_DIR, 'shell.html'));
  win.webContents.on('did-finish-load', () => {
    console.log('[guard] shell loaded');
    console.log('[guard] --- 拦截日志 ---');
    log.forEach((l) => console.log('   ' + l));
  });
});
