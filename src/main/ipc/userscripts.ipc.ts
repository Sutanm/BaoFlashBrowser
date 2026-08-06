// Userscript runtime IPC: snapshot/report/values/menu/listeners/clipboard/
// notification/download/xhr channels. All payloads are zod-validated
// (sendSync/on channels use registerValidatedListener so event.returnValue
// can be set; async channels that need the sender id use ipcMain.handle with
// safeParse directly, mirroring tabs.ipc.ts's ruffleDiagnostic pattern).

import { clipboard, ipcMain } from 'electron';
import { z } from 'zod';
import { registerValidatedListener, createValidatedHandler } from '../utils/ipc-wrapper';
import { getUserscriptManager, getRequestService, getDownloadService } from '../modules/userscripts';
import type { UserscriptReport } from '../../shared/userscript-types';

const commandIdSchema = z.object({ commandId: z.string() });

export function registerUserscriptsIPC(): void {
  const manager = () => getUserscriptManager();
  const requests = () => getRequestService();
  const downloads = () => getDownloadService();

  // Sync snapshot: preload asks at document start; the response is bounded by
  // the manager's snapshot budgets (maxSnapshotBytes/maxSourceBytesPerPage).
  registerValidatedListener(
    'userscript:get-config',
    z.object({ url: z.string(), isMainFrame: z.boolean(), documentId: z.string() }),
    (event, payload) => {
      const active = manager();
      event.returnValue = active
        ? active.snapshotFor(event.sender.id, payload.url, payload.isMainFrame)
        : { ok: false, scripts: [], values: {} };
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
    z.object({ commandId: z.string(), scriptId: z.string(), documentId: z.string(), title: z.string() }),
    (event, payload) => {
      manager()?.registerMenuCommand(event.sender.id, payload.scriptId, payload.documentId, payload.title, payload.commandId);
    },
  );

  registerValidatedListener('userscript:menu-unregister', commandIdSchema, (event, payload) => {
    manager()?.unregisterMenuCommand(event.sender.id, payload.commandId);
  });

  registerValidatedListener(
    'userscript:open-in-tab',
    z.object({ scriptId: z.string(), url: z.string() }),
    (event, payload) => {
      manager()?.openInTab(event.sender.id, payload.scriptId, payload.url);
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
    return { ok: notificationId !== null, notificationId };
  });

  ipcMain.handle('userscript:download', async (event, raw: unknown) => {
    const active = manager();
    const service = downloads();
    const parsed = z.object({ scriptId: z.string(), pageUrl: z.string(), details: downloadDetailsSchema, localId: z.number() }).safeParse(raw);
    if (!active || !service || !parsed.success) return { ok: false, error: 'not-ready' };
    const metadata = active.getScriptMetadata(parsed.data.scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments' };
    return service.download(event.sender.id, parsed.data.scriptId, parsed.data.pageUrl, metadata.metadata.connect, parsed.data.details, parsed.data.localId);
  });

  registerValidatedListener('userscript:download-abort', z.object({ localId: z.number() }), (event, payload) => {
    downloads()?.abort(event.sender.id, payload.localId);
  });

  ipcMain.handle('userscript:xhr-request', async (event, raw: unknown) => {
    const active = manager();
    const service = requests();
    const parsed = z.object({ scriptId: z.string(), pageUrl: z.string(), details: xhrDetailsSchema, localId: z.number() }).safeParse(raw);
    if (!active || !service || !parsed.success) return { ok: false, error: 'not-ready' };
    const metadata = active.getScriptMetadata(parsed.data.scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments', errorMessage: 'unknown script' };
    return service.request(event.sender.id, parsed.data.scriptId, parsed.data.pageUrl, metadata.metadata.connect, parsed.data.details, parsed.data.localId);
  });

  registerValidatedListener('userscript:xhr-abort', z.object({ localId: z.number() }), (event, payload) => {
    requests()?.abort(event.sender.id, payload.localId);
  });
}
