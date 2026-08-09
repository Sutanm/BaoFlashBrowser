// Userscript runtime bootstrap for BrowserView preloads. Invoked by
// src/webview-preload/index.ts (both main frames and subframes) after the
// Ruffle/PPAPI shims; a failed runtime must never break the page.
// Mirrors tests/electron/userscripts/preload/bootstrap.ts (demo origin).

import { ipcRenderer, webFrame } from 'electron';
import type { FrameSnapshot, GmWebRequestEvent } from '../../shared/userscript-types';
import { scheduleScripts } from './scheduler';
import { executeUserscript } from './sandbox';
import { createGmApi, grantGmApi, type GmApi, type GrantedGmApi } from './gm-api';
import { createUnsafeWindowProxy } from './unsafe-proxy';
import { PAGE_BRIDGE_SOURCE, BRIDGE_MARKER } from './page-bridge';

const isMainFrame = Boolean(process.isMainFrame);

// In ppapi mode (contextIsolation: true) Electron exposes Node bindings on the
// isolated-world global. Lexical shadowing blocks direct references, but
// constructor chains (`Function('return process')`) reach them, so strip the
// bindings from the isolated global itself.
// Must NOT run in ruffle mode: there the preload shares the page world, whose
// global already has no Node bindings, and defineProperty would create
// own `process`/`module`/... keys (value undefined) that break legacy feature
// detection (`'process' in window`). Mode is only known after the sync query,
// which executes no user script, so stripping happens there.
function stripNodeGlobals(): void {
  try {
    const isolatedGlobal = Function('return this')();
    for (const name of ['process', 'require', 'module', 'exports', 'Buffer', 'global', '__filename', '__dirname']) {
      try {
        Object.defineProperty(isolatedGlobal, name, { value: undefined, configurable: true, writable: true });
      } catch { /* skip non-configurable properties */ }
    }
  } catch { /* ignore */ }
}

export function initUserscriptRuntime(): void {
  const documentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  const snapshot = ipcRenderer.sendSync('userscript:get-config', {
    url: String(window.location.href || ''),
    isMainFrame,
    documentId,
  }) as FrameSnapshot;

  if (snapshot && snapshot.ok) {
  if (snapshot.mode === 'ppapi') stripNodeGlobals();
  const { mode, generation, scripts, values } = snapshot;
  const base = { mode, generation, documentId };
  // D5 page-world bridge: in ppapi (isolated world) mode unsafeWindow must
  // reach the page MAIN world. The bridge script is injected into the main
  // world via webFrame.executeJavaScript, which executes in the page main
  // world the isolated preload cannot touch directly. This is the real-product
  // injection path (CDP Page.addScriptToEvaluateOnNewDocument does not work:
  // its registrations are removed when the debugger detaches). Ruffle mode
  // shares the page world, so the plain window already is the main world.
  const report = (phase: string, detail?: unknown): void => {
    ipcRenderer.send('userscript:report', {
      ...base,
      frameUrl: String(window.location.href || ''),
      isMainFrame,
      phase,
      detail,
    });
  };

  report('bootstrap', { readyState: document.readyState, scripts: scripts.map((s) => s.id) });

  let unsafeWindow: unknown = window;
  if (mode === 'ppapi') {
    try {
      webFrame.executeJavaScript(PAGE_BRIDGE_SOURCE, true);
      // webFrame.executeJavaScript may run in the caller's world on some
      // Electron versions; verify the bridge actually landed in the MAIN
      // world, which is where the page bridge must live.
      webFrame.executeJavaScript(`typeof window.${BRIDGE_MARKER}`, true).then((type) => {
        report('bridge-inject', { ok: type === 'object', mainWorldType: type });
      }).catch((error) => {
        report('bridge-inject', { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    } catch (error) {
      report('bridge-inject', { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    unsafeWindow = createUnsafeWindowProxy(window);
  }

  const gmByScript = new Map<string, GmApi>();
  const grantedByScript = new Map<string, GrantedGmApi>();
  for (const script of scripts) {
    const gm = createGmApi({
      script,
      documentId,
      isMainFrame,
      values: (values && values[script.id]) || {},
      resources: (snapshot.resources && snapshot.resources[script.id]) || {},
      flashRuntime: mode as 'ppapi' | 'ruffle',
      bridge: {
        send: (channel, payload) => ipcRenderer.send(channel, payload),
        invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
      },
    });
    gmByScript.set(script.id, gm);
    grantedByScript.set(script.id, grantGmApi(gm, script.info?.grant));
  }

  ipcRenderer.on('userscript:menu-invoke', (_event, raw: unknown) => {
    const payload = raw as { commandId?: unknown; documentId?: string };
    if (!payload || payload.documentId !== documentId) return;
    if (typeof payload.commandId !== 'string' || !payload.commandId.startsWith(documentId + ':')) return;
    const rest = payload.commandId.slice(documentId.length + 1);
    const separator = rest.lastIndexOf(':');
    if (separator < 0) return;
    const scriptId = rest.slice(0, separator);
    const localId = Number(rest.slice(separator + 1));
    if (!Number.isInteger(localId)) return;
    const gm = gmByScript.get(scriptId);
    if (gm) gm.handleMenuInvoke(localId);
  });

  ipcRenderer.on('userscript:probe-late', (_event, delayMs: unknown) => {
    setTimeout(() => report('delayed-probe', { delayMs: Number(delayMs) || 100 }), Number(delayMs) || 100);
  });

  ipcRenderer.on('userscript:value-changed', (_event, payload: unknown) => {
    const message = payload as { scriptId?: string; key?: string; oldValue?: unknown; newValue?: unknown };
    const gm = gmByScript.get(String(message?.scriptId ?? ''));
    gm?.handleValueChanged(String(message?.key ?? ''), message?.oldValue, message?.newValue);
  });

  ipcRenderer.on('userscript:web-request-event', (_event, payload: unknown) => {
    const message = payload as { scriptId?: string; documentId?: string; event?: GmWebRequestEvent };
    if (message.documentId !== documentId) return;
    const gm = gmByScript.get(String(message?.scriptId ?? ''));
    gm?.handleWebRequestEvent(message.event as GmWebRequestEvent);
  });

  ipcRenderer.on('userscript:notification-click', (_event, payload: unknown) => {
    const message = payload as { scriptId?: string; documentId?: string; notificationId?: number };
    const gm = gmByScript.get(String(message?.scriptId ?? ''));
    gm?.handleNotificationClick(String(message?.documentId ?? ''), Number(message?.notificationId));
  });

  scheduleScripts(scripts, {
    executeScript: (script, runAt) => {
      report('script-start', { scriptId: script.id, runAt });
      const granted = grantedByScript.get(script.id);
      const result = executeUserscript(script.source, {
        mode: mode as 'ppapi' | 'ruffle',
        unsafeWindow: granted?.unsafeWindow ? unsafeWindow : undefined,
        window,
        document,
        GM: granted?.modern ?? {},
        GM_info: granted?.info,
        legacyGm: granted?.legacy ?? {},
      });
      report(result.ok ? 'script-complete' : 'script-error', {
        scriptId: script.id,
        runAt,
        error: result.error,
        usedVmFallback: result.usedVmFallback,
      });
    },
  });
  }
}
