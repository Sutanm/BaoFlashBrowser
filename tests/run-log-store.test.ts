import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRunLogMetaLine,
  isLegacyRunLogFileName,
  isRunLogFileName,
  listRunLogFiles,
  parseRunLogMetaLine,
  readRunLogEntries,
  readRunLogMeta,
  runLogScriptName,
  sanitizeScriptName,
  writeRunLogMeta,
} from '../src/main/modules/automation/run-log-store';

// 运行日志归属：2026-11 起首行写元信息头（packageId），历史列表按脚本隔离。
// 没有元信息头的老文件必须回退到"文件名里的脚本名"匹配，否则升级后历史会整片消失。
describe('run log store', () => {
  let directory = '';

  const legacyFile = (name: string, entries: Array<Record<string, unknown>> = []): string => {
    writeFileSync(path.join(directory, name), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
    return name;
  };
  const metaFile = async (name: string, packageId: string, packageName: string, startedAt = Date.now()): Promise<string> => {
    await writeRunLogMeta(path.join(directory, name), { packageId, packageName, startedAt });
    return name;
  };

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'bao-run-log-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('文件名安全化与还原互为逆运算', () => {
    expect(sanitizeScriptName('斗地主/闯关: v2')).toBe('斗地主_闯关_ v2');
    expect(sanitizeScriptName('  a   b  ')).toBe('a b');
    expect(sanitizeScriptName('')).toBe('未命名脚本');
    expect(sanitizeScriptName('x'.repeat(60))).toHaveLength(40);
    expect(runLogScriptName('260110-12-30-斗地主_闯关_ v2-记录3.json')).toBe('斗地主_闯关_ v2');
    expect(runLogScriptName('260110-12-30-斗地主-记录3.json')).toBe('斗地主');
  });

  it('只接受白名单文件名，拒绝目录穿越', () => {
    expect(isRunLogFileName('260110-12-30-斗地主-记录3.json')).toBe(true);
    expect(isRunLogFileName('../260110-12-30-斗地主-记录3.json')).toBe(false);
    expect(isRunLogFileName('run-1700000000000-abc123.jsonl')).toBe(false);
    expect(isLegacyRunLogFileName('run-1700000000000-abc123.jsonl')).toBe(true);
    expect(isRunLogFileName('x'.repeat(200) + '-记录1.json')).toBe(false);
  });

  it('元信息行可往返解析，普通日志行不会被误认', () => {
    const line = buildRunLogMetaLine({ packageId: 'pkg-1', packageName: '斗地主', frontendId: 'workflow', startedAt: 1700000000000 });
    expect(parseRunLogMetaLine(line)).toEqual({ packageId: 'pkg-1', packageName: '斗地主', frontendId: 'workflow', startedAt: 1700000000000 });
    expect(parseRunLogMetaLine(JSON.stringify({ timestamp: 1, level: 'info', message: '开始运行' }))).toBeNull();
    expect(parseRunLogMetaLine('not json')).toBeNull();
    expect(parseRunLogMetaLine(JSON.stringify({ _baoRunLogMeta: true, packageId: '', packageName: 'x' }))).toBeNull();
  });

  it('写入元信息头后能读回，且读取条目时把它剔除', async () => {
    const name = '260110-12-30-斗地主-记录1.json';
    await metaFile(name, 'pkg-1', '斗地主', 1700000000000);
    writeFileSync(path.join(directory, name), JSON.stringify({ timestamp: 1, level: 'info', message: '第一行' }) + '\n', { flag: 'a' });
    writeFileSync(path.join(directory, name), 'broken line\n', { flag: 'a' });
    writeFileSync(path.join(directory, name), JSON.stringify({ timestamp: 2, level: 'error', message: '第二行' }) + '\n', { flag: 'a' });

    expect(await readRunLogMeta(path.join(directory, name))).toMatchObject({ packageId: 'pkg-1', packageName: '斗地主' });
    const entries = await readRunLogEntries(path.join(directory, name));
    expect(entries).toEqual([
      { timestamp: 1, level: 'info', message: '第一行' },
      { timestamp: 2, level: 'error', message: '第二行' },
    ]);
  });

  it('按 packageId 只返回该脚本的运行（新→旧），并给出脚本名与开始时间', async () => {
    await metaFile('260110-10-00-斗地主-记录1.json', 'pkg-a', '斗地主', 1700000000000);
    await metaFile('260110-11-00-斗地主-记录1.json', 'pkg-b', '斗地主', 1700000100000);
    await metaFile('260110-12-00-斗地主-记录1.json', 'pkg-a', '斗地主', 1700000200000);

    const forA = await listRunLogFiles(directory, { packageId: 'pkg-a' });
    expect(forA.map((item) => item.startedAt)).toEqual([1700000200000, 1700000000000]);
    expect(forA.every((item) => item.packageId === 'pkg-a' && item.identity === 'meta')).toBe(true);
    expect(forA[0].scriptName).toBe('斗地主');

    // 同名脚本不能混进来：pkg-b 的运行不属于 pkg-a
    expect((await listRunLogFiles(directory, { packageId: 'pkg-b' })).map((item) => item.startedAt)).toEqual([1700000100000]);
    expect(await listRunLogFiles(directory)).toHaveLength(3);
  });

  it('没有元信息头的老日志回退到文件名脚本名匹配', async () => {
    legacyFile('260110-10-00-斗地主-记录1.json', [{ timestamp: 5, level: 'info', message: '老记录' }]);
    legacyFile('260110-11-00-麻将-记录1.json');
    await metaFile('260110-12-00-斗地主-记录1.json', 'pkg-a', '斗地主', 1700000200000);

    const scoped = await listRunLogFiles(directory, { packageId: 'pkg-a', packageName: '斗地主' });
    expect(scoped).toHaveLength(2);
    expect(scoped.map((item) => item.identity).sort()).toEqual(['legacy-name', 'meta']);

    // 只给 packageId 时，老日志无法归属，不猜
    const strict = await listRunLogFiles(directory, { packageId: 'pkg-a' });
    expect(strict).toHaveLength(1);
    expect(strict[0].identity).toBe('meta');

    // 名字需要走同一套安全化：带非法字符的脚本名也能匹配到老文件
    legacyFile('260110-13-00-斗地主_闯关-记录1.json');
    const sanitized = await listRunLogFiles(directory, { packageId: 'pkg-z', packageName: '斗地主/闯关' });
    expect(sanitized.map((item) => item.name)).toEqual(['260110-13-00-斗地主_闯关-记录1.json']);
  });

  it('忽略非白名单文件与不存在的目录', async () => {
    writeFileSync(path.join(directory, 'README.txt'), 'not a log', 'utf8');
    writeFileSync(path.join(directory, 'run-1700000000000-abc123.jsonl'), '', 'utf8');
    await metaFile('260110-12-00-斗地主-记录1.json', 'pkg-a', '斗地主');
    expect((await listRunLogFiles(directory)).map((item) => item.name)).toEqual(['260110-12-00-斗地主-记录1.json']);
    expect(await listRunLogFiles(path.join(directory, 'missing'))).toEqual([]);
    expect(await readRunLogMeta(path.join(directory, 'missing.json'))).toBeNull();
  });

  it('元信息损坏时不影响列出，回退文件名', async () => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, '260110-12-00-斗地主-记录1.json'), '{broken\n', 'utf8');
    const listed = await listRunLogFiles(directory);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ scriptName: '斗地主', identity: 'legacy-name' });
    expect(await readRunLogEntries(path.join(directory, '260110-12-00-斗地主-记录1.json'))).toEqual([]);
  });
});
