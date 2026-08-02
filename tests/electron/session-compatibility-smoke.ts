import { app, BrowserView, BrowserWindow, session } from 'electron';
import http from 'http';
import { applyCompatibilitySessionConfig } from '../../src/main/modules/session-manager';

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

async function listen(server: http.Server, firstPort: number): Promise<number> {
  for (let port = firstPort; port < firstPort + 100; port++) {
    const listening = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (listening) return port;
  }
  throw new Error('fixture could not reserve a safe local port');
}

const timeout = setTimeout(() => {
  console.error('[compat-smoke] timed out');
  app.exit(1);
}, 30000);

app.whenReady().then(async () => {
  const swfServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-shockwave-flash' });
    response.end(Buffer.from([0x46, 0x57, 0x53, 0x09, 0x08, 0, 0, 0]));
  });
  const swfPort = await listen(swfServer, 18080);
  const pageServer = http.createServer((request, response) => {
    if (request.url === '/crossdomain.xml') {
      response.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      response.end('<?xml version="1.0"?><cross-domain-policy><site-control permitted-cross-domain-policies="master-only"/><native-policy-marker/></cross-domain-policy>');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>compat fixture</title><main>local fixture</main><img src="http://127.0.0.1:${swfPort}/fixture.swf">`);
  });
  const pagePort = await listen(pageServer, 18180);

  const fixtureSession = session.fromPartition('persist:compatibility-smoke');
  applyCompatibilitySessionConfig(fixtureSession);
  const swfHeaders = new Promise<Electron.OnCompletedListenerDetails['responseHeaders']>((resolve) => {
    fixtureSession.webRequest.onCompleted(
      { urls: [`http://127.0.0.1:${swfPort}/fixture.swf`] },
      (details) => resolve(details.responseHeaders),
    );
  });
  const host = new BrowserWindow({ show: false });
  const view = new BrowserView({ webPreferences: { partition: 'persist:compatibility-smoke', plugins: false } });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 640, height: 480 });

  try {
    await view.webContents.loadURL(`http://127.0.0.1:${pagePort}/`);
    const responseHeaders = await swfHeaders;
    const corsHeader = Object.entries(responseHeaders || {}).find(([name]) => name.toLowerCase() === 'access-control-allow-origin')?.[1]?.[0];
    await view.webContents.loadURL(`http://127.0.0.1:${pagePort}/crossdomain.xml`);
    const policy = await view.webContents.executeJavaScript('document.documentElement.outerHTML', true);
    const result = {
      nativePolicyPreserved: String(policy).includes('native-policy-marker') && !String(policy).includes('allow-access-from'),
      policy: String(policy).slice(0, 200),
    };
    await view.webContents.loadURL('https://webres.61.com/common/js/swfobject.js');
    const swfObjectSource = await view.webContents.executeJavaScript('document.body.innerText', true);
    const combined = {
      swfCorsOk: corsHeader === '*',
      corsHeader,
      swfObjectPatched: String(swfObjectSource).includes('_swf_patched=1'),
      ...result,
    };
    if (!combined.swfCorsOk || !combined.nativePolicyPreserved || !combined.swfObjectPatched) {
      throw new Error(`unexpected fixture result: ${JSON.stringify(combined)}`);
    }
    console.log('[compat-smoke] PASS ' + JSON.stringify(combined));
    clearTimeout(timeout);
    swfServer.close();
    pageServer.close();
    app.exit(0);
  } catch (error) {
    console.error('[compat-smoke] failed:', error);
    clearTimeout(timeout);
    swfServer.close();
    pageServer.close();
    app.exit(1);
  }
}).catch((error) => {
  console.error('[compat-smoke] startup failed:', error);
  clearTimeout(timeout);
  app.exit(1);
});
