// 运行日志（automation-logs/*.json）的落盘格式与查询。
//
// 为什么单独一个模块：这段逻辑决定"某条历史属于哪个脚本"，必须能脱离 Electron
// 单测（service-v3 一旦 import electron 就进不了 unit 项目）。所以这里只依赖 fs/path。
//
// 文件格式（JSONL）：
//   第一行 = 归属元信息 {"_baoRunLogMeta":true,"packageId":...,"packageName":...,...}
//   其余行 = 运行日志条目 {timestamp,level,message,system?}
//
// 归属以 packageId 为准：文件名里的脚本名只是给人看的可读性信息，脚本改名/重名时
// 按名字归属会错配。2026-11 之前落盘的老文件没有元信息头，列表查询时回退到
// "文件名里的脚本名 == 当前脚本名"（仅当调用方同时给出 packageName）。
import fs from 'fs';
import path from 'path';

/** 运行日志条目（与 service-v3 的 AutomationRunLog 结构一致）。 */
export type RunLogEntry = {
  readonly system?: boolean;
  readonly timestamp: number;
  readonly level: 'info' | 'success' | 'error';
  readonly message: string;
};

/** 运行日志首行的归属元信息。 */
export type RunLogMeta = {
  readonly packageId: string;
  readonly packageName: string;
  readonly frontendId?: string;
  readonly startedAt: number;
};

/** 列表里的一行（给 UI 用）。 */
export type RunLogFileSummary = {
  name: string;
  sizeLabel: string;
  scriptName: string;
  startedAt: number;
  /** 只有带元信息头的日志才有；老日志为 undefined（按文件名回退）。 */
  packageId?: string;
  /** 归属来源：meta = 元信息头；legacy-name = 文件名回退。 */
  identity: 'meta' | 'legacy-name';
};

export type RunLogFilter = {
  /** 按 packageId 精确过滤（推荐）。 */
  packageId?: string;
  /** 仅用于老日志回退：文件名里的脚本名与之匹配也算命中。 */
  packageName?: string;
};

const META_KEY = '_baoRunLogMeta';
/** 读元信息只读文件头这么点字节，避免为列表把整份日志读进内存。 */
const META_HEAD_BYTES = 4_096;

/** 运行日志文件名：YYMMDD-HH-MM-脚本名称-记录N.json（脚本名已做文件名安全化）。 */
const RUN_LOG_FILE_PATTERN = /^\d{6}-\d{2}-\d{2}-[^\\/:*?"<>|\p{Cc}]+-记录\d{1,6}\.json$/u;
/** 旧格式（run-<ts>-<rand>.jsonl）只用于清理，不再列出。 */
const LEGACY_RUN_LOG_PATTERN = /^run-\d{13}-[a-z0-9]{6}\.jsonl$/u;

/** 文件名白名单校验：格式、长度、基名（防目录穿越）。 */
export function isRunLogFileName(name: string): boolean {
  return name.length <= 160 && RUN_LOG_FILE_PATTERN.test(name) && name === path.basename(name) && !name.includes('..');
}

export function isLegacyRunLogFileName(name: string): boolean {
  return LEGACY_RUN_LOG_PATTERN.test(name);
}

/** 从文件名还原脚本名（列表回退与展示共用）。 */
export function runLogScriptName(fileName: string): string {
  return fileName.replace(/^\d{6}-\d{2}-\d{2}-/u, '').replace(/-记录\d+\.json$/u, '');
}

/** 与 service-v3 写文件名时的规则一致（Windows 非法字符 → `_`，合并空白，截断 40，空名兜底）。 */
export function sanitizeScriptName(name: string): string {
  const cleaned = String(name).replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').replace(/\s+/gu, ' ').trim().slice(0, 40);
  return cleaned || '未命名脚本';
}

export function buildRunLogMetaLine(meta: RunLogMeta): string {
  return JSON.stringify({
    [META_KEY]: true,
    packageId: String(meta.packageId),
    packageName: String(meta.packageName).slice(0, 256),
    ...(meta.frontendId ? { frontendId: String(meta.frontendId) } : {}),
    startedAt: Number(meta.startedAt) || Date.now(),
  });
}

/** 解析首行；不是元信息行（或字段不可信）时返回 null。 */
export function parseRunLogMetaLine(line: string): RunLogMeta | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const data = parsed as Record<string, unknown>;
  if (data[META_KEY] !== true) return null;
  if (typeof data.packageId !== 'string' || !data.packageId) return null;
  if (typeof data.packageName !== 'string') return null;
  const startedAt = Number(data.startedAt);
  return {
    packageId: data.packageId,
    packageName: data.packageName,
    ...(typeof data.frontendId === 'string' && data.frontendId ? { frontendId: data.frontendId } : {}),
    startedAt: Number.isFinite(startedAt) ? startedAt : 0,
  };
}

