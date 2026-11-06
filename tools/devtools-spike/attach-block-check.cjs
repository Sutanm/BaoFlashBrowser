#!/usr/bin/env node
/**
 * S6：embedded vs remote attach 对页面脚本执行的阻塞对照。
 *   node tools/devtools-spike/attach-block-check.cjs
 *
 * 编排：外部脚本经指令文件指挥 runner 主进程执行 embedded attach/detach，
 * 导航计时统一走 fixture server 的 /done 上报（performance.now()）。
 * 五场景 × 每场景 2 轮导航：
 *   1 baseline        无 attach
 *   2 embedded RT     wc.debugger + Runtime.enable + addBinding（模拟捕获）
 *   3 embedded RT+Db  再 + Debugger.enable（模拟桥/DevTools 全套）
 *   4 remote RT       page-ws + Runtime.enable（模拟抽屉前端连接）
 *   5 remote RT+Db    page-ws + Runtime + Debugger（真 DevTools 形态）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const DEBUG_PORT = 19229;
const CMD_FILE = path.join(os.tmpdir(), 'bfb-s6-cmd.json');
const ACK_FILE = path.join(os.tmpdir(), 'bfb-s6-ack.json');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const RUNNER = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false });
  await win.loadURL('about:blank');
  await new Promise((r) => setTimeout(r, 800));
  const wc = win.webContents;
  let currentCmd = null;
  setInterval(() => {
    try {
      const cmd = JSON.parse(fs.readFileSync(${JSON.stringify(CMD_FILE)}, 'utf8'));
      if (cmd && cmd.seq !== currentCmd) {
        currentCmd = cmd.seq;
        let result = 'ok';
        try {
          if (cmd.action === 'attach-runtime') {
            wc.debugger.attach('1.3');
            wc.debugger.sendCommand('Runtime.enable');
            wc.debugger.sendCommand('Runtime.addBinding', { name: '__baopProbe' });
          } else if (cmd.action === 'attach-runtime-debugger') {
            wc.debugger.attach('1.3');
            wc.debugger.sendCommand('Runtime.enable');
            wc.debugger.sendCommand('Debugger.enable');
          } else if (cmd.action === 'detach') {
            try { wc.debugger.detach(); } catch (e) { /* not attached */ }
          }
        } catch (e) { result = 'throw: ' + e.message; }
        fs.writeFileSync(${JSON.stringify(ACK_FILE)}, JSON.stringify({ seq: cmd.seq, result }));
      }
    } catch (e) { /* file not ready yet */ }
  }, 50);
  setTimeout(() => app.exit(0), 120000);
});
`;

function startFixtureServer() {
  let lastDone = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head>
<script>window.__marks = [];</script>
<script src="/s?i=1"></script>
<script src="/s?i=2"></script>
<script src="/s?i=3"></script>
</head><body>
<script>
window.addEventListener('load', function () {
  fetch('/done?t=' + Math.round(performance.now()) + '&marks=' + window.__marks.join(','));
});
</script>
</body></html>`);
      return;
    }
    if (url.pathname === '/s') {
      const i = url.searchParams.get('i');
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(`window.__marks.push(${JSON.stringify(i)});`);
      }, 80);
      return;
    }
    if (url.pathname === '/done') {
      lastDone = url.searchParams.get('t') + '|marks=' + url.searchParams.get('marks');
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, getLastDone: () => lastDone, clearDone: () => { lastDone = null; } }));
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}

function wsClient(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id); pending.delete(msg.id);
      resolve(msg);
    }
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    send(method, params = {}) {
      const messageId = ++id;
      socket.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { const e = pending.get(messageId); if (e) { pending.delete(messageId); resolve({ error: { message: 'timeout' } }); } }, 5000);
        pending.set(messageId, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

let cmdSeq = 0;
async function sendCmd(action) {
  cmdSeq += 1;
  try { fs.unlinkSync(ACK_FILE); } catch { /* none */ }
  fs.writeFileSync(CMD_FILE, JSON.stringify({ seq: cmdSeq, action }));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const ack = JSON.parse(fs.readFileSync(ACK_FILE, 'utf8'));
      if (ack.seq === cmdSeq) return ack.result;
    } catch { /* pending */ }
    await sleep(40);
  }
  return 'ack-timeout';
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const { server, port: fixturePort, getLastDone, clearDone } = await startFixtureServer();
  const pageUrl = `http://127.0.0.1:${fixturePort}/page`;

  const logPath = path.join(os.tmpdir(), 'bfb-s6.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const runnerPath = path.join(os.tmpdir(), `bfb-s6-runner-${Date.now()}.cjs`);
  fs.writeFileSync(runnerPath, RUNNER);
  const child = spawn(ELECTRON, ['--remote-debugging-port=' + DEBUG_PORT, runnerPath], {
    cwd: APP_ROOT, stdio: ['ignore', out, out], env,
  });

  let shell = null;
  for (let i = 0; i < 60 && !shell; i += 1) {
    const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`).catch(() => []);
    shell = (list || []).find((t) => t.type === 'page' && t.url === 'about:blank');
    if (!shell) await sleep(500);
  }
  if (!shell) { console.error('[s6] target 没出现'); process.exit(2); }

  const client = wsClient(shell.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');

  async function navigateAndMeasure() {
    clearDone();
    await client.send('Page.navigate', { url: pageUrl });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const done = getLastDone();
      if (done) return done;
      await sleep(50);
    }
    return 'TIMEOUT/NO-DONE';
  }

  async function runScenario(name, rounds) {
    const results = [];
    for (let i = 0; i < rounds; i += 1) {
      const r = await navigateAndMeasure();
      results.push(r);
      await sleep(300);
    }
    console.log(`[s6] ${name}:`, JSON.stringify(results));
    return { name, results };
  }

  const summary = [];

  await navigateAndMeasure().catch(() => null); // 首轮预热
  summary.push(await runScenario('1 baseline', 2));
  summary.push(await runScenario('1 baseline(r2)', 1));

  const attachA = await sendCmd('attach-runtime');
  console.log('[s6] embedded attach(Runtime):', attachA);
  await sleep(300);
  summary.push(await runScenario('2 embedded Runtime', 2));
  const attachB = await sendCmd('attach-runtime-debugger');
  console.log('[s6] embedded attach(+Debugger):', attachB);
  await sleep(300);
  summary.push(await runScenario('3 embedded Runtime+Debugger', 2));
  const detach = await sendCmd('detach');
  console.log('[s6] detach:', detach);
  await sleep(500);

  await client.send('Runtime.enable');
  summary.push(await runScenario('4 remote Runtime', 2));
  await client.send('Debugger.enable');
  summary.push(await runScenario('5 remote Runtime+Debugger', 2));
  await client.send('Debugger.disable');
  await client.send('Runtime.disable');

  child.kill();
  server.close();

  console.log('\n===== summary =====');
  for (const s of summary) console.log(s.name, JSON.stringify(s.results));
  process.exit(0);
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
