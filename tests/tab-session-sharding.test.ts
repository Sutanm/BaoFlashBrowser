// 多窗口 P5：会话 key 分片与旧 key 单归属迁移的纯逻辑。
import { describe, expect, it } from 'vitest';
import { TAB_SESSION_META_KEY, planLegacySessionMigration, tabSessionKey } from '../src/renderer/services/tab-session';

describe('tab session sharding (P5)', () => {
  it('builds per-window session keys', () => {
    expect(tabSessionKey('abc123')).toBe('tab-session:abc123');
  });

  it('lets only the primary window claim the legacy snapshot once', () => {
    expect(planLegacySessionMigration({
      windowKey: 'abc123', isPrimary: true, hasShardedSession: false, legacyExists: true,
    })).toEqual({ migrate: true, fromKey: TAB_SESSION_META_KEY, toKey: 'tab-session:abc123' });

    for (const blocked of [
      { windowKey: 'abc123', isPrimary: false, hasShardedSession: false, legacyExists: true },
      { windowKey: 'abc123', isPrimary: true, hasShardedSession: true, legacyExists: true },
      { windowKey: 'abc123', isPrimary: true, hasShardedSession: false, legacyExists: false },
      { windowKey: '', isPrimary: true, hasShardedSession: false, legacyExists: true },
    ]) {
      expect(planLegacySessionMigration(blocked)).toBeNull();
    }
  });
});
