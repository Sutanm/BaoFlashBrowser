import type { Settings } from '@shared/types/settings';
import type { TabState } from '../store/useTabsStore';
import { AUTOMATION_URL, USERSCRIPTS_URL, isNewtabUrl } from './url-utils';

export interface InternalTabTitles {
  newTab: string;
  userscripts: string;
  automation: string;
}

export function resolveInitialRuffleMode(
  url: string,
  settings: Pick<Settings, 'flashEngineMode' | 'flashEngineRules'>,
): 'ppapi' | 'ruffle' {
  let engineMode = settings.flashEngineMode;
  if (!isNewtabUrl(url)) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const rule = settings.flashEngineRules.find((item) => {
        const domain = item.domain.trim().toLowerCase().replace(/^\./, '');
        return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
      });
      if (rule) engineMode = rule.mode;
    } catch { /* navigation validation reports invalid input later */ }
  }
  return engineMode === 'prefer-ruffle' ? 'ruffle' : 'ppapi';
}

export function createInitialTabState(
  id: string,
  url: string,
  settings: Pick<Settings, 'flashEngineMode' | 'flashEngineRules'>,
  titles: InternalTabTitles,
  now = Date.now(),
): TabState {
  const title = url === USERSCRIPTS_URL
    ? titles.userscripts
    : url === AUTOMATION_URL ? titles.automation : titles.newTab;
  return {
    id,
    url,
    title,
    zoomFactor: 1,
    isLoading: false,
    isAudible: false,
    isMuted: false,
    canGoBack: false,
    canGoForward: false,
    createdAt: now,
    ruffleMode: resolveInitialRuffleMode(url, settings),
    crashed: false,
  };
}
