import { ipcMain } from 'electron';
import { z } from 'zod';
import { getAutomationV3Service } from '../modules/automation/service-v3';
import { detectGameSurfaces } from '../modules/automation/game-surface-detector';
import { tabManager } from '../modules/tabs';
import { DEFAULT_IMAGE_MATCH_MASK } from '../../shared/automation/vision-policy';

/** Shared narrow authoring endpoints; each transport supplies its own caller gate. */
export function registerAutomationAssistantBridge(prefix: string, allowed: (wcId: number, scriptId: string) => boolean): void {
  ipcMain.handle(`${prefix}list`, async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string() }).strict().safeParse(raw);
    const service = getAutomationV3Service();
    if (!parsed.success || !service || !allowed(event.sender.id, parsed.data.scriptId)) return [];
    return service.listPackages();
  });

  ipcMain.handle(`${prefix}status`, async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string() }).strict().safeParse(raw);
    const service = getAutomationV3Service();
    if (!parsed.success || !service || !allowed(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    await service.ready;
    return service.status();
  });

  ipcMain.handle(`${prefix}start`, async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string(), packageId: z.string().min(1).max(128), frontendId: z.string().min(1).max(128), profilePath: z.string().max(500).optional() }).strict().safeParse(raw);
    const service = getAutomationV3Service();
    const targetTabId = tabManager.getTabIdForWebContents(event.sender.id);
    if (!parsed.success || !service || !targetTabId || !allowed(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    return service.start(parsed.data.packageId, parsed.data.frontendId, targetTabId, parsed.data.profilePath);
  });

  ipcMain.handle(`${prefix}cancel`, async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string() }).strict().safeParse(raw);
    const service = getAutomationV3Service();
    if (!parsed.success || !service || !allowed(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    await service.cancel();
    return { cancelled: true as const };
  });

  ipcMain.handle(`${prefix}asset-preview`, async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string(), packageId: z.string().min(1).max(128), asset: z.string().min(1).max(512) }).strict().safeParse(raw);
    const service = getAutomationV3Service();
    if (!parsed.success || !service || !allowed(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    return service.assetPreview(parsed.data.packageId, parsed.data.asset);
  });

  ipcMain.handle(`${prefix}warm`, async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string(), packageId: z.string().min(1).max(128) }).strict().safeParse(raw);
    const service = getAutomationV3Service();
    if (!parsed.success || !service || !allowed(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    await service.warmAuthoring(parsed.data.packageId);
    return { warm: true as const };
  });

  ipcMain.handle(`${prefix}capture`, async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string(), packageId: z.string().min(1).max(128), region: z.object({ x: z.number().min(0), y: z.number().min(0), width: z.number().min(1), height: z.number().min(1), viewportWidth: z.number().positive().optional(), viewportHeight: z.number().positive().optional() }).strict().optional(), referenceKind: z.enum(['viewport', 'region', 'surface']).optional() }).strict().safeParse(raw);
    const service = getAutomationV3Service();
    const targetTabId = tabManager.getTabIdForWebContents(event.sender.id);
    if (!parsed.success || !service || !targetTabId || !allowed(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    return service.captureAssetFrame(parsed.data.packageId, targetTabId, parsed.data.region, parsed.data.referenceKind);
  });

  ipcMain.handle(`${prefix}save-capture`, async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string(), packageId: z.string().min(1).max(128), token: z.string().regex(/^[a-f0-9]{32}$/u), assetName: z.string().min(1).max(180), rect: z.object({ x: z.number().min(0), y: z.number().min(0), width: z.number().min(1), height: z.number().min(1) }).strict(), overwrite: z.boolean() }).strict().safeParse(raw);
    const service = getAutomationV3Service();
    if (!parsed.success || !service || !allowed(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    try {
      return await service.saveCapturedAsset(parsed.data.packageId, parsed.data.token, parsed.data.assetName, parsed.data.rect, parsed.data.overwrite);
    } catch (error) {
      if (error instanceof Error && error.message === 'asset already exists') return { conflict: true as const };
      throw error;
    }
  });

  ipcMain.handle(`${prefix}match`, async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string(), packageId: z.string().min(1).max(128), asset: z.string().min(1).max(32_768), threshold: z.number().min(.1).max(1), scales: z.array(z.number().min(.25).max(4)).min(1).max(16).optional(), mask: z.enum(['auto', 'none', 'alpha']).optional(), region: z.object({ x: z.number().min(0), y: z.number().min(0), width: z.number().min(1), height: z.number().min(1), viewportWidth: z.number().positive().optional(), viewportHeight: z.number().positive().optional() }).strict().optional() }).strict().safeParse(raw);
    const service = getAutomationV3Service();
    const targetTabId = tabManager.getTabIdForWebContents(event.sender.id);
    if (!parsed.success || !service || !targetTabId || !allowed(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    return service.testAssetPreview(parsed.data.packageId, targetTabId, parsed.data.asset, parsed.data.threshold, parsed.data.scales, parsed.data.mask ?? DEFAULT_IMAGE_MATCH_MASK, parsed.data.region);
  });

  ipcMain.handle(`${prefix}ocr`, async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string(), packageId: z.string().min(1).max(128), text: z.string().trim().min(1).max(200), match: z.enum(['contains', 'exact']), minConfidence: z.number().min(0).max(1), region: z.object({ x: z.number().min(0), y: z.number().min(0), width: z.number().min(1), height: z.number().min(1), viewportWidth: z.number().positive().optional(), viewportHeight: z.number().positive().optional() }).strict().optional() }).strict().safeParse(raw);
    const service = getAutomationV3Service();
    const targetTabId = tabManager.getTabIdForWebContents(event.sender.id);
    if (!parsed.success || !service || !targetTabId || !allowed(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    return service.testTextPreview(parsed.data.packageId, targetTabId, parsed.data.text, parsed.data.match, parsed.data.minConfidence, parsed.data.region);
  });

  ipcMain.handle(`${prefix}surfaces`, async (event, raw: unknown) => {
    const parsed = z.object({ scriptId: z.string() }).strict().safeParse(raw);
    const targetTabId = tabManager.getTabIdForWebContents(event.sender.id);
    if (!parsed.success || !targetTabId || !allowed(event.sender.id, parsed.data.scriptId)) throw new Error('automation assistant access denied');
    return tabManager.inspectAutomationTarget(targetTabId, detectGameSurfaces);
  });
}
