// Userscript management IPC (stage 2): list/install/uninstall/enable/update.
// All payloads are zod-validated; file and URL installs fetch on the main
// process side (URL fetches are capped so a remote source cannot exhaust
// memory).

import { BrowserWindow, dialog, net } from 'electron';
import { z } from 'zod';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import log from 'electron-log';
import { tabManager } from '../modules/tabs';
import {
  installUserscript,
  listUserscripts,
  setUserscriptEnabled,
  uninstallUserscript,
  updateUserscriptSource,
  getUserscriptSource,
  getUserscriptManager,
} from '../modules/userscripts';
import { parseUserscriptMetadata } from '../modules/userscripts/userscript-parser';

const MAX_INSTALL_SOURCE_BYTES = 2 * 1024 * 1024;

function fetchInstallSource(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' });
    let received = 0;
    const chunks: Buffer[] = [];
    request.on('response', (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        try { (response as unknown as { resume(): void }).resume(); } catch { /* ignore */ }
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_INSTALL_SOURCE_BYTES) {
          try { request.abort(); } catch { /* ignore */ }
          reject(new Error(`source exceeds ${MAX_INSTALL_SOURCE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', (error) => reject(error));
    request.end();
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

  // Stage 2 sidebar: scripts matching the active tab URL + its menu commands.
  createValidatedHandler('userscripts:for-tab', z.object({ tabId: z.string(), url: z.string() }), async (payload) => ({
    scripts: getUserscriptManager()?.matchingFor(payload.url) ?? [],
    commands: tabManager.getUserscriptCommandsForTab(payload.tabId),
  }));

  createValidatedHandler('userscripts:invoke-command', z.object({ tabId: z.string(), commandId: z.string() }), async (payload) => ({
    ok: tabManager.invokeUserscriptCommand(payload.tabId, payload.commandId),
  }));
}
