import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import log from 'electron-log';
import type { AutomationRuntimeEvent, AutomationRunnerState, ImageMatch } from './runtime';
import { AutomationRunner } from './runtime';
import { BrowserViewAutomationDriver } from './browserview-driver';
import { NativeImageTemplateProvider } from './native-image-template-provider';
import { CachingAutomationTemplateProvider, OpenCvWorkerMatcher } from './vision-worker-matcher';
import { inferAutomationCapabilities, loadAutomationPackage, serializeAutomationPackage, type LoadedAutomationPackage } from './package';
import { collectWorkflowAssetIds, parseAutomationWorkflow } from '../../../shared/automation/schema';
import { createAutomationAbortController } from '../../../shared/automation/abort-controller';
import { DEFAULT_AUTOMATION_VIEWPORT } from '../../../shared/automation/types';
import type { AutomationImageMask, AutomationMessage, AutomationStep, AutomationWorkflow } from '../../../shared/automation/types';
import { PROJECT_PROVENANCE, PROVENANCE_SHORT_ID } from '../../../shared/provenance';
import { tabManager, type AutomationTabHandle } from '../tabs';
import { chooseLocatedGameSurface, chooseMatchingGameSurface, chooseReplacementGameSurface, detectGameSurfaces as detectTabGameSurfaces, type GameSurfaceCandidate } from './game-surface-detector';

export type AutomationServiceStatus = {
  enabled: boolean;
  state: AutomationRunnerState;
  packageId?: string;
  workflowName?: string;
  tabId?: string;
  message?: AutomationMessage;
  currentStep?: AutomationMessage;
  executedSteps?: number;
  debugMode?: boolean;
  debugPaused?: boolean;
  logs?: AutomationLogEntry[];
};

export type AutomationLogEntry = {
  id: number;
  timestamp: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: AutomationMessage;
  step?: number;
};

export type AutomationRunRecord = {
  id: string; packageId: string; workflowName: string; tabId: string; mode: 'run' | 'debug';
  startedAt: number; finishedAt: number; state: 'completed' | 'failed' | 'cancelled'; executedSteps: number;
  logs: AutomationLogEntry[];
};

export type AutomationPackageDiagnostic = {
  packageId: string; valid: boolean; assetCount: number; assetBytes: number; referencedAssets: number;
  unreferencedAssets: string[]; missingAssets: string[]; stepCount: number; maxDepth: number; capabilities: string[];
  issues: Array<{ level: 'info' | 'warning' | 'error'; code: string; detail: string }>;
};

type LoadedEntry = {
  id: string;
  source: LoadedAutomationPackage;
  assetKeys: Map<string, string>;
};

type ActiveSession = {
  packageId: string;
  tabId: string;
  handle: AutomationTabHandle;
  matcher: OpenCvWorkerMatcher | null;
  runner: AutomationRunner;
  history?: { id: string; mode: 'run' | 'debug'; startedAt: number };
};

type ActiveProbe = {
  controller: AbortController;
  handle: AutomationTabHandle;
  matcher: OpenCvWorkerMatcher;
};

type ImageTestSession = {
  matcher: OpenCvWorkerMatcher;
  queue: Promise<void>;
  closeTimer: NodeJS.Timeout;
};

type ActiveAuthoringViewport = {
  tabId: string;
  handle: AutomationTabHandle;
  timer: NodeJS.Timeout;
};

type IdleRuntimeMatcher = {
  matcher: OpenCvWorkerMatcher;
  closeTimer: NodeJS.Timeout;
};

type BoundGameSurface = {
  webContentsId: number;
  fingerprint: string;
  candidate: GameSurfaceCandidate;
};

const RUNTIME_MATCHER_IDLE_MS = 60_000;

export class AutomationService {
  private readonly enabled: boolean;
  private readonly emitStatus: (status: AutomationServiceStatus) => void;
  private readonly storageDir?: string;
  private readonly appVersion: string;
  private readonly ready: Promise<void>;
  private readonly packages = new Map<string, LoadedEntry>();
  private active: ActiveSession | null = null;
  private probe: ActiveProbe | null = null;
  private authoringViewport: ActiveAuthoringViewport | null = null;
  private readonly imageTests = new Map<string, ImageTestSession>();
  private readonly runtimeMatchers = new Map<string, IdleRuntimeMatcher>();
  private readonly detectedGameSurfaces = new Map<string, GameSurfaceCandidate[]>();
  private readonly boundGameSurfaces = new Map<string, BoundGameSurface>();
  private status: AutomationServiceStatus;
  private nextLogId = 1;
  private runHistory: AutomationRunRecord[] = [];
  private historyWrite: Promise<void> = Promise.resolve();

  constructor(options: { enabled?: boolean; storageDir?: string; appVersion?: string; emitStatus?: (status: AutomationServiceStatus) => void } = {}) {
    this.enabled = options.enabled ?? true;
    this.emitStatus = options.emitStatus ?? (() => {});
    this.storageDir = options.storageDir ? path.resolve(options.storageDir) : undefined;
    this.appVersion = options.appVersion ?? '0.0.0';
    this.status = { enabled: this.enabled, state: 'idle' };
    this.ready = this.initialize();
  }

  whenReady(): Promise<void> { return this.ready; }

  getStatus(): AutomationServiceStatus { return { ...this.status }; }

  async detectGameSurfaces(tabId: string): Promise<{ candidates: GameSurfaceCandidate[]; bound: GameSurfaceCandidate | null }> {
    this.assertEnabled();
    if (this.active || this.probe) throw new Error('another automation session is active');
    if (this.authoringViewport && this.authoringViewport.tabId !== tabId) this.endAuthoringViewport(this.authoringViewport.tabId);
    const candidates = this.authoringViewport?.tabId === tabId
      ? await detectTabGameSurfaces(this.authoringViewport.handle.webContents)
      : await tabManager.inspectAutomationTarget(tabId, detectTabGameSurfaces);
    this.detectedGameSurfaces.set(tabId, candidates);
    const binding = this.boundGameSurfaces.get(tabId);
    const wc = tabManager.getWebContents(tabId);
    const bound = binding && wc && binding.webContentsId === wc.id
      ? chooseMatchingGameSurface(candidates, binding.fingerprint) ?? chooseReplacementGameSurface(candidates, binding.candidate) : null;
    if (bound && binding) { binding.candidate = bound; binding.fingerprint = bound.fingerprint; }
    return { candidates, bound };
  }

