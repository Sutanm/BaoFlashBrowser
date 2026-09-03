import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { nativeImage, type NativeImage } from 'electron';
import type { TargetRef, ValueExpression, WorkflowDocumentV3, WorkflowNode } from '../../../shared/automation/core';
import { validateWorkflowDocument } from '../../../shared/automation/core';
import type { JavaScriptAutomationCapability } from '../../../shared/automation/javascript-api';
import type { AutomationPackageV3, AutomationProfileV3 } from '../../../shared/automation/package-v3';
import { loadAutomationPackageV3, serializeAutomationPackageV3 } from './package-v3';
import { AutomationPackageV3Repository } from './package-v3-repository';
import { tabManager } from '../tabs';
import { BrowserViewAutomationCoreSession } from './browserview-core-session';
import type { WorkflowRunHandle } from '../../../shared/automation/core';
import type { JavaScriptSandboxRunHandle } from './javascript-sandbox-host';
import { JavaScriptAutomationGrantStore } from './javascript-grant-store';
import { automationMainEntryId } from '../../../shared/automation/package-v3';
import { decodeAutomationImageGroup } from '../../../shared/automation/image-groups';
import { DEFAULT_IMAGE_MATCH_MASK, DEFAULT_IMAGE_MATCH_THRESHOLD, imageMatchFallbackScales, imageMatchScales, surfaceReferenceImageScales } from '../../../shared/automation/vision-policy';
import { createAutomationAbortController } from '../../../shared/automation/abort-controller';
import { OpenCvWorkerMatcher } from './vision-worker-matcher';
import { registerAutomationAssetSource, sharedAutomationOcrEngine, sharedAutomationVisionMatcher, shutdownAutomationVision } from './automation-warm-start';
import { keyOutAssetBackground } from './asset-keyout';
import { loadConfig } from '../config';
import { AUTHORING_BEST_CANDIDATE_THRESHOLD, AutomationVisionService } from './vision-service';
import { AutomationTextRecognitionService } from './text-recognition-service';
import type { AutomationCapturedFrame } from './capability-contracts';
import ts from 'typescript';

export type AutomationPackageV3Detail = {
  readonly packageId: string;
  readonly name: string;
  readonly mainEntryId: string;
  readonly workflow?: WorkflowDocumentV3;
  readonly scripts: readonly { readonly id: string; readonly name: string; readonly path: string; readonly language: 'javascript' | 'typescript'; readonly permissions: readonly JavaScriptAutomationCapability[]; readonly source: string }[];
  readonly assets: readonly string[];
  readonly profiles: readonly { readonly path: string; readonly profile: AutomationProfileV3 }[];
};

type AuthoringVisionSession = {
  readonly matcher: OpenCvWorkerMatcher;
  queue: Promise<void>;
  closeTimer: NodeJS.Timeout;
};

export type AutomationRunLog = {
  readonly timestamp: number;
  readonly level: 'info' | 'success' | 'error';
  readonly message: string;
};

export type AutomationRunStatus = {
  readonly state: 'idle' | 'preparing' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  readonly runId?: string;
  readonly packageId?: string;
  readonly frontendId?: string;
  readonly workflowName?: string;
  readonly currentStep?: string;
  readonly executedSteps: number;
  readonly message?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly logs: readonly AutomationRunLog[];
};

const AUTHORING_VISION_IDLE_MS = 30_000;

