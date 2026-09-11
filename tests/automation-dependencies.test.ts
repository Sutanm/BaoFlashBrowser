import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import chokidar from 'chokidar';

describe('automation dependency compatibility', () => {
  it('round-trips a unicode automation package with fflate', () => {
    const archive = zipSync({
      'project.json': strToU8(JSON.stringify({ name: '每日登录' })),
      'assets/登录按钮.txt': strToU8('fixture'),
    });
    const files = unzipSync(archive);
    expect(JSON.parse(strFromU8(files['project.json'])).name).toBe('每日登录');
    expect(strFromU8(files['assets/登录按钮.txt'])).toBe('fixture');
  });

  it('loads the Node 12 compatible asset watcher API', () => {
    expect(typeof chokidar.watch).toBe('function');
  });
});
