/**
 * DevTools 工作区：真实本地文件夹。
 *
 * 背景：内置 DevTools 前端跑在「hosted mode」——没有原生宿主进程，
 * `core/host/host.js` 回退到 `InspectorFrontendHostStub`，它的 `addFileSystem`
 * 只是往工作区塞一个 `filesystem:devtools://…/overrides` 的沙盒假条目：点第一次
 * 出现一行 `/overrides`，点第二次就撞 "A project with id … already exists"，
 * 看起来就是「点了没反应」。真 Chrome 里这个能力由浏览器进程实现（弹目录选择 +
 * 授予 isolated filesystem），Electron 11 没有对应 API，只能自己补。
 *
 * 本模块提供宿主侧的真实实现：目录选择、按需读写、重命名、删除、搜索。
 * 前端的虚拟 FileSystem 在 `scripts/build-devtools-frontend.cjs` 注入的
 * `bfb-workspace.js` 里（它把 DOM FileSystem 的调用翻译成本模块的 IPC）。
 *
 * 安全边界：
 * - **只有用户通过系统目录选择框授权的目录**可读写，清单持久化在
 *   userData/devtools-workspace.json；
 * - 所有相对路径都夹在授权根目录内（resolve + `..` 归一 + realpath 防符号链接逃逸）；
 * - IPC 只接受 DevTools 前端容器的 WebContents（见 devtoolbox.ipc.ts）。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app, dialog } from 'electron';
import log from 'electron-log';
import { getMainWindow } from './window';

export interface WorkspaceRootDescriptor {
  /** 前端拿它换 virtual file system（`isolatedFileSystem(fileSystemName, rootURL)`）。 */
  fileSystemName: string;
  /** 原始文件系统路径（Windows 用反斜杠），前端的 embedderPath。 */
  fileSystemPath: string;
  rootURL: string;
  type: 'workspace' | 'overrides';
}

export interface FsOpFailure {
  ok: false;
  error: { name: string; message: string };
}

export type FsOpResult<T = object> = ({ ok: true } & T) | FsOpFailure;

interface StoredRoot {
  id: string;
  path: string;
  type: 'workspace' | 'overrides';
}

/** 前端只把 rootURL 当标识符用，我们不需要真实的 filesystem: 源。 */
const ROOT_URL = 'filesystem:bfb://workspace/isolated/';

/** 搜索时跳过的目录（与前端默认排除列表一致的常见项）。 */
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.idea', '.cache', 'bower_components', '.devtools', '.sass-cache']);
/** 索引最多收录的文件数；超过就不再往里加（保护主进程内存）。 */
const INDEX_MAX_FILES = 200_000;
/** 单次搜索结果上限：结果要跨 IPC 回传，不能无限大。 */
const SEARCH_MAX_RESULTS = 5_000;
/** 参与索引/搜索的单文件大小上限。 */
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 内容缓存总字节上限（重复搜索直接命中内存）。 */
const CONTENT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
/** 变更合并窗口：一次保存往往触发多条 rename/change。 */
const CHANGE_DEBOUNCE_MS = 300;

let cachedRoots: StoredRoot[] | null = null;

function storeFile(): string {
  return path.join(app.getPath('userData'), 'devtools-workspace.json');
}

function loadRoots(): StoredRoot[] {
  if (cachedRoots) return cachedRoots;
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf-8')) as { roots?: unknown };
    const list = Array.isArray(parsed.roots) ? parsed.roots : [];
    cachedRoots = list
      .filter((item): item is StoredRoot => Boolean(item)
        && typeof (item as StoredRoot).id === 'string'
        && typeof (item as StoredRoot).path === 'string')
      .map((item) => ({
        id: item.id,
        path: item.path,
        type: item.type === 'overrides' ? 'overrides' : 'workspace',
      }));
  } catch {
    // 文件不存在 / 损坏：当作没有工作区（用户重新选一次即可）
    cachedRoots = [];
  }
  return cachedRoots;
}

function saveRoots(roots: StoredRoot[]): void {
  cachedRoots = roots;
  const file = storeFile();
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ roots }, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (error) {
    log.warn('[DevToolsWorkspace] 保存工作区清单失败:', error instanceof Error ? error.message : String(error));
  }
}

