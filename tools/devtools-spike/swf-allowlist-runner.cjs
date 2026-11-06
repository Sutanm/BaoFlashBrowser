/**
 * 单点验证：白名单**不含** .swf 所在目录时，本地 .swf 到底还能不能加载？
 * （Flash 是 PPAPI 插件，插件进程的文件请求可能不走 renderer 的 URL loader，
 *   需要实测确认拦截器对 .swf 是否有效。）
 */
const { app, BrowserWindow, BrowserView, protocol } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const T = path.join(os.tmpdir(), 'bfb-swf');
try { fs.rmdirSync(T, { recursive: true }); } catch { /* 不存在 */ }
const ALLOW = path.join(T, 'allow');
fs.mkdirSync(ALLOW, { recursive: true });
app.setPath('userData', path.join(T, 'ud'));
app.commandLine.appendSwitch('remote-debugging-port', '0');

const SWF = path.resolve(__dirname, '..', '..', '.packaging-worktrees', 'win32', 'tests',
  'sample-swf-files-sample_1280x720.swf');
const toLocal = (u) => { try { return path.normalize(decodeURIComponent(fileURLToPath(u))).toLowerCase(); } catch { return ''; } };

app.whenReady().then(() => {
  const allowRoot = ALLOW.toLowerCase();
  const hits = [];
  protocol.interceptFileProtocol('file', (request, callback) => {
    const local = toLocal(request.url);
    const ok = local === allowRoot || local.startsWith(allowRoot + path.sep);
    hits.push((ok ? 'ALLOW ' : 'DENY  ') + local);
    if (ok) callback({ path: fileURLToPath(request.url) });
    else callback({ error: -10 });
  });

  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  const view = new BrowserView({ webPreferences: { partition: 'persist:', plugins: true } });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });

  const state = { finish: false, fail: null, loaded: null };
  view.webContents.on('did-finish-load', () => {
    state.finish = true;
    state.loaded = view.webContents.getURL();
  });
  view.webContents.on('did-fail-load', (_e, code, desc, url) => {
    state.fail = code + ' ' + desc + ' | ' + String(url).slice(-40);
  });

  console.log('[swf] exists=' + fs.existsSync(SWF));
  console.log('[swf] 白名单=' + allowRoot + ' （不含 swf 目录，故意制造 DENY）');
  view.webContents.loadURL('file:///' + SWF.replace(/\\/g, '/'));

  setTimeout(() => {
    console.log('[swf] finish=' + state.finish + ' fail=' + state.fail);
    console.log('[swf] url=' + String(state.loaded || '').slice(0, 70));
    console.log('[swf] --- 拦截命中 ---');
    hits.forEach((h) => console.log('   ' + h));
    const swfHit = hits.filter((h) => h.includes('swf'));
    console.log('[swf] 命中 swf 的次数=' + swfHit.length);
  }, 6000);
});
