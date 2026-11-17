'use strict';

const { app, BrowserWindow, BrowserView } = require('electron');
const fs = require('fs');
const net = require('net');
const { once } = require('events');
const path = require('path');
const readline = require('readline');
const { pathToFileURL } = require('url');
const { waitFor } = require('../lib/timeout.cjs');

const [profile, output, pipe, mode] = process.argv.slice(2);
const root = path.resolve(__dirname, '..', '..', '..');
app.setPath('userData', profile);
app.commandLine.appendSwitch('ppapi-flash-path', path.join(root, 'plugins', 'win64', 'pepflashplayer64.dll'));
app.commandLine.appendSwitch('ppapi-flash-version', '34.0.0.330');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

async function main() {
  await app.whenReady();
  const offscreen = mode === 'offscreen';
  const webPreferences = { plugins: true, contextIsolation: true, backgroundThrottling: false, partition: 'persist:' };
  const win = new BrowserWindow({
    show: false, frame: false, width: 550, height: 420,
    webPreferences: offscreen ? { ...webPreferences, offscreen: true } : undefined,
  });
  let wc = win.webContents;
  if (!offscreen) {
    const view = new BrowserView({ webPreferences });
    win.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 550, height: 420 });
    view.setAutoResize({ width: true, height: true });
    wc = view.webContents;
  }
  let frames = 0;
  let latestFrame;
  if (offscreen) {
    wc.setFrameRate(60);
    wc.on('paint', (_event, _dirty, image) => { frames++; latestFrame = image; });
  }
  const swf = path.join(profile, 'button.swf');
  fs.writeFileSync(swf, Buffer.from(fs.readFileSync(path.join(
    root, 'tools', 'automation-probe', 'fixtures', 'ruffle-button1.swf.base64',
  ), 'utf8'), 'base64'));
  await wc.loadURL(pathToFileURL(swf).href);
  await wc.insertCSS('html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}' +
    'embed,object{width:100%!important;height:100%!important}');

  const socket = net.createConnection(pipe);
  await once(socket, 'connect');
  socket.on('error', () => app.exit(1));
  const input = readline.createInterface({ input: socket });
  const lifetime = setTimeout(() => app.exit(2), 45_000);
  input.on('close', () => {
    clearTimeout(lifetime);
    fs.appendFileSync(path.join(output, 'worker.log'), 'pipe closed\n');
    app.exit();
  });
  socket.write('BAO ' + JSON.stringify({
    id: 0, value: { hwnd: win.getNativeWindowHandle().readBigUInt64LE().toString(), versions: { electron: process.versions.electron, chrome: process.versions.chrome } },
  }) + '\n');
  for await (const line of input) {
    const { id, operation, name } = JSON.parse(line);
    try {
      let value;
      if (operation === 'show') {
        win.showInactive();
      } else if (operation === 'keyboard') {
        await wc.executeJavaScript(`(() => {
          const input = document.createElement('input');
          document.body.append(input);
          input.focus();
        })()`);
        for (const type of ['keyDown', 'char', 'keyUp']) {
          wc.sendInputEvent({ type, keyCode: 'A' });
        }
        value = await wc.executeJavaScript("document.querySelector('input').value");
      } else if (operation === 'state') {
        value = await wc.executeJavaScript(`({
          width: innerWidth, height: innerHeight, has: CSS.supports('selector(:has(*))'),
          flash: Array.from(navigator.plugins).some(p => p.name === 'Shockwave Flash')
        })`);
      } else if (operation === 'frameState') {
        value = { frames, focused: win.isFocused() };
      } else if (operation === 'input') {
        wc.sendInputEvent({ type: name, x: 250, y: 210, button: 'left', clickCount: 1 });
      } else if (operation === 'capture') {
        let image = latestFrame;
        if (!offscreen) {
          wc.incrementCapturerCount();
          try {
            await waitFor(async () => {
              image = await wc.capturePage();
              return !image.isEmpty();
            }, { timeoutMs: 2000, label: 'non-empty Flash capture' });
          } finally {
            wc.decrementCapturerCount();
          }
        }
        if (!image || image.isEmpty()) throw new Error('no offscreen frame');
        fs.writeFileSync(path.join(output, name + '.png'), image.toPNG());
      } else {
        throw new Error('unknown worker operation');
      }
      socket.write('BAO ' + JSON.stringify({ id, value }) + '\n');
    } catch (error) {
      socket.write('BAO ' + JSON.stringify({ id, error: error.message }) + '\n');
    }
  }
}

app.on('window-all-closed', () => {
  fs.appendFileSync(path.join(output, 'worker.log'), 'window closed\n');
  app.exit();
});
main().catch((error) => { console.error(error); app.exit(1); });
