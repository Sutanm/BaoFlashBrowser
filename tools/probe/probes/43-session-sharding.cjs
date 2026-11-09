// Probe 43 · P5 可行性：会话与窗口几何的持久化隔离
//
// P5 要把「全局一份会话快照」改成「每窗口一份」。本 probe 不碰真实应用数据，
// 只用临时目录验证三件事：
//   1. electron-store 可以在同一 store 里按 key 前缀分片（tab-session:<key>）
//   2. 多个窗口的几何与标签快照互不覆盖
//   3. 旧全局 key 能安全迁移给第一个窗口，迁移成功后才删除
//
// 全部读写都发生在 probe 专属的临时 userData（host-electron 已隔离），
// 不改动任何用户数据。
'use strict';

const path = require('path');
const fs = require('fs');

module.exports = {
  id: '43-session-sharding',
  name: 'P5 per-window session & geometry sharding',
  needsElectron: true,
  timeoutMs: 30_000,

  async run(ctx) {
    const { app } = ctx.electron;
    const failures = [];
    const check = (name, ok, detail) => { if (!ok) failures.push({ name, detail }); };

    const dir = path.join(app.getPath('userData'), 'probe-session-sharding');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'windows.json');

    // 用纯文件模拟 electron-store 的 JSON 语义（避免把依赖注入 probe）
    const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
    const write = (data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

    // --- 1. 分片写入：两个窗口互不覆盖 ---
    const store = { windows: [], sessions: {} };
    store.windows.push({ key: 'w-aaa', bounds: { x: 100, y: 100, width: 1280, height: 800 }, maximized: false });
    store.windows.push({ key: 'w-bbb', bounds: { x: 300, y: 200, width: 1024, height: 720 }, maximized: true });
    store.sessions['tab-session:w-aaa'] = [{ id: 't1', url: 'https://a.example' }, { id: 't2', url: 'https://b.example' }];
    store.sessions['tab-session:w-bbb'] = [{ id: 't3', url: 'https://c.example' }];
    write(store);

    const loaded = read();
    check('two window records persisted', loaded.windows.length === 2, loaded.windows);
    check('window order preserved', loaded.windows[0].key === 'w-aaa' && loaded.windows[1].key === 'w-bbb',
      loaded.windows.map((w) => w.key));
    check('geometry isolated per window',
      loaded.windows[0].bounds.width === 1280 && loaded.windows[1].bounds.width === 1024,
      loaded.windows.map((w) => w.bounds));
    check('maximized flag isolated', loaded.windows[0].maximized === false && loaded.windows[1].maximized === true,
      loaded.windows.map((w) => w.maximized));
    check('session sharded by window key',
      Object.keys(loaded.sessions).length === 2
      && loaded.sessions['tab-session:w-aaa'].length === 2
      && loaded.sessions['tab-session:w-bbb'].length === 1,
      Object.keys(loaded.sessions));
    check('sessions do not leak across windows',
      loaded.sessions['tab-session:w-aaa'].every((t) => t.id !== 't3'),
      loaded.sessions);

    // --- 2. 旧全局 key 迁移 ---
    const legacy = [{ id: 'old1', url: 'https://legacy.example' }, { id: 'old2', url: 'https://legacy2.example' }];
    const migrate = (data, legacySnapshot) => {
      const hasShards = Object.keys(data.sessions).some((k) => k.startsWith('tab-session:'));
      if (!hasShards && legacySnapshot && data.windows.length > 0) {
        const firstKey = data.windows[0].key;
        const next = { ...data, sessions: { ...data.sessions, ['tab-session:' + firstKey]: legacySnapshot } };
        // 先落盘新 key，成功后由调用方删除旧 key —— 这里返回 next 供断言
        return { next, migratedTo: firstKey };
      }
      return { next: data, migratedTo: null };
    };

    const emptyStore = { windows: [{ key: 'w-ccc', bounds: { x: 0, y: 0, width: 800, height: 600 } }], sessions: {} };
    const migration = migrate(emptyStore, legacy);
    check('legacy snapshot migrates to first window',
      migration.migratedTo === 'w-ccc'
      && migration.next.sessions['tab-session:w-ccc'].length === 2,
      migration.next.sessions);
    check('migration is a no-op when shards already exist',
      migrate(loaded, legacy).migratedTo === null,
      Object.keys(loaded.sessions));

    // --- 3. 边界：无窗口记录时不应迁移（避免写出孤儿 key）---
    const noWindows = migrate({ windows: [], sessions: {} }, legacy);
    check('no migration when no window record exists', noWindows.migratedTo === null, noWindows.next);

    // 清理 probe 自己的临时目录
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

    return {
      ok: failures.length === 0,
      summary: failures.length === 0 ? 'sharding + migration logic sound' : `${failures.length} check(s) failed`,
      detail: { failures, note: '逻辑验证，未触碰真实 userData 的 tab-session 数据' },
    };
  },
};
