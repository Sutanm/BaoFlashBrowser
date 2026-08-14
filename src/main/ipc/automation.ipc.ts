import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, dialog, nativeImage } from 'electron';
import { z } from 'zod';
import { automationWorkflowSchema } from '../../shared/automation/schema';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import { AutomationService } from '../modules/automation/service';
import { scanAutomationAssets } from '../modules/automation/assets';
import { previewRectToSource } from '../modules/automation/capture-geometry';

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const packageId = z.string().min(1).max(160);
const tabId = z.string().min(1).max(128);
const scriptId = z.string().min(1).max(96).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const scriptName = z.string().min(1).max(120);
const assetId = z.string().min(1).max(512);
const writableAssetId = assetId.refine((value) => {
  if (!value.toLowerCase().endsWith('.png') || value.includes('\\') || value.startsWith('/')) return false;
  return value.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part));
}, 'asset id must be a safe relative PNG path');

let registeredAutomationService: AutomationService | null = null;
export function getAutomationService(): AutomationService | null { return registeredAutomationService; }

export function registerAutomationIPC(getWin: () => BrowserWindow | null): AutomationService {
  const service = new AutomationService({
    enabled: !app.isPackaged || process.env.BAO_AUTOMATION_M3 === '1',
    storageDir: path.join(app.getPath('userData'), 'automation', 'packages'),
    appVersion: app.getVersion(),
    emitStatus: (status) => getWin()?.webContents.send('automation:status-changed', status),
  });
  const captures = new Map<string, { image: Electron.NativeImage; previewWidth: number; previewHeight: number; createdAt: number; timer: NodeJS.Timeout }>();
  const testScenes = new Map<string, { image: Electron.NativeImage; previewWidth: number; previewHeight: number; createdAt: number; timer: NodeJS.Timeout }>();
  const liveTestScenes = new Map<string, { image: Electron.NativeImage; previewWidth: number; previewHeight: number; createdAt: number; timer: NodeJS.Timeout }>();
  const linkedAssetFolders = new Map<string, { packageId: string; root: string }>();
  const forgetLinkedFolders = (packageId: string): void => {
    for (const [token, linked] of linkedAssetFolders) if (linked.packageId === packageId) linkedAssetFolders.delete(token);
  };
  const expireCaptures = (): void => {
    const cutoff = Date.now() - 2 * 60_000;
    for (const [token, capture] of captures) if (capture.createdAt < cutoff) { clearTimeout(capture.timer); captures.delete(token); }
  };
  const expireScenes = (scenes: typeof testScenes): void => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [token, scene] of scenes) if (scene.createdAt < cutoff) { clearTimeout(scene.timer); scenes.delete(token); }
  };
  const retainTestScene = (image: Electron.NativeImage, name: string, scenes = testScenes): { token: string; name: string; dataUrl: string; previewWidth: number; previewHeight: number; sourceWidth: number; sourceHeight: number } => {
    const size = image.getSize();
    const scale = Math.min(1, 1200 / size.width, 720 / size.height);
    const previewWidth = Math.max(1, Math.round(size.width * scale));
    const previewHeight = Math.max(1, Math.round(size.height * scale));
    const preview = scale < 1 ? image.resize({ width: previewWidth, height: previewHeight }) : image;
    expireScenes(scenes);
    const token = randomBytes(16).toString('hex');
    const timer = setTimeout(() => scenes.delete(token), 10 * 60_000); timer.unref();
    scenes.set(token, { image, previewWidth, previewHeight, createdAt: Date.now(), timer });
    while (scenes.size > 2) {
      const oldest = scenes.keys().next().value as string;
      const removed = scenes.get(oldest); if (removed) clearTimeout(removed.timer);
      scenes.delete(oldest);
    }
    return { token, name, dataUrl: preview.toDataURL(), previewWidth, previewHeight, sourceWidth: size.width, sourceHeight: size.height };
  };

  createValidatedHandler('automation:capabilities', z.object({}).optional(), () => service.getStatus());
  createValidatedHandler('automation:validate-workflow', z.object({ workflow: z.unknown() }).strict(), ({ workflow }) => {
    const result = automationWorkflowSchema.safeParse(workflow);
    return result.success
      ? { valid: true as const, workflow: result.data }
      : { valid: false as const, issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) };
  });
  createValidatedHandler('automation:open-package', z.object({
    title: z.string().optional(),
    filterName: z.string().optional(),
    replace: z.string().optional(),
    cancel: z.string().optional(),
    existsTitle: z.string().optional(),
    existsMessage: z.string().optional(),
  }).optional(), async (payload) => {
    const win = getWin() ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, {
      title: payload?.title ?? 'Open Automation Script Package',
      properties: ['openFile'],
      filters: [{ name: payload?.filterName ?? 'BaoFlash Automation Scripts', extensions: ['baoauto'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const filePath = result.filePaths[0];
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new Error('automation package exceeds 32MB');
    await service.whenReady();
    const bytes = new Uint8Array(await fs.promises.readFile(filePath));
    let loaded: Awaited<ReturnType<AutomationService['loadPackage']>>;
    try { loaded = await service.loadPackage(bytes); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('automation script already exists:')) throw error;
      const confirmation = await dialog.showMessageBox(win, {
        type: 'question', buttons: [payload?.replace ?? 'Replace', payload?.cancel ?? 'Cancel'], defaultId: 0, cancelId: 1,
        title: payload?.existsTitle ?? 'Script Already Exists', message: payload?.existsMessage ?? 'A script with the same ID already exists. Replace it with the imported file?',
      });
      if (confirmation.response !== 0) return { canceled: true as const };
      loaded = await service.loadPackage(bytes, true);
    }
    return { canceled: false as const, ...loaded };
  });
  createValidatedHandler('automation:status', z.object({}).optional(), () => service.getStatus());
  createValidatedHandler('automation:list-packages', z.object({}).optional(), async () => { await service.whenReady(); return service.listPackages(); });
  createValidatedHandler('automation:get-package', z.object({ packageId }).strict(), async ({ packageId: id }) => { await service.whenReady(); return service.getPackage(id); });
  createValidatedHandler('automation:diagnose-package', z.object({ packageId }).strict(), async ({ packageId: id }) => { await service.whenReady(); return service.diagnosePackage(id); });
  createValidatedHandler('automation:list-run-history', z.object({ packageId: packageId.optional() }).strict(), async ({ packageId: id }) => { await service.whenReady(); return service.listRunHistory(id); });
  createValidatedHandler('automation:clear-run-history', z.object({ packageId: packageId.optional() }).strict(), async ({ packageId: id }) => { await service.whenReady(); await service.clearRunHistory(id); return { success: true as const }; });
  createValidatedHandler('automation:get-asset-preview', z.object({ packageId, asset: assetId }).strict(), async ({ packageId: id, asset }) => {
    await service.whenReady();
    const source = service.getAsset(id, asset);
    if (source.bytes.byteLength > 16 * 1024 * 1024) throw new Error('automation asset is too large to preview');
    const image = nativeImage.createFromBuffer(Buffer.from(source.bytes));
    if (image.isEmpty()) throw new Error(`unable to decode automation image asset: ${asset}`);
    const original = image.getSize();
    if (original.width > 16_384 || original.height > 16_384) throw new Error('automation asset dimensions exceed preview limit');
    const scale = Math.min(1, 280 / original.width, 180 / original.height);
    const preview = scale < 1 ? image.resize({ width: Math.max(1, Math.round(original.width * scale)), height: Math.max(1, Math.round(original.height * scale)) }) : image;
    return { asset, width: original.width, height: original.height, bytes: source.bytes.byteLength, dataUrl: preview.toDataURL() };
  });
  registeredAutomationService = service;
  createValidatedHandler('automation:open-test-scene', z.object({ title: z.string().optional(), filterName: z.string().optional() }).strict(), async ({ title, filterName }) => {
    const win = getWin() ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, { title: title ?? 'Select Target Scene', properties: ['openFile'], filters: [{ name: filterName ?? 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const stat = await fs.promises.stat(result.filePaths[0]);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('target scene exceeds 32MB');
    const image = nativeImage.createFromPath(result.filePaths[0]);
    if (image.isEmpty()) throw new Error('unable to decode target scene');
    const size = image.getSize();
    if (size.width > 16_384 || size.height > 16_384) throw new Error('target scene dimensions exceed limit');
    if (size.width * size.height > 8_000_000) throw new Error('target scene exceeds the 8 megapixel matching limit');
    return { canceled: false as const, ...retainTestScene(image, path.basename(result.filePaths[0])) };
  });
  createValidatedHandler('automation:capture-test-scene-tab', z.object({ tabId }).strict(), async ({ tabId: id }) => {
    await service.whenReady();
    const captured = await service.captureReferenceFrame(id);
    const image = nativeImage.createFromBuffer(Buffer.from(captured.png));
    if (image.isEmpty()) throw new Error('unable to decode selected tab capture');
    return retainTestScene(image, `tab-${id}.png`, liveTestScenes);
  });
  createValidatedHandler('automation:test-asset-on-scene', z.object({
    packageId, asset: assetId, token: z.string().regex(/^[a-f0-9]{32}$/), threshold: z.number().min(0.1).max(1),
    scales: z.array(z.number().min(0.25).max(4)).min(1).max(16).optional(), mask: z.enum(['none', 'alpha']).optional(),
  }).strict(), async ({ packageId: id, asset, token, threshold, scales, mask }) => {
    await service.whenReady(); expireScenes(testScenes); expireScenes(liveTestScenes);
    const scene = testScenes.get(token) ?? liveTestScenes.get(token);
    if (!scene) throw new Error('target scene expired; import it again');
    const size = scene.image.getSize();
    const match = await service.testAssetOnImage(id, asset, { width: size.width, height: size.height, bgra: Uint8Array.from(scene.image.toBitmap()) }, { scales, mask });
    if (!match) return { candidate: null, matched: false, threshold };
    return { candidate: match, matched: match.score >= threshold, threshold };
  });
  createValidatedHandler('automation:warmup-vision', z.object({ packageId }).strict(), async ({ packageId: id }) => {
    await service.whenReady(); await service.warmupVision(id); return { ready: true as const };
  });
  createValidatedHandler('automation:import-asset-files', z.object({ packageId, title: z.string().optional(), filterName: z.string().optional() }).strict(), async ({ packageId: id, title, filterName }) => {
    await service.whenReady();
    const win = getWin() ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, { title: title ?? 'Import UI Assets', properties: ['openFile', 'multiSelections'], filters: [{ name: filterName ?? 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled) return { canceled: true as const };
    const assets = new Map<string, Uint8Array>(); let total = 0;
    for (const filePath of result.filePaths) {
      const stat = await fs.promises.stat(filePath); total += stat.size;
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || total > 60 * 1024 * 1024) throw new Error('selected UI assets exceed size limit');
      const bytes = new Uint8Array(await fs.promises.readFile(filePath));
      if (nativeImage.createFromBuffer(Buffer.from(bytes)).isEmpty()) throw new Error(`unable to decode UI asset: ${path.basename(filePath)}`);
      assets.set(path.basename(filePath), bytes);
    }
    return { canceled: false as const, assets: await service.importAssets(id, assets) };
  });
  createValidatedHandler('automation:get-asset-references', z.object({ packageId, asset: assetId }).strict(), async ({ packageId: id, asset }) => {
    await service.whenReady(); return service.getAssetReferences(id, asset);
  });
  createValidatedHandler('automation:delete-asset', z.object({ packageId, asset: assetId }).strict(), async ({ packageId: id, asset }) => {
    await service.whenReady(); return { assets: await service.deleteAsset(id, asset) };
  });
  createValidatedHandler('automation:replace-asset', z.object({ packageId, asset: assetId, title: z.string().optional(), filterName: z.string().optional() }).strict(), async ({ packageId: id, asset, title, filterName }) => {
    await service.whenReady();
    const win = getWin() ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, { title: title ?? `Replace Asset ${asset}`, properties: ['openFile'], filters: [{ name: filterName ?? 'Image Assets', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const filePath = result.filePaths[0];
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('automation asset exceeds 16MB');
    const bytes = new Uint8Array(await fs.promises.readFile(filePath));
    if (nativeImage.createFromBuffer(Buffer.from(bytes)).isEmpty()) throw new Error('unable to decode replacement image');
    return { canceled: false as const, assets: await service.importAssets(id, new Map([[asset, bytes]])) };
  });
  createValidatedHandler('automation:capture-asset-frame', z.object({ tabId }).strict(), async ({ tabId: id }) => {
    await service.whenReady(); expireCaptures();
    const captured = await service.captureAssetFrame(id);
    const image = nativeImage.createFromBuffer(Buffer.from(captured.png));
    if (image.isEmpty()) throw new Error('unable to decode captured BrowserView frame');
    const scale = Math.min(1, 900 / captured.width, 560 / captured.height);
    const previewWidth = Math.max(1, Math.round(captured.width * scale));
    const previewHeight = Math.max(1, Math.round(captured.height * scale));
    const preview = scale < 1 ? image.resize({ width: previewWidth, height: previewHeight }) : image;
    const token = randomBytes(16).toString('hex');
    const timer = setTimeout(() => captures.delete(token), 2 * 60_000); timer.unref();
    captures.set(token, { image, previewWidth, previewHeight, createdAt: Date.now(), timer });
    while (captures.size > 3) {
      const oldest = captures.keys().next().value as string;
      const removed = captures.get(oldest); if (removed) clearTimeout(removed.timer);
      captures.delete(oldest);
    }
    return { token, dataUrl: preview.toDataURL(), previewWidth, previewHeight, sourceWidth: captured.width, sourceHeight: captured.height };
  });
  createValidatedHandler('automation:save-captured-asset', z.object({
    packageId, token: z.string().regex(/^[a-f0-9]{32}$/), asset: writableAssetId,
    rect: z.object({ x: z.number().min(0), y: z.number().min(0), width: z.number().min(2), height: z.number().min(2) }).strict(),
  }).strict(), async ({ packageId: id, token, asset, rect }) => {
    await service.whenReady(); expireCaptures();
    const capture = captures.get(token);
    if (!capture) throw new Error('captured frame expired; capture the page again');
    const sourceSize = capture.image.getSize();
    const crop = previewRectToSource(rect, { width: capture.previewWidth, height: capture.previewHeight }, sourceSize);
    const bytes = new Uint8Array(capture.image.crop(crop).toPNG());
    const assets = await service.importAssets(id, new Map([[asset, bytes]]));
    clearTimeout(capture.timer);
    captures.delete(token);
    return { asset, width: crop.width, height: crop.height, assets };
  });
  createValidatedHandler('automation:update-workflow', z.object({ packageId, workflow: z.unknown() }).strict(), async ({ packageId: id, workflow }) => {
    await service.whenReady(); return service.updateWorkflow(id, workflow);
  });
  createValidatedHandler('automation:create-package', z.object({ id: scriptId, name: scriptName }).strict(), async (args) => {
    await service.whenReady(); return service.createPackage(args.id, args.name);
  });
  createValidatedHandler('automation:duplicate-package', z.object({ packageId, id: scriptId, name: scriptName }).strict(), async (args) => {
    await service.whenReady(); return service.duplicatePackage(args.packageId, args.id, args.name);
  });
  createValidatedHandler('automation:delete-package', z.object({ packageId }).strict(), async ({ packageId: id }) => {
    await service.whenReady(); await service.deletePackage(id); forgetLinkedFolders(id); return { success: true as const };
  });
  createValidatedHandler('automation:import-assets', z.object({ packageId, title: z.string().optional() }).strict(), async ({ packageId: id, title }) => {
    await service.whenReady();
    const win = getWin() ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, { title: title ?? 'Select Asset Folder', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const scanned = scanAutomationAssets(result.filePaths[0]);
    const totalBytes = scanned.reduce((total, asset) => total + asset.bytes, 0);
    if (totalBytes > 60 * 1024 * 1024) throw new Error('asset directory exceeds 60MB');
    const assets = new Map<string, Uint8Array>();
    for (const asset of scanned) assets.set(asset.id, new Uint8Array(await fs.promises.readFile(asset.absolutePath)));
    return { canceled: false as const, assets: await service.importAssets(id, assets) };
  });
  createValidatedHandler('automation:link-asset-folder', z.object({ packageId, title: z.string().optional() }).strict(), async ({ packageId: id, title }) => {
    await service.whenReady(); service.getPackage(id);
    const win = getWin() ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, { title: title ?? 'Link Asset Folder', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const root = path.resolve(result.filePaths[0]);
    const scanned = scanAutomationAssets(root);
    const token = randomBytes(16).toString('hex');
    forgetLinkedFolders(id);
    while (linkedAssetFolders.size >= 16) linkedAssetFolders.delete(linkedAssetFolders.keys().next().value as string);
    linkedAssetFolders.set(token, { packageId: id, root });
    return { canceled: false as const, token, name: path.basename(root), files: scanned.map(({ id: asset, bytes }) => ({ asset, bytes })) };
  });
  createValidatedHandler('automation:sync-asset-folder', z.object({ packageId, token: z.string().regex(/^[a-f0-9]{32}$/) }).strict(), async ({ packageId: id, token }) => {
    await service.whenReady(); service.getPackage(id);
    const linked = linkedAssetFolders.get(token);
    if (!linked || linked.packageId !== id) throw new Error('linked asset folder is no longer available; link it again');
    const resolvedRoot = linked.root;
    const scanned = scanAutomationAssets(resolvedRoot);
    const totalBytes = scanned.reduce((total, item) => total + item.bytes, 0);
    if (totalBytes > 60 * 1024 * 1024) throw new Error('asset directory exceeds 60MB');
    const current = new Set(service.getPackage(id).assets);
    const changed = scanned.filter((item) => !current.has(item.id) || createHash('sha256').update(fs.readFileSync(item.absolutePath)).digest('hex') !== service.getAsset(id, item.id).cacheKey);
    const assets = new Map<string, Uint8Array>();
    for (const item of changed) assets.set(item.id, new Uint8Array(await fs.promises.readFile(item.absolutePath)));
    const nextAssets = assets.size ? await service.importAssets(id, assets) : service.getPackage(id).assets;
    return { assets: nextAssets, addedOrUpdated: changed.map((item) => item.id), missingFromFolder: nextAssets.filter((asset) => !scanned.some((item) => item.id === asset)) };
  });
  createValidatedHandler('automation:export-package', z.object({ packageId, title: z.string().optional(), filterName: z.string().optional() }).strict(), async ({ packageId: id, title, filterName }) => {
    await service.whenReady();
    const entry = service.getPackage(id);
    const win = getWin() ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No window available');
    const result = await dialog.showSaveDialog(win, {
      title: title ?? 'Export Automation Script Package',
      defaultPath: `${entry.workflow.id}.baoauto`,
      filters: [{ name: filterName ?? 'BaoFlash Automation Scripts', extensions: ['baoauto'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true as const };
    await fs.promises.writeFile(result.filePath, service.exportPackage(id));
    return { canceled: false as const, filePath: result.filePath };
  });
  createValidatedHandler('automation:check-ready', z.object({ packageId, tabId }).strict(), (args) =>
    service.whenReady().then(() => service.checkReady(args.packageId, args.tabId)));
  createValidatedHandler('automation:test-asset', z.object({
    packageId, tabId, asset: assetId,
    threshold: z.number().min(0.1).max(1),
    scales: z.array(z.number().min(0.25).max(4)).min(1).max(16).optional(),
    mask: z.enum(['none', 'alpha']).optional(),
  }).strict(), (args) => service.whenReady().then(() => service.testAsset(args.packageId, args.tabId, args.asset, {
    threshold: args.threshold, scales: args.scales, mask: args.mask,
  })));
  createValidatedHandler('automation:start', z.object({
    packageId, tabId, countdownMs: z.number().int().min(0).max(60_000).optional(),
  }).strict(), (args) => service.whenReady().then(() => service.start(args.packageId, args.tabId, args.countdownMs)));
  createValidatedHandler('automation:debug-start', z.object({ packageId, tabId }).strict(), async (args) => {
    await service.whenReady(); return service.startDebug(args.packageId, args.tabId);
  });
  createValidatedHandler('automation:debug-continue', z.object({}).optional(), () => service.continueDebug());
  createValidatedHandler('automation:cancel', z.object({}).optional(), () => service.cancel());
  return service;
}
