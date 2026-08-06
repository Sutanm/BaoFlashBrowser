import type { Tab } from '@shared/types/tab';
import { sanitizeUrlForPersistence } from '@shared/utils/url-privacy';

export const TAB_SESSION_META_KEY = 'tab_session_v1';
export const MAX_RESTORED_TABS = 20;

export interface TabSessionSnapshot {
  version: 1;
  savedAt: number;
  activeTabId: string | null;
  tabs: Tab[];
}

function safeSessionUrl(value: unknown): string | null {
  if (value === 'about:newtab' || value === 'about:blank') return 'about:newtab';
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192) return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'file:'].includes(parsed.protocol) ? sanitizeUrlForPersistence(value) : null;
  } catch {
    return null;
  }
}

export function sanitizeTabSession(value: unknown): TabSessionSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<TabSessionSnapshot>;
  if (!Array.isArray(candidate.tabs)) return null;

  const ids = new Set<string>();
  const tabs: Tab[] = [];
  for (const raw of candidate.tabs) {
    if (tabs.length >= MAX_RESTORED_TABS) break;
    if (!raw || typeof raw !== 'object') continue;
    const tab = raw as Partial<Tab>;
    const url = safeSessionUrl(tab.url);
    if (!url || typeof tab.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tab.id) || ids.has(tab.id)) continue;
    ids.add(tab.id);
    tabs.push({
      id: tab.id,
      url,
      title: typeof tab.title === 'string' ? tab.title.slice(0, 500) : url,
      favicon: typeof tab.favicon === 'string' && tab.favicon.length <= 8192 ? tab.favicon : undefined,
      zoomFactor: typeof tab.zoomFactor === 'number' && tab.zoomFactor >= 0.25 && tab.zoomFactor <= 5 ? tab.zoomFactor : 1,
      isLoading: false,
      isAudible: false,
      isMuted: tab.isMuted === true,
      canGoBack: false,
      canGoForward: false,
      createdAt: typeof tab.createdAt === 'number' ? tab.createdAt : Date.now(),
      ruffleMode: tab.ruffleMode === 'ruffle' ? 'ruffle' : 'ppapi',
      suspended: false,
      crashed: false,
    });
  }

  if (tabs.length === 0) return null;
  const activeTabId = typeof candidate.activeTabId === 'string' && ids.has(candidate.activeTabId)
    ? candidate.activeTabId
    : tabs[0].id;
  return { version: 1, savedAt: Date.now(), activeTabId, tabs };
}

export function createTabSession(tabs: Tab[], activeTabId: string | null): TabSessionSnapshot | null {
  const snapshot = sanitizeTabSession({ version: 1, savedAt: Date.now(), activeTabId, tabs });
  if (snapshot?.tabs.every((tab) => tab.url === 'about:newtab')) return null;
  return snapshot;
}

export function createTabSessionSignature(tabs: Tab[], activeTabId: string | null): string {
  return JSON.stringify({
    activeTabId,
    tabs: tabs.slice(0, MAX_RESTORED_TABS).map((tab) => ({
      id: tab.id,
      url: sanitizeUrlForPersistence(tab.url),
      ruffleMode: tab.ruffleMode,
      zoomFactor: tab.zoomFactor,
      isMuted: tab.isMuted,
      suspended: Boolean(tab.suspended),
      crashed: Boolean(tab.crashed),
    })),
  });
}

export function selectCrashRecoverySession(
  value: unknown,
  abnormalExit: boolean,
  recoveryEnabled: boolean,
): TabSessionSnapshot | null {
  if (!abnormalExit || !recoveryEnabled) return null;
  return sanitizeTabSession(value);
}
