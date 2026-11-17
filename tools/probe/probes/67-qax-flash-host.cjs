'use strict';

// 67-qax-flash-host — 奇安信可信浏览器 1.1.46401.52（Chromium 102.0.5005.200）的
// PPAPI Flash 通道复核。回答三个问题，供内核选型使用：
//   1. 高版本内核上的 Flash 是不是真的走了 out-of-process PPAPI（而不是 Ruffle/扩展）？
//   2. 它的 Flash 插件路径从哪来？能不能用 --ppapi-flash-path 换成我们自带的 DLL？
//   3. 杀掉插件进程后，页面 JS 是否仍存活（= 插件真的是独立进程，不是内联仿真）？
//
// 该探测需要一份**外部**浏览器副本（我们不分发、不进 git），所以是 opt-in：
//   BAO_QAX_EXE=<安装目录>\Chrome-bin\qaxbrowser.exe node tools/probe/host.cjs --only 67
// 未设置时回落到 .cache/qax-46401-win/payload/Chrome-bin/qaxbrowser.exe，两者都没有则跳过。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { waitFor } = require('../lib/timeout.cjs');

const PLUGIN_HINT = 'pepflashplayer';
const SYSTEM_REGISTRY_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Macromedia\\FlashPlayerPepper';

function resolveExe(root) {
  const candidates = [
    process.env.BAO_QAX_EXE,
    path.join(root, '.cache', 'qax-46401-win', 'payload', 'Chrome-bin', 'qaxbrowser.exe'),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function registryFlashPath() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$k='${SYSTEM_REGISTRY_KEY}'; if (Test-Path "Registry::$k") { (Get-ItemProperty "Registry::$k").PlayerPath }`],
      { encoding: 'utf8', timeout: 8000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function procInfoById(ids) {
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${ids.join(',')}) } | ForEach-Object {` +
      ' [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; exe=$_.ExecutablePath;' +
      " type=[regex]::Match($_.CommandLine, '--type=([^ ]+)').Groups[1].Value } } | ConvertTo-Json -Compress"],
      { encoding: 'utf8', timeout: 8000 }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function loadedModules(pid) {
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | ForEach-Object { $_.Modules } |` +
      " Where-Object { $_.ModuleName -match 'pepflash|flashplayer' } |" +
      ' ForEach-Object { $_.FileName } | ConvertTo-Json -Compress'],
      { encoding: 'utf8', timeout: 8000 }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
}

async function probeRun({ exe, root, label, flashDll, fixtureDir }) {
  const { chromium } = require('playwright');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-qax-' + label + '-'));
  const args = [
    '--user-data-dir=' + profile,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--window-size=900,700',
  ];
  if (flashDll) {
    args.push('--ppapi-flash-path=' + flashDll, '--ppapi-flash-version=34.0.0.330', '--allow-outdated-plugins');
  }
  args.push('about:blank');

  const child = spawn(exe, args, { cwd: path.dirname(exe), stdio: 'ignore' });
  const report = { label, flashDllArg: flashDll ? path.basename(flashDll) : null };
  let browser;
  try {
    const marker = path.join(profile, 'DevToolsActivePort');
    await waitFor(() => fs.existsSync(marker) || child.exitCode !== null, { timeoutMs: 10_000, intervalMs: 100, label: label + ' DevToolsActivePort' });
    if (!fs.existsSync(marker)) throw new Error('DevToolsActivePort missing (exit ' + child.exitCode + ')');
    const port = Number(fs.readFileSync(marker, 'utf8').split(/\r?\n/)[0]);
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
    const cdp = await browser.newBrowserCDPSession();
    report.version = await cdp.send('Browser.getVersion');

    const page = await browser.contexts()[0].newPage();
    await page.goto(pathToFileURL(path.join(fixtureDir, 'button.html')).href, { timeout: 8000 });
    await page.waitForTimeout(900);
    report.plugins = await page.evaluate(() => Array.from(navigator.plugins, (p) => ({
      name: p.name, filename: p.filename, description: p.description,
    })));
    report.flashMime = await page.evaluate(() => !!navigator.mimeTypes['application/x-shockwave-flash']);

    // 真实的交互出帧：悬停/按下/抬起三个状态只要画面摘要不同，就说明插件在渲染而非静态占位。
    const shots = [];
    shots.push(digest(await page.screenshot({ timeout: 5000 })));
    await page.mouse.move(250, 210);
    await page.waitForTimeout(200);
    shots.push(digest(await page.screenshot({ timeout: 5000 })));
    await page.mouse.down();
    await page.waitForTimeout(200);
    shots.push(digest(await page.screenshot({ timeout: 5000 })));
    await page.mouse.up();
    report.frameDigests = shots;
    report.interactiveFrames = new Set(shots).size;

    const info = await cdp.send('SystemInfo.getProcessInfo').catch(() => null);
    const pepper = info ? info.processInfo.filter((p) => p.type === 'Pepper Plugin').map((p) => p.id) : [];
    const osProcs = pepper.length ? procInfoById([child.pid, ...pepper]) : [];
    report.pepperPids = pepper;
    report.osProcesses = osProcs;
    report.ppapiIsChild = osProcs.some((p) => p.parent === child.pid && p.type === 'ppapi' &&
      String(p.exe || '').toLowerCase() === path.resolve(exe).toLowerCase());
    report.pepperModules = pepper.length ? loadedModules(pepper[0]) : [];

    if (pepper.length) {
      process.kill(pepper[0]);
      await page.waitForTimeout(700);
      report.afterKill = await page.evaluate(() => ({ jsAlive: true, title: document.title }));
      const after = await cdp.send('SystemInfo.getProcessInfo').catch(() => null);
      report.afterKill.pepperPids = after ? after.processInfo.filter((p) => p.type === 'Pepper Plugin').map((p) => p.id) : [];
      report.afterKill.frameDigest = digest(await page.screenshot({ timeout: 5000 }));
      report.afterKill.frameChanged = report.afterKill.frameDigest !== shots[shots.length - 1];
    }
    await cdp.send('Browser.close').catch(() => {});
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
  }
  return report;
}

module.exports = {
  id: '67-qax-flash-host',
  name: '奇安信 102 内核的 PPAPI Flash 通道',
  needsElectron: false,
  timeoutMs: 60_000,

  async run({ root }) {
    const exe = resolveExe(root);
    if (!exe) {
      return { ok: true, summary: 'skipped: set BAO_QAX_EXE to a qaxbrowser.exe copy' };
    }
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-qax-fixture-'));
    const swfBase64 = fs.readFileSync(path.join(root, 'tools', 'automation-probe', 'fixtures', 'ruffle-button1.swf.base64'), 'utf8');
    fs.writeFileSync(path.join(fixtureDir, 'button.swf'), Buffer.from(swfBase64, 'base64'));
    fs.writeFileSync(path.join(fixtureDir, 'button.html'),
      '<!doctype html><style>body{margin:0}embed{display:block}</style>' +
      '<embed type="application/x-shockwave-flash" src="button.swf" width="550" height="420">');
    const flashDll = path.join(root, 'plugins', 'win32', 'pepflashplayer.dll');

    const stock = await probeRun({ exe, root, label: 'stock', fixtureDir });
    const override = fs.existsSync(flashDll)
      ? await probeRun({ exe, root, label: 'override', flashDll, fixtureDir })
      : null;

    const flashPlugin = (report) => (report.plugins || []).find((p) => String(p.name).includes('Shockwave Flash')) || null;
    const stockFlash = flashPlugin(stock);
    const overrideFlash = override ? flashPlugin(override) : null;
    const flashPathHonored = Boolean(overrideFlash && overrideFlash.filename === path.basename(flashDll));

    const checks = {
      ppapiProcess: Boolean(stock.ppapiIsChild && stock.pepperPids && stock.pepperPids.length),
      registeredPlugin: Boolean(stockFlash && stock.flashMime),
      systemFlashLoaded: (stock.pepperModules || []).some((file) => /Macromed/i.test(file)) ||
        Boolean(stockFlash && new RegExp(PLUGIN_HINT, 'i').test(stockFlash.filename)),
      interactiveFrames: stock.interactiveFrames >= 2,
      killLeavesJsAlive: Boolean(stock.afterKill && stock.afterKill.jsAlive && (stock.afterKill.pepperPids || []).length === 0),
    };
    const ok = Object.values(checks).every(Boolean);
    return {
      ok,
      summary: [
        'v' + String(stock.version && stock.version.product || '').replace('Chrome/', ''),
        'ppapi=' + (checks.ppapiProcess ? 'yes' : 'no'),
        'plugin=' + (stockFlash ? stockFlash.filename : 'none'),
        'frames=' + stock.interactiveFrames,
        'overrideHonored=' + (override ? String(flashPathHonored) : 'n/a'),
        'killKeepsJs=' + (checks.killLeavesJsAlive ? 'yes' : 'no'),
      ].join(' · '),
      detail: {
        exe,
        registryPlayerPath: registryFlashPath(),
        checks,
        flashPathHonored,
        note: 'override 未生效 = 该分支只加载注册表登记的系统 Flash，不能换成自带的 DLL',
        stock,
        override,
      },
    };
  },
};
