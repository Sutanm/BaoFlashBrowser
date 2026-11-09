import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { app, nativeImage, shell, type NativeImage } from 'electron';
import type { WorkflowDocumentV3, WorkflowNode } from '../../../shared/automation/core';
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
import { DEFAULT_IMAGE_MATCH_MASK, DEFAULT_IMAGE_MATCH_THRESHOLD, imageMatchFallbackScales, imageMatchScales } from '../../../shared/automation/vision-policy';
import { createAutomationAbortController } from '../../../shared/automation/abort-controller';
import { automationError, automationErrorMessage } from '../../../shared/automation/error-format';
import { registerAutomationAssetSource, unregisterAutomationAssetSource, sharedAutomaticVisionMatcher, sharedAutomationColorMatcher, sharedAutomationOcrEngine, sharedAutomationVisionMatcher } from './automation-warm-start';
import { keyOutAssetBackground } from './asset-keyout';
import { clonePackage, runtimePackage } from './automation-transpile';
import { describeWorkflowNode, indexWorkflowNodes, shouldReportWorkflowNode, workflowReferencesScript } from './automation-run-description';
import { AuthoringVisionPool } from './authoring-vision-pool';
import { AUTHORING_BEST_CANDIDATE_THRESHOLD, AutomationVisionService } from './vision-service';
import { AutomationTextRecognitionService } from './text-recognition-service';
import type { AutomationCapturedFrame } from './capability-contracts';
import { evaluateStructuredColorMatch } from './color-structure-policy';

export type AutomationPackageV3Detail = {
  readonly packageId: string;
  readonly name: string;
  readonly mainEntryId: string;
  readonly workflow?: WorkflowDocumentV3;
  readonly scripts: readonly { readonly id: string; readonly name: string; readonly path: string; readonly language: 'javascript' | 'typescript'; readonly permissions: readonly JavaScriptAutomationCapability[]; readonly source: string }[];
  readonly assets: readonly string[];
  readonly profiles: readonly { readonly path: string; readonly profile: AutomationProfileV3 }[];
};

