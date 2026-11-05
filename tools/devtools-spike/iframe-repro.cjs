// 复现：file:// 父页面里 iframe 加载 DevTools 前端，抓 iframe 内的异常
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const APP = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const ROOT = path.join(APP, 'assets', 'devtools-frontend');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.avif': 'image/avif',
  '.webp': 'image/webp', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.map': 'application/json',
};

const json = (u) => new Promise((res, rej) => {
  const r = http.get(u, (x) => { let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); });
  r.on('error', rej);
  r.setTimeout(2000, () => r.destroy(new Error('timeout')));
});

(async () => {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'inspector.html';
    const f = path.resolve(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404).end('nf'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(18080, '127.0.0.1', r));

  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await new Promise((r) => setTimeout(r, 1200));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(os.tmpdir(), 'bfb-repro.log'), 'w');
  const child = spawn(ELECTRON, ['--remote-debugging-port=19222', '.'], { cwd: APP, stdio: ['ignore', log, log], env });

  let shell = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    try {
      const list = await json('http://127.0.0.1:19222/json/list');
      shell = list.find((t) => /dist\/renderer\/index\.html$/.test(t.url || ''));
    } catch { /* not ready */ }
    if (!shell) await new Promise((r) => setTimeout(r, 500));
  }
  if (!shell) { console.log('no shell'); process.exit(2); }

  const hostPath = path.join(os.tmpdir(), 'bfb-host.html');
  const frameUrl = `http://127.0.0.1:18080/inspector.html?ws=127.0.0.1:19222/devtools/page/${shell.id}`;
  fs.writeFileSync(hostPath, `<!doctype html><meta charset=utf-8><style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style><iframe src="${frameUrl}"></iframe>`);
  const fileUrl = 'file:///' + hostPath.split(path.sep).join('/');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  const info = await page.evaluate(() => {
    const frame = document.querySelector('iframe');
    let inside = 'cross-origin';
    try { inside = frame.contentDocument ? frame.contentDocument.body.innerText.slice(0, 120) : 'no-doc'; } catch { inside = 'blocked'; }
    return { inside };
  });
  console.log('frame probe:', JSON.stringify(info));
  console.log('errors:', JSON.stringify(errs.slice(0, 8), null, 1));
  await page.screenshot({ path: path.join(APP, 'artifacts', 'devtools-iframe-repro.png') });
  await browser.close();
  server.close();
  try { child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => {
  console.error('failed', e);
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(1);
});