function descriptor(root: StoredRoot): WorkspaceRootDescriptor {
  return {
    fileSystemName: root.id,
    fileSystemPath: root.path,
    rootURL: ROOT_URL,
    type: root.type,
  };
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function fail(name: string, message: string): FsOpFailure {
  return { ok: false, error: { name, message } };
}

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code);
    if (code === 'ENOENT') return 'NotFoundError';
    if (code === 'EEXIST') return 'InvalidModificationError';
    if (code === 'EACCES' || code === 'EPERM') return 'NoModificationAllowedError';
    if (code === 'ENOTDIR' || code === 'EISDIR') return 'TypeMismatchError';
    if (code === 'ENOTEMPTY') return 'InvalidModificationError';
  }
  return 'InvalidStateError';
}

function toFailure(error: unknown): FsOpFailure {
  return fail(errorName(error), error instanceof Error ? error.message : String(error));
}

/**
 * 把「相对授权根目录的路径」夹回根目录内。
 *
 * 返回绝对路径；越界（`..`、绝对路径指向别处、符号链接跳出）返回 null。
 */
function resolveInside(rootPath: string, relative: string): string | null {
  const rootResolved = path.resolve(rootPath);
  const cleaned = (relative ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(rootResolved, cleaned);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return null;
  try {
    const realRoot = fs.realpathSync.native(rootResolved);
    const realTarget = fs.realpathSync.native(target);
    const rootCmp = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
    const targetCmp = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget;
    if (targetCmp !== rootCmp && !targetCmp.startsWith(rootCmp + path.sep)) return null;
  } catch {
    // target 还不存在（创建场景）：上一步的字符串夹取已经够用
  }
  return target;
}

/** 相对路径（前端约定：正斜杠、无前导斜杠）。 */
function toRelative(rootPath: string, absolute: string): string {
  const rel = path.relative(path.resolve(rootPath), absolute);
  return rel.split(path.sep).join('/');
}

function findRootByName(name: string): StoredRoot | null {
  return loadRoots().find((root) => root.id === name) ?? null;
}

function findRootByPath(fileSystemPath: string): StoredRoot | null {
  return loadRoots().find((root) => samePath(root.path, fileSystemPath)) ?? null;
}

export function listWorkspaceRoots(): WorkspaceRootDescriptor[] {
  return loadRoots().map(descriptor);
}

/* ------------------------------------------------------------------ *
 * 文件索引 + 变更监听
 *
 * 为什么需要：前端 `initializeFilePaths()` 只在我们返回目录时递归拉一遍；
 * 用户在外部编辑器里改了文件，Sources 面板不会知道，得手动重开。而「在文件夹
 * 中搜索」如果不建索引就只能每次从头扫盘，大目录下慢且必须设紧上限。
 *
 * 索引 = 每个授权根目录下的文件相对路径集合（首次递归建立，之后靠 watcher
 * 增量更新）。搜索在索引上过滤，并按需读内容（带 LRU 式字节预算）。
 *
 * watcher 用 `fs.watch(dir, { recursive: true })`：实测 Electron 11（Node 12）
 * 在 Windows 上子目录内的新增/修改都能收到。**recursive 只有 Windows/macOS
 * 支持**，Linux 上退回「只监听根目录」（顶层变更仍能收到，深层需要重新添加）。
 * ------------------------------------------------------------------ */

interface RootIndex {
  /** 相对路径（正斜杠）集合。 */
  paths: Set<string>;
  /** 相对路径 → 内容缓存条目。 */
  contents: Map<string, { text: string; size: number }>;
  cachedBytes: number;
  watcher: fs.FSWatcher | null;
  /** 变更合并定时器。 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 待推给前端的变更（相对路径）。 */
  pending: { changed: Set<string>; added: Set<string>; removed: Set<string> };
  /** 建立索引时的世代号：watcher 回调据此丢弃过期任务。 */
  generation: number;
}

const indexes = new Map<string, RootIndex>();
let changeSink: ((fileSystemPath: string, change: { changed: string[]; added: string[]; removed: string[] }) => void) | null = null;

/** 主进程往前端推变更用的出口（由 IPC 层注册）。 */
export function setWorkspaceChangeSink(
  sink: ((fileSystemPath: string, change: { changed: string[]; added: string[]; removed: string[] }) => void) | null,
): void {
  changeSink = sink;
}

function isSkippedName(name: string): boolean {
  return SKIPPED_DIRS.has(name.toLowerCase());
}

/** 递归枚举一个根目录下的所有文件（相对路径）。 */
function enumerateFiles(rootPath: string): Set<string> {
  const base = path.resolve(rootPath);
  const out = new Set<string>();
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > 24) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= INDEX_MAX_FILES) { truncated = true; return; }
      if (entry.isDirectory()) {
        if (!isSkippedName(entry.name)) walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      out.add(toRelative(base, path.join(dir, entry.name)));
    }
  };
  walk(base, 0);
  if (truncated) {
    log.warn('[DevToolsWorkspace] 索引达到上限 %d，已截断:', INDEX_MAX_FILES, rootPath);
  }
  return out;
}

