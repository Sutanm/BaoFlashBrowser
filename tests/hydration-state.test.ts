// 多窗口 P8：IndexedDB 水合完成标记（主题/语言推送的前置条件）。
import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateFromDb, useDataStore } from '../src/renderer/store/useDataStore';

describe('data store hydration gate (P8)', () => {
  beforeEach(() => {
    useDataStore.setState({ hydrated: false });
  });

  it('starts unhydrated and stays unhydrated after a partial hydrate', () => {
    expect(useDataStore.getState().hydrated).toBe(false);
    hydrateFromDb({ themeMode: 'dark' });
    expect(useDataStore.getState().themeMode).toBe('dark');
    expect(useDataStore.getState().hydrated).toBe(false);
  });

  it('marks hydrated exactly when the hydrator says so', () => {
    useDataStore.getState().markHydrated();
    expect(useDataStore.getState().hydrated).toBe(true);
  });
});