  bindGameSurface(tabId: string, candidateId: string): GameSurfaceCandidate {
    const candidate = this.detectedGameSurfaces.get(tabId)?.find((item) => item.id === candidateId);
    const wc = tabManager.getWebContents(tabId);
    if (!candidate || !wc) throw new Error('game surface candidate expired; detect the page again');
    this.boundGameSurfaces.set(tabId, { webContentsId: wc.id, fingerprint: candidate.fingerprint, candidate });
    return candidate;
  }

  clearGameSurface(tabId: string): void {
    this.detectedGameSurfaces.delete(tabId);
    this.boundGameSurfaces.delete(tabId);
  }

  private async refreshBoundGameSurface(tabId: string): Promise<void> {
    const binding = this.boundGameSurfaces.get(tabId);
    if (!binding) return;
    const wc = tabManager.getWebContents(tabId);
    if (!wc || binding.webContentsId !== wc.id) {
      this.clearGameSurface(tabId);
      return;
    }
    const result = await this.detectGameSurfaces(tabId);
    const candidate = chooseMatchingGameSurface(result.candidates, binding.fingerprint)
      ?? chooseReplacementGameSurface(result.candidates, binding.candidate);
    if (!candidate) throw new Error('无法重新定位已选择的游戏画面，请在自动化助手中重新选择');
    binding.candidate = candidate; binding.fingerprint = candidate.fingerprint;
  }

