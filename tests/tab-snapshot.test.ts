// P7：跨窗迁移后的标签重建 —— favicon 不能丢、url 不能猜。
import { describe, expect, it } from 'vitest';
import { mergeTabSnapshot, pickActiveTabId } from '../src/renderer/services/tab-snapshot';
import type { TabState } from '../src/renderer/store/useTabsStore';
import type { TabSnapshotEntry } from '../src/shared/types/ipc';

const settings = { flashEngineMode: 'auto' as const, flashEngineRules: [] };
const titles = { newTab: '新标签页', userscripts: '脚本', automation: '自动化' };

function tab(overrides: Partial<TabState> & { id: string }): TabState {
  return {
    id: overrides.id,
    url: 'https://example.com/',
    title: 'Example',
    zoomFactor: 1,
    isLoading: false,
    isAudible: false,
    isMuted: false,
    canGoBack: false,
    canGoForward: false,
    createdAt: 1,
    ruffleMode: 'ppapi',
    ...overrides,
  };
}

describe('mergeTabSnapshot (P7)', () => {
  it('keeps the favicon and per-tab runtime state of tabs it already knows', () => {
    const prev = [tab({ id: 'a', favicon: 'https://www.7k7k.com/favicon.ico', zoomFactor: 1.25, createdAt: 42, title: '旧标题' })];
    const snapshot: TabSnapshotEntry[] = [{ tabId: 'a', url: 'https://www.7k7k.com/', title: '', active: true }];

    const [merged] = mergeTabSnapshot(prev, snapshot, settings, titles);
    expect(merged.favicon).toBe('https://www.7k7k.com/favicon.ico');
    expect(merged.zoomFactor).toBe(1.25);
    expect(merged.createdAt).toBe(42);
    // 快照里 title 为空时保留原值（getTitle 在隐藏视图上可能返回空串）。
    expect(merged.title).toBe('旧标题');
    expect(merged.url).toBe('https://www.7k7k.com/');
  });

  it('adopts the favicon carried by the snapshot for a tab it has never seen', () => {
    const snapshot: TabSnapshotEntry[] = [{
      tabId: 'b', url: 'https://www.4399.com/', title: '4399', favicon: 'https://www.4399.com/favicon.ico', active: true,
      suspended: true, zoomFactor: 1.5, isMuted: true, ruffleMode: 'ruffle', ruffleSource: 'cdn',
    }];

    const [merged] = mergeTabSnapshot([], snapshot, settings, titles);
    expect(merged.id).toBe('b');
    expect(merged.favicon).toBe('https://www.4399.com/favicon.ico');
    expect(merged.title).toBe('4399');
    expect(merged).toMatchObject({ suspended: true, zoomFactor: 1.5, isMuted: true, ruffleMode: 'ruffle', ruffleSource: 'cdn' });
  });

  it('never turns an empty url into a new tab page for a tab it already knows', () => {
    const prev = [tab({ id: 'a', url: 'https://www.7k7k.com/' })];
    const snapshot: TabSnapshotEntry[] = [{ tabId: 'a', url: '', title: '', active: true }];

    expect(mergeTabSnapshot(prev, snapshot, settings, titles)[0].url).toBe('https://www.7k7k.com/');
  });

  it('drops tabs the main process no longer owns and follows its order', () => {
    const prev = [tab({ id: 'a' }), tab({ id: 'ghost' })];
    const snapshot: TabSnapshotEntry[] = [
      { tabId: 'b', url: 'https://b.example/', title: 'B', active: false },
      { tabId: 'a', url: 'https://a.example/', title: 'A', active: true },
    ];

    const merged = mergeTabSnapshot(prev, snapshot, settings, titles);
    expect(merged.map((item) => item.id)).toEqual(['b', 'a']);
    expect(merged[0].favicon).toBeUndefined();
  });

  it('picks the flagged active tab, falling back to the first entry', () => {
    const snapshot: TabSnapshotEntry[] = [
      { tabId: 'a', url: 'https://a.example/', title: 'A', active: false },
      { tabId: 'b', url: 'https://b.example/', title: 'B', active: true },
    ];
    expect(pickActiveTabId(snapshot)).toBe('b');
    expect(pickActiveTabId([{ tabId: 'a', url: 'https://a.example/', title: 'A', active: false }])).toBe('a');
    expect(pickActiveTabId([])).toBeNull();
  });
});