function readIndexedText(rootPath: string, index: RootIndex, relative: string): string | null {
  const cached = index.contents.get(relative);
  if (cached) return cached.text;
  const absolute = resolveInside(rootPath, relative);
  if (!absolute) return null;
  try {
    if (fs.statSync(absolute).size > SEARCH_MAX_FILE_BYTES) return null;
    const text = fs.readFileSync(absolute, 'utf-8');
    if (text.includes('\u0000')) return null; // 二进制
    // 简单字节预算：超了就把最早插入的条目丢掉（Map 保持插入顺序）
    if (index.cachedBytes + text.length <= CONTENT_CACHE_MAX_BYTES) {
      index.contents.set(relative, { text, size: text.length });
      index.cachedBytes += text.length;
    } else if (index.cachedBytes > 0) {
      const firstKey = index.contents.keys().next();
      if (!firstKey.done) {
        const evicted = index.contents.get(firstKey.value);
        index.contents.delete(firstKey.value);
        index.cachedBytes -= evicted ? evicted.size : 0;
      }
    }
    return text;
  } catch {
    return null;
  }
}

function dropCachedContent(index: RootIndex, relative: string): void {
  const cached = index.contents.get(relative);
  if (!cached) return;
  index.contents.delete(relative);
  index.cachedBytes -= cached.size;
}

function scheduleFlush(rootPath: string, index: RootIndex): void {
  if (index.timer) return;
  index.timer = setTimeout(() => {
    index.timer = null;
    const { changed, added, removed } = index.pending;
    index.pending = { changed: new Set(), added: new Set(), removed: new Set() };
    if (changed.size === 0 && added.size === 0 && removed.size === 0) return;
    const changes = changeSink;
    if (!changes) return;
    try {
      changes(rootPath, {
        changed: [...changed],
        added: [...added],
        removed: [...removed],
      });
    } catch (error) {
      log.warn('[DevToolsWorkspace] 推送文件变更失败:', error instanceof Error ? error.message : String(error));
    }
  }, CHANGE_DEBOUNCE_MS);
  index.timer.unref?.();
}

/**
 * 把 watcher 报的一条变更折算成「相对路径 + 增/改/删」。
 *
 * `fs.watch` 只给事件类型（rename/change）和文件名，不保证准确：
 * 同一个路径可能既报 rename 又报 change，删除也不会说"删了"。所以一律以
 * **磁盘现状**为准：存在 → added/changed，不存在 → removed。
 */
