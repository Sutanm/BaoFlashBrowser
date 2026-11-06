#!/usr/bin/env node
/**
 * S5 探针：docked 模式互斥性 + setDevToolsWebContents 容器方案可行性。
 *   node tools/devtools-spike/cdp-container-check.cjs
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const RUNNER = `
const { app, BrowserWindow, BrowserView } = require('electron');
app.whenReady().then(async () => {
  const report = [];
  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  await win.loadURL('about:blank');
  const wc = win.webContents;
  wc.openDevTools({ mode: 'bottom' });
  await new Promise((r) => setTimeout(r, 2000));
  let dockAttach = 'ok';
  try { wc.debugger.attach('1.3'); } catch (e) { dockAttach = 'throw: ' + e.message; }
  let dockCmd = null;
  if (dockAttach === 'ok') {
    try { dockCmd = await wc.debugger.sendCommand('Runtime.evaluate', { expression: '"d:"+(1+1)', returnByValue: true }).then((r) => r.result.value).catch((e) => 'cmd-fail: ' + e.message); } catch (e) { dockCmd = 'throw'; }
  }
  report.push({ dockAttach, dockCmd });
  wc.closeDevTools();

  const win2 = new BrowserWindow({ width: 900, height: 700, show: false });
  await win2.loadURL('about:blank');
  const wc2 = win2.webContents;
  const devtoolsView = new BrowserView({ webPreferences: {} });
  win2.addBrowserView(devtoolsView);
  devtoolsView.setBounds({ x: 0, y: 400, width: 900, height: 300 });
  wc2.setDevToolsWebContents(devtoolsView.webContents);
  wc2.openDevTools({ mode: 'detach' });
  await new Promise((r) => setTimeout(r, 2500));
  const dvUrl = devtoolsView.webContents.getURL();
  let eAttach = 'ok';
  try { wc2.debugger.attach('1.3'); } catch (e) { eAttach = 'throw: ' + e.message; }
  let eCmd = null;
  if (eAttach === 'ok') {
    try { eCmd = await wc2.debugger.sendCommand('Runtime.evaluate', { expression: '"e:"+(2+2)', returnByValue: true }).then((r) => r.result.value).catch((e) => 'cmd-fail: ' + e.message); } catch (e) { eCmd = 'throw'; }
  }
  report.push({ dvUrlPrefix: String(dvUrl).slice(0, 40), eAttach, eCmd, opened: wc2.isDevToolsOpened() });
  console.log('REPORT ' + JSON.stringify(report, null, 1));
  setTimeout(() => app.exit(0), 300);
});
`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);
  const runnerPath = path.join(os.tmpdir(), `bfb-s5-${Date.now()}.cjs`);
  fs.writeFileSync(runnerPath, RUNNER);
  const outPath = runnerPath.replace('.cjs', '.out');
  const out = fs.openSync(outPath, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [runnerPath], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });
  await new Promise((resolve) => {
    const deadline = Date.now() + 25000;
    const poll = setInterval(() => {
      if (child.exitCode !== null || Date.now() > deadline) { clearInterval(poll); resolve(); }
    }, 300);
  });
  try { child.kill(); } catch { /* ignore */ }
  const text = fs.readFileSync(outPath, 'utf-8');
  const m = text.match(/REPORT ([\s\S]*)/);
  console.log(m ? m[1].slice(0, 1200) : text.slice(0, 800));
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
