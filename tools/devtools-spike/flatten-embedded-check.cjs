#!/usr/bin/env node
/**
 * S7：flatten session 与 embedded debugger 的真实关系（S3 "域未找到"之谜）。
 *   node tools/devtools-spike/flatten-embedded-check.cjs
 *
 * 决定"桥"的正确后端：flatten（browser ws）还是 embedded（wc.debugger）。
 * 场景：
 *   a) flatten only            → evaluate（S2 基线复测）
 *   b) flatten + embedded      → 各自 evaluate
 *   c) detach embedded 后      → flatten evaluate（是否恢复）
 *   d) 重新 attach embedded    → flatten evaluate
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
const CMD_FILE = path.join(os.tmpdir(), 'bfb-s7-cmd.json');
const ACK_FILE = path.join(os.tmpdir(), 'bfb-s7-ack.json');
const EMBED_LOG = path.join(os.tmpdir(), 'bfb-s7-embed.json');

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
        const out = { seq: cmd.seq, action: cmd.action };
        try {
          if (cmd.action === 'attach-eval') {
            wc.debugger.attach('1.3');
            wc.debugger.sendCommand('Runtime.enable').then(() =>
              wc.debugger.sendCommand('Runtime.evaluate', { expression: '"emb:"+(2+2)', returnByValue: true })
            ).then((r) => { out.eval = r.result && r.result.result && r.result.result.value; })
              .catch((e) => { out.eval = 'cmd-fail: ' + e.message; })
              .then(() => fs.writeFileSync(${JSON.stringify(EMBED_LOG)}, JSON.stringify(out)));
            return; // ack 在 evaluate 完成后写
          } else if (cmd.action === 'detach') {
            try { wc.debugger.detach(); } catch (e) { out.error = e.message; }
          } else if (cmd.action === 'attach') {
            wc.debugger.attach('1.3');
          }
        } catch (e) { out.error = e.message; }
        fs.writeFileSync(${JSON.stringify(ACK_FILE)}, JSON.stringify(out));
      }
    } catch (e) { /* not ready */ }
  }, 50);
  setTimeout(() => app.exit(0), 120000);
});
`;

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
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
    send(method, params = {}, sessionId) {
      const messageId = ++id;
      const message = { id: messageId, method, params };
      if (sessionId) message.sessionId = sessionId;
      socket.send(JSON.stringify(message));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { const e = pending.get(messageId); if (e) { pending.delete(messageId); resolve({ error: { message: 'timeout' } }); } }, 5000);
        pending.set(messageId, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function flattenEval(browser, sessionId, label) {
  if (!sessionId) return `${label}: no-session`;
  const r = await browser.send('Runtime.evaluate', { expression: `"flat:"+(1+1)`, returnByValue: true }, sessionId);
  const value = r.error ? `err:${r.error.message}` : (r.result && r.result.result && r.result.result.value);
  return `${label}: ${value}`;
}

let cmdSeq = 0;
async function sendCmd(action) {
  cmdSeq += 1;
  try { fs.unlinkSync(ACK_FILE); } catch { /* none */ }
  try { fs.unlinkSync(EMBED_LOG); } catch { /* none */ }
  fs.writeFileSync(CMD_FILE, JSON.stringify({ seq: cmdSeq, action }));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const ack = JSON.parse(fs.readFileSync(ACK_FILE, 'utf8'));
      if (ack.seq === cmdSeq) return ack;
    } catch { /* pending */ }
    await sleep(60);
  }
  return { seq: cmdSeq, error: 'ack-timeout' };
}

async function readEmbedLog(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const log = JSON.parse(fs.readFileSync(EMBED_LOG, 'utf8'));
      if (log && log.seq === cmdSeq) return log;
    } catch { /* pending */ }
    await sleep(60);
  }
  return { seq: cmdSeq, eval: 'embed-log-timeout' };
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const logPath = path.join(os.tmpdir(), 'bfb-s7.log');
  const out = fs.openSync(logPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const runnerPath = path.join(os.tmpdir(), `bfb-s7-runner-${Date.now()}.cjs`);
  fs.writeFileSync(runnerPath, RUNNER);
  const child = spawn(ELECTRON, ['--remote-debugging-port=' + DEBUG_PORT, runnerPath], {
    cwd: APP_ROOT, stdio: ['ignore', out, out], env,
  });

  let target = null;
  let version = null;
  for (let i = 0; i < 60 && (!target || !version); i += 1) {
    const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`).catch(() => []);
    target = target || (list || []).find((t) => t.type === 'page' && t.url === 'about:blank');
    version = version || await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`).catch(() => null);
    if (!target || !version) await sleep(500);
  }
  if (!target || !version) { console.error('[s7] target 没出现'); process.exit(2); }
  console.log('[s7] target:', target.id);

  const browser = wsClient(version.webSocketDebuggerUrl);
  await browser.ready;
  const flat = await browser.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  const sessionId = flat.result && flat.result.sessionId;
  console.log('[s7] flatten attach:', flat.error ? JSON.stringify(flat.error) : 'ok', 'sessionId:', sessionId ? 'yes' : 'no');

  // a) flatten only
  console.log('[s7]', await flattenEval(browser, sessionId, 'a) flatten only'));

  // b) flatten + embedded
  const ackB = await sendCmd('attach-eval');
  const embedB = await readEmbedLog(6000);
  console.log('[s7] b) embedded attach+eval:', JSON.stringify(embedB));
  console.log('[s7]', await flattenEval(browser, sessionId, 'b) flatten after embed'));

  // c) detach embedded
  const ackC = await sendCmd('detach');
  console.log('[s7] c) detach:', JSON.stringify(ackC));
  await sleep(500);
  console.log('[s7]', await flattenEval(browser, sessionId, 'c) flatten after detach'));

  // d) re-attach embedded（不 evaluate，仅 attach）
  const ackD = await sendCmd('attach');
  console.log('[s7] d) re-attach:', JSON.stringify(ackD));
  await sleep(500);
  console.log('[s7]', await flattenEval(browser, sessionId, 'd) flatten after re-attach'));

  child.kill();
  browser.close();
  process.exit(0);
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
