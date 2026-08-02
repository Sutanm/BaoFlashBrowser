import { describe, expect, it } from 'vitest';
import type { Tab } from '../src/shared/types/tab';
import { isTabEligibleForSuspension } from '../src/renderer/services/tab-suspension';

const tab = (patch: Partial<Tab> = {}): Tab => ({
  id: 'tab-1', url: 'https://game.example/', title: 'Game', zoomFactor: 1,
  isLoading: false, isAudible: false, isMuted: false, canGoBack: false,
  canGoForward: false, createdAt: 1, ruffleMode: 'ppapi', ...patch,
});

describe('inactive tab suspension policy', () => {
  it('allows only inactive, settled and silent web tabs', () => {
    expect(isTabEligibleForSuspension(tab(), 'other', true)).toBe(true);
    expect(isTabEligibleForSuspension(tab(), 'tab-1', true)).toBe(false);
    expect(isTabEligibleForSuspension(tab({ isLoading: true }), 'other', true)).toBe(false);
    expect(isTabEligibleForSuspension(tab({ isAudible: true }), 'other', true)).toBe(false);
  });

  it('never suspends new-tab UI or an already suspended tab', () => {
    expect(isTabEligibleForSuspension(tab({ url: 'about:newtab' }), 'other', true)).toBe(false);
    expect(isTabEligibleForSuspension(tab({ suspended: true }), 'other', true)).toBe(false);
    expect(isTabEligibleForSuspension(tab(), 'other', false)).toBe(false);
  });
});
