#!/usr/bin/env node
/**
 * S4 探针：openDevTools 系前端（embedded 通道）与 webContents.debugger 的互斥性。
 *
 *   node tools/devtools-spike/cdp-opendevtools-coexist.cjs
 *
 * 这是"容器包裹 DevTools"（setDevToolsWebContents 挤压方案）的生死判定：
 *   a) openDevTools 开着 → wc.debugger.attach 是否抛错
 *   b) wc.debugger 先 attach → openDevTools 是否还能打开
 *   c) 若能共存：detach 后 attach 再恢复
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const RUNNER = `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const report = [];
  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  await win.loadURL('about:blank');
  const wc = win.webContents;

  // a) 先开 DevTools，再 attach
  wc.openDevTools({ mode: 'detach' });
  await new Promise((r) => setTimeout(r, 2500));
  let attachAfterOpen = 'ok';
  try { wc.debugger.attach('1.3'); } catch (e) { attachAfterWs = undefined; attachAfterOpen = 'throw: ' + e.message; }
  report.push({ attachAfterOpen });
  let embeddedEval = null;
  if (attachAfterOpen === 'ok') {
    try {
      embeddedEval = await wc.debugger.sendCommand('Runtime.evaluate', { expression: '"emb:"+(1+1)', returnByValue: true }).then((r) => r.result.value);
    } catch (e) { embeddedEval = 'cmd-fail: ' + e.message; }
  }
  report.push({ embeddedEval });

  // b) detach 一次再 attach（模拟捕获链路的常规节奏）
  let detachThen = null;
  try { wc.debugger.detach(); } catch (e) { detachThen = 'detach-throw: ' + e.message; }
  let reattach = 'ok';
  try { wc.debugger.attach('1.3'); } catch (e) { reattach = 'throw: ' + e.message; }
  report.push({ detachThen, reattach });

  // c) debugger 先 attach（重开一个窗口验证反向顺序）
  const win2 = new BrowserWindow({ width: 500, height: 400, show: false });
  await win2.loadURL('about:blank');
  const wc2 = win2.webContents;
  wc2.debugger.attach('1.3');
  wc2.debugger.sendCommand('Runtime.enable').catch(() => {});
  wc2.openDevTools({ mode: 'detach' });
  await new Promise((r) => setTimeout(r, 2500));
  const devtoolsOpen = wc2.isDevToolsOpened();
  let cmdAfter = null;
  try {
    cmdAfter = await wc2.debugger.sendCommand('Runtime.evaluate', { expression: '"c:"+(2+2)', returnByValue: true }).then((r) => r.result.value).catch((e) => 'cmd-fail: ' + e.message);
  } catch (e) { cmdAfter = 'throw: ' + e.message; }
  report.push({ devtoolsOpen, cmdAfter });

  console.log('REPORT ' + JSON.stringify(report, null, 1));
  setTimeout(() => app.exit(0), 300);
});
`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const runnerPath = path.join(os.tmpdir(), `bfb-s4-${Date.now()}.cjs`);
  fs.writeFileSync(runnerPath, RUNNER);
  const outPath = runnerPath.replace('.cjs', '.out');
  const out = fs.openSync(outPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [runnerPath], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });
  console.log('[s4] electron pid', child.pid);
  await new Promise((resolve) => {
    const deadline = Date.now() + 30000;
    const poll = setInterval(() => {
      if (child.exitCode !== null || Date.now() > deadline) { clearInterval(poll); resolve(); }
    }, 300);
  });
  try { child.kill(); } catch { /* ignore */ }
  const text = fs.readFileSync(outPath, 'utf-8');
  const m = text.match(/REPORT ([\s\S]*)/);
  console.log(m ? m[1].slice(0, 1500) : text.slice(0, 1200));
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((error) => {
  console.error('[s4] failed:', error && error.message);
  process.exit(1);
});
