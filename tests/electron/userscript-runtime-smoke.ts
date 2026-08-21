import { app, BrowserView, BrowserWindow, clipboard, ipcMain, session, type WebContents } from 'electron';
import http from 'http';
import path from 'path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { applyCompatibilitySessionConfig } from '../../src/main/modules/session-manager';
import { UserscriptManager } from '@main/modules/userscripts/userscript-manager';
import { ValueStore } from '@main/modules/userscripts/userscript-store';
import { parseUserscriptMetadata } from '@main/modules/userscripts/userscript-parser';
import { GmRequestService, type GmRequestResult } from '@main/modules/userscripts/userscript-request-service';
import { GmDownloadService } from '@main/modules/userscripts/userscript-download-service';
import { RequireCache } from '@main/modules/userscripts/userscript-require-cache';
import type { InstalledUserscript, UserscriptReport } from '@shared/userscript-types';
import { PAGE_BRIDGE_SOURCE, BRIDGE_MARKER } from '../../src/webview-preload/userscripts/page-bridge';
import type { InstalledUserscript, UserscriptReport } from './userscripts/userscript-types';

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => { /* smoke controls its own exit code */ });
const smokeUserDataDir = process.env.BAO_SMOKE_USER_DATA ?? app.getPath('userData');

type Mode = 'ppapi' | 'ruffle';

interface CheckResult {
  mode: Mode | 'lifecycle';
  name: string;
  required: boolean;
  passed: boolean;
  detail?: unknown;
}

interface StoredReport extends UserscriptReport {
  accepted: boolean;
  wcId: number;
}

const checks: CheckResult[] = [];
const reports: StoredReport[] = [];
const wcRegistry = new Map<number, WebContents>();
let manager: UserscriptManager | null = null;
let realManagerRef: UserscriptManager | null = null;
let requestService: GmRequestService | null = null;
let downloadService: GmDownloadService | null = null;
let downloadDir = '';
let requireCache: RequireCache | null = null;
const requireRequests: Record<string, number> = {};

function httpGetText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
  });
}

function addCheck(mode: CheckResult['mode'], name: string, required: boolean, passed: boolean, detail?: unknown): void {
  checks.push({ mode, name, required, passed, detail });
}

function listen(server: http.Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('fixture server did not expose a TCP port'));
      else resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    server.close(finish);
    // Chromium 87 may keep fixture sockets alive after BrowserWindow.destroy().
    // The smoke is already complete, so never let teardown hang the CI job.
    const timer = setTimeout(finish, 2000);
    timer.unref?.();
  });
}

function html(title: string, body: string, lateScript = ''): string {
  return `<!doctype html>
    <html><head><meta charset="utf-8"><title>${title}</title></head>
    <body><main id="fixture">${body}</main>${lateScript}</body></html>`;
}

// Page with the D5 page-world bridge inlined into the head so it registers
// before any page script, plus a page-world section that installs state the
// bridge fixtures interact with through unsafeWindow.
function pageWorldHtml(title: string, body: string): string {
  return `<!doctype html>
    <html><head><meta charset="utf-8"><title>${title}</title>
      <script>${PAGE_BRIDGE_SOURCE}</script>
      <script>
        window.YUI_config = { flickr: { api: 'secret-key' } };
        window.__pageLog = [];
        window.__pageFn = function (value) { window.__pageLog.push(String(value)); return 'page-fn-ok'; };
        window.__double = function (value) { return Number(value) * 2; };
      </script>
    </head>
    <body><main id="fixture">${body}</main></body></html>`;
}

