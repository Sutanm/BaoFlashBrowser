import type { Tab } from '@shared/types/tab';

export function isTabEligibleForSuspension(tab: Tab, activeTabId: string | null, enabled: boolean): boolean {
  if (!enabled || tab.id === activeTabId || tab.suspended || tab.isLoading || tab.isAudible) return false;
  return Boolean(tab.url) && !['about:newtab', 'about:blank'].includes(tab.url) && !tab.url.startsWith('data:');
}