/** 读文件头的元信息；不存在/损坏 → null（调用方回退文件名）。 */
export async function readRunLogMeta(target: string): Promise<RunLogMeta | null> {
  if (!isRunLogFileName(path.basename(target))) return null;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(target, 'r');
    const buffer = Buffer.alloc(META_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, META_HEAD_BYTES, 0);
    if (!bytesRead) return null;
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    const endOfLine = head.indexOf('\n');
    if (endOfLine !== -1 || bytesRead < META_HEAD_BYTES) {
      return parseRunLogMetaLine(endOfLine === -1 ? head : head.slice(0, endOfLine));
    }
    // Older writers could emit arbitrarily long names. Their header puts the
    // validated package ID first, so restore ownership from that bounded prefix.
    const legacyHeader = /^\{"_baoRunLogMeta":true,"packageId":"([A-Za-z0-9][A-Za-z0-9._-]{0,127})","packageName":"/u.exec(head);
    return legacyHeader ? {
      packageId: legacyHeader[1],
      packageName: runLogScriptName(path.basename(target)),
      startedAt: 0,
    } : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** 写元信息头（整文件重写：每次运行新建文件，只在开头写一次）。 */
export async function writeRunLogMeta(target: string, meta: RunLogMeta): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, buildRunLogMetaLine(meta) + '\n', 'utf8');
}

/** 读条目：跳过元信息行与坏行。 */
export async function readRunLogEntries(target: string): Promise<RunLogEntry[]> {
  let raw: string;
  try { raw = await fs.promises.readFile(target, 'utf8'); } catch { return []; }
  const entries: RunLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    if ((parsed as Record<string, unknown>)[META_KEY] === true) continue;
    const data = parsed as Record<string, unknown>;
    if (typeof data.message !== 'string' || typeof data.timestamp !== 'number') continue;
    const level = data.level === 'success' || data.level === 'error' ? data.level : 'info';
    entries.push({ timestamp: data.timestamp, level, message: data.message, ...(data.system === true ? { system: true } : {}) });
  }
  return entries;
}

function sizeLabelOf(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/**
 * 列出运行日志（新→旧）。`filter.packageId` 命中元信息头即归属；
 * 没有元信息头的老文件按"文件名脚本名 == filter.packageName"回退。
 */
export async function listRunLogFiles(directory: string, filter?: RunLogFilter): Promise<RunLogFileSummary[]> {
  let names: string[];
  try { names = await fs.promises.readdir(directory); } catch { return []; }
  const stats = await Promise.all(names.filter(isRunLogFileName).map(async (name) => {
    try {
      const stat = await fs.promises.stat(path.join(directory, name));
      return { name, mtime: stat.mtimeMs, bytes: stat.size };
    } catch {
      return null;
    }
  }));
  const present = stats.filter((item): item is { name: string; mtime: number; bytes: number } => item !== null);
  const summarized = await Promise.all(present.map(async (item): Promise<RunLogFileSummary> => {
    const meta = await readRunLogMeta(path.join(directory, item.name));
    const fallbackName = runLogScriptName(item.name);
    return {
      name: item.name,
      sizeLabel: sizeLabelOf(item.bytes),
      scriptName: meta?.packageName || fallbackName,
      startedAt: meta?.startedAt || item.mtime,
      ...(meta ? { packageId: meta.packageId, identity: 'meta' as const } : { identity: 'legacy-name' as const }),
    };
  }));
  const legacyName = filter?.packageName ? sanitizeScriptName(filter.packageName) : null;
  const wanted = filter?.packageId
    ? summarized.filter((item) => (item.identity === 'meta'
      ? item.packageId === filter.packageId
      : legacyName !== null && sanitizeScriptName(item.scriptName) === legacyName))
    : summarized;
  return wanted.sort((a, b) => b.startedAt - a.startedAt);
}
