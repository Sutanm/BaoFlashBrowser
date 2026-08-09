// Userscript runtime IPC: snapshot/report/values/menu/listeners/clipboard/
// notification/download/xhr channels. All payloads are zod-validated
// (sendSync/on channels use registerValidatedListener so event.returnValue
// can be set; async channels that need the sender id use ipcMain.handle with
// safeParse directly, mirroring tabs.ipc.ts's ruffleDiagnostic pattern).

import { BrowserWindow, clipboard, ipcMain, Notification } from 'electron';
import log from 'electron-log';
import { z } from 'zod';
import { registerValidatedListener, createValidatedHandler } from '../utils/ipc-wrapper';
import { getUserscriptManager, getRequestService, getDownloadService, getBackgroundRuntime, getCookieService, getWebRequestObserver } from '../modules/userscripts';
import { createLogRateLimiter } from './userscript-log-rate';
import type { UserscriptReport } from '../../shared/userscript-types';

const commandIdSchema = z.object({ commandId: z.string() });

// GM_log per-script rate limit: 10 lines/s, overflow dropped with at most one
// warn per script per 30s.
const logLimiter = createLogRateLimiter({ perSecond: 10 });

export function registerUserscriptsIPC(): void {
  const manager = () => getUserscriptManager();
  const requests = () => getRequestService();
  const downloads = () => getDownloadService();
  const cookies = () => getCookieService();

  // Script logging: sinks into electron-log so it lands in userData/logs/main.log.
  // Never log credentials: message text is script-provided and may contain
  // anything, but it is user-visible app logging (same surface as console.log).
  registerValidatedListener(
    'userscript:log',
    z.object({ scriptId: z.string(), level: z.enum(['info', 'warn', 'error']).optional(), message: z.string().max(4000) }),
    (event, payload) => {
      const active = manager();
      if (!active || !active.isScriptInstalled(payload.scriptId)) return;
      if (!logLimiter.allow(payload.scriptId)) {
        if (logLimiter.warnOnce(payload.scriptId)) {
          log.warn('[userscripts] log rate limit hit for ' + payload.scriptId);
        }
        return;
      }
      const level = payload.level ?? 'info';
      // NOTE: never write `fn?.(...) ?? log.info(...)` here — a void return
      // would evaluate the right side and double-log every message.
      const fn = (log as unknown as Record<string, (m: string) => void>)[level] ?? log.info;
      fn(`[userscript:${payload.scriptId}] ${payload.message}`);
    },
  );

  // Sync snapshot: preload asks at document start; the response is bounded by
  // the manager's snapshot budgets (maxSnapshotBytes/maxSourceBytesPerPage).
  // The @background window is dispatched by sender wc id — its payload carries
  // no background marker.
  registerValidatedListener(
    'userscript:get-config',
    z.object({ url: z.string(), isMainFrame: z.boolean(), documentId: z.string() }),
    (event, payload) => {
      const active = manager();
      if (!active) { event.returnValue = { ok: false, scripts: [], values: {} }; return; }
      // Per-script background windows: resolve by wc id, snapshot only that script.
      const bgScriptId = getBackgroundRuntime()?.getScriptIdForWc(event.sender.id) ?? null;
      if (bgScriptId != null) {
        event.returnValue = active.snapshotBackground(event.sender.id);
      } else {
        event.returnValue = active.snapshotFor(event.sender.id, payload.url, payload.isMainFrame);
      }
    },
  );

  registerValidatedListener(
    'userscript:report',
    z.object({
      documentId: z.string(),
      frameUrl: z.string(),
      isMainFrame: z.boolean(),
      mode: z.enum(['ppapi', 'ruffle']),
      generation: z.number(),
      phase: z.string(),
      detail: z.unknown().optional(),
    }),
    (event, payload) => {
      const active = manager();
      if (active) active.acceptReport(event.sender.id, payload as unknown as UserscriptReport);
    },
  );

  registerValidatedListener(
    'userscript:set-value',
    z.object({ scriptId: z.string(), key: z.string(), value: z.unknown() }),
    (event, payload) => {
      const active = manager();
      if (active && active.isScriptInstalled(payload.scriptId) && payload.key) {
        active.setValue(event.sender.id, payload.scriptId, payload.key, payload.value as import('../../shared/userscript-types').GMSerializable);
      }
    },
  );

  registerValidatedListener(
    'userscript:delete-value',
    z.object({ scriptId: z.string(), key: z.string() }),
    (event, payload) => {
      manager()?.deleteValue(event.sender.id, payload.scriptId, payload.key);
    },
  );

  registerValidatedListener(
    'userscript:menu-register',
    z.object({ commandId: z.string(), scriptId: z.string(), documentId: z.string(), isMainFrame: z.boolean().optional(), title: z.string() }),
    (event, payload) => {
      manager()?.registerMenuCommand(event.sender.id, payload.scriptId, payload.documentId, payload.title, payload.commandId, Boolean(payload.isMainFrame));
    },
  );

  registerValidatedListener('userscript:menu-unregister', commandIdSchema, (event, payload) => {
    manager()?.unregisterMenuCommand(event.sender.id, payload.commandId);
  });

  registerValidatedListener(
    'userscript:open-in-tab',
    z.object({ scriptId: z.string(), url: z.string() }),
    (event, payload) => {
      let target: URL;
      try { target = new URL(payload.url); } catch { return; }
      if (!['http:', 'https:'].includes(target.protocol) && target.toString() !== 'about:blank') return;
      if (!manager()?.openInTab(event.sender.id, payload.scriptId, target.toString())) return;
      const host = event.sender.hostWebContents
        ?? BrowserWindow.getAllWindows().find((win) => win.isVisible() && !win.isDestroyed())?.webContents;
      host?.send('userscript:open-tab', { url: target.toString() });
    },
  );

  registerValidatedListener(
    'userscript:menu-invoked',
    z.object({ documentId: z.string(), scriptId: z.string(), commandId: z.string() }),
    (event, payload) => {
      const active = manager();
      const registration = active?.getRegistration(event.sender.id);
      if (!active || !registration) return;
      const report: UserscriptReport = {
        documentId: payload.documentId,
        frameUrl: '',
        isMainFrame: false,
        mode: registration.mode,
        generation: registration.generation,
        scriptId: payload.scriptId,
        phase: 'menu-command-invoked',
        ok: true,
        detail: { commandId: payload.commandId },
      };
      active.acceptReport(event.sender.id, report);
    },
  );

  registerValidatedListener(
    'userscript:value-listener-add',
    z.object({ scriptId: z.string(), key: z.string(), listenerId: z.number() }),
    (event, payload) => {
      manager()?.addValueListener(event.sender.id, payload.scriptId, payload.key, payload.listenerId);
    },
  );

  registerValidatedListener(
    'userscript:value-listener-remove',
    z.object({ scriptId: z.string(), listenerId: z.number() }),
    (event, payload) => {
      manager()?.removeValueListener(event.sender.id, payload.scriptId, payload.listenerId);
    },
  );

  // GM_webRequest observation: register/unregister the per-document listener.
  registerValidatedListener(
    'userscript:web-request-register',
    z.object({ scriptId: z.string(), documentId: z.string() }),
    (event, payload) => {
      const active = manager();
      if (!active || !active.isScriptInstalled(payload.scriptId)) return;
      getWebRequestObserver()?.register({ wcId: event.sender.id, documentId: payload.documentId, scriptId: payload.scriptId });
    },
  );

  registerValidatedListener(
    'userscript:web-request-unregister',
    z.object({ scriptId: z.string(), documentId: z.string() }),
    (event, payload) => {
      getWebRequestObserver()?.unregister(event.sender.id, payload.documentId, payload.scriptId);
    },
  );

  createValidatedHandler(
    'userscript:set-clipboard',
    z.object({ text: z.string().max(1024 * 1024) }),
    async (payload) => {
      if (!manager()) return { ok: false };
      clipboard.writeText(payload.text);
      return { ok: true };
    },
  );

  const downloadDetailsSchema = z.object({
    url: z.string(),
    name: z.string().optional(),
    method: z.string().optional(),
    timeout: z.number().optional(),
  }).passthrough();

  const xhrDetailsSchema = z.object({
    method: z.string(),
    url: z.string(),
    headers: z.record(z.string()).optional(),
    data: z.string().optional(),
    responseType: z.enum(['text', 'json', 'blob', 'arraybuffer']).optional(),
    timeout: z.number().optional(),
  }).passthrough();

  ipcMain.handle('userscript:notification', async (event, raw: unknown) => {
    const active = manager();
    const parsed = z.object({
      scriptId: z.string(), documentId: z.string(), text: z.string().optional(), title: z.string().optional(),
    }).safeParse(raw);
    if (!active || !parsed.success) return { ok: false };
    const notificationId = active.notify(event.sender.id, parsed.data.scriptId, parsed.data.documentId, {
      text: parsed.data.text,
      title: parsed.data.title,
    });
    // Surface as a system notification; clicking routes back through the
    // manager so the script's onclick fires (triggerNotification).
    if (notificationId !== null) {
      try {
        const notification = new Notification({
          title: parsed.data.title || parsed.data.scriptId,
          body: parsed.data.text ?? '',
          silent: true,
        });
        notification.on('click', () => {
          active.triggerNotification(event.sender.id, notificationId);
        });
        notification.show();
      } catch { /* notifications unavailable */ }
    }
    return { ok: notificationId !== null, notificationId };
  });

  ipcMain.handle('userscript:download', async (event, raw: unknown) => {
    const active = manager();
    const service = downloads();
    const parsed = z.object({ scriptId: z.string(), pageUrl: z.string(), details: downloadDetailsSchema, localId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).safeParse(raw);
    if (!active || !service || !parsed.success) return { ok: false, error: 'not-ready' };
    const metadata = active.getScriptMetadata(parsed.data.scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments' };
    return service.download(event.sender.id, parsed.data.scriptId, parsed.data.pageUrl, metadata.metadata.connect, parsed.data.details, parsed.data.localId);
  });

  registerValidatedListener('userscript:download-abort', z.object({ scriptId: z.string(), localId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }), (event, payload) => {
    downloads()?.abort(event.sender.id, payload.scriptId, payload.localId);
  });

  ipcMain.handle('userscript:xhr-request', async (event, raw: unknown) => {
    const active = manager();
    const service = requests();
    const parsed = z.object({ scriptId: z.string(), pageUrl: z.string(), details: xhrDetailsSchema, localId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).safeParse(raw);
    if (!active || !service || !parsed.success) return { ok: false, error: 'not-ready' };
    const metadata = active.getScriptMetadata(parsed.data.scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments', errorMessage: 'unknown script' };
    return service.request(event.sender.id, parsed.data.scriptId, parsed.data.pageUrl, metadata.metadata.connect, parsed.data.details, parsed.data.localId);
  });

  registerValidatedListener('userscript:xhr-abort', z.object({ scriptId: z.string(), localId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }), (event, payload) => {
    requests()?.abort(event.sender.id, payload.scriptId, payload.localId);
  });

  // GM_cookie READ-ONLY (list/get). Host gating = @connect list of the script.
  ipcMain.handle('userscript:cookie-list', async (event, raw: unknown) => {
    const parsed = z.object({
      scriptId: z.string(), pageUrl: z.string(),
      url: z.string().optional(), domain: z.string().optional(), name: z.string().optional(),
    }).safeParse(raw);
    const active = manager();
    const service = cookies();
    if (!active || !service || !parsed.success) return { ok: false, error: 'not-ready' };
    const metadata = active.getScriptMetadata(parsed.data.scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments' };
    return service.list(event.sender.id, parsed.data.scriptId, parsed.data.pageUrl, metadata.metadata.connect,
      { url: parsed.data.url, domain: parsed.data.domain, name: parsed.data.name });
  });

  ipcMain.handle('userscript:cookie-get', async (event, raw: unknown) => {
    const parsed = z.object({
      scriptId: z.string(), pageUrl: z.string(), url: z.string(), name: z.string(),
    }).safeParse(raw);
    const active = manager();
    const service = cookies();
    if (!active || !service || !parsed.success) return { ok: false, error: 'not-ready' };
    const metadata = active.getScriptMetadata(parsed.data.scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments' };
    return service.get(event.sender.id, parsed.data.scriptId, parsed.data.pageUrl, metadata.metadata.connect,
      { url: parsed.data.url, name: parsed.data.name });
  });
}
