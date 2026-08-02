const { app, BrowserView, BrowserWindow, protocol, session } = require('electron');
const fs = require('fs');
const path = require('path');

protocol.registerSchemesAsPrivileged([{
  scheme: 'ruffle-resource',
  privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const resourceDir = path.join(__dirname, '..', '..', 'dist', 'lib', 'ruffle');
const served = new Set();

function fail(message) {
  console.error('[ruffle-smoke] ' + message);
  app.exit(1);
}

function registerFor(targetSession) {
  return new Promise((resolve, reject) => {
    targetSession.protocol.registerBufferProtocol('ruffle-resource', (request, callback) => {
      const url = new URL(request.url);
      const fileName = decodeURIComponent(url.hostname || url.pathname.replace(/^\/+/, ''));
      if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) return callback({ error: -10 });
      fs.readFile(path.join(resourceDir, fileName), (error, data) => {
        if (error) return callback({ error: -6 });
        served.add(fileName);
        callback({
          mimeType: fileName.endsWith('.wasm') ? 'application/wasm'
            : fileName.endsWith('.js') ? 'application/javascript' : 'application/octet-stream',
          data,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      });
    }, (error) => error ? reject(error) : resolve());
  });
}

app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const persistentSession = session.fromPartition('persist:');
  await registerFor(persistentSession);

  const host = new BrowserWindow({ show: false });
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      plugins: false,
      partition: 'persist:',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 640, height: 480 });

  const errors = [];
  view.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await view.webContents.loadURL('data:text/html,<html><body></body></html>');

  const ruffleJs = fs.readFileSync(path.join(resourceDir, 'ruffle.js'), 'utf8');
  const result = await view.webContents.executeJavaScript(`(async () => {
    const failures = [];
    window.addEventListener('error', (event) => failures.push(String(event.error || event.message)));
    window.addEventListener('unhandledrejection', (event) => failures.push(String(event.reason)));
    window.RufflePlayer = { config: { publicPath: 'ruffle-resource://', autoplay: 'on' } };
    eval(${JSON.stringify(ruffleJs)});
    const source = window.RufflePlayer && window.RufflePlayer.newest && window.RufflePlayer.newest();
    if (!source) return { ok: false, stage: 'source', failures };
    const player = source.createPlayer();
    document.body.appendChild(player);
    const swf = new Uint8Array([70,87,83,9,16,0,0,0,8,0,0,0,1,0,0,0]);
    try { await player.load({ data: swf, autoplay: 'on' }); }
    catch (error) { failures.push(String(error)); }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { ok: player.readyState >= 1, version: source.version, failures };
  })()`, true);

  const files = [...served];
  const hasCore = files.some((name) => /^core\.ruffle\..+\.js$/.test(name));
  const hasWasm = files.some((name) => name.endsWith('.wasm'));
  if (!result.ok || !hasCore || !hasWasm) {
    fail(`Ruffle did not initialize in persist: BrowserView: ${JSON.stringify({ result, files, errors })}`);
    return;
  }
  console.log('[ruffle-smoke] PASS ' + JSON.stringify({ version: result.version, files }));
  app.exit(0);
}).catch((error) => fail(error && error.stack ? error.stack : String(error)));

setTimeout(() => fail('timed out'), 30000);