function shortAutomationText(value: string, maxLength = 28): string {
  const clean = value.trim().replace(/\s+/gu, ' ');
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

function literalExpression(value: ValueExpression): null | boolean | number | string | undefined {
  return value.kind === 'literal' ? value.value : undefined;
}

function describeTarget(target: TargetRef): string {
  const locator = target.locator;
  if (locator.kind === 'coordinate') {
    const x = locator.point.unit === 'ratio' ? Math.round(locator.point.x * 10_000) : Math.round(locator.point.x);
    const y = locator.point.unit === 'ratio' ? Math.round(locator.point.y * 10_000) : Math.round(locator.point.y);
    return `坐标 ${x},${y}`;
  }
  if (locator.kind === 'image') {
    const names = [locator.asset, ...(locator.alternatives ?? [])];
    if (names.length > 1) return `图片组（${names.length} 张）`;
    return `图片「${shortAutomationText(locator.asset.replace(/^assets\//u, ''))}」`;
  }
  if (locator.kind === 'text') return `文字「${shortAutomationText(locator.text)}」`;
  return `多个目标（${locator.locators.length} 项）`;
}

function describeWorkflowNode(node: WorkflowNode): string {
  if (node.kind === 'with') {
    if (node.surface?.kind === 'visual') return '进入指定游戏画面';
    if (node.surface?.kind === 'region' || node.region) return '进入指定坐标范围';
    if (node.surface?.kind === 'viewport') return '使用整个页面范围';
    return '切换执行范围';
  }
  if (node.kind === 'action') {
    const action = node.action;
    if (action.kind === 'click') return `点击${describeTarget(action.target)}`;
    if (action.kind === 'move') return `移动到${describeTarget(action.target)}`;
    if (action.kind === 'drag') return `拖拽：${describeTarget(action.from)} → ${describeTarget(action.to)}`;
    if (action.kind === 'keyPress') return `按键「${action.key}」`;
    if (action.kind === 'typeText') return `输入文字「${shortAutomationText(action.text)}」`;
    if (action.kind === 'scroll') return '滚动页面';
    if (action.kind === 'navigate') return `打开网址「${shortAutomationText(action.url)}」`;
    if (action.kind === 'reload') return '刷新页面';
    if (action.kind === 'log') return `记录日志「${shortAutomationText(action.message)}」`;
    return `发送通知「${shortAutomationText(action.title)}」`;
  }
  if (node.kind === 'wait') {
    if ('durationMs' in node) {
      const duration = literalExpression(node.durationMs);
      return typeof duration === 'number' ? `等待 ${duration} 毫秒` : '等待指定时间';
    }
    return '等待识别条件满足';
  }
  if (node.kind === 'loop') {
    const count = node.mode === 'repeat' ? literalExpression(node.count) : undefined;
    return typeof count === 'number' ? `重复执行 ${count} 次` : node.mode === 'while' ? '按条件重复执行' : '一直循环';
  }
  if (node.kind === 'if') return '判断条件';
  if (node.kind === 'query') {
    if (node.query.kind === 'readText') return `读取文字 → ${node.assignTo}`;
    if (node.query.kind === 'readNumber') return `读取数字 → ${node.assignTo}`;
    if (node.query.kind === 'find') return `查找目标 → ${node.assignTo}`;
    return `判断目标是否存在 → ${node.assignTo}`;
  }
  if (node.kind === 'let') return `设置变量「${node.name}」`;
  if (node.kind === 'set') return `更新变量「${node.name}」`;
  if (node.kind === 'callScript') return `运行脚本「${node.scriptId}」`;
  if (node.kind === 'break') return '跳出循环';
  if (node.kind === 'continue') return '继续下一次循环';
  return '执行流程';
}

function indexWorkflowNodes(root: WorkflowNode): ReadonlyMap<string, WorkflowNode> {
  const nodes = new Map<string, WorkflowNode>();
  const visit = (node: WorkflowNode): void => {
    nodes.set(node.id, node);
    if (node.kind === 'sequence') node.nodes.forEach(visit);
    else if (node.kind === 'with' || node.kind === 'loop') visit(node.body);
    else if (node.kind === 'if') { visit(node.then); if (node.else) visit(node.else); }
  };
  visit(root);
  return nodes;
}

function workflowReferencesScript(root: WorkflowNode, scriptId: string): boolean {
  if (root.kind === 'callScript' && root.scriptId === scriptId) return true;
  if (root.kind === 'sequence') return root.nodes.some((node) => workflowReferencesScript(node, scriptId));
  if (root.kind === 'with' || root.kind === 'loop') return workflowReferencesScript(root.body, scriptId);
  if (root.kind === 'if') return workflowReferencesScript(root.then, scriptId) || Boolean(root.else && workflowReferencesScript(root.else, scriptId));
  return false;
}

function shouldReportWorkflowNode(node: WorkflowNode): boolean {
  return node.kind !== 'sequence';
}

function cropPreview(image: NativeImage, region: { x: number; y: number; width: number; height: number } | undefined): { image: NativeImage; origin: { x: number; y: number } } {
  if (!region) return { image, origin: { x: 0, y: 0 } };
  const size = image.getSize();
  const x = Math.max(0, Math.floor(region.x)); const y = Math.max(0, Math.floor(region.y));
  const right = Math.min(size.width, Math.ceil(region.x + region.width)); const bottom = Math.min(size.height, Math.ceil(region.y + region.height));
  if (right <= x || bottom <= y) throw new Error('游戏区域不在当前截图范围内，请重新选择游戏画面');
  return { image: image.crop({ x, y, width: right - x, height: bottom - y }), origin: { x, y } };
}

function clonePackage(source: AutomationPackageV3, patch: Partial<AutomationPackageV3>): AutomationPackageV3 {
  return { ...source, ...patch };
}

function runtimePackage(source: AutomationPackageV3): AutomationPackageV3 {
  const typescriptEntries = source.manifest.frontends.scripts.filter((entry) => entry.language === 'typescript' || entry.path.endsWith('.ts'));
  if (!typescriptEntries.length) return source;
  const scripts = new Map(source.scripts);
  for (const entry of typescriptEntries) {
    const input = scripts.get(entry.path); if (input === undefined) continue;
    const result = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None, strict: true }, reportDiagnostics: true });
    const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length) throw new Error(`TypeScript 编译失败：${errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n')}`);
    scripts.set(entry.path, result.outputText);
  }
  return clonePackage(source, { scripts });
}

export class AutomationV3Service {
  readonly ready: Promise<void>;
  private active: { session: BrowserViewAutomationCoreSession; handle: WorkflowRunHandle | JavaScriptSandboxRunHandle; packageId: string; frontendId: string } | null = null;
  private runStatus: AutomationRunStatus = { state: 'idle', executedSteps: 0, logs: [] };
  private readonly captures = new Map<string, { image: NativeImage; referenceKind: 'viewport' | 'region' | 'surface'; createdAt: number; timer: NodeJS.Timeout }>();
  private readonly authoringVision = new Map<string, AuthoringVisionSession>();
  /** 与预热模块共享同一 Sidecar,避免工作台再建一个 OCR 进程。 */
  private readonly authoringOcr = sharedAutomationOcrEngine();
  constructor(private readonly repository: AutomationPackageV3Repository, private readonly grants: JavaScriptAutomationGrantStore) {
    this.ready = Promise.all([repository.initialize(), grants.initialize()]).then(() => undefined);
  }

  async listPackages() { await this.ready; return this.repository.list(); }

  status(): AutomationRunStatus { return { ...this.runStatus, logs: [...this.runStatus.logs] }; }

