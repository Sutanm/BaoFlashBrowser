import { describe, expect, it } from 'vitest';
import { createInitialTabState, resolveInitialRuffleMode } from '../src/renderer/services/tab-initial-state';
import type { Settings } from '../src/shared/types/settings';

const engineSettings: Pick<Settings, 'flashEngineMode' | 'flashEngineRules'> = {
  flashEngineMode: 'prefer-ppapi',
  flashEngineRules: [{ domain: '.example.com', mode: 'prefer-ruffle' }],
};

describe('initial tab state', () => {
  it('applies exact and subdomain engine rules without matching suffix lookalikes', () => {
    expect(resolveInitialRuffleMode('https://example.com/game', engineSettings)).toBe('ruffle');
    expect(resolveInitialRuffleMode('https://www.example.com/game', engineSettings)).toBe('ruffle');
    expect(resolveInitialRuffleMode('https://notexample.com/game', engineSettings)).toBe('ppapi');
  });

  it('builds internal tab titles and stable initial flags', () => {
    expect(createInitialTabState('tab-1', 'about:userscripts', engineSettings, {
      newTab: 'New tab', userscripts: 'Scripts', automation: 'Automation',
    }, 1234)).toMatchObject({
      id: 'tab-1', title: 'Scripts', createdAt: 1234, ruffleMode: 'ppapi',
      zoomFactor: 1, isLoading: false, isMuted: false, crashed: false,
    });
  });
});