  private async prepareWorkflowGameSurface(entry: LoadedEntry, tabId: string, wait: boolean): Promise<boolean> {
    const locator = entry.source.workflow.gameSurface;
    if (!locator) {
      await this.refreshBoundGameSurface(tabId);
      return true;
    }
    const timeoutMs = wait ? (entry.source.workflow.gameSurfaceTimeoutMs ?? 30_000) : 0;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await this.detectGameSurfaces(tabId);
      const candidate = chooseLocatedGameSurface(result.candidates, locator);
      const wc = tabManager.getWebContents(tabId);
      if (candidate && wc) {
        this.boundGameSurfaces.set(tabId, { webContentsId: wc.id, fingerprint: candidate.fingerprint, candidate });
        return true;
      }
      if (!wait || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  async beginAuthoringViewport(tabId: string): Promise<void> {
    this.assertEnabled();
    if (this.active || this.probe) throw new Error('another automation session is active');
    if (this.authoringViewport?.tabId === tabId) {
      clearTimeout(this.authoringViewport.timer);
      this.authoringViewport.timer = this.scheduleAuthoringViewportRelease(tabId);
      await this.authoringViewport.handle.ready;
      return;
    }
    // Authoring is a short-lived, read-only reservation. Moving from the
    // workbench or another tab to the assistant must transfer that reservation
    // instead of leaving the next tab blocked for the five-minute idle timeout.
    if (this.authoringViewport) this.endAuthoringViewport(this.authoringViewport.tabId);
    const handle = tabManager.beginAutomation(tabId, DEFAULT_AUTOMATION_VIEWPORT);
    const timer = this.scheduleAuthoringViewportRelease(tabId);
    this.authoringViewport = { tabId, handle, timer };
    try { await handle.ready; }
    catch (error) { this.endAuthoringViewport(tabId); throw error; }
  }

  endAuthoringViewport(tabId: string): void {
    const active = this.authoringViewport;
    if (!active || active.tabId !== tabId) return;
    this.authoringViewport = null;
    clearTimeout(active.timer);
    active.handle.release();
  }

  private scheduleAuthoringViewportRelease(tabId: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.endAuthoringViewport(tabId), 5 * 60_000);
    timer.unref();
    return timer;
  }

  listPackages(): Array<{ packageId: string; id: string; name: string; assets: string[] }> {
    return [...this.packages.values()].map((entry) => ({
      packageId: entry.id,
      id: entry.source.manifest.id,
      name: entry.source.workflow.name,
      assets: [...entry.source.assets.keys()],
    }));
  }

  getPackage(packageId: string): { packageId: string; workflow: AutomationWorkflow; assets: string[] } {
    const entry = this.requirePackage(packageId);
    return { packageId, workflow: entry.source.workflow, assets: [...entry.source.assets.keys()] };
  }

  diagnosePackage(packageId: string): AutomationPackageDiagnostic {
    const entry = this.requirePackage(packageId);
    const referenced = collectWorkflowAssetIds(entry.source.workflow);
    const available = new Set(entry.source.assets.keys());
    const missingAssets = [...referenced].filter((asset) => !available.has(asset)).sort();
    const unreferencedAssets = [...available].filter((asset) => !referenced.has(asset)).sort();
    const { stepCount, maxDepth } = this.measureWorkflow(entry.source.workflow.root);
    const assetBytes = [...entry.source.assets.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
    const capabilities = inferAutomationCapabilities(entry.source.workflow);
    const issues: AutomationPackageDiagnostic['issues'] = [];
    if (missingAssets.length) issues.push({ level: 'error', code: 'missing-assets', detail: missingAssets.join(', ') });
    if (!entry.source.workflow.root.steps.length) issues.push({ level: 'warning', code: 'empty-workflow', detail: 'workflow has no executable steps' });
    if (unreferencedAssets.length) issues.push({ level: 'info', code: 'unreferenced-assets', detail: `${unreferencedAssets.length} assets are not referenced` });
    if (available.size > 300) issues.push({ level: 'warning', code: 'many-assets', detail: `${available.size} assets may slow down authoring` });
    if (assetBytes > 40 * 1024 * 1024) issues.push({ level: 'warning', code: 'large-package', detail: `assets use ${(assetBytes / 1024 / 1024).toFixed(1)} MB` });
    if (stepCount > 500) issues.push({ level: 'warning', code: 'many-steps', detail: `${stepCount} steps may be difficult to maintain` });
    if (maxDepth > 16) issues.push({ level: 'warning', code: 'deep-workflow', detail: `workflow nesting depth is ${maxDepth}` });
    if (entry.source.manifest.minimumAppVersion && this.compareVersions(this.appVersion, entry.source.manifest.minimumAppVersion) < 0) issues.push({ level: 'error', code: 'app-version', detail: `requires app ${entry.source.manifest.minimumAppVersion}, current ${this.appVersion}` });
    if (JSON.stringify(entry.source.manifest.capabilities ?? []) !== JSON.stringify(capabilities)) issues.push({ level: 'info', code: 'capabilities-refreshed', detail: 'capability declaration will be refreshed on export' });
    return { packageId, valid: !issues.some((issue) => issue.level === 'error'), assetCount: available.size, assetBytes, referencedAssets: referenced.size, unreferencedAssets, missingAssets, stepCount, maxDepth, capabilities, issues };
  }

  async listRunHistory(packageId?: string): Promise<AutomationRunRecord[]> {
    await this.historyWrite;
    return this.runHistory.filter((record) => !packageId || record.packageId === packageId).map((record) => ({ ...record, logs: record.logs.map((entry) => ({ ...entry })) }));
  }

  async clearRunHistory(packageId?: string): Promise<void> {
    this.runHistory = packageId ? this.runHistory.filter((record) => record.packageId !== packageId) : [];
    this.queueHistoryWrite(); await this.historyWrite;
  }

  getAsset(packageId: string, asset: string): { bytes: Uint8Array; cacheKey: string } {
    const entry = this.requirePackage(packageId);
    const bytes = entry.source.assets.get(asset);
    const cacheKey = entry.assetKeys.get(asset);
    if (!bytes || !cacheKey) throw new Error(`automation asset is missing: ${asset}`);
    return { bytes: Uint8Array.from(bytes), cacheKey };
  }

  getAssetReferences(packageId: string, asset: string): { referenced: boolean } {
    const entry = this.requirePackage(packageId);
    return { referenced: collectWorkflowAssetIds(entry.source.workflow).has(asset) };
  }

  async deleteAsset(packageId: string, asset: string): Promise<string[]> {
    const entry = this.requirePackage(packageId);
    if (this.active?.packageId === packageId || this.probe) throw new Error('cannot update assets while the script is running');
    if (!entry.source.assets.has(asset)) throw new Error(`automation asset is missing: ${asset}`);
    if (collectWorkflowAssetIds(entry.source.workflow).has(asset)) throw new Error(`automation asset is referenced by the workflow: ${asset}`);
    const previousAssets = entry.source.assets;
    const previousKeys = entry.assetKeys;
    entry.source.assets = new Map(previousAssets);
    entry.source.assets.delete(asset);
    entry.assetKeys = this.createEntry(entry.source).assetKeys;
    try { await this.persistEntry(entry); }
    catch (error) { entry.source.assets = previousAssets; entry.assetKeys = previousKeys; throw error; }
    await this.closeRuntimeMatcher(packageId);
    return [...entry.source.assets.keys()];
  }

  async captureAssetFrame(tabId: string): Promise<{ png: Uint8Array; width: number; height: number }> {
    this.assertEnabled();
    if (this.active || this.probe || this.authoringViewport) throw new Error('another automation session is active');
    const handle = tabManager.beginAutomation(tabId, DEFAULT_AUTOMATION_VIEWPORT);
    const wc = handle.webContents;
    let capturing = false;
    try {
      await handle.ready;
      wc.incrementCapturerCount();
      capturing = true;
      const image = await wc.capturePage();
      if (image.isEmpty()) throw new Error('BrowserView capture is empty');
      const size = image.getSize();
      return { png: Uint8Array.from(image.toPNG()), width: size.width, height: size.height };
    } finally {
      if (capturing) wc.decrementCapturerCount();
      handle.release();
    }
  }

  async updateWorkflow(packageId: string, workflow: unknown): Promise<AutomationWorkflow> {
    if (this.active?.packageId === packageId || this.probe) throw new Error('cannot update a running automation script');
    const entry = this.requirePackage(packageId);
    const parsed = parseAutomationWorkflow(workflow);
    serializeAutomationPackage(entry.source, parsed);
    const previousWorkflow = entry.source.workflow;
    const previousManifest = entry.source.manifest;
    entry.source.workflow = parsed;
    entry.source.manifest = { ...entry.source.manifest, name: parsed.name };
    try { await this.persistEntry(entry); }
    catch (error) { entry.source.workflow = previousWorkflow; entry.source.manifest = previousManifest; throw error; }
    await this.closeRuntimeMatcher(packageId);
    return parsed;
  }

  exportPackage(packageId: string): Uint8Array {
    const entry = this.requirePackage(packageId);
    return serializeAutomationPackage(entry.source);
  }

  async loadPackage(bytes: Uint8Array, replace = false): Promise<{ packageId: string; id: string; name: string; assets: string[] }> {
    const source = loadAutomationPackage(bytes);
    const packageId = source.manifest.id;
    const exists = this.packages.has(packageId);
    if (exists && !replace) throw new Error(`automation script already exists: ${packageId}`);
    if (exists && (this.active?.packageId === packageId || this.probe)) throw new Error('cannot replace a running automation script');
    const entry = this.createEntry(source);
    await this.persistEntry(entry, !exists);
    if (exists) {
      await this.closeImageTestSession(packageId);
      await this.closeRuntimeMatcher(packageId);
    }
    this.packages.set(packageId, entry);
    return { packageId, id: source.manifest.id, name: source.manifest.name, assets: [...source.assets.keys()] };
  }

  async createPackage(id: string, name: string): Promise<{ packageId: string; id: string; name: string; assets: string[] }> {
    const workflow = parseAutomationWorkflow({ formatVersion: 2, viewport: DEFAULT_AUTOMATION_VIEWPORT, id, name, root: { type: 'sequence', steps: [] } });
    if (this.packages.has(workflow.id)) throw new Error(`automation script already exists: ${workflow.id}`);
    const source: LoadedAutomationPackage = {
      manifest: {
        format: 'baoauto',
        formatVersion: 2,
        id: workflow.id,
        name: workflow.name,
        workflow: 'workflow.json',
        assets: 'assets/',
        createdBy: `${PROJECT_PROVENANCE.project} Automation Workbench · ${PROJECT_PROVENANCE.author} · ${PROVENANCE_SHORT_ID}`,
      },
      workflow,
      assets: new Map(),
    };
    const entry = this.createEntry(source);
    await this.persistEntry(entry, true);
    this.packages.set(entry.id, entry);
    return { packageId: entry.id, id: workflow.id, name: workflow.name, assets: [] };
  }

  async duplicatePackage(packageId: string, id: string, name: string): Promise<{ packageId: string; id: string; name: string; assets: string[] }> {
    const original = this.requirePackage(packageId);
    const workflow = parseAutomationWorkflow({ ...original.source.workflow, id, name });
    if (this.packages.has(workflow.id)) throw new Error(`automation script already exists: ${workflow.id}`);
    const source: LoadedAutomationPackage = {
      manifest: { ...original.source.manifest, id: workflow.id, name: workflow.name },
      workflow,
      assets: new Map([...original.source.assets].map(([asset, bytes]) => [asset, Uint8Array.from(bytes)])),
    };
    const entry = this.createEntry(source);
    await this.persistEntry(entry, true);
    this.packages.set(entry.id, entry);
    return { packageId: entry.id, id: workflow.id, name: workflow.name, assets: [...source.assets.keys()] };
  }

  async deletePackage(packageId: string): Promise<void> {
    if (this.active?.packageId === packageId || this.probe) throw new Error('cannot delete a running automation script');
    this.requirePackage(packageId);
    if (this.storageDir) {
      try { await fs.promises.unlink(this.packagePath(packageId)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await this.closeImageTestSession(packageId);
    await this.closeRuntimeMatcher(packageId);
    this.packages.delete(packageId);
    if (this.runHistory.some((record) => record.packageId === packageId)) {
      this.runHistory = this.runHistory.filter((record) => record.packageId !== packageId);
      this.queueHistoryWrite();
    }
  }

  async importAssets(packageId: string, assets: Map<string, Uint8Array>): Promise<string[]> {
    const entry = this.requirePackage(packageId);
    if (this.active?.packageId === packageId || this.probe) throw new Error('cannot update assets while the script is running');
    const previousAssets = entry.source.assets;
    const previousKeys = entry.assetKeys;
    const merged = new Map([...previousAssets, ...assets]);
    const totalBytes = [...merged.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
    if (totalBytes > 60 * 1024 * 1024) throw new Error('installed automation assets exceed 60MB');
    entry.source.assets = merged;
    entry.assetKeys = this.createEntry(entry.source).assetKeys;
    try { await this.persistEntry(entry); }
    catch (error) { entry.source.assets = previousAssets; entry.assetKeys = previousKeys; throw error; }
    await this.closeRuntimeMatcher(packageId);
    return [...entry.source.assets.keys()];
  }

  async checkReady(packageId: string, tabId: string): Promise<boolean> {
    this.assertEnabled();
    const entry = this.requirePackage(packageId);
    if (!await this.prepareWorkflowGameSurface(entry, tabId, false)) return false;
    const session = this.ensureSession(packageId, tabId);
    try {
      await session.handle.ready;
      const ready = await session.runner.checkReady();
      return ready;
    } catch (error) {
      if (session.runner.state === 'cancelled') return false;
      this.setStatus({ state: 'failed', message: { key: 'status.readyCheckFailed', params: { detail: this.errorMessage(error) } } });
      this.appendLog('error', { key: 'status.readyCheckFailed', params: { detail: this.errorMessage(error) } }, this.status.executedSteps);
      throw error;
    } finally {
      await this.disposeSession(session);
    }
  }

  async start(packageId: string, tabId: string, countdownMs = 0): Promise<boolean> {
    this.assertEnabled();
    const entry = this.requirePackage(packageId);
    if (!await this.prepareWorkflowGameSurface(entry, tabId, true)) throw new Error('未找到脚本指定的游戏画面');
    const session = this.ensureSession(packageId, tabId);
    this.beginHistory(session, 'run');
    try {
      await session.handle.ready;
      return await session.runner.run({ countdownMs });
    } catch (error) {
      if (session.runner.state === 'cancelled') return false;
      this.setStatus({ state: session.runner.state, message: { key: 'status.runFailed', params: { detail: this.errorMessage(error) } } });
      this.appendLog('error', { key: 'status.runFailed', params: { detail: this.errorMessage(error) } }, this.status.executedSteps);
      this.finishHistory(session, 'failed');
      throw error;
    } finally {
      await this.disposeSession(session);
    }
  }

  async startDebug(packageId: string, tabId: string): Promise<boolean> {
    this.assertEnabled();
    const entry = this.requirePackage(packageId);
    if (!await this.prepareWorkflowGameSurface(entry, tabId, true)) throw new Error('未找到脚本指定的游戏画面');
    const session = this.ensureSession(packageId, tabId);
    this.beginHistory(session, 'debug');
    this.setStatus({ state: this.status.state, debugMode: true, debugPaused: false });
    void session.handle.ready.then(() => session.runner.run({ stepMode: true })).catch((error) => {
      if (session.runner.state === 'cancelled') return;
      this.setStatus({ state: session.runner.state, message: { key: 'status.runFailed', params: { detail: this.errorMessage(error) } }, debugPaused: false });
      this.appendLog('error', { key: 'status.runFailed', params: { detail: this.errorMessage(error) } }, this.status.executedSteps);
      this.finishHistory(session, 'failed');
    }).finally(() => this.disposeSession(session));
    return true;
  }

  continueDebug(): boolean {
    const session = this.active;
    if (!session || !this.status.debugMode || !this.status.debugPaused) throw new Error('automation is not paused in step mode');
    session.runner.continueStep();
    this.setStatus({ state: this.status.state, debugPaused: false, message: { key: 'status.stepNext' } });
    return true;
  }

  async testAsset(
    packageId: string,
    tabId: string,
    asset: string,
    options: { threshold: number; scales?: number[]; mask?: AutomationImageMask },
  ): Promise<ImageMatch | null> {
    this.assertEnabled();
    if (this.active || this.probe) throw new Error('another automation session is active');
    const entry = this.requirePackage(packageId);
    if (!entry.source.assets.has(asset)) throw new Error(`automation asset is missing: ${asset}`);
    const handle = tabManager.beginAutomation(tabId, entry.source.workflow.viewport);
    const matcher = this.createMatcher(entry);
    const controller = createAutomationAbortController();
    const probe = { controller, handle, matcher };
    this.probe = probe;
    this.setStatus({ state: 'checking', packageId, tabId, workflowName: entry.source.workflow.name, currentStep: { key: 'status.checkingAsset', params: { asset } }, executedSteps: 0, message: undefined });
    try {
      await handle.ready;
      const driver = this.createDriver(handle, matcher);
      const match = await driver.findImage({ asset, threshold: options.threshold, scales: options.scales, mask: options.mask }, controller.signal);
      this.setStatus({
        state: match ? 'ready' : 'idle', packageId, tabId, workflowName: entry.source.workflow.name,
        message: match
          ? { key: 'status.assetMatch', params: { score: (match.score * 100).toFixed(1) } }
          : { key: 'status.assetNoMatch', params: { asset } },
      });
      return match;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.setStatus({ state: cancelled ? 'cancelled' : 'failed', message: { key: cancelled ? 'status.assetTestStopped' : 'status.assetTestFailed', params: { detail: this.errorMessage(error) } } });
      this.appendLog(cancelled ? 'warning' : 'error', { key: cancelled ? 'status.assetTestStopped' : 'status.assetTestFailed', params: { detail: this.errorMessage(error) } });
      throw error;
    } finally {
      if (this.probe === probe) this.probe = null;
      handle.release();
      await matcher.close();
    }
  }

  async captureReferenceFrame(tabId: string, options: { retainViewport?: boolean } = {}): Promise<{ png: Uint8Array; width: number; height: number }> {
    this.assertEnabled();
    let handle: AutomationTabHandle;
    let release = true;
    if (options.retainViewport) {
      await this.beginAuthoringViewport(tabId);
      const authoring = this.authoringViewport;
      if (!authoring || authoring.tabId !== tabId) throw new Error('automation authoring viewport is unavailable');
      handle = authoring.handle;
      release = false;
    } else {
      handle = tabManager.beginAutomation(tabId, DEFAULT_AUTOMATION_VIEWPORT);
    }
    const wc = handle.webContents;
    let capturing = false;
    let succeeded = false;
    try {
      await handle.ready;
      wc.incrementCapturerCount();
      capturing = true;
      const image = await wc.capturePage();
      if (image.isEmpty()) throw new Error('selected tab capture is empty');
      if (tabManager.getWebContents(tabId) !== wc) throw new Error('selected tab changed while capturing');
      const size = image.getSize();
      succeeded = true;
      return { png: Uint8Array.from(image.toPNG()), width: size.width, height: size.height };
    } finally {
      if (capturing) wc.decrementCapturerCount();
      if (release) handle.release();
      else if (!succeeded) this.endAuthoringViewport(tabId);
    }
  }

  async testAssetOnImage(
    packageId: string,
    asset: string,
    scene: { width: number; height: number; bgra: Uint8Array },
    options: { scales?: number[]; mask?: AutomationImageMask },
  ): Promise<ImageMatch | null> {
    this.assertEnabled();
    const entry = this.requirePackage(packageId);
    if (!entry.source.assets.has(asset)) throw new Error(`automation asset is missing: ${asset}`);
    if (scene.width <= 0 || scene.height <= 0 || scene.bgra.byteLength !== scene.width * scene.height * 4) throw new Error('invalid target scene pixels');
    const session = this.getImageTestSession(packageId, entry);
    const previous = session.queue;
    let release!: () => void;
    session.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    clearTimeout(session.closeTimer);
    const controller = createAutomationAbortController();
    try {
      return await session.matcher.find(asset, {
        image: {
          isEmpty: () => false,
          getSize: () => ({ width: scene.width, height: scene.height }),
          toPNG: () => Buffer.alloc(0),
          toBitmap: () => Buffer.from(scene.bgra),
        },
        deviceSize: { width: scene.width, height: scene.height },
        cssSize: { width: scene.width, height: scene.height },
      }, { threshold: -1, scales: options.scales ?? [1], mask: options.mask ?? 'auto' }, controller.signal);
    } finally {
      release();
      session.closeTimer = this.scheduleImageTestClose(packageId, session);
    }
  }

  async warmupVision(packageId: string): Promise<void> {
    this.assertEnabled();
    const entry = this.requirePackage(packageId);
    const session = this.getImageTestSession(packageId, entry);
    const previous = session.queue;
    let release!: () => void;
    session.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    clearTimeout(session.closeTimer);
    try { await session.matcher.warmup(createAutomationAbortController().signal); }
    finally { release(); session.closeTimer = this.scheduleImageTestClose(packageId, session); }
  }

  async cancel(): Promise<void> {
    const probe = this.probe;
    if (probe) {
      probe.controller.abort();
      return;
    }
    const session = this.active;
    if (!session) return;
    session.runner.cancel();
    this.setStatus({ state: 'cancelled' });
  }

  private ensureSession(packageId: string, tabId: string): ActiveSession {
    if (this.probe) throw new Error('an automation asset test session is active');
    if (this.active) {
      if (this.active.packageId === packageId && this.active.tabId === tabId) return this.active;
      throw new Error('another automation session is active');
    }
    const entry = this.packages.get(packageId);
    if (!entry) throw new Error('automation package is not loaded');
    let handle: AutomationTabHandle;
    if (this.authoringViewport) {
      if (this.authoringViewport.tabId !== tabId) throw new Error('another automation authoring session is active');
      clearTimeout(this.authoringViewport.timer);
      handle = this.authoringViewport.handle;
      this.authoringViewport = null;
    } else {
      handle = tabManager.beginAutomation(tabId, entry.source.workflow.viewport);
    }
    const matcher = inferAutomationCapabilities(entry.source.workflow).includes('vision')
      ? this.acquireRuntimeMatcher(entry)
      : null;
    const driver = this.createDriver(handle, matcher, entry.source.workflow.gameSurface);
    const runner = new AutomationRunner(entry.source.workflow, driver, {
      onEvent: (event) => this.handleRuntimeEvent(event, packageId, tabId, entry.source.workflow.name),
    });
    const session = { packageId, tabId, handle, matcher, runner };
    this.active = session;
    this.setStatus({
      state: 'idle', packageId, tabId, workflowName: entry.source.workflow.name,
      message: undefined, currentStep: undefined, executedSteps: 0, debugMode: false, debugPaused: false, logs: [],
    });
    return session;
  }

  private createMatcher(entry: LoadedEntry): OpenCvWorkerMatcher {
    const templates = new NativeImageTemplateProvider({
      load: async (asset, signal) => {
        if (signal.aborted) throw new Error('automation cancelled');
        const bytes = entry.source.assets.get(asset);
        const cacheKey = entry.assetKeys.get(asset);
        if (!bytes || !cacheKey) throw new Error(`automation asset is missing: ${asset}`);
        return { bytes, cacheKey };
      },
    });
    return new OpenCvWorkerMatcher(new CachingAutomationTemplateProvider(templates, 64));
  }

  private acquireRuntimeMatcher(entry: LoadedEntry): OpenCvWorkerMatcher {
    const idle = this.runtimeMatchers.get(entry.id);
    if (!idle) return this.createMatcher(entry);
    this.runtimeMatchers.delete(entry.id);
    clearTimeout(idle.closeTimer);
    return idle.matcher;
  }

  private releaseRuntimeMatcher(packageId: string, matcher: OpenCvWorkerMatcher): void {
    const existing = this.runtimeMatchers.get(packageId);
    if (existing) {
      clearTimeout(existing.closeTimer);
      void existing.matcher.close();
    }
    const closeTimer = setTimeout(() => {
      const idle = this.runtimeMatchers.get(packageId);
      if (!idle || idle.matcher !== matcher) return;
      this.runtimeMatchers.delete(packageId);
      void matcher.close();
    }, RUNTIME_MATCHER_IDLE_MS);
    closeTimer.unref();
    this.runtimeMatchers.set(packageId, { matcher, closeTimer });
  }

  private async closeRuntimeMatcher(packageId: string): Promise<void> {
    const idle = this.runtimeMatchers.get(packageId);
    if (!idle) return;
    this.runtimeMatchers.delete(packageId);
    clearTimeout(idle.closeTimer);
    await idle.matcher.close();
  }

  private getImageTestSession(packageId: string, entry: LoadedEntry): ImageTestSession {
    const existing = this.imageTests.get(packageId);
    if (existing) return existing;
    const session: ImageTestSession = {
      matcher: this.createMatcher(entry),
      queue: Promise.resolve(),
      closeTimer: setTimeout(() => {}, 0),
    };
    clearTimeout(session.closeTimer);
    session.closeTimer = this.scheduleImageTestClose(packageId, session);
    this.imageTests.set(packageId, session);
    return session;
  }

  private scheduleImageTestClose(packageId: string, session: ImageTestSession): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (this.imageTests.get(packageId) !== session) return;
      this.imageTests.delete(packageId);
      void session.queue.then(() => session.matcher.close());
    }, 30_000);
    timer.unref();
    return timer;
  }

  private async closeImageTestSession(packageId: string): Promise<void> {
    const session = this.imageTests.get(packageId);
    if (!session) return;
    this.imageTests.delete(packageId);
    clearTimeout(session.closeTimer);
    await session.queue;
    await session.matcher.close();
  }

  private createDriver(handle: AutomationTabHandle, matcher: OpenCvWorkerMatcher | null, locator?: AutomationWorkflow['gameSurface']): BrowserViewAutomationDriver {
    return new BrowserViewAutomationDriver(handle.webContents, matcher, {
      getCssViewport: () => handle.getCssViewport(),
      getViewportTransform: () => handle.getViewportTransform(),
      getViewportRevision: () => handle.getViewportRevision?.() ?? 0,
      waitForViewport: () => handle.waitForViewport?.() ?? Promise.resolve(),
      getCoordinateSurface: () => {
        const binding = this.boundGameSurfaces.get(handle.tabId);
        return binding?.webContentsId === handle.webContents.id ? { ...binding.candidate.rect } : null;
      },
      refreshCoordinateSurface: async () => {
        const binding = this.boundGameSurfaces.get(handle.tabId);
        if (!binding || binding.webContentsId !== handle.webContents.id) throw new Error('游戏画面坐标不可用：游戏画面绑定已失效');
        const candidates = await detectTabGameSurfaces(handle.webContents);
        const candidate = locator
          ? chooseLocatedGameSurface(candidates, locator)
          : chooseMatchingGameSurface(candidates, binding.fingerprint) ?? chooseReplacementGameSurface(candidates, binding.candidate);
        if (!candidate) throw new Error('窗口变化后无法重新定位游戏画面');
        binding.candidate = candidate;
        binding.fingerprint = candidate.fingerprint;
      },
      assertCurrent: () => handle.assertCurrent(),
      log: (message) => log.info(`[Automation] ${message}`),
    });
  }

  private requirePackage(packageId: string): LoadedEntry {
    const entry = this.packages.get(packageId);
    if (!entry) throw new Error('automation package is not loaded');
    return entry;
  }

  private createEntry(source: LoadedAutomationPackage): LoadedEntry {
    const assetKeys = new Map<string, string>();
    for (const [asset, content] of source.assets) assetKeys.set(asset, createHash('sha256').update(content).digest('hex'));
    return { id: source.manifest.id, source, assetKeys };
  }

  private async initialize(): Promise<void> {
    await this.loadInstalledPackages();
    await this.loadRunHistory();
  }

  private historyPath(): string | undefined { return this.storageDir ? path.join(this.storageDir, '.run-history.json') : undefined; }

  private async loadRunHistory(): Promise<void> {
    const filePath = this.historyPath(); if (!filePath) return;
    try {
      const stat = await fs.promises.stat(filePath); if (stat.size > 2 * 1024 * 1024) throw new Error('history file exceeds 2MB');
      const value = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown;
      if (!Array.isArray(value)) throw new Error('history root must be an array');
      this.runHistory = value.filter((item): item is AutomationRunRecord => this.isRunRecord(item)).slice(-50);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('[Automation] ignored invalid run history:', this.errorMessage(error));
      this.runHistory = [];
    }
  }

  private isRunRecord(value: unknown): value is AutomationRunRecord {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<AutomationRunRecord>;
    return typeof item.id === 'string' && typeof item.packageId === 'string' && typeof item.workflowName === 'string' && typeof item.tabId === 'string'
      && (item.mode === 'run' || item.mode === 'debug') && typeof item.startedAt === 'number' && typeof item.finishedAt === 'number'
      && (item.state === 'completed' || item.state === 'failed' || item.state === 'cancelled') && typeof item.executedSteps === 'number' && Array.isArray(item.logs);
  }

  private beginHistory(session: ActiveSession, mode: 'run' | 'debug'): void {
    session.history = { id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`, mode, startedAt: Date.now() };
  }

  private finishHistory(session: ActiveSession, state: AutomationRunRecord['state']): void {
    const history = session.history; if (!history) return; session.history = undefined;
    this.runHistory = [...this.runHistory, {
      id: history.id, packageId: session.packageId, workflowName: this.status.workflowName ?? session.packageId,
      tabId: session.tabId, mode: history.mode, startedAt: history.startedAt, finishedAt: Date.now(), state,
      executedSteps: this.status.executedSteps ?? 0, logs: (this.status.logs ?? []).map((entry) => ({ ...entry })),
    }].slice(-50);
    this.queueHistoryWrite();
  }

  private queueHistoryWrite(): void {
    const filePath = this.historyPath(); if (!filePath) return;
    const snapshot = JSON.stringify(this.runHistory, null, 2);
    this.historyWrite = this.historyWrite.catch(() => {}).then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, snapshot, 'utf8');
    }).catch((error) => { log.warn('[Automation] failed to persist run history:', this.errorMessage(error)); });
  }

  private measureWorkflow(root: AutomationStep): { stepCount: number; maxDepth: number } {
    let stepCount = 0; let maxDepth = 0;
    const visit = (step: AutomationStep, depth: number): void => {
      stepCount += step.type === 'sequence' ? 0 : 1; maxDepth = Math.max(maxDepth, depth);
      if (step.type === 'sequence') step.steps.forEach((child) => visit(child, depth + 1));
      else if (step.type === 'vision-region' || step.type === 'coordinate-space') visit(step.body, depth + 1);
      else if (step.type === 'if-image' || step.type === 'if-condition') { visit(step.then, depth + 1); if (step.else) visit(step.else, depth + 1); }
      else if (step.type === 'wait-condition-branch') { visit(step.success, depth + 1); visit(step.timeout, depth + 1); }
      else if (step.type === 'position-compare') { visit(step.then, depth + 1); if (step.else) visit(step.else, depth + 1); }
      else if (step.type === 'repeat' || step.type === 'repeat-until-image' || step.type === 'repeat-until-condition') visit(step.body, depth + 1);
    };
    visit(root, 0); return { stepCount, maxDepth };
  }

  private compareVersions(left: string, right: string): number {
    const a = left.split('.').map(Number); const b = right.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) { const difference = (a[index] || 0) - (b[index] || 0); if (difference) return difference; }
    return 0;
  }

  private async loadInstalledPackages(): Promise<void> {
    if (!this.storageDir) return;
    await fs.promises.mkdir(this.storageDir, { recursive: true });
    let entries = await fs.promises.readdir(this.storageDir, { withFileTypes: true });
    for (const dirent of entries) {
      const backupMatch = /^\.([a-zA-Z0-9][a-zA-Z0-9._-]*)\.\d+\.\d+\.bak$/.exec(dirent.name);
      if (dirent.isFile() && backupMatch) {
        const destination = this.packagePath(backupMatch[1]);
        try { await fs.promises.access(destination); await fs.promises.unlink(path.join(this.storageDir, dirent.name)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') await fs.promises.rename(path.join(this.storageDir, dirent.name), destination);
          else throw error;
        }
      } else if (dirent.isFile() && dirent.name.endsWith('.tmp')) {
        await fs.promises.unlink(path.join(this.storageDir, dirent.name)).catch(() => {});
      }
    }
    entries = await fs.promises.readdir(this.storageDir, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isFile() || !dirent.name.endsWith('.baoauto')) continue;
      try {
        const bytes = new Uint8Array(await fs.promises.readFile(path.join(this.storageDir, dirent.name)));
        const source = loadAutomationPackage(bytes);
        if (dirent.name !== `${source.manifest.id}.baoauto`) throw new Error('filename does not match manifest id');
        this.packages.set(source.manifest.id, this.createEntry(source));
      } catch (error) { log.warn(`[Automation] skipped invalid installed package ${dirent.name}:`, this.errorMessage(error)); }
    }
  }

  private packagePath(packageId: string): string {
    if (!this.storageDir) throw new Error('automation package storage is not configured');
    return path.join(this.storageDir, `${packageId}.baoauto`);
  }

  private async persistEntry(entry: LoadedEntry, exclusive = false): Promise<void> {
    if (!this.storageDir) return;
    await fs.promises.mkdir(this.storageDir, { recursive: true });
    const destination = this.packagePath(entry.id);
    const bytes = serializeAutomationPackage(entry.source);
    if (exclusive) {
      await fs.promises.writeFile(destination, bytes, { flag: 'wx' });
      return;
    }
    const temporary = path.join(this.storageDir, `.${entry.id}.${process.pid}.${Date.now()}.tmp`);
    const backup = path.join(this.storageDir, `.${entry.id}.${process.pid}.${Date.now()}.bak`);
    await fs.promises.writeFile(temporary, bytes, { flag: 'wx' });
    let movedOriginal = false;
    try {
      try { await fs.promises.rename(destination, backup); movedOriginal = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await fs.promises.rename(temporary, destination);
      if (movedOriginal) await fs.promises.unlink(backup).catch(() => {});
    } catch (error) {
      await fs.promises.unlink(temporary).catch(() => {});
      if (movedOriginal) await fs.promises.rename(backup, destination).catch(() => {});
      throw error;
    }
  }

  private handleRuntimeEvent(event: AutomationRuntimeEvent, packageId: string, tabId: string, workflowName: string): void {
    if (event.type === 'state') {
      this.setStatus({ state: event.state, packageId, tabId, workflowName, debugPaused: false });
      if (event.state === 'completed') this.appendLog('success', { key: 'status.scriptCompleted' }, this.status.executedSteps);
      else if (event.state === 'cancelled') this.appendLog('warning', { key: 'status.scriptStopped' }, this.status.executedSteps);
      if (event.state === 'completed' || event.state === 'cancelled') {
        const session = this.active;
        if (session?.packageId === packageId && session.tabId === tabId) this.finishHistory(session, event.state);
      }
    } else if (event.type === 'step-start') {
      const description = this.describeStep(event.step);
      this.setStatus({
        state: this.status.state, packageId, tabId, workflowName,
        currentStep: description, executedSteps: event.executedSteps, debugPaused: false,
      });
      if (event.step.type !== 'sequence') this.appendLog('info', description, event.executedSteps);
    } else if (event.type === 'step-paused') {
      const description = this.describeStep(event.step);
      this.setStatus({
        state: this.status.state, packageId, tabId, workflowName,
        currentStep: description, debugPaused: true, message: { key: 'status.pausedNext', params: { step: description } },
      });
    } else if (event.type === 'image-match') {
      log.debug('[Automation] vision performance', {
        asset: event.asset,
        captureMs: event.match.captureMs,
        bitmapMs: event.match.bitmapMs,
        templateLoadMs: event.match.templateLoadMs,
        workerReadyMs: event.match.workerReadyMs,
        sharedCopyMs: event.match.sharedCopyMs,
        sceneMatMs: event.match.sceneMatMs,
        grayMs: event.match.grayMs,
        resizeMs: event.match.resizeMs,
        matchTemplateMs: event.match.matchTemplateMs,
        scaledTemplateCacheHits: event.match.scaledTemplateCacheHits,
        scaledTemplateCacheMisses: event.match.scaledTemplateCacheMisses,
        matchMs: event.match.matchMs,
        totalMs: event.match.totalMs,
        sceneBytes: event.match.sceneBytes,
        sceneTransferBytes: event.match.sceneTransferBytes,
        wasmHeapBytes: event.match.wasmHeapBytes,
        templateCacheBytes: event.match.templateCacheBytes,
        templateCacheEntries: event.match.templateCacheEntries,
        testedScales: event.match.testedScales,
      });
      this.appendLog('success', {
        key: 'status.imageMatch',
        params: {
          asset: event.asset,
          score: (event.match.score * 100).toFixed(1),
          totalMs: event.match.totalMs?.toFixed(0) ?? '?',
          captureMs: event.match.captureMs?.toFixed(0) ?? '?',
          matchMs: event.match.matchMs?.toFixed(0) ?? '?',
        },
      }, this.status.executedSteps);
    } else if (event.type === 'random-click-coordinate') {
      const message: AutomationMessage = { key: 'status.randomClickCoordinate', params: event.coordinate };
      this.setStatus({ state: this.status.state, packageId, tabId, workflowName, message });
      this.appendLog('info', message, this.status.executedSteps);
    } else if (event.type === 'log') {
      log.info(`[Automation] ${event.message}`);
      this.setStatus({ state: this.status.state, packageId, tabId, workflowName, message: { key: 'raw', params: { text: event.message } } });
      this.appendLog('info', { key: 'raw', params: { text: event.message } }, this.status.executedSteps);
    }
  }

  private appendLog(level: AutomationLogEntry['level'], message: AutomationMessage, step?: number): void {
    const entry: AutomationLogEntry = { id: this.nextLogId++, timestamp: Date.now(), level, message, step };
    const logs = [...(this.status.logs ?? []), entry].slice(-100);
    this.setStatus({ state: this.status.state, logs });
  }

  private describeStep(step: AutomationStep): AutomationMessage {
    switch (step.type) {
      case 'sequence': return { key: 'step.sequence' };
      case 'wait-image': return { key: 'step.waitImage', params: { asset: step.asset } };
      case 'wait-image-state': return { key: 'step.waitImageState', params: { asset: step.asset, state: step.state } };
      case 'click-image': return { key: 'step.clickImage', params: { asset: step.asset } };
      case 'click-coordinate': return { key: 'step.clickCoordinate', params: step.coordinate };
      case 'random-click-region': return { key: 'step.randomClickRegion' };
      case 'vision-region': return { key: 'step.visionRegion', params: step.region };
      case 'coordinate-space': return { key: 'step.coordinateSpace', params: { space: step.space === 'game' ? '游戏画面' : '整个页面' } };
      case 'move-to-image': return { key: 'step.moveToImage', params: { asset: step.asset } };
      case 'move-to-coordinate': return { key: 'step.moveToCoordinate', params: step.coordinate };
      case 'drag-image': return { key: 'step.dragImage', params: { source: step.source.asset, target: step.target.asset } };
      case 'drag': return { key: 'step.drag' };
      case 'delay': return { key: 'step.delay', params: { ms: step.durationMs } };
      case 'key-press': return { key: 'step.keyPress', params: { key: step.key } };
      case 'key-hold-until-image': return { key: 'step.keyHoldUntilImage', params: { key: step.key, state: step.state, asset: step.asset } };
      case 'text-input': return { key: 'step.textInput' };
      case 'scroll': return { key: 'step.scroll' };
      case 'navigate': return { key: 'step.navigate' };
      case 'reload': return { key: 'step.reload' };
      case 'log': return { key: 'step.log', params: { message: step.message } };
      case 'notification': return { key: 'step.notification', params: { title: step.title } };
      case 'if-image': return { key: 'step.ifImage', params: { asset: step.condition.asset } };
      case 'if-condition': return { key: 'step.ifCondition' };
      case 'wait-condition': return { key: 'step.waitCondition' };
      case 'wait-condition-branch': return { key: 'step.waitConditionBranch' };
      case 'end': return { key: 'step.end', params: { result: step.result, message: step.message ?? '' } };
      case 'repeat': return { key: 'step.repeat', params: { times: step.times } };
      case 'repeat-until-image': return { key: 'step.repeatUntilImage', params: { asset: step.condition.asset } };
      case 'repeat-until-condition': return { key: 'step.repeatUntilCondition' };
      case 'position-compare': return { key: 'step.positionCompare', params: { relation: step.relation } };
    }
  }

  private async disposeSession(session: ActiveSession): Promise<void> {
    if (this.active !== session) return;
    this.active = null;
    session.handle.release();
    if (session.matcher) this.releaseRuntimeMatcher(session.packageId, session.matcher);
  }

  private setStatus(patch: Omit<AutomationServiceStatus, 'enabled'>): void {
    this.status = { ...this.status, ...patch, enabled: this.enabled };
    this.emitStatus(this.getStatus());
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error('automation platform is disabled');
  }

  private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