async function waitForReport(predicate: (report: StoredReport) => boolean, description: string, timeoutMs = 6000): Promise<StoredReport> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = reports.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function waitForAttr(wc: WebContents, name: string, timeoutMs = 15000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await Promise.race([
      wc.executeJavaScript(`document.documentElement.getAttribute(${JSON.stringify(name)})`).catch(() => null),
      new Promise<null | '__hung__'>((resolve) => setTimeout(() => resolve('__hung__'), 5000)),
    ]);
    if (value === '__hung__') {
      console.error(`[userscript-smoke] executeJavaScript hung; crashed=${wc.isCrashed()} url=${wc.getURL()}`);
    } else if (typeof value === 'string' && value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for attribute ${name}`);
}

// ---------------------------------------------------------------------------
// Fixture scripts. Installed per mode so value round-trips are mode-local.
// Scripts communicate results through DOM attributes, which are visible across
// the isolated preload world (ppapi) and the page world (ruffle).
// ---------------------------------------------------------------------------

const fixtureScripts: Array<{ id: string; enabled: boolean; source: (origins: { main: string; cross: string }) => string }> = [
  {
    id: 'demo:start',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Start
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Sets a marker at document-start
// @match        ${main}/document-start
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-start', '1');
  var s = document.createElement('style');
  s.setAttribute('data-demo-start-css', '1');
  s.textContent = ':root { --demo-start: 1; }';
  document.documentElement.appendChild(s);
})();
`,
  },
  {
    id: 'demo:body',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Body
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Runs when the body exists
// @match        ${main}/document-start
// @run-at       document-body
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-body', Boolean(document.body) ? '1' : '0');
})();
`,
  },
  {
    id: 'demo:end',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo End
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Runs at DOMContentLoaded
// @match        ${main}/document-start
// @run-at       document-end
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-end', document.readyState);
})();
`,
  },
  {
    id: 'demo:idle',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Idle
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Runs when the page is idle
// @match        ${main}/document-start
// @run-at       document-idle
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-idle', document.readyState);
})();
`,
  },
  {
    id: 'demo:values',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Values
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Value round trip across documents
// @match        ${main}/document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @run-at       document-end
// ==/UserScript==
(function () {
  var before = GM_getValue('counter', 0);
  GM_setValue('counter', before + 1);
  GM_setValue('marker', 'first-run');
  var fallback = GM_getValue('missing-key', 'default-value');
  var keys = GM_listValues();
  document.documentElement.setAttribute('data-demo-values', before + ':' + (before + 1));
  document.documentElement.setAttribute('data-demo-values-keys', keys.join(','));
  document.documentElement.setAttribute('data-demo-values-fallback', fallback);
})();
`,
  },
  {
    id: 'demo:legacy',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Legacy API
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Uses classic GM_* names
// @match        ${main}/document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==
(function () {
  GM_setValue('legacy-marker', 'legacy-ok');
  document.documentElement.setAttribute('data-demo-legacy', GM_getValue('legacy-marker'));
})();
`,
  },
  {
    id: 'demo:info',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Info
// @namespace    https://demo.baoflash.local/
// @version      3.2.1
// @description  Reports GM_info
// @match        ${main}/document-start
// @grant        GM_info
// @run-at       document-end
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-info', [
    GM_info.script.name,
    GM_info.script.version,
    GM_info.script.runAt,
    GM_info.scriptHandler,
    GM_info.flashRuntime
  ].join('|'));
})();
`,
  },
  {
    id: 'demo:fail',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Fail
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Throws on purpose
// @match        ${main}/document-start
// @run-at       document-start
// ==/UserScript==
(function () {
  throw new Error('demo-failure');
})();
`,
  },
  {
    id: 'demo:neighbor',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Neighbor
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Runs right after a failing script
// @match        ${main}/document-start
// @run-at       document-start
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-neighbor', '1');
})();
`,
  },
  {
    id: 'demo:disabled',
    enabled: false,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Disabled
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Must never run
// @match        ${main}/document-start
// @run-at       document-end
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-disabled', '1');
})();
`,
  },
  {
    id: 'demo:style',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Style
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Injects a stylesheet
// @match        ${main}/document-start
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==
(function () {
  GM_addStyle('#demo-style-target { color: rgb(1, 2, 3); }');
})();
`,
  },
  {
    id: 'demo:noframes',
    enabled: true,
    source: (origins) => `// ==UserScript==
// @name         Demo NoFrames
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Main frame only
// @match        ${origins.main}/frame-child*
// @match        ${origins.main}/document-start
// @noframes
// @run-at       document-end
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-noframes', '1');
})();
`,
  },
  {
    id: 'demo:iframe',
    enabled: true,
    source: (origins) => `// ==UserScript==
// @name         Demo Iframe
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Runs inside iframes
// @match        ${origins.main}/frame-child*
// @match        ${origins.cross}/frame-child*
// @run-at       document-end
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-iframe', '1');
})();
`,
  },
  {
    id: 'demo:menu',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Menu
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Registers a menu command
// @match        ${main}/document-start
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==
(function () {
  var id = GM_registerMenuCommand('Demo Command', function () {
    GM_setValue('menu-fired', true);
  });
  document.documentElement.setAttribute('data-demo-menu', String(id));
})();
`,
  },
  {
    id: 'demo:open',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo OpenInTab
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Opens a background tab
// @match        ${main}/document-start
// @grant        GM_openInTab
// @run-at       document-end
// ==/UserScript==
(function () {
  GM_openInTab('about:blank');
})();
`,
  },
  {
    id: 'demo:menu2',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Menu Two
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Second script registering a menu command
// @match        ${main}/document-start
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==
(function () {
  var id = GM_registerMenuCommand('Demo Command Two', function () {
    GM_setValue('menu2-fired', true);
  });
  document.documentElement.setAttribute('data-demo-menu2', String(id));
})();
`,
  },
  {
    id: 'demo:evil',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Evil Escape Probe
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Attempts Node escape paths; must all fail
// @match        ${main}/document-start
// @run-at       document-end
// ==/UserScript==
(function () {
  function probe(fn) {
    try { return fn(); } catch (e) { return 'blocked:' + e.message; }
  }
  var escapes = {
    direct: typeof require,
    globalProcess: typeof globalThis.process,
    globalRequire: typeof globalThis.require,
    ctorChain: probe(function () {
      var f = this && this.constructor && this.constructor.constructor;
      return typeof f === 'function' ? f('return typeof process')() : 'no-ctor';
    }),
    indirectEval: probe(function () { return (0, eval)('typeof process'); }),
    fnCtor: probe(function () { return Function('return typeof global')(); }),
    fnCtorThis: probe(function () { return Function('return this')() === window; }),
    windowRequire: typeof window.require
  };
  document.documentElement.setAttribute('data-demo-evil', JSON.stringify(escapes));
})();
`,
  },
  {
    id: 'demo:proto',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Prototype Pollution Probe
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Prototype pollution and GM function constructor chains
// @match        ${main}/document-start
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==
(function () {
  function probe(fn) {
    try { return fn(); } catch (e) { return 'blocked:' + e.message; }
  }
  var results = {
    protoEscape: probe(function () {
      Object.prototype.__defineGetter__('__demoProtoProbe__', function () { return typeof require; });
      var got = ({}).__demoProtoProbe__;
      try { delete Object.prototype.__demoProtoProbe__; } catch (e) { /* ignore */ }
      return got;
    }),
    gmCtorChain: probe(function () { return GM_setValue.constructor('return typeof process')(); }),
    gmCtorProtoChain: probe(function () {
      var f = GM_setValue.constructor;
      return typeof f === 'function' ? f('return typeof global')() : 'no-fn';
    }),
    protoNowClean: !('__demoProtoProbe__' in Object.prototype)
  };
  document.documentElement.setAttribute('data-demo-proto', JSON.stringify(results));
})();
`,
  },
  {
    id: 'demo:proto-clean',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Prototype Clean Check
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Runs after the pollution probe and verifies the prototype
// @match        ${main}/document-start
// @run-at       document-end
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-proto-clean',
    ('__demoProtoProbe__' in Object.prototype) ? 'dirty' : 'clean');
})();
`,
  },
  {
    id: 'demo:xhr',
    enabled: true,
    source: (origins) => `// ==UserScript==
// @name         Demo XHR
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  GM_xmlhttpRequest probes
// @match        ${origins.main}/document-start
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-end
// ==/UserScript==
(function () {
  var main = '${origins.main}';
  var cross = '${origins.cross}';
  function req(details) {
    return new Promise(function (resolve) {
      GM_xmlhttpRequest(Object.assign({}, details, {
        onload: function (e) { resolve({ ok: true, status: e.status, body: e.responseText, headers: e.responseHeaders || {} }); },
        onerror: function (e) { resolve({ ok: false, error: e.error, message: e.errorMessage }); },
        onabort: function () { resolve({ ok: false, error: 'aborted' }); },
        ontimeout: function () { resolve({ ok: false, error: 'timeout' }); }
      }));
    });
  }
  var results = {};
  (async function () {
    var crossPort = new URL(cross).port;
    results.sameOrigin = await req({ method: 'GET', url: main + '/xhr/echo-headers' });
    results.crossAuthorized = await req({ method: 'GET', url: 'http://127.0.0.1:' + crossPort + '/xhr/echo-headers' });
    results.crossDenied = await req({ method: 'GET', url: cross + '/xhr/echo-headers' });
    results.privateBlocked = await req({ method: 'GET', url: 'http://10.255.255.1/xhr/echo-headers' });
    results.cookieFollows = await req({ method: 'GET', url: main + '/xhr/echo-headers' });
    results.headerFilter = await req({ method: 'GET', url: main + '/xhr/echo-headers', headers: { Authorization: 'Bearer secret', Cookie: 'x=1', 'X-Custom': 'kept' } });
    results.redirectTwo = await req({ method: 'GET', url: main + '/xhr/redirect/2' });
    results.redirectPrivate = await req({ method: 'GET', url: main + '/xhr/redirect-private' });
    results.redirectLoop = await req({ method: 'GET', url: main + '/xhr/redirect/6' });
    results.bigBlocked = await req({ method: 'GET', url: main + '/xhr/big?bytes=131072' });
    results.timeout = await req({ method: 'GET', url: main + '/xhr/slow?ms=3000', timeout: 800 });
    results.jsonType = await req({ method: 'GET', url: main + '/xhr/json', responseType: 'json' });
    results.abort = await new Promise(function (resolve) {
      var xhr = GM_xmlhttpRequest({ method: 'GET', url: main + '/xhr/slow?ms=3000', timeout: 10000, onabort: function () { resolve({ ok: false, error: 'aborted' }); }, onerror: function (e) { resolve({ ok: false, error: e.error }); }, onload: function (e) { resolve({ ok: true, status: e.status }); } });
      setTimeout(function () { xhr.abort(); }, 100);
    });
    results.concurrency = await new Promise(function (resolve) {
      var done = 0;
      var states = [];
      function finish(state) { states.push(state); done += 1; if (done === 3) resolve(states); }
      for (var i = 0; i < 3; i++) {
        GM_xmlhttpRequest({ method: 'GET', url: main + '/xhr/slow?ms=500', timeout: 5000, onload: function () { finish('ok'); }, onerror: function (e) { finish(e.error || 'error'); } });
      }
    });
    document.documentElement.setAttribute('data-demo-xhr', JSON.stringify(results));
  })().catch(function (e) {
    document.documentElement.setAttribute('data-demo-xhr', JSON.stringify({ fatal: String(e && e.message || e) }));
  });
})();
`,
  },
  {
    id: 'demo:require',
    enabled: true,
    source: (origins) => `// ==UserScript==
// @name         Demo Require
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Uses @require libraries
// @match        ${origins.main}/document-start
// @require      ${origins.main}/require/lib-a.js
// @require      ${origins.main}/require/lib-b.js
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==
(function () {
  var total = LIB_A.v + libHelper(3);
  GM_setValue('require-marker', String(total));
  document.documentElement.setAttribute('data-demo-require', String(total) + ':' + GM_getValue('require-marker', ''));
})();
`,
  },
  {
    id: 'demo:require-config',
    enabled: true,
    source: (origins) => `// ==UserScript==
// @name         Demo Require GM API
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Library code calling GM APIs
// @match        ${origins.main}/document-start
// @require      ${origins.main}/require/gm-config.js
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==
(function () {
  var before = GMConfigDemo.read('require-config-key', 'none');
  GMConfigDemo.write('require-config-key', 'config-ok');
  var after = GMConfigDemo.read('require-config-key', 'none');
  document.documentElement.setAttribute('data-demo-require-config', before + ':' + after);
})();
`,
  },
  {
    id: 'demo:resource',
    enabled: true,
    source: (origins) => `// ==UserScript==
// @name         Demo Resource
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Uses @resource via GM_getResourceText/URL
// @match        ${origins.main}/document-start
// @resource     demo-data ${origins.main}/resource/data.txt
// @grant        GM_getResourceText
// @grant        GM_getResourceURL
// @run-at       document-end
// ==/UserScript==
(function () {
  var text = GM_getResourceText('demo-data');
  var url = GM_getResourceURL('demo-data');
  document.documentElement.setAttribute('data-demo-resource', text || 'missing');
  document.documentElement.setAttribute('data-demo-resource-url', (url || '').slice(0, 40));
})();
`,
  },
  {
    id: 'demo:require-fail',
    enabled: true,
    source: (origins) => `// ==UserScript==
// @name         Demo Require Fail
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Requires a missing library; must never run
// @match        ${origins.main}/document-start
// @require      ${origins.main}/require/missing.js
// @run-at       document-end
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-require-fail', '1');
})();
`,
  },
  {
    id: 'demo:listener',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Value Listener
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Listens for value changes
// @match        ${main}/document-start
// @grant        GM_addValueChangeListener
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==
(function () {
  GM_addValueChangeListener('listen-key', function (name, oldValue, newValue, remote) {
    document.documentElement.setAttribute('data-demo-listener', String(newValue) + ':' + String(remote));
  });
  if (GM_getValue('listen-key', null) === null) {
    GM_setValue('listen-key', 'local-hello');
  }
})();
`,
  },
  {
    id: 'demo:getvalues',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo GetValues
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Reads all values at once
// @match        ${main}/document-start
// @grant        GM_setValue
// @grant        GM_getValues
// @grant        GM_deleteValue
// @run-at       document-end
// ==/UserScript==
(function () {
  GM_setValue('gv-key-a', 'a');
  GM_setValue('gv-key-b', 7);
  var all = GM_getValues();
  var hasA = Object.prototype.hasOwnProperty.call(all, 'gv-key-a');
  var hasB = Object.prototype.hasOwnProperty.call(all, 'gv-key-b');
  GM_deleteValue('gv-key-a');
  var after = GM_getValues();
  document.documentElement.setAttribute('data-demo-getvalues',
    (hasA && hasB ? 'ab' : 'x') + ':' + (Object.prototype.hasOwnProperty.call(after, 'gv-key-a') ? 'still' : 'gone'));
})();
`,
  },
  {
    id: 'demo:clipboard',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Clipboard
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Copies text to the clipboard
// @match        ${main}/document-start
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==
(function () {
  GM_setClipboard('clipboard-demo');
})();
`,
  },
  {
    id: 'demo:notification',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Notification
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Shows a notification with a click callback
// @match        ${main}/document-start
// @grant        GM_notification
// @run-at       document-end
// ==/UserScript==
(function () {
  GM_notification({
    text: 'notify-text',
    title: 'notify-title',
    onclick: function () {
      document.documentElement.setAttribute('data-demo-notification-click', '1');
    }
  });
})();
`,
  },
  {
    id: 'demo:download',
    enabled: true,
    source: (origins) => `// ==UserScript==
// @name         Demo Download
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  GM_download probes
// @match        ${origins.main}/document-start
// @grant        GM_download
// @connect      127.0.0.1
// @run-at       document-end
// ==/UserScript==
(function () {
  var main = '${origins.main}';
  var cross = '${origins.cross}';
  var results = {};
  function dl(details) {
    return new Promise(function (resolve) {
      GM_download(Object.assign({}, details, {
        onload: function () { resolve({ ok: true }); },
        onerror: function () { resolve({ ok: false }); }
      }));
    });
  }
  (async function () {
    results.good = await dl({ url: main + '/download/file.txt', name: 'demo-file.txt' });
    results.denied = await dl({ url: cross + '/download/file.txt', name: 'denied.txt' });
    results.redirectPrivate = await dl({ url: main + '/download/redirect-private', name: 'redirect-private.txt' });
    results.big = await dl({ url: main + '/download/big.bin', name: 'big.bin' });
    results.abort = await new Promise(function (resolve) {
      var d = GM_download({
        url: main + '/download/slow?ms=3000',
        name: 'abort.bin',
        onload: function () { resolve({ ok: true }); },
        onerror: function () { resolve({ ok: false }); }
      });
      setTimeout(function () { d.abort(); }, 100);
    });
    document.documentElement.setAttribute('data-demo-download', JSON.stringify(results));
  })();
})();
`,
  },
  {
    id: 'demo:csp',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo CSP
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Runs under strict CSP
// @match        ${main}/strict-csp
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==
(function () {
  document.documentElement.setAttribute('data-demo-csp', '1');
  var s = document.createElement('style');
  s.setAttribute('data-demo-csp-css', '1');
  document.documentElement.appendChild(s);
  document.documentElement.setAttribute('data-demo-csp-node', JSON.stringify({
    require: typeof require,
    process: typeof process,
    module: typeof module,
    Buffer: typeof Buffer,
    global: typeof global
  }));
})();
`,
  },
  {
    id: 'demo:bridge',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Page-World Bridge
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  unsafeWindow set/call/chain probes through the D5 page bridge
// @match        ${main}/page-world
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==
(function () {
  var setOk = true;
  try { unsafeWindow.__demoSet = 'via-bridge'; } catch (e) { setOk = false; }
  var fnSetOk = true;
  try { unsafeWindow.__demoFn = function () { return 'fn-via-bridge'; }; } catch (e) { fnSetOk = false; }
  var callOk = true;
  try { unsafeWindow.__pageFn('from-userscript'); } catch (e) { callOk = false; }
  var orderOk = true;
  try {
    for (var i = 0; i < 5; i++) unsafeWindow.__pageLog.push('seq-' + i);
  } catch (e) { orderOk = false; }
  var cfg = unsafeWindow.YUI_config;
  var cfgType = typeof cfg;
  var cfgApi = (cfg && cfg.flickr && typeof cfg.flickr.api === 'string') ? String(cfg.flickr.api) : (cfg && cfg.flickr ? 'wrapper' : 'missing');
  var ret = unsafeWindow.__double(21);
  document.documentElement.setAttribute('data-bridge', JSON.stringify({
    setOk: setOk, fnSetOk: fnSetOk, callOk: callOk, orderOk: orderOk,
    cfgType: cfgType, cfgApi: cfgApi,
    retType: typeof ret, retDesc: String(ret).slice(0, 40)
  }));
})();
`,
  },
  {
    id: 'demo:bridge-dead',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo Bridge Fallback
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Page without a bridge: unsafeWindow falls back to the isolated window
// @match        ${main}/strict-csp
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==
(function () {
  try {
    unsafeWindow.__cspBridgeSet = 'leaked-to-isolated-only';
    document.documentElement.setAttribute('data-bridge-dead', '1');
  } catch (e) {
    document.documentElement.setAttribute('data-bridge-dead', '0');
  }
})();
`,
  },
  {
    id: 'demo:spa',
    enabled: true,
    source: ({ main }) => `// ==UserScript==
// @name         Demo SPA Navigation
// @namespace    https://demo.baoflash.local/
// @version      1.0.0
// @description  Counts executions across soft navigation
// @match        ${main}/spa*
// @run-at       document-start
// ==/UserScript==
(function () {
  var count = Number(document.documentElement.getAttribute('data-spa-count') || 0) + 1;
  document.documentElement.setAttribute('data-spa-count', String(count));
})();
`,
  },
];

function installFixtures(origins: { main: string; cross: string }): InstalledUserscript[] {
  const now = Date.now();
  const installed: InstalledUserscript[] = [];
  for (const fixture of fixtureScripts) {
    const source = fixture.source(origins);
    const metadata = parseUserscriptMetadata(source);
    if (!metadata) throw new Error(`fixture ${fixture.id} has no metadata header`);
    installed.push({
      id: fixture.id,
      source,
      enabled: fixture.enabled,
      metadata,
      installedAt: now,
      updatedAt: now,
      revision: 1,
    });
  }
  return installed;
}

// ---------------------------------------------------------------------------
// Per-mode run
// ---------------------------------------------------------------------------

interface PageSnapshot {
  firstScriptSawStartMarker: boolean;
  cspNodeTypes: Record<string, string> | null;
  evilEscapes: Record<string, unknown> | null;
  protoProbe: Record<string, unknown> | null;
  nodeLeak: {
    requireType: string;
    processType: string;
    electronType: string;
    hasProcessKey: boolean;
    hasRequireKey: boolean;
  };
  attrs: Record<string, string | null>;
}

async function pageSnapshot(wc: WebContents): Promise<PageSnapshot> {
  return (await wc.executeJavaScript(`(() => {
    const attr = (name) => document.documentElement.getAttribute(name);
    let cspNodeTypes = null;
    const cspRaw = attr('data-demo-csp-node');
    if (cspRaw) { try { cspNodeTypes = JSON.parse(cspRaw); } catch { cspNodeTypes = null; } }
    let evilEscapes = null;
    const evilRaw = attr('data-demo-evil');
    if (evilRaw) { try { evilEscapes = JSON.parse(evilRaw); } catch { evilEscapes = null; } }
    let protoProbe = null;
    const protoRaw = attr('data-demo-proto');
    if (protoRaw) { try { protoProbe = JSON.parse(protoRaw); } catch { protoProbe = null; } }
    return {
      firstScriptSawStartMarker: Boolean(window.__demoFirstScript && window.__demoFirstScript.sawMarker),
      cspNodeTypes,
      evilEscapes,
      protoProbe,
      nodeLeak: {
        requireType: typeof window.require,
        processType: typeof window.process,
        electronType: typeof window.electron,
        hasProcessKey: 'process' in window,
        hasRequireKey: 'require' in window
      },
      attrs: {
        start: attr('data-demo-start'),
        startCss: document.querySelector('style[data-demo-start-css]') ? '1' : null,
        body: attr('data-demo-body'),
        end: attr('data-demo-end'),
        idle: attr('data-demo-idle'),
        values: attr('data-demo-values'),
        valuesKeys: attr('data-demo-values-keys'),
        valuesFallback: attr('data-demo-values-fallback'),
        legacy: attr('data-demo-legacy'),
        info: attr('data-demo-info'),
        neighbor: attr('data-demo-neighbor'),
        disabled: attr('data-demo-disabled'),
        noframes: attr('data-demo-noframes'),
        iframe: attr('data-demo-iframe'),
        menu: attr('data-demo-menu'),
        menu2: attr('data-demo-menu2'),
        require: attr('data-demo-require'),
        requireConfig: attr('data-demo-require-config'),
        resource: attr('data-demo-resource'),
        resourceUrl: attr('data-demo-resource-url'),
        requireFail: attr('data-demo-require-fail'),
        download: attr('data-demo-download'),
        listener: attr('data-demo-listener'),
        getvalues: attr('data-demo-getvalues'),
        notificationClick: attr('data-demo-notification-click'),
        protoClean: attr('data-demo-proto-clean'),
        protoRaw: attr('data-demo-proto'),
        csp: attr('data-demo-csp'),
        cspCss: document.querySelector('style[data-demo-csp-css]') ? '1' : null,
        styleTarget: document.querySelector('style[data-userscript-style="demo:style"]') ? '1' : null
      }
    };
  })()`, true)) as PageSnapshot;
}

async function loadAndSnapshot(view: BrowserView, mode: Mode, generation: number, url: string): Promise<PageSnapshot> {
  await view.webContents.loadURL(url);
  try {
    await waitForReport(
      (report) => report.accepted && report.mode === mode && report.generation === generation && report.frameUrl === url && report.phase === 'bootstrap',
      `bootstrap for ${url}`,
    );
  } catch (error) {
    console.error(`[userscript-smoke] no bootstrap for ${url}; recent reports:`,
      JSON.stringify(reports.slice(-8).map((r) => ({ phase: r.phase, url: r.frameUrl, wcId: r.wcId, mode: r.mode, generation: r.generation, accepted: r.accepted, scriptId: (r.detail as { scriptId?: string })?.scriptId }))));
    throw error;
  }
  return pageSnapshot(view.webContents);
}

async function runMode(
  host: BrowserWindow,
  mode: Mode,
  generation: number,
  mainOrigin: string,
  crossOrigin: string,
  preloadPath: string,
): Promise<void> {
  if (!manager) throw new Error('manager not initialized');
  const token = `${mode}-token-${generation}`;

  const view = new BrowserView({
    webPreferences: {
      preload: preloadPath,
      plugins: mode === 'ppapi',
      contextIsolation: mode === 'ppapi',
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      spellcheck: false,
      partition: 'persist:userscript-runtime-smoke',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  view.webContents.on('console-message', (_event, level, message) => {
    if (String(message).includes('[userscript-demo]')) console.log(`[wc-console] ${message}`);
  });
  view.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[userscript-smoke] preload-error on ${preloadPath}:`, error?.message ?? String(error));
  });
  view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    // D4 SPA soft navigation: in-page navigations (pushState/replaceState/
    // hashchange) never create a document, so scripts must not re-run. The
    // manager records them for compatibility tooling.
    if (isMainFrame) manager?.spaNavigate(wcId, url, 'in-page');
  });
  const wcId = view.webContents.id;
  wcRegistry.set(wcId, view.webContents);
  manager.registerView(wcId, { mode, generation, token });

  const baseUrl = `${mainOrigin}/document-start`;
  const cspUrl = `${mainOrigin}/strict-csp`;
  const iframesUrl = `${mainOrigin}/iframes`;
  const dynamicIframeUrl = `${mainOrigin}/dynamic-iframe`;

  try {
    // --- main page: scheduling, values, isolation, GM API ------------------
    const snap = await loadAndSnapshot(view, mode, generation, baseUrl);
    const startReport = await waitForReport(
      (r) => r.accepted && r.mode === mode && r.generation === generation
        && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:start'
        && r.frameUrl === baseUrl,
      `${mode} demo:start execution`,
    );
    const startDocId = startReport.documentId;

    const phases = ['demo:start', 'demo:body', 'demo:end', 'demo:idle'];
    await waitForReport(
      (r) => r.accepted && r.mode === mode && r.generation === generation && r.documentId === startDocId
        && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:idle',
      `${mode} demo:idle execution`,
    );
    // Idle scripts run asynchronously after DOMContentLoaded; snapshot again
    // once the idle execution has started so its DOM writes are visible.
    const lateSnap = await pageSnapshot(view.webContents);
    snap.attrs.idle = lateSnap.attrs.idle;
    const phaseIndex = new Map<string, number>();
    reports.forEach((report, index) => {
      if (report.accepted && report.mode === mode && report.generation === generation && report.documentId === startDocId && report.phase === 'script-start') {
        const scriptId = (report.detail as { scriptId?: string })?.scriptId;
        if (scriptId && phases.includes(scriptId) && !phaseIndex.has(scriptId)) phaseIndex.set(scriptId, index);
      }
    });
    const ordered = phases.every((phase, i) => i === 0 || (phaseIndex.get(phase) ?? -1) > (phaseIndex.get(phases[i - 1]) ?? -1));
    addCheck(mode, 'run-at order start < body < end < idle', true, ordered, Object.fromEntries(phaseIndex));

    addCheck(mode, 'document-start marker + style visible', true,
      snap.attrs.start === '1' && snap.attrs.startCss === '1', snap.attrs);
    addCheck(mode, 'document-start marker visible to first page script', true, snap.firstScriptSawStartMarker, { saw: snap.firstScriptSawStartMarker });
    addCheck(mode, 'document-body runs after body exists', true, snap.attrs.body === '1', { body: snap.attrs.body });
    const endReadyState = snap.attrs.end;
    addCheck(mode, 'document-end runs at interactive/complete', true,
      endReadyState === 'interactive' || endReadyState === 'complete', { end: endReadyState });
    const idleReadyState = snap.attrs.idle;
    addCheck(mode, 'document-idle runs at complete', true, idleReadyState === 'complete', { idle: idleReadyState });

    addCheck(mode, 'failing script does not block neighbor or disabled', true,
      snap.attrs.neighbor === '1' && snap.attrs.disabled === null, { neighbor: snap.attrs.neighbor, disabled: snap.attrs.disabled });
    const failReport = reports.find((r) => r.accepted && r.mode === mode && r.generation === generation && r.documentId === startDocId && r.phase === 'script-error' && (r.detail as { scriptId?: string })?.scriptId === 'demo:fail');
    addCheck(mode, 'script error isolated and reported', true,
      Boolean(failReport && /demo-failure/.test(String((failReport.detail as { error?: string })?.error ?? ''))),
      failReport?.detail);

    addCheck(mode, 'GM_addStyle injects stylesheet', true, snap.attrs.styleTarget === '1', snap.attrs.styleTarget);
    addCheck(mode, 'GM_info carries metadata', true,
      snap.attrs.info === 'Demo Info|3.2.1|document-end|BaoFlashBrowser Userscript Demo Runtime|' + mode, snap.attrs.info);

    addCheck(mode, 'GM_getValue/GM_setValue/GM_listValues round trip', true,
      snap.attrs.values === '0:1'
        && (snap.attrs.valuesKeys ?? '').split(',').includes('counter')
        && (snap.attrs.valuesKeys ?? '').split(',').includes('marker')
        && snap.attrs.valuesFallback === 'default-value',
      { values: snap.attrs.values, keys: snap.attrs.valuesKeys, fallback: snap.attrs.valuesFallback });
    addCheck(mode, 'legacy GM_* alias works', true, snap.attrs.legacy === 'legacy-ok', { legacy: snap.attrs.legacy });

    addCheck(mode, 'no Node/Electron globals leaked to page', true,
      Object.values(snap.nodeLeak).every((value) => value === 'undefined' || value === false), snap.nodeLeak);

    // --- menu commands (two scripts, ids must not collide) ------------------
    for (const scriptId of ['demo:menu', 'demo:menu2']) {
      await waitForReport(
        (r) => r.accepted && r.mode === mode && r.generation === generation && r.documentId === startDocId
          && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === scriptId,
        `${mode} ${scriptId} registered`,
      );
    }
    const commands = manager.commandsFor(wcId);
    const demoCommand = commands.find((command) => command.title === 'Demo Command');
    const demoCommand2 = commands.find((command) => command.title === 'Demo Command Two');
    const commandIdsAreScoped = commands.length === 2
      && commands.every((command) => command.documentId === startDocId && command.commandId.startsWith(startDocId + ':'));
    addCheck(mode, 'two menu commands coexist with unique scoped ids', true,
      Boolean(demoCommand && demoCommand2 && commandIdsAreScoped), commands);
    if (demoCommand) {
      view.webContents.send('userscript:menu-invoke', { commandId: demoCommand.commandId, documentId: startDocId });
      await waitForReport(
        (r) => r.accepted && r.mode === mode && r.generation === generation && r.phase === 'menu-command-invoked'
          && (r.detail as { commandId?: string })?.commandId === demoCommand.commandId,
        `${mode} menu command one callback`,
      );
      addCheck(mode, 'first menu command callback writes its own value', true,
        manager.getValueSnapshot().get('demo:menu', 'menu-fired') === true
        && manager.getValueSnapshot().get('demo:menu2', 'menu2-fired') === undefined, undefined);
    } else {
      addCheck(mode, 'first menu command callback writes its own value', true, false, 'no command registered');
    }
    if (demoCommand2) {
      view.webContents.send('userscript:menu-invoke', { commandId: demoCommand2.commandId, documentId: startDocId });
      await waitForReport(
        (r) => r.accepted && r.mode === mode && r.generation === generation && r.phase === 'menu-command-invoked'
          && (r.detail as { commandId?: string })?.commandId === demoCommand2.commandId,
        `${mode} menu command two callback`,
      );
      addCheck(mode, 'second menu command callback writes its own value', true,
        manager.getValueSnapshot().get('demo:menu2', 'menu2-fired') === true, undefined);
    } else {
      addCheck(mode, 'second menu command callback writes its own value', true, false, 'no command registered');
    }

    // --- Node escape probes must all fail -----------------------------------
    await waitForReport(
      (r) => r.accepted && r.mode === mode && r.generation === generation && r.documentId === startDocId
        && r.phase === 'script-complete' && (r.detail as { scriptId?: string })?.scriptId === 'demo:evil',
      `${mode} demo:evil escape probe`,
    );
    const evilSnap = await pageSnapshot(view.webContents);
    const escapes = evilSnap.evilEscapes ?? {};
    const safeValue = (value: unknown): boolean =>
      value === 'undefined' || value === false || value === 'no-ctor'
      || (typeof value === 'string' && value.startsWith('blocked:'));
    const allEscapesSafe = Object.entries(escapes)
      .filter(([key]) => key !== 'fnCtorThis') // diagnostic: confirms page-world this
      .every(([, value]) => safeValue(value) && !(typeof value === 'string' && /process|global|require|module|Buffer/i.test(value)));
    addCheck(mode, 'Node escape paths fail (ctor chain, eval, Function)', true,
      allEscapesSafe && escapes.direct === 'undefined' && escapes.windowRequire === 'undefined'
        && escapes.globalProcess === 'undefined' && escapes.globalRequire === 'undefined',
      escapes);

    // --- prototype pollution and GM function constructor chains --------------
    await waitForReport(
      (r) => r.accepted && r.mode === mode && r.generation === generation && r.documentId === startDocId
        && r.phase === 'script-complete' && (r.detail as { scriptId?: string })?.scriptId === 'demo:proto-clean',
      `${mode} demo:proto-clean`,
    );
    const protoSnap = await pageSnapshot(view.webContents);
    const proto = protoSnap.protoProbe ?? {};
    const protoSafe = (value: unknown): boolean =>
      value === 'undefined' || value === 'no-fn' || value === true
      || (typeof value === 'string' && value.startsWith('blocked:'));
    const protoEscapeSafe = protoSafe(proto.protoEscape)
      && !(typeof proto.protoEscape === 'string' && /process|global|require|module|Buffer/i.test(proto.protoEscape));
    const gmCtorSafe = protoSafe(proto.gmCtorChain) && protoSafe(proto.gmCtorProtoChain)
      && !(typeof proto.gmCtorChain === 'string' && /process|global|require|module|Buffer/i.test(proto.gmCtorChain))
      && !(typeof proto.gmCtorProtoChain === 'string' && /process|global|require|module|Buffer/i.test(proto.gmCtorProtoChain));
    addCheck(mode, 'prototype pollution getter cannot reach Node', true, protoEscapeSafe, proto);
    addCheck(mode, 'GM function constructor chains cannot reach Node', true, gmCtorSafe, proto);
    addCheck(mode, 'page prototype left clean after pollution probe', true,
      protoSnap.attrs.protoClean === 'clean', { protoClean: protoSnap.attrs.protoClean });

    // --- GM_xmlhttpRequest ----------------------------------------------------
    const xhrRaw = await waitForAttr(view.webContents, 'data-demo-xhr', 30000);
    const xhr = JSON.parse(xhrRaw) as Record<string, unknown>;
    const xhrBody = (value: unknown): { ok: boolean; status: number; body: string } =>
      (typeof value === 'object' && value !== null ? value : { ok: false, status: 0, body: '' }) as { ok: boolean; status: number; body: string };
    const parseEcho = (value: unknown): { ok: boolean; cookie?: string; hasAuthorization?: boolean; headers?: Record<string, string> } => {
      try {
        return JSON.parse(xhrBody(value).body) as { ok: boolean; cookie?: string; hasAuthorization?: boolean; headers?: Record<string, string> };
      } catch {
        return { ok: false };
      }
    };
    const xhrError = (value: unknown): string | undefined =>
      (typeof value === 'object' && value !== null ? (value as { error?: string }).error : undefined);

    const sameEcho = parseEcho(xhr.sameOrigin);
    addCheck(mode, 'GM_xmlhttpRequest same-origin GET', true,
      xhrBody(xhr.sameOrigin).ok === true && sameEcho.ok === true, xhr.sameOrigin);
    addCheck(mode, 'GM_xmlhttpRequest follows persist session cookies', true,
      Boolean(sameEcho.cookie?.includes('demo-cookie=cookie-ok')), sameEcho.cookie);

    addCheck(mode, '@connect authorizes cross-origin host', true,
      xhrBody(xhr.crossAuthorized).ok === true && xhrError(xhr.crossAuthorized) === undefined, xhr.crossAuthorized);
    addCheck(mode, '@connect denies unlisted host', true,
      xhrError(xhr.crossDenied) === 'connect-denied', xhr.crossDenied);
    addCheck(mode, 'private addresses blocked by default', true,
      xhrError(xhr.privateBlocked) === 'address-blocked', xhr.privateBlocked);

    const headerEcho = parseEcho(xhr.headerFilter);
    addCheck(mode, 'sensitive request headers stripped', true,
      headerEcho.ok === true && headerEcho.hasAuthorization === false
        && !(headerEcho.cookie ?? '').includes('x=1')
        && headerEcho.headers?.['x-custom'] === 'kept',
      { authorization: headerEcho.hasAuthorization, cookie: headerEcho.cookie, headers: headerEcho.headers });

    addCheck(mode, 'redirects followed within limit', true,
      xhrBody(xhr.redirectTwo).ok === true && xhrBody(xhr.redirectTwo).body === 'redirect-final', xhr.redirectTwo);
    addCheck(mode, 'redirect chains beyond limit aborted', true,
      xhrError(xhr.redirectLoop) === 'redirect-limit', xhr.redirectLoop);
    addCheck(mode, 'redirect target address is revalidated', true,
      xhrError(xhr.redirectPrivate) === 'address-blocked', xhr.redirectPrivate);
    addCheck(mode, 'responses above size cap aborted', true,
      xhrError(xhr.bigBlocked) === 'size-limit', xhr.bigBlocked);
    addCheck(mode, 'slow responses hit the timeout', true,
      xhrError(xhr.timeout) === 'timeout', xhr.timeout);
    addCheck(mode, 'json responseType parses the payload', true,
      xhrBody(xhr.jsonType).ok === true && xhrBody(xhr.jsonType).body.includes('"n":42'), xhr.jsonType);
    addCheck(mode, 'xhr.abort() cancels in-flight requests', true,
      xhrError(xhr.abort) === 'aborted', xhr.abort);
    const concurrency = Array.isArray(xhr.concurrency) ? xhr.concurrency.map(String) : [];
    addCheck(mode, 'per-script concurrency limit enforced', true,
      concurrency.filter((e) => e === 'ok').length === 2
        && concurrency.filter((e) => e === 'concurrency-limit').length === 1,
      xhr.concurrency);

    // --- @require / @resource ------------------------------------------------
    const requireSnap = await pageSnapshot(view.webContents);
    addCheck(mode, '@require libraries expand and share scope', true,
      requireSnap.attrs.require === '27:27', requireSnap.attrs.require);
    addCheck(mode, '@require library code can call GM APIs', true,
      requireSnap.attrs.requireConfig === 'none:config-ok', requireSnap.attrs.requireConfig);
    addCheck(mode, '@resource text and data url', true,
      requireSnap.attrs.resource === 'hello-resource'
        && (requireSnap.attrs.resourceUrl ?? '').startsWith('data:text/plain;charset=utf-8;base64,'),
      { text: requireSnap.attrs.resource, url: requireSnap.attrs.resourceUrl });
    const requireFailRan = reports.some((r) => r.accepted && r.mode === mode && r.generation === generation
      && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:require-fail');
    addCheck(mode, 'missing @require skips the script', true,
      !requireFailRan && requireSnap.attrs.requireFail === null
        && (manager?.getRequireGaps('demo:require-fail') ?? []).some((u) => u.includes('/require/missing.js')),
      { ran: requireFailRan, attr: requireSnap.attrs.requireFail, gaps: manager?.getRequireGaps('demo:require-fail') });
    addCheck('lifecycle', '@require fetched once and cached across modes', true,
      (requireRequests['/require/lib-a.js'] ?? 0) === 1, requireRequests);

    // --- value listeners / getValues / clipboard / notification ----------------
    addCheck(mode, 'GM_addValueChangeListener fires locally on setValue', true,
      requireSnap.attrs.listener === 'local-hello:false', requireSnap.attrs.listener);
    addCheck(mode, 'GM_getValues returns all values and reflects deletes', true,
      requireSnap.attrs.getvalues === 'ab:gone', requireSnap.attrs.getvalues);

    // --- GM_download -----------------------------------------------------------
    const downloadRaw = await waitForAttr(view.webContents, 'data-demo-download', 30000);
    const dl = JSON.parse(downloadRaw) as Record<string, { ok: boolean }>;
    const goodFile = path.join(downloadDir, 'demo-file.txt');
    const goodContent = existsSync(goodFile) ? readFileSync(goodFile, 'utf8') : '';
    addCheck(mode, 'GM_download saves the file with correct content', true,
      dl.good?.ok === true && goodContent === 'download-content-123',
      { ok: dl.good?.ok, content: goodContent.slice(0, 40) });
    addCheck(mode, 'GM_download denied without @connect', true,
      dl.denied?.ok === false, dl.denied);
    addCheck(mode, 'GM_download redirect target is revalidated', true,
      dl.redirectPrivate?.ok === false, dl.redirectPrivate);
    addCheck(mode, 'GM_download aborted above the size cap', true,
      dl.big?.ok === false, dl.big);
    addCheck(mode, 'GM_download abort cancels and fires onerror', true,
      dl.abort?.ok === false, dl.abort);

    const clipboardText = clipboard.readText();
    addCheck(mode, 'GM_setClipboard copies to the system clipboard', true,
      clipboardText === 'clipboard-demo', clipboardText);

    const notification = manager?.getNotifications().find((n) => n.text === 'notify-text');
    addCheck(mode, 'GM_notification recorded with text and title', true,
      Boolean(notification && notification.title === 'notify-title'), manager?.getNotifications());
    if (notification) {
      manager?.triggerNotification(wcId, notification.notificationId);
      const clickRaw = await waitForAttr(view.webContents, 'data-demo-notification-click', 10000);
      addCheck(mode, 'notification click callback fires', true, clickRaw === '1', clickRaw);
    } else {
      addCheck(mode, 'notification click callback fires', true, false, 'no notification recorded');
    }

    // --- GM_openInTab -------------------------------------------------------
    const opened = manager.getOpenTabs().find((entry) => entry.scriptId === 'demo:open');
    addCheck(mode, 'GM_openInTab recorded by main', true, Boolean(opened), opened);

    // --- iframes ------------------------------------------------------------
    await view.webContents.loadURL(iframesUrl);
    for (const [kind, url] of [['same', `${mainOrigin}/frame-child?kind=same`], ['cross', `${crossOrigin}/frame-child?kind=cross`]] as const) {
      await waitForReport(
        (r) => r.accepted && r.mode === mode && r.generation === generation && r.frameUrl === url
          && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:iframe',
        `${mode} ${kind}-origin iframe userscript`,
      );
      const iframeRun = reports.filter((r) => r.accepted && r.mode === mode && r.generation === generation
        && r.frameUrl === url && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:iframe');
      addCheck(mode, `${kind}-origin iframe script runs once`, true,
        iframeRun.length === 1 && iframeRun.every((r) => !r.isMainFrame), iframeRun);
    }

    await view.webContents.loadURL(dynamicIframeUrl);
    const dynamicRun = await waitForReport(
      (r) => r.accepted && r.mode === mode && r.generation === generation
        && r.frameUrl === `${mainOrigin}/frame-child?kind=dynamic` && r.phase === 'script-start'
        && (r.detail as { scriptId?: string })?.scriptId === 'demo:iframe',
      `${mode} dynamic iframe userscript`,
    );
    addCheck(mode, 'dynamic iframe preload + script', true, !dynamicRun.isMainFrame, dynamicRun);

    // --- noframes -----------------------------------------------------------
    const noframesInFrame = reports.some((r) => r.accepted && r.mode === mode && r.generation === generation
      && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:noframes'
      && !r.isMainFrame);
    const noframesOnMain = reports.some((r) => r.accepted && r.mode === mode && r.generation === generation
      && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:noframes'
      && r.isMainFrame && r.frameUrl === baseUrl);
    addCheck(mode, '@noframes skips subframes', true, !noframesInFrame && noframesOnMain,
      { noframesInFrame, noframesOnMain });

    // --- strict CSP ----------------------------------------------------------
    const cspSnap = await loadAndSnapshot(view, mode, generation, cspUrl);
    const cspComplete = reports.filter((r) => r.accepted && r.mode === mode && r.generation === generation
      && r.phase === 'script-complete' && (r.detail as { scriptId?: string })?.scriptId === 'demo:csp');
    const usedVmFallback = cspComplete.some((r) => Boolean((r.detail as { usedVmFallback?: boolean })?.usedVmFallback));
    addCheck(mode, 'strict CSP isolated DOM + style', true, cspSnap.attrs.csp === '1' && cspSnap.attrs.cspCss === '1', cspSnap.attrs);
    addCheck(mode, 'strict CSP script has no Node access', true,
      Boolean(cspSnap.cspNodeTypes) && Object.values(cspSnap.cspNodeTypes || {}).every((value) => value === 'undefined'),
      cspSnap.cspNodeTypes);
    addCheck(mode, `strict CSP execution strategy (vm fallback: ${mode === 'ruffle'})`, true,
      cspComplete.length === 1 && usedVmFallback === (mode === 'ruffle'), { cspComplete: cspComplete.length, usedVmFallback });

    // --- reload: identity + values persist ----------------------------------
    const reloadSnap = await loadAndSnapshot(view, mode, generation, baseUrl);
    const reloadStart = reports.filter((r) => r.accepted && r.mode === mode && r.generation === generation
      && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:start'
      && r.frameUrl === baseUrl);
    const reloadDocIds = new Set(reloadStart.map((r) => r.documentId));
    addCheck('lifecycle', `${mode} one execution per document across reload`, true,
      reloadStart.length === 2 && reloadDocIds.size === 2
        && reloadStart.every((r) => r.wcId === wcId),
      reloadStart.map((r) => r.documentId));
    addCheck(mode, 'values persist across reload', true,
      reloadSnap.attrs.values === '1:2', { values: reloadSnap.attrs.values });

    // --- stale generation rejection -----------------------------------------
    const lateProbeDocId = reloadStart[1]?.documentId ?? '';
    view.webContents.send('userscript:probe-late', 150);
    manager.registerView(wcId, { mode, generation: generation + 1, token: `${token}-next` });
    const stale = await waitForReport(
      (r) => r.mode === mode && r.phase === 'delayed-probe' && r.documentId === lateProbeDocId,
      `${mode} stale generation report`,
    );
    addCheck('lifecycle', `${mode} stale generation rejected`, true, !stale.accepted, stale);

    // --- cross-view value change broadcast ------------------------------------
    // Deliberately runs after the reload/stale assertions: the second view
    // executes the shared fixtures too, which would otherwise perturb the
    // reload counters and the stale-generation documentId lookup.
    const secondView = new BrowserView({
      webPreferences: {
        preload: preloadPath,
        plugins: mode === 'ppapi',
        contextIsolation: mode === 'ppapi',
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        spellcheck: false,
        partition: 'persist:userscript-runtime-smoke',
      },
    });
    host.addBrowserView(secondView);
    secondView.setBounds({ x: 0, y: 0, width: 900, height: 700 });
    const secondWcId = secondView.webContents.id;
    wcRegistry.set(secondWcId, secondView.webContents);
    manager?.registerView(secondWcId, { mode, generation, token: `${token}-second` });
    try {
      await loadAndSnapshot(secondView, mode, generation, baseUrl);
      await waitForReport(
        (r) => r.accepted && r.mode === mode && r.generation === generation && r.wcId === secondWcId
          && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:listener',
        `${mode} second view listener registration`,
      );
      manager?.setValue(wcId, 'demo:listener', 'listen-key', 'remote-hello');
      const remoteRaw = await waitForAttr(secondView.webContents, 'data-demo-listener', 10000);
      addCheck('lifecycle', `${mode} cross-view value change broadcast (remote=true)`, true,
        remoteRaw === 'remote-hello:true', remoteRaw);
      // The second view also runs the shared xhr fixtures; wait for its async
      // probes to finish so the teardown cancellation test below sees a free
      // per-script concurrency slot.
      await waitForAttr(secondView.webContents, 'data-demo-xhr', 15000).catch(() => null);
    } finally {
      wcRegistry.delete(secondWcId);
      manager?.unregisterView(secondWcId);
      host.removeBrowserView(secondView);
      try { (secondView.webContents as unknown as { destroy(): void }).destroy(); } catch { /* cleanup */ }
    }

    // --- D5 page-world bridge (unsafeWindow) --------------------------------
    // Runs AFTER all checks that depend on the /document-start page: the bridge
    // checks navigate the view to /page-world and /strict-csp. The reload
    // check above re-registered the main view with generation + 1; keep that.
    const bridgeGeneration = generation + 1;
    manager?.registerView(wcId, { mode, generation: bridgeGeneration, token: `${token}-bridge` });
    const bridgeUrl = `${mainOrigin}/page-world`;
    await loadAndSnapshot(view, mode, bridgeGeneration, bridgeUrl);
    await waitForReport(
      (r) => r.accepted && r.mode === mode && r.generation === bridgeGeneration
        && r.phase === 'script-complete' && (r.detail as { scriptId?: string })?.scriptId === 'demo:bridge',
      `${mode} demo:bridge execution`,
    );
    const bridgeDone = await waitForAttr(view.webContents, 'data-bridge');
    const bridge = JSON.parse(bridgeDone) as Record<string, unknown>;
    const bridgeMain = (await view.webContents.executeJavaScript(`(() => ({
      bridgeType: typeof window.${BRIDGE_MARKER},
      setValue: window.__demoSet,
      log: window.__pageLog,
      fnType: typeof window.__demoFn,
      fnResult: typeof window.__demoFn === 'function' ? window.__demoFn() : null,
      diag: window.__bfDiag,
    }))()`, true).catch(() => null)) as {
      bridgeType: string; setValue: unknown; log: unknown; fnType: string; fnResult: unknown; diag: unknown;
    } | null;
    const bridgeLog = Array.isArray(bridgeMain?.log) ? bridgeMain.log : [];
    addCheck(mode, 'page bridge script registered in main world', true,
      bridgeMain?.bridgeType === 'object', { bridgeType: bridgeMain?.bridgeType });
    addCheck(mode, 'unsafeWindow set reaches the page world', true,
      bridgeMain?.setValue === 'via-bridge', { setValue: bridgeMain?.setValue, diag: bridgeMain?.diag });
    addCheck(mode, 'unsafeWindow call reaches the page world in order', true,
      bridgeLog.join(',') === 'from-userscript,seq-0,seq-1,seq-2,seq-3,seq-4', bridgeLog);
    addCheck(mode, 'unsafeWindow function value becomes callable in page world', true,
      bridgeMain?.fnType === 'function' && bridgeMain?.fnResult === 'fn-via-bridge',
      { fnType: bridgeMain?.fnType, fnResult: bridgeMain?.fnResult });
    const chainOk = bridge?.setOk === true && bridge?.fnSetOk === true && bridge?.callOk === true && bridge?.orderOk === true;
    addCheck(mode, 'unsafeWindow operations complete without throwing', true, chainOk === true, bridge);
    const cfgType = String(bridge?.cfgType ?? '');
    const cfgApi = String(bridge?.cfgApi ?? '');
    addCheck(mode, 'unsafeWindow read stays chainable wrapper (ppapi) / live object (ruffle)', true,
      (cfgType === 'function' || cfgType === 'object')
      && (mode === 'ppapi' ? cfgApi === 'wrapper' : cfgApi === 'secret-key'),
      { cfgType, cfgApi });
    addCheck(mode, 'unsafeWindow call result synchronously usable per mode', true,
      String(bridge?.retType ?? '') === (mode === 'ppapi' ? 'function' : 'number'),
      { retType: bridge?.retType, retDesc: bridge?.retDesc });

    // --- D5 fallback: pages without a bridge ---------------------------------
    await loadAndSnapshot(view, mode, bridgeGeneration, `${mainOrigin}/strict-csp`);
    await waitForReport(
      (r) => r.accepted && r.mode === mode && r.generation === bridgeGeneration
        && r.phase === 'script-complete' && (r.detail as { scriptId?: string })?.scriptId === 'demo:bridge-dead',
      `${mode} demo:bridge-dead execution`,
    );
    const deadMarker = await waitForAttr(view.webContents, 'data-bridge-dead');
    const deadProbe = (await view.webContents.executeJavaScript(`(() => ({
      mainWorld: window.__cspBridgeSet,
      bridgeType: typeof window.${BRIDGE_MARKER},
    }))()`, true).catch(() => null)) as { mainWorld: unknown; bridgeType: string } | null;
    addCheck(mode, 'unsafeWindow on bridgeless page stays isolated (ppapi) / shared (ruffle)', true,
      deadMarker === '1'
      && (mode === 'ppapi'
        ? deadProbe?.bridgeType === 'undefined' ? deadProbe?.mainWorld === undefined : true
        : deadProbe?.mainWorld === 'leaked-to-isolated-only'),
      { deadMarker, mainWorld: deadProbe?.mainWorld, bridgeType: deadProbe?.bridgeType });

    // --- D4 SPA soft navigation ---------------------------------------------
    // The /spa page performs pushState, pushState, replaceState and a hash
    // change after load. Soft navigation must be recorded but must NOT re-run
    // scripts (no new document is created).
    await loadAndSnapshot(view, mode, bridgeGeneration, `${mainOrigin}/spa`);
    await waitForReport(
      (r) => r.accepted && r.mode === mode && r.generation === bridgeGeneration
        && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:spa',
      `${mode} demo:spa execution`,
    );
    const spaStarts = reports.filter((r) => r.accepted && r.mode === mode && r.generation === bridgeGeneration
      && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:spa');
    const spaCount = await waitForAttr(view.webContents, 'data-spa-count');
    const spaDeadline = Date.now() + 5000;
    let navs: Array<{ wcId: number; url: string; reason: string }> = [];
    while (Date.now() < spaDeadline) {
      navs = (manager?.getSpaNavigations() ?? []).filter((n) => n.wcId === wcId);
      if (navs.length >= 4) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const navUrls = navs.map((n) => n.url);
    addCheck(mode, 'SPA soft navigations recorded (pushState/replaceState/hash)', true,
      navs.length >= 4
      && navUrls.some((u) => u.endsWith('/spa/one'))
      && navUrls.some((u) => u.endsWith('/spa/two'))
      && navUrls.some((u) => u.endsWith('/spa/three'))
      && navUrls.some((u) => u.endsWith('#four')),
      navUrls);
    addCheck(mode, 'SPA soft navigation does not re-run scripts', true,
      spaStarts.length === 1 && spaCount === '1', { starts: spaStarts.length, count: spaCount });

    // --- suspend/resume simulation: view destroyed and recreated -------------
    const suspendGeneration = generation + 2;
    const pendingWcCancel = requestService.request(
      wcId,
      'demo:xhr',
      baseUrl,
      ['127.0.0.1'],
      { method: 'GET', url: `${mainOrigin}/xhr/slow?ms=3000`, timeout: 10000 },
      9000001,
    );
    // Wait for the connection to establish: Electron 11's net.request ignores
    // abort() before the connection exists (in-flight cancellation is covered
    // by the xhr.abort() probe above).
    await new Promise((resolve) => setTimeout(resolve, 200));
    manager.unregisterView(wcId);
    wcRegistry.delete(wcId);
    requestService.cancelForWc(wcId);
    const pendingWcResult = await pendingWcCancel;
    addCheck('lifecycle', `${mode} pending requests cancelled on view teardown`, true,
      requestService.getActiveCount() === 0 && !pendingWcResult.ok && pendingWcResult.error !== undefined,
      pendingWcResult);
    host.removeBrowserView(view);
    try { (view.webContents as unknown as { destroy(): void }).destroy(); } catch { /* cleanup */ }

    const recreated = new BrowserView({
      webPreferences: {
        preload: preloadPath,
        plugins: mode === 'ppapi',
        contextIsolation: mode === 'ppapi',
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        spellcheck: false,
        partition: 'persist:userscript-runtime-smoke',
      },
    });
    host.addBrowserView(recreated);
    recreated.setBounds({ x: 0, y: 0, width: 900, height: 700 });
    const recreatedWcId = recreated.webContents.id;
    manager.registerView(recreatedWcId, { mode, generation: suspendGeneration, token: `${token}-resumed` });
    const resumeSnap = await loadAndSnapshot(recreated, mode, suspendGeneration, baseUrl);
    const resumeStart = reports.filter((r) => r.accepted && r.mode === mode && r.generation === suspendGeneration
      && r.phase === 'script-start' && (r.detail as { scriptId?: string })?.scriptId === 'demo:start');
    addCheck('lifecycle', `${mode} recreated view executes exactly once`, true,
      resumeStart.length === 1 && resumeSnap.attrs.start === '1', resumeStart.map((r) => r.documentId));

    manager.unregisterView(recreatedWcId);
    host.removeBrowserView(recreated);
    try { (recreated.webContents as unknown as { destroy(): void }).destroy(); } catch { /* cleanup */ }
  } catch (error) {
    addCheck(mode, `${mode} run completed without harness failure`, true, false, String(error));
  } finally {
    manager?.unregisterView(wcId);
    wcRegistry.delete(wcId);
    requestService?.cancelForWc(wcId);
    downloadService?.cancelForWc(wcId);
    host.removeBrowserView(view);
    try { (view.webContents as unknown as { destroy(): void }).destroy(); } catch { /* cleanup */ }
  }
}

// ---------------------------------------------------------------------------
// Real-script compatibility run (D6): installs the downloaded .user.js files
// as-is, executes them on a fixture page, and classifies the result.
// ---------------------------------------------------------------------------

interface RealScriptVerdict {
  kind: 'PASS' | 'PARTIAL' | 'FAIL-API' | 'FAIL-NET' | 'FAIL-R';
  detail: string;
}

// mpiv is excluded from the auto-run list: on Chromium 87 the 130KB
// document-start script crashes the MAIN process natively (verified in both
// engine modes and confirmed unrelated to the userscript runtime). It is
// recorded as FAIL-C87 below so the rest of the smoke stays alive.
const REAL_SCRIPTS: Array<{ file: string; requireRewrite: boolean }> = [
  { file: 'mouse-gestures.user.js', requireRewrite: false },
  { file: 'switch-zh-simplified-traditional.user.js', requireRewrite: false },
  { file: 'picviewer-ce.user.js', requireRewrite: true },
];

function classifyRealError(error: string | undefined, gaps: string[]): RealScriptVerdict {
  const message = String(error ?? '');
  if (gaps.length > 0) return { kind: 'FAIL-NET', detail: `require unavailable: ${gaps.join(', ')}` };
  if (/is not a function|is not defined|undefined is not a function/.test(message)) {
    return { kind: 'FAIL-API', detail: message.slice(0, 200) };
  }
  return { kind: 'FAIL-R', detail: message.slice(0, 200) };
}

async function runRealScript(host: BrowserWindow, mainOrigin: string, preloadPath: string, item: { file: string; requireRewrite: boolean }): Promise<void> {
  const label = item.file;
  console.log(`[userscript-smoke] stage: real ${label}`);
  const fixturesDir = path.join(__dirname, '..', '..', 'tests', 'electron', 'fixtures');
  let source: string;
  try {
    source = readFileSync(path.join(fixturesDir, item.file), 'utf8');
  } catch (error) {
    addCheck('real', `real: ${label}`, false, false, { verdict: 'FAIL-NET', detail: String(error) });
    return;
  }
  const metadata = parseUserscriptMetadata(source);
  if (!metadata) {
    addCheck('real', `real: ${label}`, false, false, { verdict: 'FAIL-R', detail: 'metadata parse failed' });
    return;
  }
  if (item.requireRewrite) {
    metadata.require = metadata.require.map((url) => {
      if (url.includes('GM_config')) return `${mainOrigin}/real-lib/gm-config.js`;
      if (url.includes('pvcep_rules')) return `${mainOrigin}/real-lib/pvcep_rules.js`;
      if (url.includes('pvcep_lang')) return `${mainOrigin}/real-lib/pvcep_lang.js`;
      return url;
    });
  }

  const realManager = new UserscriptManager(new ValueStore(), {
    requireCache: requireCache ?? undefined,
    sendToWc: (wcId, channel, payload) => {
      try { wcRegistry.get(wcId)?.send(channel, payload); } catch { /* view gone */ }
    },
  });
  realManager.registerView(9999, { mode: 'ppapi', generation: 99, token: 'real' });
  realManager.loadScripts([{
    id: 'real',
    source,
    enabled: true,
    metadata,
    installedAt: 0,
    updatedAt: 0,
    revision: 1,
  }]);
  await realManager.ensureRequires();

  // The shared IPC handlers resolve the active manager via realManagerRef
  // while this real script runs so its frames get a snapshot and its reports
  // are accepted.
  realManagerRef = realManager;

  const view = new BrowserView({
    webPreferences: {
      preload: preloadPath,
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      spellcheck: false,
      partition: 'persist:userscript-runtime-smoke',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  const wc = view.webContents;
  wcRegistry.set(wc.id, wc);
  realManager.registerView(wc.id, { mode: 'ppapi', generation: 99, token: 'real' });

  try {
    await wc.loadURL(`${mainOrigin}/real`);
    const deadline = Date.now() + 25000;
    let verdict: RealScriptVerdict | null = null;
    while (Date.now() < deadline) {
      const errorReport = reports.find((r) => r.wcId === wc.id && r.phase === 'script-error' && (r.detail as { scriptId?: string })?.scriptId === 'real');
      if (errorReport) {
        verdict = classifyRealError((errorReport.detail as { error?: string })?.error, realManager.getRequireGaps('real'));
        break;
      }
      const done = reports.find((r) => r.wcId === wc.id && r.phase === 'script-complete' && (r.detail as { scriptId?: string })?.scriptId === 'real');
      if (done) {
        verdict = { kind: 'RUN', detail: '' };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!verdict) {
      const probe = realManager.snapshotFor(wc.id, `${mainOrigin}/real`, true);
      const skipped = probe.scripts.length === 0;
      addCheck('real', `real: ${label}`, false, false, {
        verdict: 'FAIL-R',
        detail: skipped
          ? 'script excluded from the document snapshot (expanded @require source exceeds the per-page budget, or requires unavailable)'
          : 'no execution report within 25s',
      });
      return;
    }
    if (verdict.kind === 'RUN') {
      // The page bridge applies unsafeWindow set/call asynchronously (message
      // round-trip), so poll the page world for observable side effects.
      const deadline = Date.now() + 3000;
      let side: {
        scriptStyles: number; bodyText: string; globalHits: string[]; tc2scType: string; sc2tcType: string; bridgeType: string;
      } | null = null;
      while (Date.now() < deadline) {
        const raw = await wc.executeJavaScript(`(() => ({
          scriptStyles: document.querySelectorAll('style[data-userscript-style]').length,
          bodyText: document.body ? document.body.textContent.slice(0, 200) : '',
          globalHits: Object.keys(window).filter((k) => /mpiv|pvcep|pv_|gesture|zh-|config|GM_config|tc2sc|sc2tc/i.test(k)).slice(0, 20),
          tc2scType: typeof window.tc2sc,
          sc2tcType: typeof window.sc2tc,
          bridgeType: typeof window.${BRIDGE_MARKER}
        }))()`, true).catch(() => null);
        side = raw as typeof side;
        if (side && (side.scriptStyles > 0 || side.globalHits.length > 0 || side.bodyText.includes('简体')
          || side.tc2scType === 'function' || side.sc2tcType === 'function')) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const s = side ?? { scriptStyles: 0, bodyText: '', globalHits: [], tc2scType: 'undefined', sc2tcType: 'undefined', bridgeType: 'undefined' };
      // D5: switch-zh exposes tc2sc/sc2tc on the page world through
      // _unsafeWindow — visible only when the page bridge works.
      if (s.scriptStyles > 0 || s.globalHits.length > 0 || s.bodyText.includes('简体')
        || s.tc2scType === 'function' || s.sc2tcType === 'function') {
        verdict = { kind: 'PASS', detail: `styles=${s.scriptStyles} globals=${s.globalHits.length} tc2sc=${s.tc2scType} sc2tc=${s.sc2tcType} bridge=${s.bridgeType}` };
      } else {
        verdict = { kind: 'PARTIAL', detail: `executed without error; no observable side effect on the fixture page (bridge=${s.bridgeType})` };
      }
    }
    addCheck('real', `real: ${label}`, false, verdict.kind === 'PASS', { verdict: verdict.kind, detail: verdict.detail });
  } catch (error) {
    addCheck('real', `real: ${label}`, false, false, { verdict: 'FAIL-R', detail: String(error) });
  } finally {
    realManagerRef = null;
    wcRegistry.delete(wc.id);
    realManager.unregisterView(wc.id);
    realManager.unregisterView(9999);
    host.removeBrowserView(view);
    try { (view.webContents as unknown as { destroy(): void }).destroy(); } catch { /* cleanup */ }
  }
}

async function runRealScripts(host: BrowserWindow, mainOrigin: string, preloadPath: string): Promise<void> {
  // Real-script results are compatibility classifications (records), not
  // mechanism checks — FAIL-C87 / PARTIAL (interaction) / FAIL-R (size
  // budget) are expected outcomes, so they are optional checks that never
  // block the smoke.
  addCheck('real', 'real: mpiv.user.js', false, false, {
    verdict: 'FAIL-C87',
    detail: 'Chromium 87 native main-process crash when executing the 130KB document-start script (verified in both ppapi and ruffle modes; unrelated to the runtime). Skipped to keep the smoke alive.',
  });
  for (const item of REAL_SCRIPTS) {
    await runRealScript(host, mainOrigin, preloadPath, item);
  }
}

// ---------------------------------------------------------------------------
// D5 bridge injection rehearsal: the real product registers the page bridge
// from the preload via webFrame.executeJavaScript (main world). CDP
// Page.addScriptToEvaluateOnNewDocument was tried first and does NOT work:
// registrations are session-bound and removed when the debugger detaches, and
// keeping the debugger attached freezes navigation (AGENTS.md). This check
// loads a page WITHOUT an inline bridge and asserts the preload injection put
// the bridge into the main world and that page load events still fire.
// ---------------------------------------------------------------------------

async function runBridgeInjectCheck(host: BrowserWindow, mainOrigin: string, preloadPath: string): Promise<void> {
  console.log('[userscript-smoke] stage: bridge-inject check');
  const view = new BrowserView({
    webPreferences: {
      preload: preloadPath,
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      partition: 'persist:userscript-runtime-smoke',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  const wc = view.webContents;
  // The preload only injects the bridge when its get-config snapshot is ok, so
  // this view needs a manager registration like every other view.
  const injectManager = new UserscriptManager(new ValueStore(), { sendToWc: () => undefined });
  injectManager.registerView(wc.id, { mode: 'ppapi', generation: 99, token: 'bridge-inject' });
  injectManager.loadScripts([]);
  // The shared IPC handlers resolve the active manager via realManagerRef
  // (manager is null outside the per-mode loop).
  realManagerRef = injectManager;
  try {
    await wc.loadURL(`${mainOrigin}/cdp-inject`);
    // webFrame.executeJavaScript injection is asynchronous; poll briefly.
    const deadline = Date.now() + 3000;
    let probe: { bridgeType: string; loadFired: boolean } | null = null;
    while (Date.now() < deadline) {
      probe = (await wc.executeJavaScript(`(() => ({
        bridgeType: typeof window.${BRIDGE_MARKER},
        loadFired: window.__loadFired === true,
      }))()`, true).catch(() => null)) as { bridgeType: string; loadFired: boolean } | null;
      if (probe?.bridgeType === 'object') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    addCheck('lifecycle', 'preload injects the page bridge into the main world without inline script', true,
      probe?.bridgeType === 'object' && probe?.loadFired === true, probe);
  } catch (error) {
    addCheck('lifecycle', 'preload injects the page bridge into the main world without inline script', true, false, String(error));
  } finally {
    realManagerRef = null;
    injectManager.unregisterView(wc.id);
    host.removeBrowserView(view);
    try { (view.webContents as unknown as { destroy(): void }).destroy(); } catch { /* cleanup */ }
  }
}

// ---------------------------------------------------------------------------
// IPC wiring (registered once; `manager` is swapped per mode)
// ---------------------------------------------------------------------------

function activeManager(): UserscriptManager | null {
  return realManagerRef ?? manager;
}

function registerIpc(): void {
  // The full webview-preload queries ruffle mode at document start (Ruffle
  // IIFE). Mirror tabs.ipc.ts so the sendSync never hits a missing handler —
  // an unhandled sendSync in the preload accumulates renderer IPC corruption
  // that hangs the renderer on later navigations.
  ipcMain.on('get-ruffle-mode', (event) => {
    event.returnValue = { enabled: false, source: 'bundled', js: '', bundle: null };
  });
  ipcMain.on('userscript:get-config', (event, payload) => {
    const active = activeManager();
    if (!active) {
      event.returnValue = { ok: false, scripts: [], values: {} };
      return;
    }
    event.returnValue = active.snapshotFor(event.sender.id, payload?.url ?? '', Boolean(payload?.isMainFrame));
  });

  ipcMain.on('userscript:report', (event, payload) => {
    const active = activeManager();
    if (!active) return;
    const accepted = active.acceptReport(event.sender.id, payload);
    reports.push({ ...payload, accepted, wcId: event.sender.id });
  });

  ipcMain.on('userscript:set-value', (event, payload) => {
    const active = activeManager();
    if (!active) return;
    const scriptId = String(payload?.scriptId ?? '');
    const key = String(payload?.key ?? '');
    if (active.isScriptInstalled(scriptId) && key) active.setValue(event.sender.id, scriptId, key, payload?.value);
  });

  ipcMain.on('userscript:delete-value', (event, payload) => {
    const active = activeManager();
    if (!active) return;
    active.deleteValue(event.sender.id, String(payload?.scriptId ?? ''), String(payload?.key ?? ''));
  });

  ipcMain.on('userscript:menu-register', (event, payload) => {
    const active = activeManager();
    if (!active) return;
    const commandId = String(payload?.commandId ?? '');
    const scriptId = String(payload?.scriptId ?? '');
    const documentId = String(payload?.documentId ?? '');
    const title = String(payload?.title ?? '');
    if (!commandId || !scriptId || !documentId) return;
    active.registerMenuCommand(event.sender.id, scriptId, documentId, title, commandId);
  });

  ipcMain.on('userscript:menu-unregister', (event, payload) => {
    const active = activeManager();
    if (!active) return;
    active.unregisterMenuCommand(event.sender.id, String(payload?.commandId ?? ''));
  });

  ipcMain.on('userscript:open-in-tab', (event, payload) => {
    const active = activeManager();
    if (!active) return;
    active.openInTab(event.sender.id, String(payload?.scriptId ?? ''), String(payload?.url ?? ''));
  });

  ipcMain.on('userscript:menu-invoked', (event, payload) => {
    const active = activeManager();
    if (!active) return;
    const registration = active.getRegistration(event.sender.id);
    if (!registration) return;
    const documentId = String(payload?.documentId ?? '');
    if (!documentId) return;
    const report: UserscriptReport = {
      documentId,
      frameUrl: '',
      isMainFrame: false,
      mode: registration.mode,
      generation: registration.generation,
      scriptId: String(payload?.scriptId ?? ''),
      phase: 'menu-command-invoked',
      ok: true,
      detail: { commandId: String(payload?.commandId ?? '') },
    };
    const accepted = active.acceptReport(event.sender.id, report);
    reports.push({ ...report, accepted, wcId: event.sender.id });
  });

  ipcMain.on('userscript:value-listener-add', (event, payload) => {
    const active = activeManager();
    if (!active) return;
    active.addValueListener(event.sender.id, String(payload?.scriptId ?? ''), String(payload?.key ?? ''), Number(payload?.listenerId));
  });

  ipcMain.on('userscript:value-listener-remove', (event, payload) => {
    const active = activeManager();
    if (!active) return;
    active.removeValueListener(event.sender.id, String(payload?.scriptId ?? ''), Number(payload?.listenerId));
  });

  ipcMain.handle('userscript:set-clipboard', async (_event, payload) => {
    if (!activeManager()) return { ok: false };
    const text = String(payload?.text ?? '').slice(0, 1024 * 1024);
    clipboard.writeText(text);
    return { ok: true };
  });

  ipcMain.handle('userscript:notification', async (event, payload) => {
    const active = activeManager();
    if (!active) return { ok: false };
    const notificationId = active.notify(
      event.sender.id,
      String(payload?.scriptId ?? ''),
      String(payload?.documentId ?? ''),
      { text: payload?.text, title: payload?.title },
    );
    return { ok: notificationId !== null, notificationId };
  });

  ipcMain.handle('userscript:download', async (event, payload) => {
    const active = activeManager();
    if (!active || !downloadService) return { ok: false, error: 'not-ready' };
    const scriptId = String(payload?.scriptId ?? '');
    const metadata = active.getScriptMetadata(scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments' };
    return downloadService.download(
      event.sender.id,
      scriptId,
      String(payload?.pageUrl ?? ''),
      metadata.metadata.connect,
      payload?.details,
      Number(payload?.localId),
    );
  });

  ipcMain.on('userscript:download-abort', (event, payload) => {
    downloadService?.abort(event.sender.id, String(payload?.scriptId ?? ''), Number(payload?.localId));
  });

  ipcMain.handle('userscript:xhr-request', async (event, payload) => {
    const active = activeManager();
    if (!active || !requestService) throw new Error('xhr service not ready');
    const scriptId = String(payload?.scriptId ?? '');
    const metadata = active.getScriptMetadata(scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments', errorMessage: 'unknown script' };
    return requestService.request(
      event.sender.id,
      scriptId,
      String(payload?.pageUrl ?? ''),
      metadata.metadata.connect,
      payload?.details,
      Number(payload?.localId),
    );
  });

  ipcMain.on('userscript:xhr-abort', (event, payload) => {
    requestService?.abort(event.sender.id, String(payload?.scriptId ?? ''), Number(payload?.localId));
  });
}

const timeout = setTimeout(() => {
  console.error('[userscript-smoke] timed out');
  app.exit(1);
}, 120000);

app.whenReady().then(async () => {
    let mainPort = 0;
  let crossPort = 0;

  const mainServer = http.createServer((request, response) => {
    if (request.url === '/xhr/echo-headers') {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) headers[name] = String(value ?? '');
      const cookie = request.headers.cookie || '';
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, cookie, hasAuthorization: Boolean(request.headers.authorization), headers }));
      return;
    }
    if (request.url?.startsWith('/xhr/slow')) {
      const ms = Number(new URL(request.url, 'http://x').searchParams.get('ms') ?? 1000);
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('slow-ok');
      }, ms);
      return;
    }
    if (request.url === '/xhr/redirect-private') {
      response.writeHead(302, { Location: 'http://10.255.255.1/private' });
      response.end();
      return;
    }
    if (request.url?.startsWith('/xhr/redirect/')) {
      const count = Number(request.url.split('/').pop() ?? 0);
      if (count > 0) {
        response.writeHead(302, { Location: `/xhr/redirect/${count - 1}` });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('redirect-final');
      return;
    }
    if (request.url?.startsWith('/xhr/big')) {
      const bytes = Number(new URL(request.url, 'http://x').searchParams.get('bytes') ?? 1024);
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end('x'.repeat(bytes));
      return;
    }
    if (request.url === '/xhr/json') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ hello: 'world', n: 42 }));
      return;
    }
    if (request.url === '/require/lib-a.js') {
      requireRequests['/require/lib-a.js'] = (requireRequests['/require/lib-a.js'] ?? 0) + 1;
      response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      response.end('var LIB_A = { v: 21 };');
      return;
    }
    if (request.url === '/require/lib-b.js') {
      requireRequests['/require/lib-b.js'] = (requireRequests['/require/lib-b.js'] ?? 0) + 1;
      response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      response.end('function libHelper(x) { return x * 2; }');
      return;
    }
    if (request.url === '/require/gm-config.js') {
      requireRequests['/require/gm-config.js'] = (requireRequests['/require/gm-config.js'] ?? 0) + 1;
      response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      response.end('var GMConfigDemo = { read: function (k, f) { return GM_getValue(k, f); }, write: function (k, v) { GM_setValue(k, v); } };');
      return;
    }
    if (request.url === '/resource/data.txt') {
      requireRequests['/resource/data.txt'] = (requireRequests['/resource/data.txt'] ?? 0) + 1;
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('hello-resource');
      return;
    }
    if (request.url === '/require/missing.js') {
      requireRequests['/require/missing.js'] = (requireRequests['/require/missing.js'] ?? 0) + 1;
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }
    if (request.url === '/download/redirect-private') {
      response.writeHead(302, { Location: 'http://10.255.255.1/private' });
      response.end();
      return;
    }
    if (request.url === '/download/file.txt') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('download-content-123');
      return;
    }
    if (request.url?.startsWith('/download/big.bin')) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end('x'.repeat(100 * 1024));
      return;
    }
    if (request.url?.startsWith('/download/slow')) {
      const ms = Number(new URL(request.url, 'http://x').searchParams.get('ms') ?? 1000);
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.end('slow-download');
      }, ms);
      return;
    }
    if (request.url === '/real') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html><head><meta charset="utf-8"><title>real-script</title>
        <script>${PAGE_BRIDGE_SOURCE}</script>
        </head>
        <body>
          <p id="zh">這是繁體中文測試文字</p>
          <a id="thumb-link" href="http://127.0.0.1:${mainPort}/img/photo.png">
            <img id="thumb" src="http://127.0.0.1:${mainPort}/img/thumb.png" alt="thumb">
          </a>
        </body></html>`);
      return;
    }
    if (request.url === '/page-world') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(pageWorldHtml('page-world', 'page-world fixture'));
      return;
    }
    if (request.url === '/cdp-inject') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html('cdp-inject', 'cdp-inject fixture',
        '<script>window.__loadFired = false; window.addEventListener(\'load\', function () { window.__loadFired = true; });</script>'));
      return;
    }
    if (request.url?.startsWith('/spa')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html('spa', 'spa fixture',
        `<script>
          window.addEventListener('load', function () {
            history.pushState({}, '', '/spa/one');
            history.pushState({}, '', '/spa/two');
            history.replaceState({}, '', '/spa/three');
            window.location.hash = '#four';
          });
        </script>`));
      return;
    }
    if (request.url?.startsWith('/real-lib/')) {
      const name = request.url.slice('/real-lib/'.length);
      const file = name === 'gm-config.js' ? 'gm-config-cn.js' : name;
      try {
        const content = readFileSync(path.join(__dirname, '..', '..', 'tests', 'electron', 'fixtures', file), 'utf8');
        response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        response.end(content);
      } catch {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('not found');
      }
      return;
    }
    if (request.url?.startsWith('/img/')) {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      return;
    }
    if (request.url === '/document-start') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html('document-start', 'document-start fixture',
        '<script>window.__demoFirstScript = { sawMarker: document.documentElement.hasAttribute("data-demo-start") };</script>'));
      return;
    }
    if (request.url === '/strict-csp') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; object-src 'none'",
      });
      response.end(html('strict-csp', 'strict CSP fixture'));
      return;
    }
    if (request.url === '/iframes') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html('iframes', `
        <iframe id="same" src="http://127.0.0.1:${mainPort}/frame-child?kind=same"></iframe>
        <iframe id="cross" src="http://localhost:${crossPort}/frame-child?kind=cross"></iframe>
      `));
      return;
    }
    if (request.url === '/dynamic-iframe') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html('dynamic-iframe', `dynamic iframe host
        <script>
          setTimeout(function () {
            var frame = document.createElement('iframe');
            frame.id = 'dynamic';
            frame.src = 'http://127.0.0.1:${mainPort}/frame-child?kind=dynamic';
            document.body.appendChild(frame);
          }, 25);
        </script>
      `));
      return;
    }
    if (request.url?.startsWith('/frame-child')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html('same-frame', 'same-origin frame'));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  });

  const crossServer = http.createServer((request, response) => {
    if (request.url?.startsWith('/xhr/echo-headers')) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, cross: true, cookie: request.headers.cookie || '' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html('cross-frame', request.url || 'cross-origin frame'));
  });
  
  registerIpc();
  
  try {
        mainPort = await listen(mainServer);
        crossPort = await listen(crossServer, 'localhost');
        const fixtureSession = session.fromPartition('persist:userscript-runtime-smoke');
        applyCompatibilitySessionConfig(fixtureSession);
        await fixtureSession.cookies.set({
            url: `http://127.0.0.1:${mainPort}/`,
            name: 'demo-cookie',
            value: 'cookie-ok',
        });
        requestService = new GmRequestService({
      session: fixtureSession,
      allowedLoopbackHosts: ['127.0.0.1', 'localhost'],
      maxRedirects: 5,
      maxResponseBytes: 32 * 1024,
      defaultTimeoutMs: 3000,
      maxConcurrentPerScript: 2,
      maxConcurrentGlobal: 8,
    });
        requireCache = new RequireCache({
      fetcher: async (url) => httpGetText(url),
    });
        downloadDir = mkdtempSync(path.join(tmpdir(), 'userscript-download-'));
        downloadService = new GmDownloadService({
      downloadDir,
      session: fixtureSession,
      allowedLoopbackHosts: ['127.0.0.1'],
      maxBytes: 8 * 1024,
      maxConcurrentPerScript: 2,
    });
    
    const host = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: { nodeIntegration: false, contextIsolation: true, spellcheck: false },
    });
    const preloadPath = path.join(__dirname, 'userscript-runtime-preload.cjs');
    const origins = { main: `http://127.0.0.1:${mainPort}`, cross: `http://localhost:${crossPort}` };

    for (const mode of ['ppapi', 'ruffle'] as Mode[]) {
      manager = new UserscriptManager(new ValueStore(), {
        requireCache: requireCache ?? undefined,
        sendToWc: (wcId, channel, payload) => {
          try { wcRegistry.get(wcId)?.send(channel, payload); } catch { /* view gone */ }
        },
      });
      manager.loadScripts(installFixtures(origins));
      await manager.ensureRequires();
      await runMode(host, mode, mode === 'ppapi' ? 1 : 10, origins.main, origins.cross, preloadPath);
      manager = null;
    }

    await runBridgeInjectCheck(host, origins.main, preloadPath);
    await runRealScripts(host, origins.main, preloadPath);

    const requiredFailed = checks.filter((check) => check.required && !check.passed);
    const summary = {
      required: `${checks.filter((check) => check.required && check.passed).length}/${checks.filter((check) => check.required).length}`,
      optional: `${checks.filter((check) => !check.required && check.passed).length}/${checks.filter((check) => !check.required).length}`,
      decision: requiredFailed.length === 0 ? 'CONTINUE' : 'REVIEW_REQUIRED',
      checks,
    };
    for (const check of checks) {
      console.log(`[userscript-smoke] ${check.passed ? 'PASS' : 'FAIL'} ${check.required ? 'required' : 'optional'} ${check.mode} / ${check.name}`);
    }
    console.log('[userscript-smoke] SUMMARY ' + JSON.stringify(summary));
    clearTimeout(timeout);
    host.destroy();
    await Promise.all([closeServer(mainServer), closeServer(crossServer)]);
    try { rmSync(downloadDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    try { rmSync(smokeUserDataDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    app.exit(requiredFailed.length === 0 ? 0 : 1);
  } catch (error) {
    console.error('[userscript-smoke] failed:', error);
    clearTimeout(timeout);
    await Promise.allSettled([closeServer(mainServer), closeServer(crossServer)]);
    app.exit(1);
  }
}).catch((error) => {
  console.error('[userscript-smoke] startup failed:', error);
  clearTimeout(timeout);
  app.exit(1);
});