export type AutomationRunLog = {
  readonly system?: boolean;
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

/** 运行日志文件名：YYMMDD-HH-MM-脚本名称-记录N.json（脚本名已做文件名安全化）。 */
const RUN_LOG_FILE_PATTERN = /^\d{6}-\d{2}-\d{2}-[^\\/:*?"<>|\p{Cc}]+-记录\d{1,6}\.json$/u;
/** 旧格式（run-<ts>-<rand>.jsonl）只用于清理，不再列出。 */
const LEGACY_RUN_LOG_PATTERN = /^run-\d{13}-[a-z0-9]{6}\.jsonl$/u;

/** 文件名白名单校验：格式、长度、基名（防目录穿越）。 */
export function isRunLogFileName(name: string): boolean {
  return name.length <= 160 && RUN_LOG_FILE_PATTERN.test(name) && name === path.basename(name) && !name.includes('..');
}

/** 脚本名进文件名前替换 Windows 非法字符，避免写盘失败。 */
function sanitizeScriptName(name: string): string {
  const cleaned = String(name).replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').replace(/\s+/gu, ' ').trim().slice(0, 40);
  return cleaned || '未命名脚本';
}

function cropPreview(image: NativeImage, region: { x: number; y: number; width: number; height: number } | undefined): { image: NativeImage; origin: { x: number; y: number } } {
  if (!region) return { image, origin: { x: 0, y: 0 } };
  const size = image.getSize();
  const x = Math.max(0, Math.floor(region.x)); const y = Math.max(0, Math.floor(region.y));
  const right = Math.min(size.width, Math.ceil(region.x + region.width)); const bottom = Math.min(size.height, Math.ceil(region.y + region.height));
  if (right <= x || bottom <= y) throw new Error('游戏区域不在当前截图范围内，请重新选择游戏画面');
  return { image: image.crop({ x, y, width: right - x, height: bottom - y }), origin: { x, y } };
}

export class AutomationV3Service {
  readonly ready: Promise<void>;
  private active: { session: BrowserViewAutomationCoreSession; handle: WorkflowRunHandle | JavaScriptSandboxRunHandle; packageId: string; frontendId: string } | null = null;
  /** start() 的异步准备阶段占位，避免并发调用同时通过 this.active 检查。 */
  private starting = false;
  private runStatus: AutomationRunStatus = { state: 'idle', executedSteps: 0, logs: [] };
  /** 当前运行的落盘文件名，每次 start() 重置；idle 时为 null 不落盘。 */
  private currentLogFile: string | null = null;
  private readonly captures = new Map<string, { image: NativeImage; referenceKind: 'viewport' | 'region' | 'surface'; viewportTransform: { scaleX: number; scaleY: number }; createdAt: number; timer: NodeJS.Timeout }>();
  private readonly authoringVision = new AuthoringVisionPool();
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

  private appendRunLog(level: AutomationRunLog['level'], message: string, system = true): void {
    const clean = String(message).trim().slice(0, 4_000); if (!clean) return;
    const logs = [...this.runStatus.logs, { timestamp: Date.now(), level, message: clean, system }].slice(-2_000);
    this.runStatus = { ...this.runStatus, logs };
    // 历史落盘：JSONL 追加写，跨运行可回溯，不随内存裁剪丢行
    void this.persistRunLog({ timestamp: Date.now(), level, message: clean, system }).catch(() => { /* 日志落盘失败不影响运行 */ });
  }

  /** 生成 `YYMMDD-HH-MM-脚本名称-记录N.json`，同名已存在时 N 递增。 */
  private async createRunLogFileName(scriptName: string): Promise<string> {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    const stamp = `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const prefix = `${stamp}-${sanitizeScriptName(scriptName)}-记录`;
    // 命名只是可读性增强，取不到 userData（单测/异常环境）时退化为不查重，不能阻断运行。
    let existing = new Set<string>();
    try {
      const logDirectory = path.join(app.getPath('userData'), 'automation-logs');
      await fs.promises.mkdir(logDirectory, { recursive: true });
      existing = new Set(await fs.promises.readdir(logDirectory));
    } catch { /* 目录不可用时直接返回首个候选名 */ }
    for (let index = 1; index <= 9999; index += 1) {
      const candidate = `${prefix}${index}.json`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${prefix}${Date.now()}.json`;
  }

  private async persistRunLog(entry: AutomationRunLog): Promise<void> {
    // 先取快照：调用方是 fire-and-forget，运行结束时 currentLogFile 可能已被清空。
    const file = this.currentLogFile;
    if (!file) return;
    try {
      const logDirectory = path.join(app.getPath('userData'), 'automation-logs');
      await fs.promises.mkdir(logDirectory, { recursive: true });
      await fs.promises.appendFile(path.join(logDirectory, file), JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* 日志落盘失败不影响运行（含 userData 不可用的环境） */ }
  }

  /** 自动清理：只保留最近 7 天、最多 50 份运行日志，避免长期运行无限增长。 */
  private async pruneRunLogs(): Promise<void> {
    let names: string[];
    let logDirectory: string;
    try {
      logDirectory = path.join(app.getPath('userData'), 'automation-logs');
      names = await fs.promises.readdir(logDirectory);
    } catch { return; }
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const files = names.filter((name) => (RUN_LOG_FILE_PATTERN.test(name) || LEGACY_RUN_LOG_PATTERN.test(name)) && name !== this.currentLogFile);
    const stats = await Promise.all(files.map(async (name) => {
      try {
        const stat = await fs.promises.stat(path.join(logDirectory, name));
        return { name, mtime: stat.mtimeMs, legacy: LEGACY_RUN_LOG_PATTERN.test(name) };
      } catch { return null; }
    }));
    const kept = stats
      .filter((item): item is { name: string; mtime: number; legacy: boolean } => item !== null)
      .sort((a, b) => b.mtime - a.mtime);
    await Promise.all(kept
      // 旧命名文件已不再展示，直接清掉，避免和新格式混在一起。
      .filter((item, index) => item.legacy || index >= 50 || item.mtime < cutoff)
      .map((item) => fs.promises.unlink(path.join(logDirectory, item.name)).catch(() => undefined)));
  }

  /** 列出落盘的运行日志（新→旧），文件名白名单校验在 readPersistedRunLog。 */
  async listPersistedRunLogs(): Promise<Array<{ name: string; sizeLabel: string; scriptName: string; startedAt: number }>> {
    let names: string[];
    let logDirectory: string;
    try {
      logDirectory = path.join(app.getPath('userData'), 'automation-logs');
      names = await fs.promises.readdir(logDirectory);
    } catch { return []; }
    const files = names.filter((name) => isRunLogFileName(name));
    const stats = await Promise.all(files.map(async (name) => {
      try {
        const stat = await fs.promises.stat(path.join(logDirectory, name));
        return { name, mtime: stat.mtimeMs, bytes: stat.size };
      } catch { return null; }
    }));
    return stats
      .filter((item): item is { name: string; mtime: number; bytes: number } => item !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .map((item) => ({
        name: item.name,
        sizeLabel: item.bytes >= 1024 ? `${(item.bytes / 1024).toFixed(1)} KB` : `${item.bytes} B`,
        // 从文件名还原脚本名：YYMMDD-HH-MM-脚本名称-记录N.json
        scriptName: item.name.replace(/^\d{6}-\d{2}-\d{2}-/u, '').replace(/-记录\d+\.json$/u, ''),
        startedAt: item.mtime,
      }));
  }

  /** 读取单个落盘日志；文件名必须是白名单格式，防目录穿越。 */
  async readPersistedRunLog(name: string): Promise<AutomationRunLog[]> {
    if (!isRunLogFileName(name)) throw new Error('invalid automation log name');
    const target = path.join(app.getPath('userData'), 'automation-logs', name);
    let raw: string;
    try { raw = await fs.promises.readFile(target, 'utf8'); } catch { return []; }
    return raw.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) as AutomationRunLog; } catch { return null; }
    }).filter((entry): entry is AutomationRunLog => entry !== null);
  }

  /** 用系统默认程序打开日志文件（JSON 会落到编辑器/浏览器），返回错误文本或空串。 */
  async openPersistedRunLog(name: string): Promise<string> {
    if (!isRunLogFileName(name)) throw new Error('invalid automation log name');
    const target = path.join(app.getPath('userData'), 'automation-logs', name);
    return shell.openPath(target);
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
    await this.authoringVision.close(installed.packageId);
    const source = this.repository.get(installed.packageId);
    for (const entry of source.manifest.frontends.scripts) await this.grants.approve(installed.packageId, entry.id, entry.permissions, approvals[entry.id] ?? []);
    return installed;
  }
  async remove(packageId: string): Promise<void> {
    await this.ready;
    if (this.active?.packageId === packageId) throw new Error('自动化正在运行，请先停止后再删除自动化包');
    await this.authoringVision.close(packageId);
    await this.repository.remove(packageId);
    await this.grants.remove(packageId);
    // 包已删除：从共享素材注册表移除，避免同名素材继续解析到已删包的字节。
    unregisterAutomationAssetSource(packageId);
  }
  async export(packageId: string): Promise<Uint8Array> { await this.ready; return this.repository.export(packageId); }

  async start(packageId: string, frontendId: string, tabId: string, profilePath?: string): Promise<{ runId: string }> {
    await this.ready;
    // starting 覆盖从校验通过到 this.active 赋值之间的整个异步准备阶段；
    // 只检查 this.active 会让两个并发 start() 都通过检查并各建一个会话。
    if (this.active || this.starting) throw new Error('another Automation 2.0 run is active');
    const source = this.repository.get(packageId);
    const validFrontends = new Set([...(source.workflow ? ['workflow'] : []), ...source.manifest.frontends.scripts.map((entry) => entry.id)]);
    if (!validFrontends.has(frontendId)) throw new Error(`automation frontend is missing: ${frontendId}`);
    const profile = profilePath ? source.profiles.get(profilePath) : undefined;
    if (profilePath && !profile) throw new Error(`automation profile is missing: ${profilePath}`);
    if (profile && profile.entryId !== frontendId) throw new Error(`profile ${profile.id} belongs to frontend ${profile.entryId}`);
    this.starting = true;
    this.runStatus = { state: 'preparing', packageId, frontendId, workflowName: source.manifest.name, currentStep: '正在准备目标页面', executedSteps: 0, startedAt: Date.now(), logs: [] };
    this.currentLogFile = await this.createRunLogFileName(source.manifest.name);
    void this.pruneRunLogs().catch(() => undefined);
    this.appendRunLog('info', `开始运行「${source.manifest.name}」· ${frontendId === 'workflow' ? 'Blockly 主流程' : frontendId}`);
    let tab: ReturnType<typeof tabManager.beginAutomation> | undefined;
    let session: BrowserViewAutomationCoreSession | undefined;
    try {
      tab = tabManager.beginAutomation(tabId, { mode: 'fixed', width: 1280, height: 720 });
      await tab.ready;
      this.updateRunStatus({ currentStep: '正在初始化 Automation Core' });
      // 运行会话复用常驻 Worker/Sidecar,避免每次运行重新支付 OpenCV/OCR 冷启动。
      // 只转译一次：esbuild.transformSync 每次都会拉起子进程，重复调用没有意义。
      const runtime = runtimePackage(source);
      registerAutomationAssetSource(packageId, runtime);
      session = new BrowserViewAutomationCoreSession(tab, runtime, profile, (message, level) => this.appendRunLog(level === 'error' ? 'error' : 'info', message, false), (entryId) => this.grants.get(packageId, entryId), { matcher: sharedAutomationVisionMatcher(), colorMatcher: sharedAutomationColorMatcher(), automaticMatcher: sharedAutomaticVisionMatcher(), ocrEngine: sharedAutomationOcrEngine() });
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
            const error = automationError(result.error);
            this.appendRunLog('error', error.message);
            this.updateRunStatus({ state: 'failed', currentStep: '执行失败', message: error.message, finishedAt: Date.now() });
          }
        } finally {
          if (frontendId !== 'workflow') await session!.close().catch((error) => this.appendRunLog('error', `资源释放失败：${automationErrorMessage(error)}`));
          if (this.active?.handle === handle) this.active = null;
          // 运行真正结束后才清空落盘文件名；start() 的 finally 早于运行完成。
          this.currentLogFile = null;
        }
      }).catch((error) => {
        this.appendRunLog('error', `运行状态处理失败：${automationErrorMessage(error)}`);
        this.updateRunStatus({ state: 'failed', message: automationErrorMessage(error), finishedAt: Date.now() });
        if (this.active?.handle === handle) this.active = null;
        this.currentLogFile = null;
      });
      return { runId: handle.runId };
    } catch (error) {
      if (session) await session.close().catch(() => undefined); else tab?.release();
      const message = automationErrorMessage(error);
      this.appendRunLog('error', message);
      this.updateRunStatus({ state: 'failed', currentStep: '启动失败', message, finishedAt: Date.now() });
      // appendRunLog 已同步取走文件名快照，这里清空不会丢这条落盘记录。
      this.currentLogFile = null;
      throw error;
    } finally {
      this.starting = false;
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
    await this.authoringVision.close(packageId);
    return this.getPackage(packageId);
  }

  async deleteAsset(packageId: string, asset: string): Promise<AutomationPackageV3Detail> {
    await this.ready; const current = this.repository.get(packageId); const normalized = asset.startsWith('assets/') ? asset : `assets/${asset}`;
    if (current.workflow && JSON.stringify(current.workflow).includes(normalized.replace(/^assets\//u, ''))) throw new Error('该素材仍被积木引用，请先移除引用');
    const assets = new Map(current.assets); assets.delete(normalized);
    const assetMetadata = { ...(current.manifest.assetMetadata ?? {}) }; delete assetMetadata[normalized];
    await this.repository.save(clonePackage(current, { assets, manifest: { ...current.manifest, assetMetadata } }));
    await this.authoringVision.close(packageId);
    return this.getPackage(packageId);
  }

  async captureAssetFrame(packageId: string, tabId: string, authoringRegion?: { x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number }, referenceKind?: 'viewport' | 'region' | 'surface'): Promise<{ token: string; dataUrl: string; previewWidth: number; previewHeight: number; sourceWidth: number; sourceHeight: number; captureMs: number }> {
    let logicalRegion: { x: number; y: number; width: number; height: number } | undefined;
    const captured = await this.withAuthoring(packageId, tabId, (session) => {
      logicalRegion = authoringRegion && authoringRegion.viewportWidth && authoringRegion.viewportHeight
        ? session.authoringDisplayRegionToLogical({ ...authoringRegion, viewportWidth: authoringRegion.viewportWidth, viewportHeight: authoringRegion.viewportHeight })
        : authoringRegion && { x: authoringRegion.x, y: authoringRegion.y, width: authoringRegion.width, height: authoringRegion.height };
      return session.capturePreviewWithViewportTransform();
    });
    const fullImage = nativeImage.createFromBitmap(Buffer.from(captured.bitmap), { width: captured.width, height: captured.height });
    if (fullImage.isEmpty()) throw new Error('captured frame cannot be decoded');
    const image = cropPreview(fullImage, logicalRegion).image; const imageSize = image.getSize();
    const token = crypto.randomBytes(16).toString('hex');
    const timer = setTimeout(() => this.captures.delete(token), 2 * 60_000); timer.unref();
    const resolvedReferenceKind = referenceKind === 'surface' && logicalRegion
      ? 'surface'
      : logicalRegion ? 'region' : 'viewport';
    this.captures.set(token, { image, referenceKind: resolvedReferenceKind, viewportTransform: captured.viewportTransform, createdAt: Date.now(), timer });
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
      [asset]: { source: 'capture' as const, reference: { kind: capture.referenceKind, width: size.width, height: size.height, viewportTransform: capture.viewportTransform } },
    };
    await this.repository.save(clonePackage(source, { assets, manifest: { ...source.manifest, assetMetadata } }));
    await this.authoringVision.close(packageId);
    clearTimeout(capture.timer); this.captures.delete(token);
    return { asset };
  }

  async testAsset(packageId: string, tabId: string, asset: string, threshold = DEFAULT_IMAGE_MATCH_THRESHOLD, scales: readonly number[] = imageMatchScales(), mask: 'auto' | 'none' | 'alpha' = DEFAULT_IMAGE_MATCH_MASK) {
    return this.withAuthoring(packageId, tabId, (session) => session.testImage(asset, threshold, scales, mask));
  }

  async testAssetOnImage(packageId: string, asset: string, image: NativeImage, _threshold = DEFAULT_IMAGE_MATCH_THRESHOLD, scales: readonly number[] = imageMatchScales(), mask: 'auto' | 'none' | 'alpha' = DEFAULT_IMAGE_MATCH_MASK) {
    await this.ready;
    const source = this.repository.get(packageId);
    const cached = this.authoringVision.get(packageId, source);
    const previous = cached.queue;
    let release!: () => void;
    cached.queue = new Promise<void>((resolve) => { release = resolve; });
    clearTimeout(cached.closeTimer);
    await previous;
    try {
      const size = image.getSize(); const group = decodeAutomationImageGroup(asset);
      const frame: AutomationCapturedFrame = { image, bitmap: image.toBitmap(), bitmapSize: size, deviceSize: size, cssSize: size };
      const vision = new AutomationVisionService(cached.matcher, cached.colorMatcher, cached.automaticMatcher); const signal = createAutomationAbortController().signal;
      const assets = group ?? [asset];
      let match = await vision.locate(frame, { assets, method: 'auto', threshold: _threshold, scales, mask }, signal);
      const fallbackScales = imageMatchFallbackScales(scales);
      if (!match && fallbackScales.length > 0) {
        match = await vision.locate(frame, { assets, method: 'auto', threshold: _threshold, scales: fallbackScales, mask }, signal);
      }
      const matched = Boolean(match);
      let rejectionReason: 'automatic-policy' | 'threshold' | undefined;
      if (!match) {
        // Diagnostics must use the same automatic router as runtime. Falling
        // back to pure OpenCV here made the Workbench advertise 100% matches
        // that the assistant and scripts correctly rejected.
        match = await vision.locate(frame, { assets, method: 'auto', threshold: AUTHORING_BEST_CANDIDATE_THRESHOLD, scales, mask }, signal);
        if (fallbackScales.length > 0) {
          const fallback = await vision.locate(frame, { assets, method: 'auto', threshold: AUTHORING_BEST_CANDIDATE_THRESHOLD, scales: fallbackScales, mask }, signal);
          if (fallback && (!match || fallback.score > match.score)) match = fallback;
        }
        if (match?.algorithm === 'color-points' && match.structureScore !== undefined) {
          const decision = evaluateStructuredColorMatch(match, _threshold);
          match = { ...match, score: decision.decisionScore };
          rejectionReason = decision.reason === 'threshold' ? 'threshold' : 'automatic-policy';
        } else if (match) {
          rejectionReason = 'threshold';
        }
      }
      return { candidate: match, matched, rejectionReason };
    } finally {
      release();
      this.authoringVision.rearm(packageId, cached);
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
      const references = scales === undefined
        ? assets.map((item) => {
          const normalized = item.startsWith('assets/') ? item : `assets/${item}`;
          const metadata = source.manifest.assetMetadata?.[normalized];
          return metadata?.source === 'capture' ? metadata.reference : undefined;
        })
        : [];
      const captureReferences = references.length === assets.length && references.every(Boolean)
        ? references as Array<NonNullable<typeof references[number]>>
        : undefined;
      const initialScales = scales ?? imageMatchScales();
      const fallbackScales = scales === undefined ? imageMatchFallbackScales(initialScales) : [];
      return session.testImagePreview(asset, threshold, initialScales, mask, logicalRegion, displayRegion, fallbackScales, captureReferences);
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
      colorRawScore: result.bitmapMatch.colorRawScore,
      structureScore: result.bitmapMatch.structureScore,
      structureMargin: result.bitmapMatch.structureMargin,
    } : null;
    return { dataUrl: image.toDataURL(), previewWidth: imageSize.width, previewHeight: imageSize.height, sourceWidth: imageSize.width, sourceHeight: imageSize.height, candidate, matched: result.accepted, rejectionReason: result.rejectionReason, threshold, captureMs: result.preview.captureMs, totalMs: performance.now() - totalStartedAt };
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
    const cached = this.authoringVision.get(packageId, source);
    const previous = cached.queue;
    let release!: () => void;
    cached.queue = new Promise<void>((resolve) => { release = resolve; });
    clearTimeout(cached.closeTimer);
    await previous;
    try { await cached.matcher.warmup(createAutomationAbortController().signal); }
    finally { release(); this.authoringVision.rearm(packageId, cached); }
  }

  private async withAuthoring<T>(packageId: string, tabId: string, task: (session: BrowserViewAutomationCoreSession) => Promise<T>): Promise<T> {
    await this.ready;
    if (this.active) throw new Error('cannot author assets while automation is running');
    const source = this.repository.get(packageId);
    const cached = this.authoringVision.get(packageId, source);
    const previous = cached.queue;
    let release!: () => void;
    cached.queue = new Promise<void>((resolve) => { release = resolve; });
    clearTimeout(cached.closeTimer);
    await previous;
    const handle = tabManager.beginAutomation(tabId, { mode: 'fixed', width: 1280, height: 720 });
    try { await handle.ready; }
    catch (error) {
      handle.release(); release(); this.authoringVision.rearm(packageId, cached); throw error;
    }
    const session = new BrowserViewAutomationCoreSession(handle, source, undefined, undefined, undefined, { matcher: cached.matcher, colorMatcher: cached.colorMatcher, automaticMatcher: cached.automaticMatcher, ocrEngine: this.authoringOcr });
    try { return await task(session); }
    finally {
      await session.close();
      release();
      this.authoringVision.rearm(packageId, cached);
    }
  }

  async shutdown(): Promise<void> {
    await this.cancel();
    await this.authoringVision.closeAll();
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
