// Userscript management IPC (stage 2): list/install/uninstall/enable/update.
// All payloads are zod-validated; file and URL installs fetch on the main
// process side (URL fetches are capped so a remote source cannot exhaust
// memory).

import { BrowserWindow, dialog, net, webContents } from 'electron';
import { z } from 'zod';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import log from 'electron-log';
import { tabManager } from '../modules/tabs';
import { mergeSidebarCommands, resolveCommandRoute } from '../modules/userscripts/userscript-sidebar';
import { defaultExportFileName } from '../modules/userscripts/userscript-export';
import {
  installUserscript,
  listUserscripts,
  setUserscriptEnabled,
  uninstallUserscript,
  updateUserscriptSource,
  getUserscriptSource,
  getUserscriptManager,
  getBackgroundRuntime,
  checkUpdates,
  applyUpdate,
} from '../modules/userscripts';
import { parseUserscriptMetadata } from '../modules/userscripts/userscript-parser';
import { DEFAULT_MAX_REDIRECTS, DEFAULT_TIMEOUT_MS, isBlockedUrl } from '../modules/userscripts/userscript-request';

const MAX_INSTALL_SOURCE_BYTES = 2 * 1024 * 1024;

function fetchInstallSource(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (isBlockedUrl(url, ['127.0.0.1', 'localhost'])) {
      reject(new Error('address-blocked'));
      return;
    }
    const request = net.request({ url, redirect: 'manual' });
    let received = 0;
    let redirects = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, source?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(source ?? '');
    };
    const timer = setTimeout(() => {
      try { request.abort(); } catch { /* ignore */ }
      finish(new Error('timeout'));
    }, DEFAULT_TIMEOUT_MS);
    request.on('redirect', (_status: number, _method: string, redirectUrl: string) => {
      redirects += 1;
      if (redirects > DEFAULT_MAX_REDIRECTS) {
        try { request.abort(); } catch { /* ignore */ }
        finish(new Error('redirect-limit'));
        return;
      }
      if (isBlockedUrl(redirectUrl, ['127.0.0.1', 'localhost'])) {
        try { request.abort(); } catch { /* ignore */ }
        finish(new Error('address-blocked'));
        return;
      }
      try { (request as unknown as { followRedirect(): void }).followRedirect(); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    request.on('response', (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        try { (response as unknown as { resume(): void }).resume(); } catch { /* ignore */ }
        finish(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_INSTALL_SOURCE_BYTES) {
          try { request.abort(); } catch { /* ignore */ }
          finish(new Error(`source exceeds ${MAX_INSTALL_SOURCE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(undefined, Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', (error) => finish(error));
    try { request.end(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

export function registerUserscriptsAdminIPC(getWindow: () => BrowserWindow | null): void {
  createValidatedHandler('userscripts:list', z.object({}).optional(), async () => ({
    scripts: listUserscripts(),
  }));

  createValidatedHandler('userscripts:get-source', z.object({ id: z.string() }), async (payload) => ({
    source: getUserscriptSource(payload.id) ?? null,
  }));

  // Two-phase install: parse for preview first (never persists), then the
  // renderer shows the permission confirmation and calls install-source.
  createValidatedHandler('userscripts:parse-source', z.object({ source: z.string().max(MAX_INSTALL_SOURCE_BYTES) }), async (payload) => {
    const metadata = parseUserscriptMetadata(payload.source);
    if (!metadata) return { ok: false, error: '没有有效的 // ==UserScript== 元数据块' };
    return {
      ok: true,
      preview: {
        name: metadata.name,
        namespace: metadata.namespace ?? '',
        version: metadata.version ?? '',
        description: metadata.description ?? '',
        runAt: metadata.runAt,
        match: metadata.match,
        include: metadata.include,
        grant: metadata.grant,
        connect: metadata.connect,
        require: metadata.require,
        resource: metadata.resource,
        noframes: metadata.noframes,
      },
    };
  });

  createValidatedHandler(
    'userscripts:install-source',
    z.object({ source: z.string().max(MAX_INSTALL_SOURCE_BYTES), enabled: z.boolean().optional() }),
    async (payload) => installUserscript(payload.source, { enabled: payload.enabled }),
  );

  // File/URL pickers only FETCH the source; the renderer previews it and
  // calls install-source on confirmation (two-phase install, plan §13.2).
  createValidatedHandler('userscripts:install-file', z.object({}).optional(), async () => {
    const win = getWindow();
    const options: Electron.OpenDialogOptions = {
      title: '安装用户脚本',
      properties: ['openFile'],
      filters: [{ name: 'Userscript', extensions: ['js', 'user.js', 'txt'] }],
    };
    const result = win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return { ok: false, error: 'cancelled' };
    try {
      const source = await (await import('fs')).promises.readFile(result.filePaths[0], 'utf8');
      return { source };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  createValidatedHandler('userscripts:install-url', z.object({ url: z.string().url().max(2048) }), async (payload) => {
    try {
      const source = await fetchInstallSource(payload.url);
      return { source };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  createValidatedHandler('userscripts:uninstall', z.object({ id: z.string() }), async (payload) => ({
    ok: uninstallUserscript(payload.id),
  }));

  createValidatedHandler(
    'userscripts:set-enabled',
    z.object({ id: z.string(), enabled: z.boolean() }),
    async (payload) => ({ ok: setUserscriptEnabled(payload.id, payload.enabled) }),
  );

  createValidatedHandler(
    'userscripts:update-source',
    z.object({ id: z.string(), source: z.string().max(MAX_INSTALL_SOURCE_BYTES) }),
    async (payload) => {
      const result = updateUserscriptSource(payload.id, payload.source);
      if (!result.ok) log.warn(`[userscripts] update failed for ${payload.id}: ${result.error}`);
      return result;
    },
  );

  // Stage 2 sidebar: scripts matching the active tab URL + its menu commands,
  // merged with @background runtime commands (marked background: true).
  createValidatedHandler('userscripts:for-tab', z.object({ tabId: z.string(), url: z.string() }), async (payload) => {
    const manager = getUserscriptManager();
    const bgWcIds = getBackgroundRuntime()?.getWcIds() ?? [];
    const bgCommands = bgWcIds.flatMap((wcId) => (manager?.commandsFor(wcId) ?? []));
    return {
      scripts: manager?.matchingFor(payload.url) ?? [],
      commands: mergeSidebarCommands(tabManager.getUserscriptCommandsForTab(payload.tabId), bgCommands),
    };
  });

  // Invoke: try the tab's view first; fall back to the background runtime via
  // the manager's commandTarget (P0-2).
  createValidatedHandler('userscripts:invoke-command', z.object({ tabId: z.string(), commandId: z.string() }), async (payload) => {
    const tabInvoked = tabManager.invokeUserscriptCommand(payload.tabId, payload.commandId);
    const target = getUserscriptManager()?.commandTarget(payload.commandId) ?? null;
    const route = resolveCommandRoute(tabInvoked, target !== null);
    if (route === 'background' && target) {
      const wc = webContents.fromId(target.wcId);
      if (wc && !wc.isDestroyed()) {
        try {
          wc.send('userscript:menu-invoke', { commandId: payload.commandId, documentId: target.documentId });
          return { ok: true };
        } catch { /* view gone */ }
      }
    }
    return { ok: route !== 'none' };
  });

  // @background runtime status + manual restart (optionally one script only).
  createValidatedHandler('userscripts:background-status', z.object({}).optional(), async () =>
    getBackgroundRuntime()?.getStatus() ?? { scripts: [], stopped: false });
  createValidatedHandler('userscripts:background-restart', z.object({ id: z.string().optional() }).optional(), async (payload) => {
    const runtime = getBackgroundRuntime();
    if (payload?.id) runtime?.restartScript(payload.id);
    else runtime?.restart();
    return { ok: true };
  });

  // Manual update check / apply (@updateURL). Serialized in the service.
  createValidatedHandler('userscripts:check-updates', z.object({}).optional(), async () => checkUpdates());
  createValidatedHandler('userscripts:apply-update', z.object({ id: z.string() }), async (payload) => applyUpdate(payload.id));

  // Export a script as .user.js via the save dialog.
  createValidatedHandler('userscripts:export-source', z.object({ id: z.string() }), async (payload) => {
    const source = getUserscriptSource(payload.id);
    if (source === undefined) return { ok: false, error: 'not-found' };
    const script = listUserscripts().find((s) => s.id === payload.id);
    const win = getWindow();
    const options: Electron.SaveDialogOptions = {
      title: '导出脚本',
      defaultPath: defaultExportFileName(script?.metadata.name ?? payload.id),
      filters: [{ name: 'Userscript', extensions: ['user.js', 'js'] }],
    };
    const result = win && !win.isDestroyed()
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
    try {
      await (await import('fs')).promises.writeFile(result.filePath, source, 'utf8');
      return { ok: true, path: result.filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // GM value management (admin page: view/edit/delete a script's values).
  createValidatedHandler('userscripts:list-values', z.object({ id: z.string() }), async (payload) => ({
    values: getUserscriptManager()?.listScriptValues(payload.id) ?? {},
  }));
  createValidatedHandler('userscripts:set-value-admin',
    z.object({ id: z.string(), key: z.string().min(1), value: z.unknown() }),
    async (payload) => ({
      ok: getUserscriptManager()?.setScriptValue(payload.id, payload.key, payload.value as import('../../shared/userscript-types').GMSerializable) ?? false,
    }));
  createValidatedHandler('userscripts:delete-value-admin',
    z.object({ id: z.string(), key: z.string().min(1) }),
    async (payload) => ({
      ok: getUserscriptManager()?.deleteScriptValue(payload.id, payload.key) ?? false,
    }));
}
