// Userscript runtime IPC: snapshot/report/values/menu/listeners/clipboard/
// notification/download/xhr channels. All payloads are zod-validated
// (sendSync/on channels use registerValidatedListener so event.returnValue
// can be set; async channels that need the sender id use ipcMain.handle with
// safeParse directly, mirroring tabs.ipc.ts's ruffleDiagnostic pattern).

import { randomBytes } from 'crypto';
import { BrowserWindow, clipboard, ipcMain, nativeImage, Notification } from 'electron';
import log from 'electron-log';
import { z } from 'zod';
import { registerValidatedListener, createValidatedHandler } from '../utils/ipc-wrapper';
import { AUTOMATION_ASSISTANT_SCRIPT_ID, getUserscriptManager, getRequestService, getDownloadService, getBackgroundRuntime, getCookieService, getWebRequestObserver } from '../modules/userscripts';
import { createLogRateLimiter } from './userscript-log-rate';
import type { UserscriptReport } from '../../shared/userscript-types';
import { getAutomationService } from './automation.ipc';
import { tabManager } from '../modules/tabs';
import { previewRectToSource } from '../modules/automation/capture-geometry';
import { DEFAULT_AUTOMATION_VIEWPORT } from '../../shared/automation/types';

const commandIdSchema = z.object({ commandId: z.string() });

// GM_log per-script rate limit: 10 lines/s, overflow dropped with at most one
// warn per script per 30s.
const logLimiter = createLogRateLimiter({ perSecond: 10 });

