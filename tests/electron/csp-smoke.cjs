// Renderer CSP smoke.
//
// Verifies the three things a CSP meta tag can silently fail at:
//   1. `'self'` resolves for a `file://` document (so ./bundle.js still loads),
//   2. the policy is actually ENFORCED (an inline <script> is refused) — a policy
//      that is merely present makes "zero violations" meaningless,
//   3. the early global error handlers, now injected from the main process because
//      `script-src 'self'` forbids the old inline script, are installed before the
//      entry module evaluates and can actually observe both error channels.
//
// A hard watchdog exits non-zero instead of wedging the runner on a hung await.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const WATCHDOG_MS = 20000;
const watchdog = setTimeout(() => {
  console.log('WATCHDOG: no result within ' + WATCHDOG_MS + 'ms — forcing exit');
  app.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

app.setPath('userData', path.join(os.tmpdir(), 'bao-csp-smoke-' + process.pid));
app.commandLine.appendSwitch('ignore-gpu-blacklist');

const messages = [];
const loadFailures = [];
const failures = [];

function check(label, condition, detail) {
  if (condition) { console.log('  ok   ' + label); return; }
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
  failures.push(label);
}

// Mirrors src/main/modules/window.ts.
const EARLY_ERROR_HANDLERS = `(function () {
  window.onerror = function () { window.__caughtByOnerror = (window.__caughtByOnerror || 0) + 1; };
  window.onunhandledrejection = function () { window.__caughtByRejection = (window.__caughtByRejection || 0) + 1; };
})();`;

app.whenReady().then(async () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const rendererHtml = path.join(repoRoot, 'dist', 'renderer', 'index.html');
  // This smoke inspects the BUILT renderer. `npm run test:smokes` builds only the
  // release/tests bundles, so skip cleanly (not a failure) when dist is absent.
  if (!fs.existsSync(rendererHtml)) {
    console.log('renderer CSP smoke');
    console.log('  skip no dist/renderer/index.html — run `npm run build:renderer` first');
    app.exit(0);
    return;
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(repoRoot, 'dist', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    messages.push({ level, message });
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    loadFailures.push(code + ' ' + description + ' ' + url);
  });
  win.webContents.on('did-start-loading', () => {
    void win.webContents.executeJavaScript(EARLY_ERROR_HANDLERS).catch((error) => {
      failures.push('early-handler injection: ' + error.message);
    });
  });

  await win.loadFile(rendererHtml);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const probe = await win.webContents.executeJavaScript(`(function () {
    return {
      mounted: !!document.querySelector('#root > *'),
      onerror: typeof window.onerror === 'function',
      onrejection: typeof window.onunhandledrejection === 'function',
    };
  })()`);

  const handlerProof = await win.webContents.executeJavaScript(`(function () {
    return new Promise(function (resolve) {
      try { window.onerror('probe', 'file', 1, 1, new Error('probe')); } catch (e) {}
      try { window.onunhandledrejection({ reason: new Error('probe') }); } catch (e) {}
      setTimeout(function () {
        resolve({ onerror: window.__caughtByOnerror || 0, rejection: window.__caughtByRejection || 0 });
      }, 50);
    });
  })()`);

  // Snapshot the load-time console BEFORE the deliberate enforcement probe below,
  // which is itself expected to produce one refusal message.
  const violationMessages = messages.filter((m) => /Refused to execute inline script/.test(m.message));
  const securityWarnings = messages.filter((m) => /Insecure Content-Security-Policy/.test(m.message));

  const enforcement = await win.webContents.executeJavaScript(`(function () {
    window.__inlineRan = false;
    var script = document.createElement('script');
    script.textContent = 'window.__inlineRan = true;';
    document.body.appendChild(script);
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ inlineRan: window.__inlineRan === true }); }, 50);
    });
  })()`);

  console.log('renderer CSP smoke');
  check('renderer document loaded', loadFailures.length === 0, loadFailures.join('; '));
  check('React mounted (script-src self allows ./bundle.js on file://)', probe.mounted === true);
  check('no Content-Security-Policy violation on load', violationMessages.length === 0,
    violationMessages.map((m) => m.message.slice(0, 120)).join(' | '));
  check('Electron "Insecure Content-Security-Policy" warning is gone', securityWarnings.length === 0);
  check('inline <script> is REFUSED (policy is enforced, not merely present)', enforcement.inlineRan === false);
  check('early error handlers installed before entry evaluation', probe.onerror && probe.onrejection);
  check('injected onerror observes errors', handlerProof.onerror > 0, JSON.stringify(handlerProof));
  check('injected unhandledrejection observes rejections', handlerProof.rejection > 0, JSON.stringify(handlerProof));

  if (failures.length > 0) {
    console.log('CSP SMOKE FAILED: ' + failures.length + ' check(s)');
    app.exit(1);
    return;
  }
  console.log('CSP SMOKE PASSED');
  app.exit(0);
});