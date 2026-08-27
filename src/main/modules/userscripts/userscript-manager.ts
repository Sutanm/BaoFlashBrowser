// Main-process demo service: script index, per-view registration, frame
// snapshot, value namespace, menu commands and validated reports.
// Mirrors the planned src/main/modules/userscripts/userscript-manager.ts.

import type {
  FrameSnapshot,
  GMSerializable,
  InstalledUserscript,
  ScriptCommand,
  SnapshotScript,
  UserscriptReport,
} from '../../../shared/userscript-types';
import { compileRules, matchesUrl, type CompiledRules } from './userscript-matcher';
import { ValueStore } from './userscript-store';
import { RequireCache } from './userscript-require-cache';

export interface ViewRegistration {
  mode: 'ppapi' | 'ruffle';
  generation: number;
  token: string;
  kind?: 'tab' | 'background';
  /** Per-script background windows: snapshotBackground returns only this script. */
  backgroundScriptId?: string;
}

export interface ManagerOptions {
  maxSnapshotBytes?: number;
  maxSourceBytesPerPage?: number;
  maxResourceBytesPerPage?: number;
  maxReports?: number;
  maxReportDetailBytes?: number;
  requireCache?: RequireCache;
  sendToWc?: (wcId: number, channel: string, payload: unknown) => void;
  persistValues?: { file: string; debounceMs?: number; urgentBytes?: number };
  /** Called when a view is unregistered (e.g. web-request observer cleanup). */
  onViewRemoved?: (wcId: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<ManagerOptions, 'requireCache' | 'sendToWc' | 'persistValues' | 'onViewRemoved'>> = {
  maxSnapshotBytes: 64 * 1024,
  maxSourceBytesPerPage: 512 * 1024,
  maxResourceBytesPerPage: 64 * 1024,
  maxReports: 200,
  maxReportDetailBytes: 2000,
};

interface IndexedScript extends InstalledUserscript {
  rules: CompiledRules;
}

export class UserscriptManager {
  private readonly options: Required<Omit<ManagerOptions, 'requireCache' | 'sendToWc' | 'persistValues' | 'onViewRemoved'>>;
  private readonly requireCache?: RequireCache;
  private readonly sendToWc?: (wcId: number, channel: string, payload: unknown) => void;
  private readonly onViewRemoved?: (wcId: number) => void;
  private readonly values: ValueStore;
  private scripts = new Map<string, IndexedScript>();
  private readonly requireGaps = new Map<string, string[]>();
  private readonly views = new Map<number, ViewRegistration>();
  private readonly valueListeners = new Map<number, Map<string, Map<string, Set<number>>>>();
  private readonly notifications: Array<{ notificationId: number; wcId: number; scriptId: string; documentId: string; text: string; title: string }> = [];
  private nextNotificationId = 1;
  private readonly reports: Array<UserscriptReport & { accepted: boolean; wcId: number }> = [];
  private readonly commands = new Map<string, ScriptCommand>();
  private readonly commandsByWc = new Map<number, Set<string>>();
  private readonly openTabs: Array<{ wcId: number; scriptId: string; url: string }> = [];
  private readonly spaNavigations: Array<{ wcId: number; url: string; reason: string; at: number }> = [];

  // persistValues 字段
  private readonly persistValues?: { file: string; debounceMs: number; urgentBytes: number };
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private scriptByteCounts = new Map<string, number>();

  constructor(values: ValueStore, options?: ManagerOptions) {
    this.values = values;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.requireCache = options?.requireCache;
    this.sendToWc = options?.sendToWc;
    this.onViewRemoved = options?.onViewRemoved;
    if (options?.persistValues) {
      this.persistValues = {
        file: options.persistValues.file,
        debounceMs: options.persistValues.debounceMs ?? 200,
        urgentBytes: options.persistValues.urgentBytes ?? 1024,
      };
    }
  }

  // Rebuilds the script index from the given list (scriptStore is the single
  // source of truth). MUST clear first: incremental merging would leave
  // disabled/uninstalled scripts matching forever (disable/enable then only
  // taking effect after a restart — reproduced).
  loadScripts(scripts: InstalledUserscript[]): void {
    this.scripts.clear();
    for (const script of scripts) {
      if (!script.enabled) continue;
      const metadata = script.metadata;
      this.scripts.set(script.id, { ...script, rules: compileRules(metadata) });
    }
  }

  isScriptInstalled(scriptId: string): boolean {
    return this.scripts.has(scriptId);
  }

  getScriptMetadata(scriptId: string): InstalledUserscript | undefined {
    return this.scripts.get(scriptId);
  }

  // Stage 2 sidebar: which installed scripts match a URL (main frame).
  matchingFor(url: string): Array<{ id: string; name: string; enabled: boolean }> {
    const frameUrl = String(url || '');
    const matched: Array<{ id: string; name: string; enabled: boolean }> = [];
    for (const script of this.scripts.values()) {
      if (script.metadata.background) continue; // background 脚本不出现在 URL 匹配中
      if (!matchesUrl(script.rules, frameUrl)) continue;
      matched.push({ id: script.id, name: script.metadata.name, enabled: script.enabled });
    }
    return matched;
  }

  registerView(wcId: number, registration: ViewRegistration): void {
    this.views.set(wcId, registration);
  }

  unregisterView(wcId: number): void {
    this.views.delete(wcId);
    this.valueListeners.delete(wcId);
    const bucket = this.commandsByWc.get(wcId);
    if (bucket) {
      for (const commandId of bucket) this.commands.delete(commandId);
      this.commandsByWc.delete(wcId);
    }
    this.onViewRemoved?.(wcId);
  }

  getRegistration(wcId: number): ViewRegistration | undefined {
    return this.views.get(wcId);
  }

  snapshotFor(wcId: number, url: string, isMainFrame: boolean): FrameSnapshot {
    const registration = this.views.get(wcId);
    if (!registration) return { ok: false, scripts: [], values: {} };
    const frameUrl = String(url || '');
    return this.buildSnapshot(registration, Array.from(this.scripts.values()).filter((script) => (
      !script.metadata.background
      && matchesUrl(script.rules, frameUrl)
      && (!script.metadata.noframes || isMainFrame)
    )));
  }

  // 抽取 require/resource 拼接到源码的公共逻辑。
  // 保持原 snapshotFor 语义:任一 require 未就绪 → 记录 gap 并返回 undefined(脚本整体跳过),
  // 不返回原源码——缺失依赖的脚本在快照中不存在。
  private assembleScriptPayload(script: IndexedScript): string | undefined {
    const requires = script.metadata.require;
    if (requires.length > 0) {
      const parts: string[] = [];
      const missing: string[] = [];
      for (const requireUrl of requires) {
        const cached = this.requireCache?.get(requireUrl);
        if (cached === undefined) {
          missing.push(requireUrl);
          continue;
        }
        parts.push(cached);
      }
      if (missing.length > 0) {
        this.requireGaps.set(script.id, missing);
        return undefined;
      }
      this.requireGaps.delete(script.id);
      if (parts.length > 0) return parts.join('\n') + '\n' + script.source;
    }
    return script.source;
  }

  // 后台脚本专用快照（per-script 窗口:只包含该窗口登记的 background 脚本）
  snapshotBackground(wcId: number): FrameSnapshot {
    const registration = this.views.get(wcId);
    if (!registration || registration.kind !== 'background') {
      return { ok: false, scripts: [], values: {} };
    }
    return this.buildSnapshot(registration, Array.from(this.scripts.values()).filter((script) => (
      script.metadata.background
      && (!registration.backgroundScriptId || script.id === registration.backgroundScriptId)
    )));
  }

  private buildSnapshot(registration: ViewRegistration, scripts: IndexedScript[]): FrameSnapshot {
    const matched: SnapshotScript[] = [];
    let sourceBytes = 0;
    for (const script of scripts) {
      const source = this.assembleScriptPayload(script);
      if (source === undefined) continue; // require 未就绪:记录 gap 并跳过
      sourceBytes += Buffer.byteLength(source, 'utf8');
      if (sourceBytes > this.options.maxSourceBytesPerPage) break;
      matched.push({
        id: script.id,
        runAt: script.metadata.runAt,
        source,
        info: {
          name: script.metadata.name,
          namespace: script.metadata.namespace,
          version: script.metadata.version,
          description: script.metadata.description,
          grant: script.metadata.grant,
          noframes: script.metadata.noframes,
          rawHeader: script.metadata.rawHeader,
        },
      });
    }

    const resources: FrameSnapshot['resources'] = {};
    let resourceBytes = 0;
    for (const script of matched) {
      const metadata = this.scripts.get(script.id)?.metadata;
      if (!metadata || metadata.resource.length === 0) continue;
      const scriptResources: Record<string, { text: string; url: string }> = {};
      for (const res of metadata.resource) {
        const text = this.requireCache?.get(res.url);
        if (text === undefined) continue;
        const bytes = Buffer.byteLength(text, 'utf8');
        if (resourceBytes + bytes > this.options.maxResourceBytesPerPage) continue;
        resourceBytes += bytes;
        scriptResources[res.name] = {
          text,
          url: `data:text/plain;charset=utf-8;base64,${Buffer.from(text, 'utf8').toString('base64')}`,
        };
      }
      if (Object.keys(scriptResources).length > 0) resources[script.id] = scriptResources;
    }

    const snapshot = this.values.snapshot(matched.map((script) => script.id), {
      maxBytes: this.options.maxSnapshotBytes,
    });
    return {
      ok: true,
      mode: registration.mode,
      generation: registration.generation,
      token: registration.token,
      scripts: matched,
      values: snapshot.values,
      resources,
    };
  }

  // 返回所有 background 脚本列表
  backgroundScripts(): InstalledUserscript[] {
    return Array.from(this.scripts.values())
      .filter((s) => s.metadata.background)
      .map((s) => s as InstalledUserscript);
  }

  getRequireGaps(scriptId: string): string[] {
    return this.requireGaps.get(scriptId) ?? [];
  }

  async ensureRequires(): Promise<void> {
    if (!this.requireCache) return;
    const urls = new Set<string>();
    for (const script of this.scripts.values()) {
      for (const requireUrl of script.metadata.require) urls.add(requireUrl);
      for (const res of script.metadata.resource) urls.add(res.url);
    }
    await Promise.all(Array.from(urls, (url) =>
      this.requireCache!.ensure(url).then((result) => {
        if (result.ok) return;
        for (const script of this.scripts.values()) {
          if (!script.metadata.require.includes(url)) continue;
          const gaps = this.requireGaps.get(script.id) ?? [];
          if (!gaps.includes(url)) gaps.push(url);
          this.requireGaps.set(script.id, gaps);
        }
      }),
    ));
  }

  setValue(wcId: number, scriptId: string, key: string, value: GMSerializable):
    { ok: true; oldValue?: GMSerializable } | { ok: false; reason?: string } {
    if (!this.views.has(wcId)) return { ok: false, reason: 'unregistered-view' };
    const oldValue = this.values.get(scriptId, key);
    try {
      this.values.set(scriptId, key, value);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'invalid-value' };
    }
    this.noteValueWrite(scriptId, key, oldValue, value);
    this.broadcastValueChange(wcId, scriptId, key, oldValue, value);
    return { ok: true, oldValue };
  }

  deleteValue(wcId: number, scriptId: string, key: string): boolean {
    if (!this.views.has(wcId)) return false;
    const oldValue = this.values.get(scriptId, key);
    this.values.delete(scriptId, key);
    this.noteValueWrite(scriptId, key, oldValue, undefined);
    this.broadcastValueChange(wcId, scriptId, key, oldValue, undefined);
    return true;
  }

  // persistValues 辅助方法:oldValue/newValue 必须在变更前捕获传入
  // (变更后再读 values 会拿到新值,累计字节计数恒为 0)
  private noteValueWrite(
    scriptId: string,
    key: string,
    oldValue: GMSerializable | undefined,
    newValue: GMSerializable | undefined,
  ): void {
    if (!this.persistValues) return;
    const oldBytes = oldValue !== undefined ? Buffer.byteLength(JSON.stringify(oldValue), 'utf8') : 0;
    const newBytes = newValue !== undefined ? Buffer.byteLength(JSON.stringify(newValue), 'utf8') : 0;
    const currentBytes = this.scriptByteCounts.get(scriptId) ?? 0;
    const total = Math.max(0, currentBytes - oldBytes + newBytes);
    this.scriptByteCounts.set(scriptId, total);
    if (newBytes > this.persistValues.urgentBytes || total > 8 * 1024) {
      this.flushValues();
    } else {
      this.scheduleSave();
    }
  }

  private scheduleSave(): void {
    if (!this.persistValues) return;
    if (this.persistTimer) return;
    const debounceMs = this.persistValues.debounceMs;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushValues();
    }, debounceMs);
  }

  flushValues(): void {
    if (!this.persistValues) return;
    try {
      this.values.save(this.persistValues.file);
    } catch {
      /* disk full etc: keep in memory */
    }
  }

  persistValuesFile(): string | undefined {
    return this.persistValues?.file;
  }

  // 卸载脚本时清理其全部 GM 值(含持久化文件残留)
  clearScriptValues(scriptId: string): void {
    this.values.deleteScript(scriptId);
    this.scriptByteCounts.delete(scriptId);
    if (this.persistValues) this.flushValues();
  }

  loadValues(file: string): void {
    this.values.load(file);
  }

  getValuesFor(wcId: number, scriptId: string): Record<string, GMSerializable> {
    if (!this.views.has(wcId)) return {};
    return this.readScriptValues(scriptId);
  }

  private readScriptValues(scriptId: string): Record<string, GMSerializable> {
    const result: Record<string, GMSerializable> = {};
    for (const key of this.values.list(scriptId)) {
      const value = this.values.get(scriptId, key);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  // --- 管理侧值访问(无 view 依赖;经管理页 UI 使用) -------------------------
  listScriptValues(scriptId: string): Record<string, GMSerializable> {
    return this.readScriptValues(scriptId);
  }

  getScriptValue(scriptId: string, key: string): GMSerializable | undefined {
    return this.values.get(scriptId, key);
  }

  setScriptValue(scriptId: string, key: string, value: GMSerializable): boolean {
    if (!key) return false;
    const oldValue = this.values.get(scriptId, key);
    try {
      this.values.set(scriptId, key, value);
    } catch {
      return false;
    }
    this.noteValueWrite(scriptId, key, oldValue, value);
    return true;
  }

  deleteScriptValue(scriptId: string, key: string): boolean {
    if (!key) return false;
    const oldValue = this.values.get(scriptId, key);
    this.values.delete(scriptId, key);
    this.noteValueWrite(scriptId, key, oldValue, undefined);
    return true;
  }

  addValueListener(wcId: number, scriptId: string, key: string, listenerId: number): boolean {
    if (!this.views.has(wcId) || !this.scripts.has(scriptId) || !key) return false;
    let byScript = this.valueListeners.get(wcId);
    if (!byScript) {
      byScript = new Map();
      this.valueListeners.set(wcId, byScript);
    }
    let byKey = byScript.get(scriptId);
    if (!byKey) {
      byKey = new Map();
      byScript.set(scriptId, byKey);
    }
    let listeners = byKey.get(key);
    if (!listeners) {
      listeners = new Set();
      byKey.set(key, listeners);
    }
    listeners.add(listenerId);
    return true;
  }

  removeValueListener(wcId: number, scriptId: string, listenerId: number): boolean {
    const listeners = this.valueListeners.get(wcId)?.get(scriptId);
    if (!listeners) return false;
    let removed = false;
    for (const set of listeners.values()) removed = set.delete(listenerId) || removed;
    return removed;
  }

  private broadcastValueChange(
    sourceWcId: number,
    scriptId: string,
    key: string,
    oldValue: GMSerializable | undefined,
    newValue: GMSerializable | undefined,
  ): void {
    if (!this.sendToWc) return;
    for (const [listenerWcId, byScript] of this.valueListeners) {
      if (listenerWcId === sourceWcId) continue;
      const listeners = byScript.get(scriptId)?.get(key);
      if (!listeners || listeners.size === 0) continue;
      this.sendToWc(listenerWcId, 'userscript:value-changed', {
        scriptId,
        key,
        oldValue,
        newValue,
        remote: true,
      });
    }
  }

  notify(wcId: number, scriptId: string, documentId: string, details: { text?: string; title?: string }): number | null {
    if (!this.views.has(wcId)) return null;
    const notificationId = this.nextNotificationId++;
    this.notifications.push({
      notificationId,
      wcId,
      scriptId,
      documentId,
      text: String(details?.text ?? '').slice(0, 500),
      title: String(details?.title ?? '').slice(0, 200),
    });
    return notificationId;
  }

  getNotifications(): Array<{ notificationId: number; wcId: number; scriptId: string; text: string; title: string }> {
    return this.notifications.slice();
  }

  triggerNotification(wcId: number, notificationId: number): boolean {
    const notification = this.notifications.find((n) => n.wcId === wcId && n.notificationId === notificationId);
    if (!notification) return false;
    this.sendToWc?.(wcId, 'userscript:notification-click', {
      scriptId: notification.scriptId,
      documentId: notification.documentId,
      notificationId,
    });
    return true;
  }

  listValues(wcId: number, scriptId: string): string[] {
    if (!this.views.has(wcId)) return [];
    return this.values.list(scriptId);
  }

  getValueSnapshot(): ValueStore {
    return this.values;
  }

  // commandId is generated by the preload as `${documentId}:${scriptId}:${localId}`
  // so it is unique across frames, documents and scripts without a main-process
  // round trip. The main process validates the full shape — documentId prefix,
  // scriptId match and positive integer localId — and adopts it as-is.
  //
  // Dedupe: the same script registers identical titles in every matching frame
  // (main frame and sub-frames). webContents.send() only reaches the MAIN-frame
  // preload, so sub-frame registrations can never be invoked — listing them
  // duplicates commands and makes clicks silently dead. Keep exactly one entry
  // per script+title on a view, preferring the main-frame registration.
  registerMenuCommand(wcId: number, scriptId: string, documentId: string, title: string, commandId: string, isMainFrame: boolean): boolean {
    if (!this.views.has(wcId)) return false;
    const expectedPrefix = `${documentId}:${scriptId}:`;
    if (!commandId || commandId.length > 200 || !commandId.startsWith(expectedPrefix)) return false;
    const localId = Number(commandId.slice(expectedPrefix.length));
    if (!Number.isInteger(localId) || localId < 1) return false;
    for (const existing of this.commands.values()) {
      if (existing.scriptId !== scriptId || existing.title !== title) continue;
      if (existing.isMainFrame || !isMainFrame) return true;
      this.commands.delete(existing.commandId);
      this.commandsByWc.get(wcId)?.delete(existing.commandId);
      break;
    }
    this.commands.set(commandId, { commandId, scriptId, documentId, title, isMainFrame });
    let bucket = this.commandsByWc.get(wcId);
    if (!bucket) {
      bucket = new Set();
      this.commandsByWc.set(wcId, bucket);
    }
    bucket.add(commandId);
    return true;
  }

  unregisterMenuCommand(wcId: number, commandId: string): boolean {
    if (!this.commandsByWc.get(wcId)?.has(commandId)) return false;
    this.commands.delete(commandId);
    this.commandsByWc.get(wcId)?.delete(commandId);
    return true;
  }

  commandTarget(commandId: string): { wcId: number; documentId: string } | null {
    const command = this.commands.get(commandId);
    if (!command) return null;
    for (const [wcId, bucket] of this.commandsByWc) {
      if (bucket.has(commandId)) return { wcId, documentId: command.documentId };
    }
    return null;
  }

  commandsFor(wcId: number): ScriptCommand[] {
    const ids = this.commandsByWc.get(wcId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.commands.get(id))
      .filter((command): command is ScriptCommand => Boolean(command));
  }

  openInTab(wcId: number, scriptId: string, url: string): boolean {
    if (!this.views.has(wcId)) return false;
    this.openTabs.push({ wcId, scriptId, url: String(url || '').slice(0, 2048) });
    return true;
  }

  getOpenTabs(): Array<{ wcId: number; scriptId: string; url: string }> {
    return this.openTabs.slice();
  }

  // D4 SPA soft navigation: recorded per view for compatibility tooling.
  // Soft navigation does NOT create a new document, so scripts must not be
  // re-run; this is a pure observation record.
  spaNavigate(wcId: number, url: string, reason: string): void {
    // background 脚本不走 SPA 导航记录
    if (this.views.get(wcId)?.kind === 'background') return;
    this.spaNavigations.push({ wcId, url: String(url || '').slice(0, 2048), reason: String(reason || 'in-page'), at: Date.now() });
    if (this.spaNavigations.length > 500) this.spaNavigations.shift();
  }

  getSpaNavigations(): Array<{ wcId: number; url: string; reason: string; at: number }> {
    return this.spaNavigations.slice();
  }

  acceptReport(wcId: number, report: UserscriptReport): boolean {
    const registration = this.views.get(wcId);
    const accepted = Boolean(
      registration
      && report.documentId
      && typeof report.documentId === 'string'
      && typeof report.phase === 'string'
      && report.mode === registration.mode
      && report.generation === registration.generation
    );
    if (accepted) {
      this.reports.push({ ...report, accepted: true, wcId });
      if (this.reports.length > this.options.maxReports) this.reports.shift();
    }
    return accepted;
  }

  getReports(): Array<UserscriptReport & { accepted: boolean; wcId: number }> {
    return this.reports.slice();
  }
}
