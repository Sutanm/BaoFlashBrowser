import { ipcMain } from 'electron';
import { z } from 'zod';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import { tabManager } from '../modules/tabs';
import { ruffleBundleInfo, ruffleJsContent } from '../modules/ruffle-bundle';
import log from 'electron-log';

export function registerTabsIPC(): void {
  ipcMain.on('password:form-detected', (event) => {
    tabManager.notifyPasswordFormDetected(event.sender.id);
  });

  // Sync handler: preload uses sendSync to get ruffle config at document-start
  ipcMain.on('get-ruffle-mode', (e) => {
    const ruffle = tabManager.getRuffleForWC(e.sender.id);
    e.returnValue = {
      enabled: ruffle?.enabled ?? false,
      source: ruffle?.source || 'bundled',
      js: (ruffle?.enabled && ruffle?.source !== 'cdn') ? ruffleJsContent() : '',
      bundle: (ruffle?.enabled && ruffle?.source !== 'cdn') ? ruffleBundleInfo() : null,
    };
  });

  const ruffleDiagnostic = z.object({
    phase: z.enum([
      'config', 'bundled-eval-ok', 'bundled-eval-error', 'cdn-loading', 'cdn-loaded', 'cdn-error',
      'runtime-ready', 'runtime-error', 'component-error',
    ]),
    detail: z.string().max(2000).optional(),
  }).strict();
  ipcMain.on('ruffle:diagnostic', (event, raw: unknown) => {
    const parsed = ruffleDiagnostic.safeParse(raw);
    const mode = tabManager.getRuffleForWC(event.sender.id);
    if (!parsed.success || !mode?.enabled) return;
    const suffix = parsed.data.detail ? ` — ${parsed.data.detail}` : '';
    log.info(`[Ruffle] wc=${event.sender.id} source=${mode.source || 'bundled'} phase=${parsed.data.phase}${suffix}`);
    event.sender.hostWebContents?.send('ruffle:diagnostic', {
      tabId: mode.tabId,
      source: mode.source || 'bundled',
      phase: parsed.data.phase,
      detail: parsed.data.detail,
    });
  });

  const tabId = z.string().min(1).max(128);
  const url = z.string().min(1).max(8192).refine((value) => {
    if (value === 'about:newtab' || value === 'about:blank') return true;
    try { return ['http:', 'https:', 'file:'].includes(new URL(value).protocol); } catch { return false; }
  }, 'Unsupported navigation URL');
  const tabOnly = z.object({ tabId }).strict();

  createValidatedHandler('tab:create', z.object({
    tabId,
    url,
    ruffleConfig: z.object({ enabled: z.boolean(), source: z.enum(['bundled', 'cdn']) }).optional(),
  }).strict(), (args) =>
    tabManager.create(args.tabId, args.url, args.ruffleConfig));

  createValidatedHandler('tab:close', tabOnly, (args) =>
    tabManager.close(args.tabId));

  createValidatedHandler('tab:suspend', tabOnly, (args) =>
    tabManager.suspend(args.tabId));

  createValidatedHandler('tab:activate', tabOnly, (args) =>
    tabManager.activate(args.tabId));

  createValidatedHandler('tab:navigate', z.object({ tabId, url }).strict(), (args) =>
    tabManager.navigate(args.tabId, args.url));

  createValidatedHandler('tab:goBack', tabOnly, (args) =>
    tabManager.goBack(args.tabId));

  createValidatedHandler('tab:goForward', tabOnly, (args) =>
    tabManager.goForward(args.tabId));

  createValidatedHandler('tab:reload', tabOnly, (args) =>
    tabManager.reload(args.tabId));

  createValidatedHandler('tab:stop', tabOnly, (args) =>
    tabManager.stop(args.tabId));

  createValidatedHandler('tab:zoom', z.object({ tabId, factor: z.number().min(0.25).max(5) }).strict(), (args) =>
    tabManager.setZoom(args.tabId, args.factor));

  createValidatedHandler('tab:mute', z.object({ tabId, muted: z.boolean() }).strict(), (args) =>
    tabManager.setMuted(args.tabId, args.muted));

  createValidatedHandler('tab:devtools', tabOnly, (args) =>
    tabManager.openDevTools(args.tabId));

  createValidatedHandler('tab:find', z.object({ tabId, text: z.string().max(10000), options: z.record(z.unknown()).optional() }).strict(), (args) =>
    tabManager.findInPage(args.tabId, args.text, args.options));

  createValidatedHandler('tab:stopFind', z.object({ tabId, action: z.enum(['clearSelection', 'keepSelection', 'activateSelection']) }).strict(), (args) =>
    tabManager.stopFindInPage(args.tabId, args.action));

  createValidatedHandler('tab:setBounds', z.object({
    x: z.number().int().min(-10000).max(50000), y: z.number().int().min(-10000).max(50000),
    w: z.number().int().min(0).max(50000), h: z.number().int().min(0).max(50000),
  }).strict(), (args) =>
    tabManager.setBounds(args.x ?? 0, args.y ?? 0, args.w ?? 0, args.h ?? 0));

  createValidatedHandler('tab:setRuffleMode', z.object({ tabId, enabled: z.boolean(), source: z.enum(['bundled', 'cdn']) }).strict(), (args) =>
    tabManager.setRuffleMode(args.tabId, args.enabled, args.source));
}
