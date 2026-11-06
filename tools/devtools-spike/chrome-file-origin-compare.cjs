/**
 * 对照实验：同一套 file:// 越界探测，分别跑在
 *   1) 标准 Chromium（Playwright 自带，默认参数）
 *   2) 标准 Chromium + --allow-file-access-from-files
 *   3) 我们的 Electron 11（已有结论，这里只做并排引用）
 *
 * 目的是回答「正常浏览器是怎么处理 file:// 的」——是禁掉页面，还是允许页面但降级 origin。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const DIR = path.join(os.tmpdir(), 'bfb-chrome-file');
try { fs.rmdirSync(DIR, { recursive: true }); } catch { /* 不存在 */ }
fs.mkdirSync(DIR, { recursive: true });

const PROBE = '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head>'
  + '<body>probe-frame</body></html>';
fs.writeFileSync(path.join(DIR, 'probe.html'), PROBE);
// 与外壳同目录的兄弟文件 + 完全在目录外的文件
fs.writeFileSync(path.join(DIR, 'sibling.txt'), 'SIBLING-SECRET');
const OUTSIDE = path.join(os.tmpdir(), 'bfb-chrome-outside.txt');
fs.writeFileSync(OUTSIDE, 'OUTSIDE-SECRET');

const shell = `<!doctype html>
<html><head><meta charset="utf-8"><title>SHELL-APP</title></head>
<body>
<script>try { localStorage.setItem('shell-token', 'SHELL-STORAGE-SECRET'); } catch (e) {}</script>
<iframe id="f" src="./probe.html" width="200" height="80"></iframe>
</body></html>`;
fs.writeFileSync(path.join(DIR, 'shell.html'), shell);

const BATTERY = `(async () => {
  const out = {};
  out.origin = String(location.origin);
  try { out.parentTitle = String(parent.document.title); } catch (e) { out.parentTitle = 'THROW:' + e.name; }
  try { out.parentStorage = String(parent.localStorage.getItem('shell-token')); } catch (e) { out.parentStorage = 'THROW:' + e.name; }
  try { localStorage.setItem('x', '1'); out.ownStorage = 'ok'; } catch (e) { out.ownStorage = 'THROW:' + e.name; }
  try { const r = await fetch('./sibling.txt'); out.sibling = (await r.text()).trim(); }
  catch (e) { out.sibling = 'BLOCKED:' + String(e.message).split('\\n')[0].slice(0, 60); }
  try { const r = await fetch('../bfb-chrome-outside.txt'); out.outside = (await r.text()).trim(); }
  catch (e) { out.outside = 'BLOCKED:' + String(e.message).split('\\n')[0].slice(0, 60); }
  return JSON.stringify(out);
})()`;

async function run(label, args) {
  const browser = await chromium.launch({ args: args || [], headless: true });
  const page = await browser.newPage();
  await page.goto(`file:///${path.join(DIR, 'shell.html').replace(/\\/g, '/')}`);
  await page.waitForTimeout(1500);
  const frame = page.frames().find((f) => /probe\.html/.test(f.url()));
  const main = await page.evaluate(`(() => {
    let ls = 'ok';
    try { localStorage.setItem('m', '1'); } catch (e) { ls = 'THROW:' + e.name; }
    return JSON.stringify({ origin: String(location.origin), secure: window.isSecureContext, localStorage: ls });
  })()`);
  let child = '{"err":"no child frame"}';
  if (frame) child = await frame.evaluate(BATTERY);
  console.log(`\n=== ${label} ===`);
  // 用 Chromium 自己吐的 origin 字符串说明问题
  console.log('   (外壳)        ', main);
  console.log('   (file://子帧) ', child);
  await browser.close();
}

(async () => {
  await run('标准 Chromium（默认参数）');
  await run('标准 Chromium + --allow-file-access-from-files', ['--allow-file-access-from-files']);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