function recordChange(rootPath: string, index: RootIndex, relative: string): void {
  if (!relative) return;
  const normalized = relative.split(path.sep).join('/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some(isSkippedName)) return;

  const absolute = resolveInside(rootPath, normalized);
  if (!absolute) return;

  let exists = false;
  let isDirectory = false;
  try {
    const stat = fs.statSync(absolute);
    exists = true;
    isDirectory = stat.isDirectory();
  } catch {
    exists = false;
  }

  if (!exists) {
    if (index.paths.delete(normalized)) {
      dropCachedContent(index, normalized);
      index.pending.removed.add(normalized);
      scheduleFlush(rootPath, index);
      return;
    }
    // 可能是整个目录被删：把它下面的条目一并摘掉
    let removedAny = false;
    for (const known of [...index.paths]) {
      if (known === normalized || known.startsWith(`${normalized}/`)) {
        index.paths.delete(known);
        dropCachedContent(index, known);
        index.pending.removed.add(known);
        removedAny = true;
      }
    }
    if (removedAny) scheduleFlush(rootPath, index);
    return;
  }

  if (isDirectory) {
    // 新建目录：把里面已有的文件补进索引（外部工具可能是先建目录再写文件）
    for (const known of enumerateFiles(path.join(rootPath, normalized))) {
      const child = `${normalized}/${known}`;
      if (index.paths.has(child)) continue;
      index.paths.add(child);
      index.pending.added.add(child);
    }
    scheduleFlush(rootPath, index);
    return;
  }

  if (index.paths.has(normalized)) {
    dropCachedContent(index, normalized);
    index.pending.changed.add(normalized);
  } else {
    index.paths.add(normalized);
    index.pending.added.add(normalized);
  }
  scheduleFlush(rootPath, index);
}

function startWatcher(root: StoredRoot): RootIndex {
  const index: RootIndex = {
    paths: enumerateFiles(root.path),
    contents: new Map(),
    cachedBytes: 0,
    watcher: null,
    timer: null,
    pending: { changed: new Set(), added: new Set(), removed: new Set() },
    generation: 0,
  };

  const generation = ++index.generation;
  try {
    // recursive 仅 Windows/macOS 支持；Linux 上抛错就退回非递归（顶层变更仍可感知）
    index.watcher = fs.watch(root.path, { recursive: true }, (event, filename) => {
      if (index.generation !== generation) return;
      if (!filename) return;
      recordChange(root.path, index, String(filename));
      void event;
    });
    index.watcher.on('error', (error) => {
      log.warn('[DevToolsWorkspace] watcher 出错:', error instanceof Error ? error.message : String(error));
    });
  } catch (error) {
    log.warn('[DevToolsWorkspace] 递归监听不可用，退回单层:', error instanceof Error ? error.message : String(error));
    try {
      index.watcher = fs.watch(root.path, (event, filename) => {
        if (index.generation !== generation || !filename) return;
        recordChange(root.path, index, String(filename));
        void event;
      });
    } catch (fallbackError) {
      log.warn('[DevToolsWorkspace] watcher 启动失败:', fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
      index.watcher = null;
    }
  }
  return index;
}

/** 取（或建立）某个根目录的索引。 */
function ensureIndex(root: StoredRoot): RootIndex {
  const existing = indexes.get(root.path);
  if (existing) return existing;
  const created = startWatcher(root);
  indexes.set(root.path, created);
  return created;
}

function stopIndex(rootPath: string): void {
  const index = indexes.get(rootPath);
  if (!index) return;
  indexes.delete(rootPath);
  index.generation += 1;
  if (index.timer) { clearTimeout(index.timer); index.timer = null; }
  try { index.watcher?.close(); } catch { /* 已关闭 */ }
  index.watcher = null;
}

/** 应用退出时释放所有 watcher。 */
export function shutdownWorkspaceWatchers(): void {
  for (const rootPath of [...indexes.keys()]) stopIndex(rootPath);
  changeSink = null;
}

/**
 * 本进程自己改动了文件后立刻同步索引。
 *
 * 不依赖 watcher 的原因：它有 300ms 合并窗口，而「在 DevTools 里新建文件后马上搜索」
 * 是很自然的操作；Linux 上非递归的兜底 watcher 更是完全看不到子目录。
 */
function touchIndex(root: StoredRoot, relative: string, kind: 'added' | 'changed' | 'removed'): void {
  const index = indexes.get(root.path);
  if (!index) return;
  const normalized = relative.split(path.sep).join('/').replace(/^\/+/, '');
  if (!normalized) return;
  if (kind === 'removed') {
    for (const known of [...index.paths]) {
      if (known === normalized || known.startsWith(`${normalized}/`)) {
        index.paths.delete(known);
        dropCachedContent(index, known);
      }
    }
    return;
  }
  index.paths.add(normalized);
  if (kind === 'changed') dropCachedContent(index, normalized);
}

/** 启动时把已授权目录的索引和 watcher 都建起来（惰性调用一次即可）。 */
export function warmWorkspaceIndexes(): void {
  for (const root of loadRoots()) {
    try {
      ensureIndex(root);
    } catch (error) {
      log.warn('[DevToolsWorkspace] 建立索引失败:', root.path, error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * 弹系统目录选择框并登记为工作区根目录。
 *
 * `duplicate` 单独返回：前端对同一路径重复登记会 `console.assert` 并重复建 project，
 * 由调用方按「取消」处理。
 */
export async function pickWorkspaceRoot(type: string): Promise<{
  cancelled?: boolean;
  duplicate?: boolean;
  fileSystem?: WorkspaceRootDescriptor;
  error?: string;
}> {
  const win = getMainWindow();
  const options: Electron.OpenDialogOptions = {
    title: type === 'overrides' ? '选择 Overrides 存放文件夹' : '选择工作区文件夹',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选择文件夹',
  };
  const result = win && !win.isDestroyed()
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return { cancelled: true };

  const picked = path.resolve(result.filePaths[0]);
  try {
    if (!fs.statSync(picked).isDirectory()) return { error: '所选路径不是文件夹' };
  } catch {
    return { error: `无法访问所选文件夹：${picked}` };
  }

  const roots = loadRoots();
  if (roots.some((root) => samePath(root.path, picked))) return { duplicate: true };

  const id = `bfb-${crypto.createHash('sha1').update(path.resolve(picked).toLowerCase()).digest('hex').slice(0, 20)}`;
  const root: StoredRoot = { id, path: picked, type: type === 'overrides' ? 'overrides' : 'workspace' };
  saveRoots([...roots, root]);
  // 立刻建索引 + 挂 watcher：前端随后的 initializeFilePaths 与搜索都走它
  try {
    ensureIndex(root);
  } catch (error) {
    log.warn('[DevToolsWorkspace] 建立索引失败:', picked, error instanceof Error ? error.message : String(error));
  }
  log.info('[DevToolsWorkspace] 已添加工作区文件夹:', picked);
  return { fileSystem: descriptor(root) };
}

export function removeWorkspaceRoot(fileSystemPath: string): FsOpResult {
  const roots = loadRoots();
  const next = roots.filter((root) => !samePath(root.path, fileSystemPath));
  if (next.length === roots.length) return fail('NotFoundError', '该文件夹不在工作区里');
  saveRoots(next);
  stopIndex(path.resolve(fileSystemPath));
  log.info('[DevToolsWorkspace] 已移除工作区文件夹:', fileSystemPath);
  return { ok: true };
}

function withRoot<T>(name: string, relative: string, run: (root: StoredRoot, target: string) => FsOpResult<T>): FsOpResult<T> {
  const root = findRootByName(name);
  if (!root) return fail('NotFoundError', '工作区文件夹未授权');
  const target = resolveInside(root.path, relative);
  if (!target) return fail('SecurityError', '路径越界');
  try {
    return run(root, target);
  } catch (error) {
    log.warn('[DevToolsWorkspace] 操作失败:', relative, error instanceof Error ? error.message : String(error));
    return toFailure(error);
  }
}

export function readWorkspaceDirectory(name: string, relative: string): FsOpResult<{ entries: Array<{ name: string; isDirectory: boolean }> }> {
  return withRoot(name, relative, (_root, target) => {
    const entries = fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
    return { ok: true, entries };
  });
}

export function statWorkspacePath(name: string, relative: string): FsOpResult<{
  exists: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}> {
  const root = findRootByName(name);
  if (!root) return fail('NotFoundError', '工作区文件夹未授权');
  const target = resolveInside(root.path, relative);
  if (!target) return fail('SecurityError', '路径越界');
  try {
    const stat = fs.statSync(target);
    return { ok: true, exists: true, isDirectory: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (errorName(error) === 'NotFoundError') return { ok: true, exists: false, isDirectory: false, size: 0, mtimeMs: 0 };
    return toFailure(error);
  }
}

export function readWorkspaceFile(name: string, relative: string): FsOpResult<{ base64: string; mtimeMs: number; size: number }> {
  return withRoot(name, relative, (_root, target) => {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return fail('TypeMismatchError', '这是一个文件夹');
    return { ok: true, base64: fs.readFileSync(target).toString('base64'), mtimeMs: stat.mtimeMs, size: stat.size };
  });
}

export function writeWorkspaceFile(name: string, relative: string, base64: string): FsOpResult<{ mtimeMs: number; size: number }> {
  return withRoot(name, relative, (root, target) => {
    const buffer = Buffer.from(base64, 'base64');
    // 原子写：临时文件 + rename，避免写一半掉电把源文件写坏
    const tmp = `${target}.bfb-${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    try {
      fs.renameSync(tmp, target);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* 临时文件清理失败不致命 */ }
      throw error;
    }
    touchIndex(root, toRelative(root.path, target), 'changed');
    const stat = fs.statSync(target);
    return { ok: true, mtimeMs: stat.mtimeMs, size: stat.size };
  });
}

export function createWorkspaceFile(name: string, relative: string, exclusive: boolean): FsOpResult {
  return withRoot(name, relative, (root, target) => {
    if (exclusive) {
      // 'wx'：已存在则 EEXIST，前端据此换下一个候选名（NewFile1、NewFile2…）
      fs.writeFileSync(target, '', { flag: 'wx' });
    } else {
      fs.closeSync(fs.openSync(target, 'a'));
    }
    touchIndex(root, toRelative(root.path, target), 'added');
    return { ok: true };
  });
}

export function createWorkspaceDirectory(name: string, relative: string): FsOpResult {
  return withRoot(name, relative, (_root, target) => {
    fs.mkdirSync(target, { recursive: true });
    return { ok: true };
  });
}

/**
 * 递归删除目录。
 *
 * 不用 `fs.rmSync`（Node 14.14+，Electron 11 是 Node 12），也不用
 * `rmdirSync(dir, { recursive: true })`——它在本项目的 @types/node 里没有重载，
 * 且从 Node 16 起被废弃。手写一遍最稳。
 */
function removeTree(target: string): void {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
  fs.rmdirSync(target);
}

export function deleteWorkspacePath(name: string, relative: string, recursive: boolean): FsOpResult {
  return withRoot(name, relative, (root, target) => {
    if (target === path.resolve(root.path)) return fail('SecurityError', '不能删除工作区根目录');
    if (fs.statSync(target).isDirectory()) {
      if (!recursive) return fail('InvalidModificationError', '这是一个文件夹');
      removeTree(target);
    } else {
      fs.unlinkSync(target);
    }
    touchIndex(root, toRelative(root.path, target), 'removed');
    return { ok: true };
  });
}

/**
 * 重命名 / 移动（前端 `FileEntry.moveTo(parent, newName)`）。
 *
 * `to` 是相对授权根目录的目标路径：同目录改名就是换最后一段，跨目录移动也走这里。
 * 目标已存在时按 DOM 约定失败（前端据此提示「同名文件已存在」）。
 */
export function moveWorkspacePath(name: string, relative: string, to: string): FsOpResult<{ path: string }> {
  const segments = String(to ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  const newName = segments[segments.length - 1] ?? '';
  if (!newName || newName === '.' || newName === '..') {
    return fail('InvalidModificationError', '文件名非法');
  }
  return withRoot(name, relative, (root, target) => {
    if (target === path.resolve(root.path)) return fail('SecurityError', '不能移动工作区根目录');
    const destination = resolveInside(root.path, to);
    if (!destination) return fail('SecurityError', '路径越界');
    if (fs.existsSync(destination)) return fail('InvalidModificationError', '同名文件已存在');
    const parent = path.dirname(destination);
    if (!fs.existsSync(parent)) return fail('NotFoundError', '目标文件夹不存在');
    fs.renameSync(target, destination);
    touchIndex(root, toRelative(root.path, target), 'removed');
    touchIndex(root, toRelative(root.path, destination), 'added');
    return { ok: true, path: toRelative(root.path, destination) };
  });
}

/**
 * 「在文件夹中搜索」：在索引上按内容过滤。
 *
 * 前端把 query 直接透传（Chrome 的宿主按正则处理），这里同样先按正则、失败退回字面量。
 * 索引不存在时现场建一次（首次搜索的代价从"每次"降为"一次"）。
 */
export function searchWorkspacePath(fileSystemPath: string, query: string): FsOpResult<{ files: string[] }> {
  const root = findRootByPath(fileSystemPath);
  if (!root) return fail('NotFoundError', '工作区文件夹未授权');
  const text = (query ?? '').slice(0, 500);
  if (!text) return { ok: true, files: [] };
  let matcher: RegExp;
  try {
    matcher = new RegExp(text, 'i');
  } catch {
    matcher = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const index = ensureIndex(root);
  const files: string[] = [];
  for (const relative of index.paths) {
    if (files.length >= SEARCH_MAX_RESULTS) break;
    // 先把文件名也当命中源：前端只做内容搜索，但文件名命中很常见、成本为零
    if (matcher.test(relative)) {
      files.push(path.join(path.resolve(root.path), relative));
      continue;
    }
    const content = readIndexedText(root.path, index, relative);
    if (content && matcher.test(content)) {
      files.push(path.join(path.resolve(root.path), relative));
    }
  }
  return { ok: true, files };
}
