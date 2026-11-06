/**
 * 停靠切换验证：底部 / 左侧 / 右侧 / 独立窗口。
 *
 * 判据全部取真值：
 *   外壳侧  .workspace-main 的 data-dock、抽屉矩形、页面区矩形
 *   页面侧  window.innerWidth / innerHeight（判断是不是真的让位）
 *   独立窗口  目标列表里是否出现一个新的 devtools_app.html 顶层 target，关掉后是否回到内嵌
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');
const LOG = path.join(os.tmpdir(), 'bfb-dock.log');
const FIXTURE = path.join(os.tmpdir(), 'bfb-dock.html');
const SHOT = path.join(APP_ROOT, 'artifacts', `devtools-dock-${Date.now()}.png`);

fs.writeFileSync(FIXTURE, '<!doctype html><html><head><meta charset="utf-8"><title>dock</title>'
  + '<style>html,body{margin:0;background:#eef;font:13px sans-serif}</style></head>'
  + '<body><div style="padding:10px">DOCK-FIXTURE</div></body></html>');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(3000, () => req.destroy(new Error('timeout')));
});

function cdp(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (typeof m.id === 'number' && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
  });
  const send = (method, params) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    return new Promise((r) => pending.set(i, r));
  };
  return { ready, send, close: () => ws.close() };
}

async function ev(client, expr) {
  const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return 'EXC';
  return r.result && r.result.result ? r.result.result.value : undefined;
}

const SNAPSHOT = `(() => {
  const main = document.querySelector('.workspace-main');
  const sep = document.querySelector('[role="separator"]');
  const drawer = sep ? sep.parentElement : null;
  const area = document.getElementById('browserview-area');
  const r = (el) => el ? (function (b) { return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; })(el.getBoundingClientRect()) : null;
  return JSON.stringify({
    dock: main ? main.getAttribute('data-dock') : null,
    drawer: r(drawer),
    area: r(area),
    hasDrawer: Boolean(drawer),
    buttons: [].slice.call(document.querySelectorAll('[title^="停靠到"],[title^="在独立窗口"]')).map(function (b) { return b.getAttribute('title'); }),
  });
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  await sleep(900);
  try { fs.unlinkSync(PORT_FILE); } catch { /* ignore */ }

  const out = fs.openSync(LOG, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  let port = 0;
  for (let i = 0; i < 60 && !port; i += 1) {
    await sleep(500);
    try {
      const p = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).split('\n')[0]);
      if (p > 0) { await getJson(`http://127.0.0.1:${p}/json/version`); port = p; }
    } catch { /* 等 */ }
  }
  if (!port) { console.error('端口没出现'); child.kill(); process.exit(2); }

  let shell = null;
  for (let i = 0; i < 50 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    shell = (list || []).find((t) => /dist\/renderer\/index\.html/.test(t.url || ''));
    if (!shell) await sleep(500);
  }
  if (!shell) { console.error('外壳没出现'); child.kill(); process.exit(2); }

  const sh = cdp(shell.webSocketDebuggerUrl);
  await sh.ready;
  await sh.send('Runtime.enable');
  await sleep(2500);

  const fixtureUrl = 'file:///' + FIXTURE.replace(/\\/g, '/');
  for (let i = 0; i < 20; i += 1) {
    const r = await ev(sh, `(() => {
      const el = document.querySelector('.address-input');
      if (!el) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(fixtureUrl)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return 'submitted';
    })()`);
    if (r === 'submitted') break;
    await sleep(500);
  }

  let pageT = null;
  for (let i = 0; i < 40 && !pageT; i += 1) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    pageT = (list || []).find((t) => /bfb-dock\.html/.test(t.url || ''));
    if (!pageT) await sleep(500);
  }
  const pg = pageT ? cdp(pageT.webSocketDebuggerUrl) : null;
  if (pg) { await pg.ready; await pg.send('Runtime.enable'); }

  const pageSize = async () => (pg ? ev(pg, 'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })') : 'no-page');

  /** 前端视图自己的尺寸与内容（CDP 截图不包含原生视图，只能这样验）。 */
  const frontendMetrics = async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const front = (list || []).find((t) => /devtools_app\.html/.test(t.url || ''));
    if (!front) return 'no-frontend-target';
    const c = cdp(front.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Runtime.enable');
    await sleep(2200);
    const out = await ev(c, `JSON.stringify({
      w: window.innerWidth, h: window.innerHeight,
      nodes: document.getElementsByTagName('*').length,
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 40),
      hasPanel: Boolean(document.querySelector('.panel, .vbox, [class*="panel"]')),
      tags: document.querySelectorAll('.webkit-html-tag, [class*="webkit-html"]').length,
    })`);
    c.close();
    return out;
  };

  // 打开抽屉。若上次运行把 dock 存成了 undocked，这里会弹独立窗口而不是抽屉——
  // 关掉它即回到内嵌位置，然后从已知状态继续。
  await ev(sh, `(() => { const b = document.querySelector('[data-devtoolbox-toggle]'); if (b) b.click(); return 1; })()`);
  await sleep(3000);
  const initialDock = JSON.parse(await ev(sh, SNAPSHOT) || '{}').dock;
  if (initialDock === 'undocked') {
    const l = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const wins = (l || []).filter((t) => /devtools_app\.html/.test(t.url || ''));
    if (wins.length) {
      const bc = cdp((await getJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl);
      await bc.ready;
      for (const t of wins) await bc.send('Target.closeTarget', { targetId: t.id });
      bc.close();
      await sleep(2800);
    }
  }

  const click = async (title) => {
    const r = await ev(sh, `(() => {
      const b = document.querySelector('[title=${JSON.stringify(title)}]');
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`);
    await sleep(1600);
    return r;
  };

  console.log('\n=== 初始（底部） ===');
  console.log('   外壳:', await ev(sh, SNAPSHOT));
  console.log('   页面:', await pageSize());
  console.log('   前端:', await frontendMetrics());
  console.log('   前端:', await frontendMetrics());

  console.log('\n=== 切到左侧 ===');
  console.log('   点击:', await click('停靠到左侧'));
  console.log('   外壳:', await ev(sh, SNAPSHOT));
  console.log('   页面:', await pageSize());
  console.log('   前端:', await frontendMetrics());

  console.log('\n=== 切到右侧 ===');
  console.log('   点击:', await click('停靠到右侧'));
  console.log('   外壳:', await ev(sh, SNAPSHOT));
  console.log('   页面:', await pageSize());
  console.log('   前端:', await frontendMetrics());

  console.log('\n=== 切到独立窗口 ===');
  console.log('   点击:', await click('在独立窗口中打开'));
  await sleep(2500);
  console.log('   外壳:', await ev(sh, SNAPSHOT));
  console.log('   页面:', await pageSize());
  console.log('   前端:', await frontendMetrics());
  const list2 = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const devWin = (list2 || []).find((t) => t.type === 'page' && /devtools_app\.html/.test(t.url || '') && !/ws=/.test(t.url || '') === false);
  const devWinTargets = (list2 || []).filter((t) => /devtools_app\.html/.test(t.url || ''));
  console.log('   devtools_app targets:', devWinTargets.length);
  devWinTargets.forEach((t) => console.log('     ', t.type, '|', String(t.url).slice(0, 80)));

  // 关掉独立窗口（等同于用户点右上角 ×）
  if (devWinTargets.length) {
    const browserClient = cdp((await getJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl);
    await browserClient.ready;
    for (const t of devWinTargets) {
      await browserClient.send('Target.closeTarget', { targetId: t.id });
    }
    browserClient.close();
    await sleep(2500);
    console.log('\n=== 关掉独立窗口后（应回到上次内嵌位置 = 右侧） ===');
    console.log('   外壳:', await ev(sh, SNAPSHOT));
  }

  // 截图留证
  const shotData = await sh.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shotData && shotData.result && shotData.result.data) {
    fs.writeFileSync(SHOT, Buffer.from(shotData.result.data, 'base64'));
    console.log('\n   截图:', SHOT);
  }

  child.kill();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
