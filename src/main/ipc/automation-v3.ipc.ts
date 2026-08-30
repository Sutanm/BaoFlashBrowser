import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { app, BrowserWindow, clipboard, dialog, nativeImage, type NativeImage } from 'electron';
import { z } from 'zod';
import { validateWorkflowDocument, type WorkflowDocumentV3 } from '../../shared/automation/core';
import { JAVASCRIPT_AUTOMATION_CAPABILITIES } from '../../shared/automation/javascript-grants';
import type { JavaScriptAutomationCapability } from '../../shared/automation/javascript-api';
import { loadAutomationPackageV3 } from '../modules/automation/package-v3';
import { AutomationPackageV3Repository } from '../modules/automation/package-v3-repository';
import { AutomationV3Service, setAutomationV3Service } from '../modules/automation/service-v3';
import { JavaScriptAutomationGrantStore } from '../modules/automation/javascript-grant-store';
import { createValidatedHandler } from '../utils/ipc-wrapper';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const name = z.string().trim().min(1).max(160);
const tabId = z.string().min(1).max(128);
const pending = new Map<string, { bytes: Uint8Array; timer: NodeJS.Timeout }>();
const testScenes = new Map<string, { image: NativeImage; timer: NodeJS.Timeout }>();
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

async function readImageDirectory(root: string): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        if (files.length >= 500) throw new Error('单次最多导入 500 张图片');
        files.push({ name: path.relative(path.dirname(root), absolute).replace(/\\/gu, '/'), bytes: new Uint8Array(await fs.promises.readFile(absolute)) });
      }
    }
  };
  await walk(root);
  if (!files.length) throw new Error('所选文件夹中没有可导入的图片');
  return files;
}

function retainTestScene(image: NativeImage, name: string) {
  const source = image.getSize(); const scale = Math.min(1, 1200 / source.width, 720 / source.height);
  const preview = scale < 1 ? image.resize({ width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)), quality: 'best' }) : image;
  const token = randomBytes(16).toString('hex'); const timer = setTimeout(() => testScenes.delete(token), 10 * 60_000); timer.unref();
  testScenes.set(token, { image, timer });
  while (testScenes.size > 3) { const oldest = testScenes.keys().next().value as string; const removed = testScenes.get(oldest); if (removed) clearTimeout(removed.timer); testScenes.delete(oldest); }
  const previewSize = preview.getSize();
  return { token, name, dataUrl: preview.toDataURL(), previewWidth: previewSize.width, previewHeight: previewSize.height, sourceWidth: source.width, sourceHeight: source.height };
}