export function registerUserscriptsIPC(): void {
  const manager = () => getUserscriptManager();
  const requests = () => getRequestService();
  const downloads = () => getDownloadService();
  const cookies = () => getCookieService();
  const automationGrant = (wcId: number, scriptId: string): boolean => {
    const active = manager();
    const registration = active?.getRegistration(wcId);
    const installed = active?.getScriptMetadata(scriptId);
    return Boolean(scriptId === AUTOMATION_ASSISTANT_SCRIPT_ID && registration && installed?.enabled && installed.metadata.grant.includes('GM_baoAutomation'));
  };
  const assistantCaptures = new Map<string, { image: Electron.NativeImage; previewWidth: number; previewHeight: number; sourceWidth: number; sourceHeight: number; createdAt: number; timer: NodeJS.Timeout }>();
  const expireAssistantCaptures = (): void => {
    const cutoff = Date.now() - 2 * 60_000;
    for (const [token, capture] of assistantCaptures) if (capture.createdAt < cutoff) {
      clearTimeout(capture.timer); assistantCaptures.delete(token);
    }
  };
  const safeCapturedAsset = z.string().min(1).max(180).refine((value) => {
    if (!value.toLowerCase().endsWith('.png') || value !== value.trim() || /[<>:"/\\|?*]/u.test(value)
      || Array.from(value).some((character) => character.charCodeAt(0) < 32)) return false;
    const base = value.slice(0, -4);
    return Boolean(base) && !/[. ]$/u.test(base) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(base);
  }, 'asset name must be a safe PNG filename');

  ipcMain.handle('userscript:automation-list', async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string() }).strict().safeParse(raw);
    const service = getAutomationService();
    if (!parsed.success || !service || !automationGrant(event.sender.id, parsed.data.scriptId)) return [];
    await service.whenReady();
    return service.listPackages().map(({ packageId, name, assets }) => ({ packageId, name, assets }));
  });

  ipcMain.handle('userscript:automation-match', async (event, raw: unknown) => {
    const parsed = z.object({
      scriptId: z.string(), packageId: z.string().min(1).max(160), asset: z.string().min(1).max(512),
      options: z.object({ threshold: z.number().min(.1).max(1).optional(), scales: z.array(z.number().min(.25).max(4)).min(1).max(16).optional(), mask: z.enum(['auto', 'none', 'alpha']).optional() }).strict(),
    }).strict().safeParse(raw);
    const service = getAutomationService();
    const tabId = tabManager.getTabIdForWebContents(event.sender.id);
    if (!parsed.success || !service || !tabId || !automationGrant(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    await service.whenReady();
    const captured = await service.captureReferenceFrame(tabId, { retainViewport: true });
    const source = nativeImage.createFromBuffer(Buffer.from(captured.png));
    if (source.isEmpty()) throw new Error('page capture is empty');
    const image = source.getSize().width === DEFAULT_AUTOMATION_VIEWPORT.width && source.getSize().height === DEFAULT_AUTOMATION_VIEWPORT.height
      ? source : source.resize({ width: DEFAULT_AUTOMATION_VIEWPORT.width, height: DEFAULT_AUTOMATION_VIEWPORT.height, quality: 'best' });
    const match = await service.testAssetOnImage(parsed.data.packageId, parsed.data.asset, { width: DEFAULT_AUTOMATION_VIEWPORT.width, height: DEFAULT_AUTOMATION_VIEWPORT.height, bgra: Uint8Array.from(image.toBitmap()) }, { scales: parsed.data.options.scales, mask: parsed.data.options.mask });
    const scale = Math.min(1, 900 / DEFAULT_AUTOMATION_VIEWPORT.width, 600 / DEFAULT_AUTOMATION_VIEWPORT.height);
    const previewWidth = Math.max(1, Math.round(DEFAULT_AUTOMATION_VIEWPORT.width * scale));
    const previewHeight = Math.max(1, Math.round(DEFAULT_AUTOMATION_VIEWPORT.height * scale));
    const preview = scale < 1 ? image.resize({ width: previewWidth, height: previewHeight }) : image;
    const threshold = parsed.data.options.threshold ?? .9;
    return { dataUrl: preview.toDataURL(), previewWidth, previewHeight, sourceWidth: DEFAULT_AUTOMATION_VIEWPORT.width, sourceHeight: DEFAULT_AUTOMATION_VIEWPORT.height, candidate: match, matched: Boolean(match && match.score >= threshold), threshold };
  });

  ipcMain.handle('userscript:automation-status', async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string() }).strict().safeParse(raw);
    const service = getAutomationService();
    if (!parsed.success || !service || !automationGrant(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    await service.whenReady(); return service.getStatus();
  });

  ipcMain.handle('userscript:automation-start', async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string(), packageId: z.string().min(1).max(160), countdownMs: z.number().int().min(0).max(60_000) }).strict().safeParse(raw);
    const service = getAutomationService(); const tabId = tabManager.getTabIdForWebContents(event.sender.id);
    if (!parsed.success || !service || !tabId || !automationGrant(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    await service.whenReady();
    if (['checking', 'countdown', 'running'].includes(service.getStatus().state)) throw new Error('an automation script is already active');
    void service.start(parsed.data.packageId, tabId, parsed.data.countdownMs).catch(() => {});
    return { started: true as const };
  });

  ipcMain.handle('userscript:automation-cancel', async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string() }).strict().safeParse(raw); const service = getAutomationService();
    if (!parsed.success || !service || !automationGrant(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    await service.cancel(); return { cancelled: true as const };
  });

  ipcMain.handle('userscript:automation-warmup', async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string(), packageId: z.string().min(1).max(160), asset: z.string().min(1).max(512).optional() }).strict().safeParse(raw);
    const service = getAutomationService();
    if (!parsed.success || !service || !automationGrant(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    await service.whenReady(); await service.warmupVision(parsed.data.packageId);
    if (parsed.data.asset) {
      const source = service.getAsset(parsed.data.packageId, parsed.data.asset);
      const image = nativeImage.createFromBuffer(Buffer.from(source.bytes));
      if (!image.isEmpty()) {
        const size = image.getSize();
        await service.testAssetOnImage(parsed.data.packageId, parsed.data.asset, { width: size.width, height: size.height, bgra: Uint8Array.from(image.toBitmap()) }, { scales: [1], mask: 'none' });
      }
    }
    return { ready: true as const };
  });

  ipcMain.handle('userscript:automation-asset-preview', async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string(), packageId: z.string().min(1).max(160), asset: z.string().min(1).max(512) }).strict().safeParse(raw);
    const service = getAutomationService();
    if (!parsed.success || !service || !automationGrant(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    const source = service.getAsset(parsed.data.packageId, parsed.data.asset);
    if (source.bytes.byteLength > 16 * 1024 * 1024) throw new Error('automation asset is too large to preview');
    const image = nativeImage.createFromBuffer(Buffer.from(source.bytes)); if (image.isEmpty()) throw new Error('unable to decode automation asset');
    const size = image.getSize(); const scale = Math.min(1, 92 / size.width, 64 / size.height);
    const preview = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }) : image;
    return { asset: parsed.data.asset, dataUrl: preview.toDataURL(), width: size.width, height: size.height };
  });

  ipcMain.handle('userscript:automation-capture-frame', async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string() }).strict().safeParse(raw); const service = getAutomationService();
    const tabId = tabManager.getTabIdForWebContents(event.sender.id);
    if (!parsed.success || !service || !tabId || !automationGrant(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    await service.whenReady(); expireAssistantCaptures();
    const captured = await service.captureReferenceFrame(tabId, { retainViewport: true }); const source = nativeImage.createFromBuffer(Buffer.from(captured.png));
    if (source.isEmpty()) throw new Error('unable to decode captured BrowserView frame');
    const image = source.getSize().width === DEFAULT_AUTOMATION_VIEWPORT.width && source.getSize().height === DEFAULT_AUTOMATION_VIEWPORT.height
      ? source : source.resize({ width: DEFAULT_AUTOMATION_VIEWPORT.width, height: DEFAULT_AUTOMATION_VIEWPORT.height, quality: 'best' });
    const scale = Math.min(1, 1600 / DEFAULT_AUTOMATION_VIEWPORT.width, 1000 / DEFAULT_AUTOMATION_VIEWPORT.height);
    const previewWidth = Math.max(1, Math.round(DEFAULT_AUTOMATION_VIEWPORT.width * scale)); const previewHeight = Math.max(1, Math.round(DEFAULT_AUTOMATION_VIEWPORT.height * scale));
    const preview = scale < 1 ? image.resize({ width: previewWidth, height: previewHeight }) : image;
    const token = randomBytes(16).toString('hex'); const timer = setTimeout(() => assistantCaptures.delete(token), 2 * 60_000); timer.unref();
    assistantCaptures.set(token, { image, previewWidth, previewHeight, sourceWidth: DEFAULT_AUTOMATION_VIEWPORT.width, sourceHeight: DEFAULT_AUTOMATION_VIEWPORT.height, createdAt: Date.now(), timer });
    while (assistantCaptures.size > 3) { const oldest = assistantCaptures.keys().next().value as string; const removed = assistantCaptures.get(oldest); if (removed) clearTimeout(removed.timer); assistantCaptures.delete(oldest); }
    return { token, dataUrl: preview.toDataURL(), previewWidth, previewHeight, sourceWidth: DEFAULT_AUTOMATION_VIEWPORT.width, sourceHeight: DEFAULT_AUTOMATION_VIEWPORT.height };
  });

  ipcMain.handle('userscript:automation-coordinate-begin', async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string() }).strict().safeParse(raw); const service = getAutomationService();
    const tabId = tabManager.getTabIdForWebContents(event.sender.id);
    if (!parsed.success || !service || !tabId || !automationGrant(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    await service.whenReady(); await service.beginAuthoringViewport(tabId);
    return { ready: true as const };
  });

  ipcMain.handle('userscript:automation-coordinate-end', async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string() }).strict().safeParse(raw); const service = getAutomationService();
    const tabId = tabManager.getTabIdForWebContents(event.sender.id);
    if (!parsed.success || !service || !tabId || !automationGrant(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    service.endAuthoringViewport(tabId);
    return { released: true as const };
  });

  ipcMain.handle('userscript:automation-save-capture', async (event, raw: unknown) => {
    const parsed = z.object({
      scriptId: z.string(), packageId: z.string().min(1).max(160), token: z.string().regex(/^[a-f0-9]{32}$/), asset: safeCapturedAsset,
      rect: z.object({ x: z.number().min(0), y: z.number().min(0), width: z.number().min(2), height: z.number().min(2) }).strict(), overwrite: z.boolean(),
    }).strict().safeParse(raw);
    const service = getAutomationService();
    if (!parsed.success || !service || !automationGrant(event.sender.id, parsed.data.scriptId)) throw new Error('invalid automation capture request');
    await service.whenReady(); expireAssistantCaptures(); const capture = assistantCaptures.get(parsed.data.token);
    if (!capture) throw new Error('captured frame expired; capture the page again');
    const existing = service.getPackage(parsed.data.packageId).assets.includes(parsed.data.asset);
    if (existing && !parsed.data.overwrite) return { conflict: true as const, asset: parsed.data.asset };
    const crop = previewRectToSource(parsed.data.rect, { width: capture.previewWidth, height: capture.previewHeight }, capture.image.getSize());
    const logicalWidth = Math.max(1, Math.round(crop.width * DEFAULT_AUTOMATION_VIEWPORT.width / capture.sourceWidth));
    const logicalHeight = Math.max(1, Math.round(crop.height * DEFAULT_AUTOMATION_VIEWPORT.height / capture.sourceHeight));
    const cropped = capture.image.crop(crop);
    const normalized = crop.width === logicalWidth && crop.height === logicalHeight
      ? cropped : cropped.resize({ width: logicalWidth, height: logicalHeight, quality: 'best' });
    const bytes = new Uint8Array(normalized.toPNG());
    const assets = await service.importAssets(parsed.data.packageId, new Map([[parsed.data.asset, bytes]]));
    clearTimeout(capture.timer); assistantCaptures.delete(parsed.data.token);
    return { conflict: false as const, asset: parsed.data.asset, width: logicalWidth, height: logicalHeight, assets };
  });

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
