import { describe, expect, it } from 'vitest';
import { createTabSession, createTabSessionSignature, MAX_RESTORED_TABS, sanitizeTabSession, selectCrashRecoverySession } from '../src/renderer/services/tab-session';
import type { Tab } from '../src/shared/types/tab';

function tab(id: string, url = `https://example.com/${id}`): Tab {
  return {
    id, url, title: id, zoomFactor: 1, isLoading: true, isAudible: true,
    isMuted: false, canGoBack: true, canGoForward: true, createdAt: 1, ruffleMode: 'ppapi',
  };
}

describe('tab session snapshots', () => {
  it('normalizes transient state and preserves the active tab', () => {
    const snapshot = createTabSession([tab('one'), { ...tab('two'), zoomFactor: 1.5, isMuted: true, ruffleMode: 'ruffle' }], 'two');
    expect(snapshot?.activeTabId).toBe('two');
    expect(snapshot?.tabs[0]).toMatchObject({ isLoading: false, isAudible: false, canGoBack: false, canGoForward: false });
    expect(snapshot?.tabs[1]).toMatchObject({ zoomFactor: 1.5, isMuted: true, ruffleMode: 'ruffle' });
  });

  it('ignores loading, sound and favicon churn when deciding whether to persist', () => {
    const first = tab('one');
    const changed = { ...first, isLoading: false, isAudible: false, favicon: 'https://example.com/icon.png' };
    expect(createTabSessionSignature([first], 'one')).toBe(createTabSessionSignature([changed], 'one'));
    expect(createTabSessionSignature([first], 'one')).not.toBe(createTabSessionSignature([{ ...first, isMuted: true }], 'one'));
  });

  it('does not create a recovery prompt for blank tabs only', () => {
    expect(createTabSession([{ ...tab('blank'), url: 'about:newtab' }], 'blank')).toBeNull();
  });

  it('preserves the internal automation workbench without creating a web URL', () => {
    const snapshot = createTabSession([tab('automation', 'about:automation')], 'automation');
    expect(snapshot?.tabs[0].url).toBe('about:automation');
  });

  it('offers a saved session only after an abnormal exit', () => {
    const saved = createTabSession([tab('one')], 'one');
    expect(selectCrashRecoverySession(saved, false, true)).toBeNull();
    expect(selectCrashRecoverySession(saved, true, false)).toBeNull();
    expect(selectCrashRecoverySession(saved, true, true)?.tabs[0].id).toBe('one');
  });

  it('rejects unsafe URLs, duplicate IDs and excess tabs', () => {
    const many = Array.from({ length: MAX_RESTORED_TABS + 5 }, (_, index) => tab(`tab_${index}`));
    const raw = { version: 1, tabs: [tab('bad', 'javascript:alert(1)'), tab('same'), tab('same'), ...many], activeTabId: 'missing' };
    const snapshot = sanitizeTabSession(raw);
    expect(snapshot?.tabs).toHaveLength(MAX_RESTORED_TABS);
    expect(snapshot?.tabs.some((item) => item.url.startsWith('javascript:'))).toBe(false);
    expect(snapshot?.activeTabId).toBe('same');
  });
});
