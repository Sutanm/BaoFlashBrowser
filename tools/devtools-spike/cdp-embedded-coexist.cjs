#!/usr/bin/env node
/**
 * S3 探针：embedded agent（webContents.debugger）与外部 page-ws / flatten session 能否共存。
 *
 *   node tools/devtools-spike/cdp-embedded-coexist.cjs
 *
 * 自己起一个最小 BrowserWindow（不走应用外壳），依次验证：
 *   a) 先 page-ws 后 debugger.attach
 *   b) 先 debugger.attach 后 page-ws
 *   c) debugger 与 flatten session 并存 + 各自 evaluate
 * 任一 attach 抛错即互斥实锤，打印具体报错。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const DEBUG_PORT = Number(process.env.BFB_SPIKE_DEBUG_PORT || 19228);

const RUNNER = `
const { app, BrowserWindow } = require('electron');
const WebSocket = require(${JSON.stringify(path.join(APP_ROOT, 'node_modules', 'ws'))});
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
function wsClient(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg);
    }
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    send(method, params = {}) {
      const messageId = ++id;
      socket.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { const e = pending.get(messageId); if (e) { pending.delete(messageId); resolve({ error: { message: 'timeout' } }); } }, 4000);
        pending.set(messageId, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch {} },
  };
}
async function evalWs(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.error ? { error: r.error.message } : { value: r.result && r.result.result && r.result.result.value };
}

app.whenReady().then(async () => {
  const report = [];
  const win = new BrowserWindow({ width: 400, height: 300, show: false });
  await win.loadURL('about:blank');
  const wc = win.webContents;
  const targetId = wc.getURL ? undefined : undefined;
  await new Promise((r) => setTimeout(r, 800));
  const list = await getJson('http://127.0.0.1:' + process.env.BFB_SPIKE_DEBUG_PORT + '/json/list');
  const page = list.find((t) => t.type === 'page' && (t.url === 'about:blank' || /about:blank/.test(t.url)));
  if (!page) { console.log('REPORT ' + JSON.stringify({ fatal: 'no about:blank target', list: list.map(t=>t.url) })); app.exit(3); return; }
  report.push({ targetId: page.id });

  // a) 先 page-ws 后 attach
  const p1 = wsClient(page.webSocketDebuggerUrl);
  await p1.ready;
  await p1.send('Runtime.enable');
  const a1 = await evalWs(p1, '"ws1:"+(1+1)');
  report.push({ wsEvalBefore: a1 });
  let attachAfterWs = null;
  try { wc.debugger.attach('1.3'); attachAfterWs = 'ok'; } catch (e) { attachAfterWs = 'throw: ' + e.message; }
  report.push({ attachAfterWs });
  let embeddedEval1 = null;
  if (attachAfterWs === 'ok') {
    try { embeddedEval1 = await wc.debugger.sendCommand('Runtime.evaluate', { expression: '"emb:"+(2+2)', returnByValue: true }).then((r) => r.result.value).catch((e) => 'cmd-fail: ' + e.message); } catch (e) { embeddedEval1 = 'throw: ' + e.message; }
  }
  report.push({ embeddedEval1 });
  const a2 = await evalWs(p1, '"ws1-after:"+(3+3)');
  report.push({ wsEvalAfterAttach: a2 });

  // b) embedded 已 attach 时，再来一个 page-ws
  const p2 = wsClient(page.webSocketDebuggerUrl);
  let p2State = 'open';
  try { await p2.ready; } catch (e) { p2State = 'error: ' + e.message; }
  let ws2Eval = null;
  if (p2State === 'open') { ws2Eval = await evalWs(p2, '"ws2:"+(4+4)'); }
  report.push({ p2State, ws2Eval });

  // c) flatten session 并存
  const ver = await getJson('http://127.0.0.1:' + process.env.BFB_SPIKE_DEBUG_PORT + '/json/version');
  const b = wsClient(ver.webSocketDebuggerUrl);
  await b.ready;
  const flat = await b.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  const sessionId = flat.result && flat.result.sessionId;
  let flatEval = null;
  if (sessionId) {
    const r = await b.send('Runtime.evaluate', { expression: '"flat:"+(5+5)', returnByValue: true }, sessionId);
    flatEval = r.error ? { error: r.error.message } : { value: r.result && r.result.result && r.result.result.value };
  } else { flatEval = { error: JSON.stringify(flat.error) }; }
  report.push({ flatAttach: flat.error ? 'fail' : 'ok', flatEval });

  // 收尾：detach 一次，看 page-ws 是否仍活着
  let detachAfter = null;
  try { wc.debugger.detach(); detachAfter = 'ok'; } catch (e) { detachAfter = 'throw: ' + e.message; }
  const ws1Final = await evalWs(p1, '"ws1-final:"+(6+6)');
  report.push({ detachAfter, ws1Final });

  console.log('REPORT ' + JSON.stringify(report, null, 1));
  p1.close(); p2.close(); b.close();
  setTimeout(() => app.exit(0), 300);
});
`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const runnerPath = path.join(os.tmpdir(), `bfb-cdp-s3-${Date.now()}.cjs`);
  fs.writeFileSync(runnerPath, RUNNER);
  const outPath = runnerPath.replace('.cjs', '.out');
  const out = fs.openSync(outPath, 'w');
  const env = { ...process.env, BFB_SPIKE_DEBUG_PORT: String(DEBUG_PORT), ELECTRON_RUN_AS_NODE: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [`--remote-debugging-port=${DEBUG_PORT}`, runnerPath], {
    cwd: APP_ROOT, stdio: ['ignore', out, out], env,
  });
  console.log('[s3] electron pid', child.pid);

  // 等应用退出（脚本自会 app.exit）
  await new Promise((resolve) => {
    const deadline = Date.now() + 30000;
    const poll = setInterval(() => {
      if (child.exitCode !== null || Date.now() > deadline) { clearInterval(poll); resolve(); }
    }, 300);
  });
  try { child.kill(); } catch { /* ignore */ }
  const text = fs.readFileSync(outPath, 'utf-8');
  const reportLine = text.split('\n').find((l) => l.startsWith('REPORT'));
  if (reportLine) console.log(reportLine.replace('REPORT ', ''));
  else { console.log('[s3] 无 REPORT 行，原始输出：'); console.log(text.slice(0, 2000)); }
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((error) => {
  console.error('[s3] failed:', error && error.message);
  process.exit(1);
});
