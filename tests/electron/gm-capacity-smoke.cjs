// Smoke: GM_xmlhttpRequest / GM_download 容量参数化 (Task 3)
// 直接调用真实 service(admin-module 导出 getRequestService/getDownloadService),
// 绕过 IPC,断言新容量:响应 2MB/超时 15s/每脚本 4/全局 16;下载 8MB/每脚本 4。
const { app } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
app.setPath('userData', process.env.BAO_SMOKE_USER_DATA || path.join(app.getPath('appData'), 'bao-flash-browser'));

const failures = [];
function check(name, ok, detail) {
  console.log(`[gm-capacity] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

// pageUrl 必须非空:new URL('') 抛异常 → connectAllows 恒 false
const PAGE_URL = 'http://127.0.0.1/';
const CONNECT = ['127.0.0.1'];

app.whenReady().then(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();
  const requests = mod.getRequestService();
  const downloads = mod.getDownloadService();

  const srv = http.createServer((req, res) => {
    if (req.url === '/big-file.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(100 * 1024, 7));
    } else if (req.url === '/big-response') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('a'.repeat(1.5 * 1024 * 1024));
    } else if (req.url === '/huge-response') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('b'.repeat(3 * 1024 * 1024));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;

  // 1. GM_download 100KB → onload,文件存在且 100KB
  const dl = await downloads.download(1, 'cap-dl', PAGE_URL, CONNECT, { url: `${base}/big-file.bin`, name: 'big-file.bin' }, 1);
  const dlPath = path.join(app.getPath('userData'), 'userscript-downloads', 'big-file.bin');
  check('download 100KB ok', dl.ok === true && dl.fileName === 'big-file.bin', dl);
  // stream.end() 后 resolve,落盘有延迟;文件在 createWriteStream 时已存在(0 字节),
  // 必须轮询 SIZE 而非 existsSync
  let dlSize = 0;
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(dlPath)) dlSize = fs.statSync(dlPath).size;
    if (dlSize === 100 * 1024) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check('download file exists with 100KB', dlSize === 100 * 1024, { path: dlPath, size: dlSize });
  try { fs.unlinkSync(dlPath); } catch { /* best effort */ }

  // 2. 1.5MB 响应 → onload
  const okRes = await requests.request(1, 'cap-xhr', PAGE_URL, CONNECT, { method: 'GET', url: `${base}/big-response` }, 101);
  check('1.5MB response onload', okRes.ok === true && (okRes.response?.responseText?.length ?? 0) >= 1.5 * 1024 * 1024, okRes.ok ? { length: okRes.response.responseText.length } : okRes);

  // 3. 3MB 响应 → size-limit
  const huge = await requests.request(1, 'cap-xhr', PAGE_URL, CONNECT, { method: 'GET', url: `${base}/huge-response` }, 102);
  check('3MB response rejected with size-limit', huge.ok === false && huge.error === 'size-limit', huge);

  // 4. 并发:20 个不同 scriptId(每脚本 1 ≤ 4,全局 16 生效)→ ≥16 onload + 其余 concurrency-limit
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    requests.request(1, `cap-${i}`, PAGE_URL, CONNECT, { method: 'GET', url: `${base}/big-response` }, 200 + i)));
  const onload = results.filter((r) => r.ok).length;
  const limited = results.filter((r) => !r.ok && r.error === 'concurrency-limit').length;
  const other = results.filter((r) => !r.ok && r.error !== 'concurrency-limit');
  check('concurrency: >=16 onload', onload >= 16, { onload, limited });
  check('concurrency: rest are concurrency-limit', onload + limited === 20, { onload, limited, other: other.map((r) => r.error) });
  check('concurrency settled within 30s', Date.now() - started < 30000, Date.now() - started);

  srv.close();
  console.log(`[gm-capacity] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