  private updateRunStatus(patch: Partial<AutomationRunStatus>): void {
    this.runStatus = { ...this.runStatus, ...patch };
  }

  private appendRunLog(level: AutomationRunLog['level'], message: string): void {
    const clean = String(message).trim().slice(0, 4_000); if (!clean) return;
    const logs = [...this.runStatus.logs, { timestamp: Date.now(), level, message: clean }].slice(-200);
    this.runStatus = { ...this.runStatus, logs };
  }

  async getPackage(packageId: string): Promise<AutomationPackageV3Detail> {
    await this.ready;
    const source = this.repository.get(packageId);
    return {
      packageId,
      name: source.manifest.name,
      mainEntryId: automationMainEntryId(source),
      workflow: source.workflow,
      scripts: source.manifest.frontends.scripts.map((entry) => ({ ...entry, language: entry.language ?? (entry.path.endsWith('.ts') ? 'typescript' : 'javascript'), source: source.scripts.get(entry.path) ?? '' })),
      assets: [...source.assets.keys()].sort(),
      profiles: [...source.profiles].map(([profilePath, profile]) => ({ path: profilePath, profile })),
    };
  }

  async createPackage(id: string, name: string): Promise<AutomationPackageV3Detail> {
    await this.ready;
    const workflow: WorkflowDocumentV3 = { formatVersion: 3, id: `${id}-workflow`, name, root: { id: 'root', kind: 'sequence', nodes: [] } };
    const source: AutomationPackageV3 = {
      manifest: { format: 'baoauto', formatVersion: 3, id, name, frontends: { workflow: 'workflow.json', scripts: [], mainEntryId: 'workflow' }, features: [], integrity: {} },
      workflow, scripts: new Map(), assets: new Map(), profiles: new Map(),
    };
    await this.repository.install(serializeAutomationPackageV3(source));
    return this.getPackage(id);
  }

  async updateWorkflow(packageId: string, workflow: WorkflowDocumentV3): Promise<WorkflowDocumentV3> {
    await this.ready; validateWorkflowDocument(workflow);
    const current = this.repository.get(packageId);
    const manifest = { ...current.manifest, name: workflow.name, frontends: { ...current.manifest.frontends, workflow: 'workflow.json' as const } };
    await this.repository.save(clonePackage(current, { manifest, workflow }));
    return workflow;
  }