export function registerAutomationV3IPC(getWin: () => BrowserWindow | null): AutomationV3Service {
  const repository = new AutomationPackageV3Repository(path.join(app.getPath('userData'), 'automation-v3', 'packages'));
  const service = new AutomationV3Service(repository, new JavaScriptAutomationGrantStore(path.join(app.getPath('userData'), 'automation-v3', 'grants.json')));
  setAutomationV3Service(service);
  createValidatedHandler('automation-v3:list', z.object({}).optional(), () => service.listPackages());
  createValidatedHandler('automation-v3:status', z.object({}).optional(), () => service.status());
  createValidatedHandler('automation-v3:get', z.object({ packageId: id }).strict(), ({ packageId }) => service.getPackage(packageId));
  createValidatedHandler('automation-v3:create', z.object({ id, name }).strict(), (input) => service.createPackage(input.id, input.name));
  createValidatedHandler('automation-v3:validate-workflow', z.object({ workflow: z.unknown() }).strict(), ({ workflow }) => {
    try { validateWorkflowDocument(workflow as WorkflowDocumentV3); return { valid: true as const, workflow: workflow as WorkflowDocumentV3 }; }
    catch (error) { return { valid: false as const, issues: [{ path: '', message: error instanceof Error ? error.message : String(error) }] }; }
  });
  createValidatedHandler('automation-v3:update-workflow', z.object({ packageId: id, workflow: z.unknown() }).strict(), ({ packageId, workflow }) => service.updateWorkflow(packageId, workflow as WorkflowDocumentV3));
  createValidatedHandler('automation-v3:upsert-script', z.object({
    packageId: id, id, name, source: z.string().max(512 * 1024), language: z.enum(['javascript', 'typescript']).optional(), permissions: z.array(z.enum(JAVASCRIPT_AUTOMATION_CAPABILITIES as [string, ...string[]])).max(JAVASCRIPT_AUTOMATION_CAPABILITIES.length),
  }).strict(), (input) => service.upsertScript(input as Parameters<AutomationV3Service['upsertScript']>[0]));
  createValidatedHandler('automation-v3:set-main-entry', z.object({ packageId: id, entryId: id }).strict(), ({ packageId, entryId }) => service.setMainEntry(packageId, entryId));
  createValidatedHandler('automation-v3:delete', z.object({ packageId: id }).strict(), async ({ packageId }) => { await service.remove(packageId); return { success: true as const }; });
  createValidatedHandler('automation-v3:open', z.object({ title: z.string().optional(), filterName: z.string().optional() }).strict(), async ({ title, filterName }) => {
    const win = getWin() ?? BrowserWindow.getFocusedWindow(); if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: [{ name: filterName ?? 'Bao Automation', extensions: ['baoauto'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const bytes = new Uint8Array(await fs.promises.readFile(result.filePaths[0]));
    const source = loadAutomationPackageV3(bytes);
    const token = randomBytes(16).toString('hex'); const timer = setTimeout(() => pending.delete(token), 2 * 60_000); timer.unref(); pending.set(token, { bytes, timer });
    return { canceled: false as const, token, packageId: source.manifest.id, name: source.manifest.name, scripts: source.manifest.frontends.scripts, exists: (await service.listPackages()).some((entry) => entry.packageId === source.manifest.id) };
  });
  createValidatedHandler('automation-v3:install', z.object({ token: z.string().regex(/^[a-f0-9]{32}$/u), replace: z.boolean().optional(), approvals: z.record(z.array(z.enum(JAVASCRIPT_AUTOMATION_CAPABILITIES as [string, ...string[]]))).optional() }).strict(), async ({ token, replace, approvals }) => {
    const item = pending.get(token); if (!item) throw new Error('automation import expired'); clearTimeout(item.timer); pending.delete(token); return service.install(item.bytes, replace, approvals as Record<string, JavaScriptAutomationCapability[]> | undefined);
  });
  createValidatedHandler('automation-v3:export', z.object({ packageId: id, title: z.string().optional(), filterName: z.string().optional() }).strict(), async ({ packageId, title, filterName }) => {
    const win = getWin() ?? BrowserWindow.getFocusedWindow(); if (!win) throw new Error('No window available');
    const result = await dialog.showSaveDialog(win, { title, defaultPath: `${packageId}.baoauto`, filters: [{ name: filterName ?? 'Bao Automation', extensions: ['baoauto'] }] });
    if (result.canceled || !result.filePath) return { canceled: true as const }; await fs.promises.writeFile(result.filePath, Buffer.from(await service.export(packageId))); return { canceled: false as const, filePath: result.filePath };
  });
  createValidatedHandler('automation-v3:start', z.object({ packageId: id, frontendId: id, tabId, profilePath: z.string().max(500).optional() }).strict(), ({ packageId, frontendId, tabId: targetTabId, profilePath }) => service.start(packageId, frontendId, targetTabId, profilePath));
  createValidatedHandler('automation-v3:cancel', z.object({}).optional(), async () => { await service.cancel(); return { success: true as const }; });
  createValidatedHandler('automation-v3:read-clipboard', z.object({}).optional(), () => clipboard.readText());
  createValidatedHandler('automation-v3:asset-preview', z.object({ packageId: id, asset: z.string().min(1).max(512) }).strict(), ({ packageId, asset }) => service.assetPreview(packageId, asset));
  createValidatedHandler('automation-v3:open-test-scene', z.object({}).optional(), async () => {
    const win = getWin() ?? BrowserWindow.getFocusedWindow(); if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, { title: '导入待测试画面', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const stat = await fs.promises.stat(result.filePaths[0]); if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('测试图片不能超过 32MB');
    const image = nativeImage.createFromBuffer(await fs.promises.readFile(result.filePaths[0])); if (image.isEmpty()) throw new Error('无法读取测试图片');
    return { canceled: false as const, ...retainTestScene(image, path.basename(result.filePaths[0])) };
  });
  createValidatedHandler('automation-v3:test-asset-on-scene', z.object({ packageId: id, token: z.string().regex(/^[a-f0-9]{32}$/u), asset: z.string().min(1).max(32_768), threshold: z.number().min(.1).max(1), scales: z.array(z.number().min(.25).max(4)).min(1).max(16), mask: z.enum(['auto', 'none', 'alpha']) }).strict(), async ({ packageId, token, asset, threshold, scales, mask }) => {
    const scene = testScenes.get(token); if (!scene) throw new Error('测试画面已过期，请重新导入');
    const candidate = await service.testAssetOnImage(packageId, asset, scene.image, threshold, scales, mask);
    return { candidate, matched: Boolean(candidate && candidate.score >= threshold), threshold };
  });
  createValidatedHandler('automation-v3:test-text-on-scene', z.object({ token: z.string().regex(/^[a-f0-9]{32}$/u), text: z.string().trim().min(1).max(200), match: z.enum(['contains', 'exact']), minConfidence: z.number().min(0).max(1) }).strict(), async ({ token, text, match, minConfidence }) => {
    const scene = testScenes.get(token); if (!scene) throw new Error('测试画面已过期，请重新导入');
    const candidate = await service.testTextOnImage(scene.image, text, match, minConfidence);
    return { candidate, matched: Boolean(candidate?.matched) };
  });
  createValidatedHandler('automation-v3:import-assets', z.object({ packageId: id }).strict(), async ({ packageId }) => {
    const win = getWin() ?? BrowserWindow.getFocusedWindow(); if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, { title: '导入图片素材', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片素材', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
    if (result.canceled) return { canceled: true as const };
    const files = await Promise.all(result.filePaths.map(async (filePath) => ({ name: path.basename(filePath), bytes: new Uint8Array(await fs.promises.readFile(filePath)) })));
    return { canceled: false as const, detail: await service.importAssets(packageId, files) };
  });
  createValidatedHandler('automation-v3:import-asset-folder', z.object({ packageId: id }).strict(), async ({ packageId }) => {
    const win = getWin() ?? BrowserWindow.getFocusedWindow(); if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, { title: '导入图片组文件夹', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    return { canceled: false as const, detail: await service.importAssets(packageId, await readImageDirectory(result.filePaths[0])) };
  });
  createValidatedHandler('automation-v3:delete-asset', z.object({ packageId: id, asset: z.string().min(1).max(512) }).strict(), ({ packageId, asset }) => service.deleteAsset(packageId, asset));
  createValidatedHandler('automation-v3:capture-asset-frame', z.object({ packageId: id, tabId }).strict(), ({ packageId, tabId: targetTabId }) => service.captureAssetFrame(packageId, targetTabId));
  createValidatedHandler('automation-v3:save-captured-asset', z.object({
    packageId: id, token: z.string().regex(/^[a-f0-9]{32}$/u), assetName: z.string().min(1).max(180),
    rect: z.object({ x: z.number().min(0), y: z.number().min(0), width: z.number().min(1), height: z.number().min(1) }).strict(), overwrite: z.boolean().optional(),
  }).strict(), ({ packageId, token, assetName, rect, overwrite }) => service.saveCapturedAsset(packageId, token, assetName, rect, overwrite));
  createValidatedHandler('automation-v3:test-asset', z.object({
    packageId: id, tabId, asset: z.string().min(1).max(32_768), threshold: z.number().min(.1).max(1), scales: z.array(z.number().min(.25).max(4)).min(1).max(16), mask: z.enum(['auto', 'none', 'alpha']),
  }).strict(), ({ packageId, tabId: targetTabId, asset, threshold, scales, mask }) => service.testAsset(packageId, targetTabId, asset, threshold, scales, mask));
  createValidatedHandler('automation-v3:test-text', z.object({
    packageId: id, tabId, text: z.string().trim().min(1).max(200), match: z.enum(['contains', 'exact']), minConfidence: z.number().min(0).max(1),
  }).strict(), ({ packageId, tabId: targetTabId, text, match, minConfidence }) => service.testText(packageId, targetTabId, text, match, minConfidence));
  createValidatedHandler('automation-v3:test-asset-preview', z.object({ packageId: id, tabId, asset: z.string().min(1).max(32_768), threshold: z.number().min(.1).max(1), scales: z.array(z.number().min(.25).max(4)).min(1).max(16), mask: z.enum(['auto', 'none', 'alpha']) }).strict(), ({ packageId, tabId: targetTabId, asset, threshold, scales, mask }) => service.testAssetPreview(packageId, targetTabId, asset, threshold, scales, mask));
  createValidatedHandler('automation-v3:test-text-preview', z.object({ packageId: id, tabId, text: z.string().trim().min(1).max(200), match: z.enum(['contains', 'exact']), minConfidence: z.number().min(0).max(1) }).strict(), ({ packageId, tabId: targetTabId, text, match, minConfidence }) => service.testTextPreview(packageId, targetTabId, text, match, minConfidence));
  return service;
}
