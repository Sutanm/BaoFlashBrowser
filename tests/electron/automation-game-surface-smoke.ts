import { app, BrowserView, BrowserWindow } from 'electron';
import http from 'http';
import { detectGameSurfaces } from '../../src/main/modules/automation/game-surface-detector';

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const childServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/xhtml+xml; charset=utf-8' });
    response.end('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><style>html,body{margin:0}</style></head><body><object id="picaTown" name="picaTown" data="Swfloader.swf?v=20211223" type="application/x-shockwave-flash" width="950" height="562"></object></body></html>');
  });
  await new Promise<void>((resolve) => childServer.listen(0, '127.0.0.1', resolve));
  const childAddress = childServer.address();
  if (!childAddress || typeof childAddress === 'string') throw new Error('child fixture server did not start');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (request.url === '/outer') {
      response.end(`<style>html,body{margin:0}iframe{position:absolute;left:50px;top:60px;width:950px;height:562px;border:0}</style><iframe src="http://127.0.0.1:${childAddress.port}/inner"></iframe>`);
      return;
    }
    response.end('<style>html,body{margin:0}iframe{position:absolute;left:40px;top:30px;width:1140px;height:650px;border:0}</style><iframe src="/outer"></iframe>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not start');

  const window = new BrowserWindow({ show: false, width: 1300, height: 800 });
  const view = new BrowserView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 1300, height: 800 });
  await view.webContents.loadURL(`http://127.0.0.1:${address.port}/`);
  const candidates = await detectGameSurfaces(view.webContents);
  const surface = candidates.find((candidate) => candidate.label === 'picaTown');
  if (!surface || surface.kind !== 'flash') throw new Error(`nested Flash object was not detected: ${JSON.stringify(candidates)}`);
  if (surface.frameDepth !== 0) throw new Error(`global DevTools DOM search did not win the nested Flash fallback: ${JSON.stringify(surface)}`);
  const expected = { x: 90, y: 90, width: 950, height: 562 };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (Math.abs(surface.rect[key] - expected[key]) > 1) throw new Error(`nested surface ${key} was ${surface.rect[key]}, expected ${expected[key]}`);
  }
  console.log(`[automation-game-surface-smoke] PASS ${JSON.stringify(surface)}`);
  window.destroy(); server.close(); childServer.close(); app.exit(0);
}).catch((error) => {
  console.error(`[automation-game-surface-smoke] FAIL ${error?.stack || error}`);
  app.exit(1);
});