  async upsertScript(input: { packageId: string; id: string; name: string; source: string; language?: 'javascript' | 'typescript'; permissions: readonly JavaScriptAutomationCapability[] }): Promise<AutomationPackageV3Detail> {
    await this.ready;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.id)) throw new Error('automation script id is invalid');
    const current = this.repository.get(input.packageId);
    const language = input.language ?? 'javascript';
    const scriptPath = `scripts/${input.id}.${language === 'typescript' ? 'ts' : 'js'}` as const;
    const scripts = new Map(current.scripts); scripts.set(scriptPath, input.source);
    const previous = current.manifest.frontends.scripts.find((entry) => entry.id === input.id);
    if (previous && previous.path !== scriptPath) scripts.delete(previous.path);
    const entries = current.manifest.frontends.scripts.filter((entry) => entry.id !== input.id && entry.path !== scriptPath);
    entries.push({ id: input.id, name: input.name, path: scriptPath, language, permissions: input.permissions });
    const manifest = { ...current.manifest, frontends: { ...current.manifest.frontends, scripts: entries } };
    await this.repository.save(clonePackage(current, { manifest, scripts }));
    await this.grants.approve(input.packageId, input.id, input.permissions, input.permissions);
    return this.getPackage(input.packageId);
  }

  async removeScript(packageId: string, scriptId: string): Promise<AutomationPackageV3Detail> {
    await this.ready;
    if (this.active?.packageId === packageId) throw new Error('自动化正在运行，请先停止后再删除脚本');
    const current = this.repository.get(packageId);
    const target = current.manifest.frontends.scripts.find((entry) => entry.id === scriptId);
    if (!target) throw new Error('要删除的脚本不存在');
    if (current.workflow && workflowReferencesScript(current.workflow.root, scriptId)) {
      throw new Error('该脚本仍被 Blockly 的“运行脚本”积木引用，请先移除对应积木');
    }
    const entries = current.manifest.frontends.scripts.filter((entry) => entry.id !== scriptId);
    if (!current.workflow && !entries.length) throw new Error('自动化包至少需要保留一个主入口');
    const scripts = new Map(current.scripts); scripts.delete(target.path);
    const profiles = new Map([...current.profiles].filter(([, profile]) => profile.entryId !== scriptId));
    const currentMain = automationMainEntryId(current);
    const mainEntryId = currentMain === scriptId
      ? (current.workflow ? 'workflow' : entries[0]!.id)
      : current.manifest.frontends.mainEntryId;
    const manifest = {
      ...current.manifest,
      frontends: { ...current.manifest.frontends, scripts: entries, mainEntryId },
    };
    await this.repository.save(clonePackage(current, { manifest, scripts, profiles }));
    await this.grants.removeEntry(packageId, scriptId);
    return this.getPackage(packageId);
  }

  async setMainEntry(packageId: string, entryId: string): Promise<AutomationPackageV3Detail> {
    await this.ready;
    const current = this.repository.get(packageId);
    if (entryId !== 'workflow' && !current.manifest.frontends.scripts.some((entry) => entry.id === entryId)) throw new Error('main entry does not exist');
    if (entryId === 'workflow' && !current.workflow) throw new Error('workflow entry does not exist');
    const manifest = { ...current.manifest, frontends: { ...current.manifest.frontends, mainEntryId: entryId } };
    await this.repository.save(clonePackage(current, { manifest }));
    return this.getPackage(packageId);
  }

  async install(bytes: Uint8Array, replace = false, approvals: Readonly<Record<string, readonly JavaScriptAutomationCapability[]>> = {}) {
    await this.ready;
    const preview = loadAutomationPackageV3(bytes);
    for (const entry of preview.manifest.frontends.scripts) {
      const requested = new Set(entry.permissions);
      if ((approvals[entry.id] ?? []).some((permission) => !requested.has(permission))) throw new Error(`install grant exceeds requested permissions: ${entry.id}`);
    }
    const installed = await this.repository.install(bytes, replace);
    await this.closeAuthoringVision(installed.packageId);
    const source = this.repository.get(installed.packageId);
    for (const entry of source.manifest.frontends.scripts) await this.grants.approve(installed.packageId, entry.id, entry.permissions, approvals[entry.id] ?? []);
    return installed;
  }
  async remove(packageId: string): Promise<void> {
    await this.ready;
    if (this.active?.packageId === packageId) throw new Error('自动化正在运行，请先停止后再删除自动化包');
    await this.closeAuthoringVision(packageId);
    await this.repository.remove(packageId);
    await this.grants.remove(packageId);
  }
  async export(packageId: string): Promise<Uint8Array> { await this.ready; return this.repository.export(packageId); }

  async start(packageId: string, frontendId: string, tabId: string, profilePath?: string): Promise<{ runId: string }> {
    await this.ready;
    if (this.active) throw new Error('another Automation 2.0 run is active');
    const source = this.repository.get(packageId);
    const validFrontends = new Set([...(source.workflow ? ['workflow'] : []), ...source.manifest.frontends.scripts.map((entry) => entry.id)]);
    if (!validFrontends.has(frontendId)) throw new Error(`automation frontend is missing: ${frontendId}`);
    const profile = profilePath ? source.profiles.get(profilePath) : undefined;
    if (profilePath && !profile) throw new Error(`automation profile is missing: ${profilePath}`);
    if (profile && profile.entryId !== frontendId) throw new Error(`profile ${profile.id} belongs to frontend ${profile.entryId}`);
    this.runStatus = { state: 'preparing', packageId, frontendId, workflowName: source.manifest.name, currentStep: '正在准备目标页面', executedSteps: 0, startedAt: Date.now(), logs: [] };
    this.appendRunLog('info', `开始运行「${source.manifest.name}」· ${frontendId === 'workflow' ? 'Blockly 主流程' : frontendId}`);
    let tab: ReturnType<typeof tabManager.beginAutomation> | undefined;
    let session: BrowserViewAutomationCoreSession | undefined;
    try {
      tab = tabManager.beginAutomation(tabId, { mode: 'fixed', width: 1280, height: 720 });
      await tab.ready;
      this.updateRunStatus({ currentStep: '正在初始化 Automation Core' });
      // 运行会话复用常驻 Worker/Sidecar,避免每次运行重新支付 OpenCV/OCR 冷启动。
      registerAutomationAssetSource(packageId, runtimePackage(source));
      session = new BrowserViewAutomationCoreSession(tab, runtimePackage(source), profile, (message, level) => this.appendRunLog(level === 'error' ? 'error' : 'info', message), (entryId) => this.grants.get(packageId, entryId), { matcher: sharedAutomationVisionMatcher(), ocrEngine: sharedAutomationOcrEngine() });
      const handle = frontendId === 'workflow' ? session.startWorkflow() : session.startJavaScript(frontendId, this.grants.get(packageId, frontendId));
      this.active = { session, handle, packageId, frontendId };
      this.updateRunStatus({ state: 'running', runId: handle.runId, currentStep: frontendId === 'workflow' ? '正在执行主流程' : `正在执行脚本 ${frontendId}` });
      if ('subscribe' in handle) {
        const workflowNodes = source.workflow ? indexWorkflowNodes(source.workflow.root) : new Map<string, WorkflowNode>();
        const reportEvent = (event: typeof handle.history[number]): void => {
          if (event.kind === 'node-start') {
            const node = workflowNodes.get(event.nodeId);
            const description = node ? describeWorkflowNode(node) : '执行流程步骤';
            this.updateRunStatus({ executedSteps: this.runStatus.executedSteps + 1, currentStep: `正在${description}` });
            if (node && shouldReportWorkflowNode(node)) this.appendRunLog('info', `开始：${description}`);
          } else if (event.kind === 'node-end') {
            const node = workflowNodes.get(event.nodeId);
            if (node && shouldReportWorkflowNode(node)) this.appendRunLog('success', `完成：${describeWorkflowNode(node)}`);
          } else if (event.kind === 'diagnostic') this.appendRunLog('error', event.message);
        };
        const initialHistory = [...handle.history];
        handle.subscribe(reportEvent);
        initialHistory.forEach(reportEvent);
      }
      void handle.completion.then(async (result) => {
        try {
          if (result.status === 'completed') {
            this.appendRunLog('success', `执行完成${'executedNodes' in result ? ` · ${result.executedNodes} 步 · ${result.durationMs}ms` : ''}`);
            this.updateRunStatus({ state: 'completed', currentStep: '执行完成', message: '自动化脚本执行完成', finishedAt: Date.now() });
          } else if (result.status === 'cancelled') {
            const reason = 'reason' in result ? result.reason : '已取消';
            this.appendRunLog('info', reason);
            this.updateRunStatus({ state: 'cancelled', currentStep: '已停止', message: reason, finishedAt: Date.now() });
          } else {
            const error = result.error instanceof Error ? result.error : new Error(String(result.error));
            this.appendRunLog('error', error.message);
            this.updateRunStatus({ state: 'failed', currentStep: '执行失败', message: error.message, finishedAt: Date.now() });
          }
        } finally {
          if (frontendId !== 'workflow') await session!.close().catch((error) => this.appendRunLog('error', `资源释放失败：${error instanceof Error ? error.message : String(error)}`));
          if (this.active?.handle === handle) this.active = null;
        }
      }).catch((error) => {
        this.appendRunLog('error', `运行状态处理失败：${error instanceof Error ? error.message : String(error)}`);
        this.updateRunStatus({ state: 'failed', message: error instanceof Error ? error.message : String(error), finishedAt: Date.now() });
        if (this.active?.handle === handle) this.active = null;
      });
      return { runId: handle.runId };
    } catch (error) {
      if (session) await session.close().catch(() => undefined); else tab?.release();
      const message = error instanceof Error ? error.message : String(error);
      this.appendRunLog('error', message);
      this.updateRunStatus({ state: 'failed', currentStep: '启动失败', message, finishedAt: Date.now() });
      throw error;
    }
  }

  async cancel(): Promise<void> {
    const active = this.active; if (!active) return;
    this.updateRunStatus({ state: 'cancelling', currentStep: '正在停止' });
    this.appendRunLog('info', '用户请求停止自动化脚本');
    await active.handle.cancel('cancelled by user');
  }

  async assetPreview(packageId: string, asset: string): Promise<{ dataUrl: string; width: number; height: number }> {
    await this.ready;
    const source = this.repository.get(packageId);
    const normalized = asset.startsWith('assets/') ? asset : `assets/${asset}`;
    const bytes = source.assets.get(normalized) ?? source.assets.get(asset);
    if (!bytes) throw new Error(`automation asset is missing: ${asset}`);
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw new Error(`automation asset cannot be decoded: ${asset}`);
    const dimensions = image.getSize();
    const scale = Math.min(1, 160 / dimensions.width, 100 / dimensions.height);
    const preview = scale < 1 ? image.resize({ width: Math.max(1, Math.round(dimensions.width * scale)), height: Math.max(1, Math.round(dimensions.height * scale)) }) : image;
    return { dataUrl: preview.toDataURL(), width: dimensions.width, height: dimensions.height };
  }

  async importAssets(packageId: string, files: readonly { name: string; bytes: Uint8Array }[]): Promise<AutomationPackageV3Detail> {
    await this.ready;
    const current = this.repository.get(packageId); const assets = new Map(current.assets);
    const assetMetadata = { ...(current.manifest.assetMetadata ?? {}) };
    for (const file of files) {
      const clean = file.name.replace(/\\/gu, '/').split('/').filter((part) => part && part !== '.' && part !== '..')
        .map((part) => part.trim().replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]/gu, '-').slice(0, 100)).filter(Boolean).join('/').slice(0, 300);
      if (!clean || file.bytes.byteLength > 16 * 1024 * 1024) throw new Error(`素材文件无效或过大：${file.name}`);
      const image = nativeImage.createFromBuffer(Buffer.from(file.bytes)); if (image.isEmpty()) throw new Error(`无法读取图片素材：${file.name}`);
      const assetPath = `assets/${clean}`;
      assets.set(assetPath, file.bytes);
      delete assetMetadata[assetPath];
    }
    await this.repository.save(clonePackage(current, { assets, manifest: { ...current.manifest, assetMetadata } }));
    await this.closeAuthoringVision(packageId);
    return this.getPackage(packageId);
  }

  async deleteAsset(packageId: string, asset: string): Promise<AutomationPackageV3Detail> {
    await this.ready; const current = this.repository.get(packageId); const normalized = asset.startsWith('assets/') ? asset : `assets/${asset}`;
    if (current.workflow && JSON.stringify(current.workflow).includes(normalized.replace(/^assets\//u, ''))) throw new Error('该素材仍被积木引用，请先移除引用');
    const assets = new Map(current.assets); assets.delete(normalized);
    const assetMetadata = { ...(current.manifest.assetMetadata ?? {}) }; delete assetMetadata[normalized];
    await this.repository.save(clonePackage(current, { assets, manifest: { ...current.manifest, assetMetadata } }));
    await this.closeAuthoringVision(packageId);
    return this.getPackage(packageId);
  }

  async captureAssetFrame(packageId: string, tabId: string, authoringRegion?: { x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number }, referenceKind?: 'viewport' | 'region' | 'surface'): Promise<{ token: string; dataUrl: string; previewWidth: number; previewHeight: number; sourceWidth: number; sourceHeight: number; captureMs: number }> {
    let logicalRegion: { x: number; y: number; width: number; height: number } | undefined;
    const captured = await this.withAuthoring(packageId, tabId, (session) => {
      logicalRegion = authoringRegion && authoringRegion.viewportWidth && authoringRegion.viewportHeight
        ? session.authoringDisplayRegionToLogical({ ...authoringRegion, viewportWidth: authoringRegion.viewportWidth, viewportHeight: authoringRegion.viewportHeight })
        : authoringRegion && { x: authoringRegion.x, y: authoringRegion.y, width: authoringRegion.width, height: authoringRegion.height };
      return session.capturePreview();
    });
    const fullImage = nativeImage.createFromBitmap(Buffer.from(captured.bitmap), { width: captured.width, height: captured.height });
    if (fullImage.isEmpty()) throw new Error('captured frame cannot be decoded');
    const image = cropPreview(fullImage, logicalRegion).image; const imageSize = image.getSize();
    const token = crypto.randomBytes(16).toString('hex');
    const timer = setTimeout(() => this.captures.delete(token), 2 * 60_000); timer.unref();
    const resolvedReferenceKind = referenceKind === 'surface' && logicalRegion
      ? 'surface'
      : logicalRegion ? 'region' : 'viewport';
    this.captures.set(token, { image, referenceKind: resolvedReferenceKind, createdAt: Date.now(), timer });
    while (this.captures.size > 3) {
      const oldest = this.captures.keys().next().value as string;
      const entry = this.captures.get(oldest); if (entry) clearTimeout(entry.timer);
      this.captures.delete(oldest);
    }
    return { token, dataUrl: image.toDataURL(), previewWidth: imageSize.width, previewHeight: imageSize.height, sourceWidth: imageSize.width, sourceHeight: imageSize.height, captureMs: captured.captureMs };
  }

  async saveCapturedAsset(packageId: string, token: string, assetName: string, rect: { x: number; y: number; width: number; height: number }, overwrite = false): Promise<{ asset: string }> {
    await this.ready;
    const capture = this.captures.get(token); if (!capture) throw new Error('captured frame expired');
    const clean = assetName.trim().replace(/\.png$/iu, '');
    const hasControlCharacter = Array.from(clean).some((character) => character.charCodeAt(0) < 32);
    if (!clean || clean.length > 160 || hasControlCharacter || /[<>:"/\\|?*]/u.test(clean) || /[. ]$/u.test(clean)) throw new Error('asset name is invalid');
    const size = capture.image.getSize();
    const crop = { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    if (crop.x + crop.width > size.width || crop.y + crop.height > size.height) throw new Error('asset selection is outside the captured frame');
    const asset = `assets/${clean}.png`;
    const source = this.repository.get(packageId); if (source.assets.has(asset) && !overwrite) throw new Error('asset already exists');
    // 自动剥离纯色背景:转成带 alpha 的 PNG 后,OpenCV Worker 会自动走 alpha mask
    // 分支,避免模板把背景像素算进归一化相关性导致分数跌穿阈值。
    const cropped = capture.image.crop(crop);
    const { image: keyedAsset } = keyOutAssetBackground(cropped);
    const assets = new Map(source.assets); assets.set(asset, new Uint8Array(keyedAsset.toPNG()));
    const assetMetadata = {
      ...(source.manifest.assetMetadata ?? {}),
      [asset]: { source: 'capture' as const, reference: { kind: capture.referenceKind, width: size.width, height: size.height } },
    };
    await this.repository.save(clonePackage(source, { assets, manifest: { ...source.manifest, assetMetadata } }));
    await this.closeAuthoringVision(packageId);
    clearTimeout(capture.timer); this.captures.delete(token);
    return { asset };
  }

  async testAsset(packageId: string, tabId: string, asset: string, threshold = DEFAULT_IMAGE_MATCH_THRESHOLD, scales: readonly number[] = imageMatchScales(), mask: 'auto' | 'none' | 'alpha' = DEFAULT_IMAGE_MATCH_MASK) {
    return this.withAuthoring(packageId, tabId, (session) => session.testImage(asset, threshold, scales, mask));
  }

  async testAssetOnImage(packageId: string, asset: string, image: NativeImage, _threshold = DEFAULT_IMAGE_MATCH_THRESHOLD, scales: readonly number[] = imageMatchScales(), mask: 'auto' | 'none' | 'alpha' = DEFAULT_IMAGE_MATCH_MASK) {
    await this.ready;
    const source = this.repository.get(packageId);
    const cached = this.getAuthoringVision(packageId, source);
    const previous = cached.queue;
    let release!: () => void;
    cached.queue = new Promise<void>((resolve) => { release = resolve; });
    clearTimeout(cached.closeTimer);
    await previous;
    try {
      const size = image.getSize(); const group = decodeAutomationImageGroup(asset);
      const frame: AutomationCapturedFrame = { image, bitmap: image.toBitmap(), bitmapSize: size, deviceSize: size, cssSize: size };
      const vision = new AutomationVisionService(cached.matcher); const signal = createAutomationAbortController().signal;
      let match = await vision.locate(frame, { assets: group ?? [asset], threshold: AUTHORING_BEST_CANDIDATE_THRESHOLD, scales, mask }, signal);
      if (!match || match.score < _threshold) {
        const fallbackScales = imageMatchFallbackScales(scales);
        const fallback = fallbackScales.length
          ? await vision.locate(frame, { assets: group ?? [asset], threshold: AUTHORING_BEST_CANDIDATE_THRESHOLD, scales: fallbackScales, mask }, signal)
          : null;
        if (fallback && (!match || fallback.score > match.score)) match = fallback;
      }
      return match;
    } finally {
      release();
      cached.closeTimer = this.scheduleAuthoringVisionClose(packageId, cached);
    }
  }

  async testTextOnImage(image: NativeImage, query: string, match: 'contains' | 'exact' = 'contains', minConfidence = .5) {
    const size = image.getSize();
    // 复用常驻 Sidecar:这里每次新建一个进程都要付一次模型加载的冷启动成本。
    const engine = sharedAutomationOcrEngine();
    const frame: AutomationCapturedFrame = { image, bitmap: image.toBitmap(), bitmapSize: size, deviceSize: size, cssSize: size };
    const textService = new AutomationTextRecognitionService(engine); const signal = createAutomationAbortController().signal;
    return textService.locateBestRecognized(frame, await textService.recognize(frame, signal), { text: query, match, minScore: minConfidence });
  }

  async testText(packageId: string, tabId: string, text: string, match: 'contains' | 'exact' = 'contains', minConfidence = .5) {
    return this.withAuthoring(packageId, tabId, (session) => session.testText(text, match, minConfidence));
  }

  async testAssetPreview(packageId: string, tabId: string, asset: string, threshold = DEFAULT_IMAGE_MATCH_THRESHOLD, scales?: readonly number[], mask: 'auto' | 'none' | 'alpha' = DEFAULT_IMAGE_MATCH_MASK, authoringRegion?: { x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number }) {
    const totalStartedAt = performance.now();
    await this.ready;
    const source = this.repository.get(packageId);
    let logicalRegion: { x: number; y: number; width: number; height: number } | undefined;
    const result = await this.withAuthoring(packageId, tabId, (session) => {
      logicalRegion = authoringRegion && authoringRegion.viewportWidth && authoringRegion.viewportHeight
        ? session.authoringDisplayRegionToLogical({ ...authoringRegion, viewportWidth: authoringRegion.viewportWidth, viewportHeight: authoringRegion.viewportHeight })
        : authoringRegion && { x: authoringRegion.x, y: authoringRegion.y, width: authoringRegion.width, height: authoringRegion.height };
      const displayRegion = authoringRegion && { x: authoringRegion.x, y: authoringRegion.y, width: authoringRegion.width, height: authoringRegion.height };
      const group = decodeAutomationImageGroup(asset); const assets = group ?? [asset];
      const references = scales === undefined && logicalRegion
        ? assets.map((item) => {
          const normalized = item.startsWith('assets/') ? item : `assets/${item}`;
          const metadata = source.manifest.assetMetadata?.[normalized];
          return metadata?.source === 'capture' && metadata.reference.kind === 'surface' ? metadata.reference : undefined;
        })
        : [];
      const predicted = references.length === assets.length && references.every(Boolean)
        ? surfaceReferenceImageScales(references as Array<{ width: number; height: number }>, logicalRegion!)
        : undefined;
      const initialScales = scales ?? predicted ?? imageMatchScales();
      const fallbackScales = scales === undefined ? imageMatchFallbackScales(initialScales) : [];
      return session.testImagePreview(asset, threshold, initialScales, mask, logicalRegion, displayRegion, fallbackScales);
    });
    const fullImage = nativeImage.createFromBitmap(Buffer.from(result.preview.bitmap), { width: result.preview.width, height: result.preview.height });
    const cropped = cropPreview(fullImage, logicalRegion); const image = cropped.image; const imageSize = image.getSize();
    const candidate = result.match && result.bitmapMatch ? {
      // The preview is the captured bitmap, so draw with the matcher's original
      // bitmap coordinates. Logical/page coordinates are reported separately.
      x: result.bitmapMatch.x - cropped.origin.x, y: result.bitmapMatch.y - cropped.origin.y,
      pageX: result.match.bounds.x, pageY: result.match.bounds.y,
      width: result.bitmapMatch.width, height: result.bitmapMatch.height, score: result.match.score,
      scale: result.bitmapMatch.scale ?? 1, matchMs: result.bitmapMatch.matchMs ?? 0,
      queueWaitMs: result.bitmapMatch.queueWaitMs ?? 0,
      queueDepthAtSubmit: result.bitmapMatch.queueDepthAtSubmit ?? 0,
      algorithm: result.bitmapMatch.algorithm,
    } : null;
    return { dataUrl: image.toDataURL(), previewWidth: imageSize.width, previewHeight: imageSize.height, sourceWidth: imageSize.width, sourceHeight: imageSize.height, candidate, matched: Boolean(candidate && candidate.score >= threshold), threshold, captureMs: result.preview.captureMs, totalMs: performance.now() - totalStartedAt };
  }

  async testTextPreview(packageId: string, tabId: string, text: string, match: 'contains' | 'exact' = 'contains', minConfidence = .5, authoringRegion?: { x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number }) {
    const totalStartedAt = performance.now();
    let logicalRegion: { x: number; y: number; width: number; height: number } | undefined;
    const result = await this.withAuthoring(packageId, tabId, (session) => {
      logicalRegion = authoringRegion && authoringRegion.viewportWidth && authoringRegion.viewportHeight
        ? session.authoringDisplayRegionToLogical({ ...authoringRegion, viewportWidth: authoringRegion.viewportWidth, viewportHeight: authoringRegion.viewportHeight })
        : authoringRegion && { x: authoringRegion.x, y: authoringRegion.y, width: authoringRegion.width, height: authoringRegion.height };
      const displayRegion = authoringRegion && { x: authoringRegion.x, y: authoringRegion.y, width: authoringRegion.width, height: authoringRegion.height };
      return session.testTextPreview(text, match, minConfidence, logicalRegion, displayRegion);
    });
    const fullImage = nativeImage.createFromBitmap(Buffer.from(result.preview.bitmap), { width: result.preview.width, height: result.preview.height });
    const cropped = result.previewIsRegion ? { image: fullImage, origin: { x: 0, y: 0 } } : cropPreview(fullImage, logicalRegion);
    const image = cropped.image; const imageSize = image.getSize();
    const candidate = result.match && result.bitmapMatch ? {
      text: result.bitmapMatch.text, score: result.match.score,
      x: result.bitmapMatch.x - cropped.origin.x, y: result.bitmapMatch.y - cropped.origin.y,
      pageX: result.match.bounds.x, pageY: result.match.bounds.y,
      width: result.bitmapMatch.width, height: result.bitmapMatch.height, matched: result.bitmapMatch.matched,
      textSimilarity: result.bitmapMatch.textSimilarity,
    } : null;
    return {
      dataUrl: image.toDataURL(), previewWidth: imageSize.width, previewHeight: imageSize.height,
      sourceWidth: imageSize.width, sourceHeight: imageSize.height, query: text,
      candidates: candidate ? [candidate] : [], matched: Boolean(candidate?.matched),
      recognizedCount: result.recognizedCount, recognizedTexts: result.recognizedTexts,
      captureMs: result.preview.captureMs, bitmapMs: result.preview.bitmapMs,
      ocrMs: result.ocrMs, totalMs: performance.now() - totalStartedAt,
    };
  }

  async warmAuthoring(packageId: string): Promise<void> {
    await this.ready;
    const source = this.repository.get(packageId);
    const cached = this.getAuthoringVision(packageId, source);
    const previous = cached.queue;
    let release!: () => void;
    cached.queue = new Promise<void>((resolve) => { release = resolve; });
    clearTimeout(cached.closeTimer);
    await previous;
    try { await cached.matcher.warmup(createAutomationAbortController().signal); }
    finally { release(); cached.closeTimer = this.scheduleAuthoringVisionClose(packageId, cached); }
  }

  private async withAuthoring<T>(packageId: string, tabId: string, task: (session: BrowserViewAutomationCoreSession) => Promise<T>): Promise<T> {
    await this.ready;
    if (this.active) throw new Error('cannot author assets while automation is running');
    const source = this.repository.get(packageId);
    const cached = this.getAuthoringVision(packageId, source);
    const previous = cached.queue;
    let release!: () => void;
    cached.queue = new Promise<void>((resolve) => { release = resolve; });
    clearTimeout(cached.closeTimer);
    await previous;
    const handle = tabManager.beginAutomation(tabId, { mode: 'fixed', width: 1280, height: 720 });
    try { await handle.ready; }
    catch (error) {
      handle.release(); release(); cached.closeTimer = this.scheduleAuthoringVisionClose(packageId, cached); throw error;
    }
    const session = new BrowserViewAutomationCoreSession(handle, source, undefined, undefined, undefined, { matcher: cached.matcher, ocrEngine: this.authoringOcr });
    try { return await task(session); }
    finally {
      await session.close();
      release();
      cached.closeTimer = this.scheduleAuthoringVisionClose(packageId, cached);
    }
  }

  private getAuthoringVision(packageId: string, source: AutomationPackageV3): AuthoringVisionSession {
    // 素材源交给常驻 Worker 的注册表解析,模板按内容 SHA-256 缓存,跨包共享。
    registerAutomationAssetSource(packageId, source);
    const existing = this.authoringVision.get(packageId);
    if (existing) return existing;
    const cached: AuthoringVisionSession = {
      matcher: sharedAutomationVisionMatcher(),
      queue: Promise.resolve(),
      closeTimer: setTimeout(() => undefined, 0),
    };
    clearTimeout(cached.closeTimer);
    cached.closeTimer = this.scheduleAuthoringVisionClose(packageId, cached);
    this.authoringVision.set(packageId, cached);
    return cached;
  }

  private scheduleAuthoringVisionClose(packageId: string, cached: AuthoringVisionSession): NodeJS.Timeout {
    // 常驻开启时 Worker 归预热模块所有。这里关闭它等于把下次识别打回冷启动,
    // 因此只保留记录、不做实际回收。
    if (loadConfig().automationVisionWarmStart) {
      const idle = setTimeout(() => undefined, 0);
      idle.unref();
      return idle;
    }
    const timer = setTimeout(() => {
      if (this.authoringVision.get(packageId) !== cached) return;
      this.authoringVision.delete(packageId);
      void cached.queue.then(() => shutdownAutomationVision());
    }, AUTHORING_VISION_IDLE_MS);
    timer.unref();
    return timer;
  }

  private async closeAuthoringVision(packageId: string): Promise<void> {
    const cached = this.authoringVision.get(packageId);
    if (!cached) return;
    this.authoringVision.delete(packageId);
    clearTimeout(cached.closeTimer);
    await cached.queue;
    // 常驻开启时保留 Worker;非常驻时释放,恢复"用完即回收"的旧行为。
    if (!loadConfig().automationVisionWarmStart) await shutdownAutomationVision();
  }

  async shutdown(): Promise<void> {
    await this.cancel();
    await Promise.all([...this.authoringVision.keys()].map((packageId) => this.closeAuthoringVision(packageId)));
    // OCR Sidecar 与 OpenCV Worker 由预热模块统一持有,退出时在那里释放。
  }
}

let activeAutomationV3Service: AutomationV3Service | null = null;

export function setAutomationV3Service(service: AutomationV3Service): void {
  activeAutomationV3Service = service;
}

export function getAutomationV3Service(): AutomationV3Service | null {
  return activeAutomationV3Service;
}
