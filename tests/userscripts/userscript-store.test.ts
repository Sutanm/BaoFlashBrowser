import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ValueStore } from '@main/modules/userscripts/userscript-store';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'userscript-store-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('userscript-store ValueStore', () => {
  it('scopes values per script id', () => {
    const store = new ValueStore();
    store.set('script-a', 'key', 1);
    store.set('script-b', 'key', 2);
    expect(store.get('script-a', 'key')).toBe(1);
    expect(store.get('script-b', 'key')).toBe(2);
    expect(store.get('script-a', 'missing')).toBeUndefined();
  });

  it('lists and deletes keys', () => {
    const store = new ValueStore();
    store.set('s', 'a', 1);
    store.set('s', 'b', 'two');
    expect(store.list('s').sort()).toEqual(['a', 'b']);
    store.delete('s', 'a');
    expect(store.list('s')).toEqual(['b']);
    expect(store.get('s', 'a')).toBeUndefined();
  });

  it('rejects non-serializable values', () => {
    const store = new ValueStore();
    expect(() => store.set('s', 'bad', () => 1)).toThrow();
    expect(store.get('s', 'bad')).toBeUndefined();
  });

  it('rejects values above the size cap', () => {
    const store = new ValueStore({ maxValueBytes: 32 });
    expect(() => store.set('s', 'big', 'x'.repeat(64))).toThrow();
  });

  it('measures sizes in UTF-8 bytes, not characters', () => {
    const store = new ValueStore({ maxValueBytes: 42 });
    const chinese = '中'.repeat(15);
    expect(chinese.length).toBeLessThan(42);
    expect(() => store.set('s', 'zh', chinese)).toThrow();
    expect(() => store.set('s', 'zh', '中'.repeat(13))).not.toThrow();
  });

  it('bounded snapshots budget in UTF-8 bytes', () => {
    const store = new ValueStore({ maxValueBytes: 8192 });
    const budget = 60;
    const chineseValue = '中'.repeat(21);
    expect(Buffer.byteLength(chineseValue, 'utf8')).toBeGreaterThan(budget);
    store.set('s1', 'zh', chineseValue);
    store.set('s1', 'small', 'ok');
    const snapshot = store.snapshot(['s1'], { maxBytes: budget });
    expect(snapshot.values.s1.zh).toBeUndefined();
    expect(snapshot.values.s1.small).toBe('ok');
  });

  it('bounded snapshots omit large values and flag them', () => {
    const store = new ValueStore({ maxValueBytes: 8192 });
    store.set('s1', 'small', 'ok');
    store.set('s1', 'huge', 'y'.repeat(2048));
    const snapshot = store.snapshot(['s1'], { maxBytes: 512 });
    expect(snapshot.values.s1.small).toBe('ok');
    expect(snapshot.values.s1.huge).toBeUndefined();
    expect(snapshot.omitted).toContain('s1:huge');
  });

  it('persists to a JSON file and reloads', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'values.json');
    const store = new ValueStore();
    store.set('s', 'count', 7);
    store.set('s', 'label', 'demo');
    store.save(file);
    expect(store.get('s', 'count')).toBe(7);

    const reloaded = new ValueStore();
    reloaded.load(file);
    expect(reloaded.get('s', 'count')).toBe(7);
    expect(reloaded.get('s', 'label')).toBe('demo');
  });

  it('loads an empty store when the file is missing', () => {
    const store = new ValueStore();
    store.load(path.join(makeTempDir(), 'nope.json'));
    expect(store.list('s')).toEqual([]);
  });

  it('writes atomically without leaving partial files', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'values.json');
    const store = new ValueStore();
    store.set('s', 'k', 1);
    store.save(file);
    const leftovers = new ValueStore().load(file).get('s', 'k');
    expect(leftovers).toBe(1);
    const entries = readdirSync(dir);
    expect(entries).toEqual(['values.json']);
  });
});
