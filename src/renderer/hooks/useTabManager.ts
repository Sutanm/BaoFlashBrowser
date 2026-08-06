import { useCallback, useState, useEffect, useRef } from 'react';
import { useTabsStore } from '../store/useTabsStore';
import { useDataStore } from '../store/useDataStore';
import { useI18nContext } from '../i18n/i18n-react';
import { normalizeUrl, generateId } from '../services/id.service';
import type { TabState } from '../store/useTabsStore';
import type { HistoryEntry } from '@shared/types/history';
import { db, loadMeta, saveMeta } from '../services/db';
import { createTabSession, createTabSessionSignature, selectCrashRecoverySession, TAB_SESSION_META_KEY } from '../services/tab-session';
import { sanitizeUrlForPersistence } from '@shared/utils/url-privacy';
import { isTabEligibleForSuspension } from '../services/tab-suspension';

const NEWTAB_URL = 'about:newtab';
const USERSCRIPTS_URL = 'about:userscripts';
const INACTIVE_TAB_SUSPEND_MS = 10 * 60 * 1000;

function isNewtabUrl(url: string): boolean {
  return !url || url === 'about:blank' || url === NEWTAB_URL || url.startsWith('data:');
}

export interface UseTabManagerReturn {
  tabs: TabState[];
  activeTabId: string | null;
  activeTab: TabState | null;
  addressUrl: string;
  setAddressUrl: React.Dispatch<React.SetStateAction<string>>;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  createTab: (url?: string) => void;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  updateTab: (tabId: string, changes: Partial<TabState>) => void;
  handleNavigate: (input: string) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
}

export function useTabManager(calcBoundsRef: React.MutableRefObject<(animated: boolean) => void>): UseTabManagerReturn {
  const { LL } = useI18nContext();
  const LLRef = useRef(LL);
  useEffect(() => { LLRef.current = LL; });
  const settings = useDataStore((s) => s.settings);
  const pushToast = useDataStore((s) => s.pushToast);
  const tabs = useTabsStore((s) => s.tabs);
  const setTabs = useTabsStore((s) => s.setTabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setActiveTabId = useTabsStore((s) => s.setActiveTabId);
  const [addressUrl, setAddressUrl] = useState('');
  const [sessionReady, setSessionReady] = useState(false);
  const recordHistory = useDataStore((s) => s.recordHistory);
  const updateHistoryByUrl = useDataStore((s) => s.updateHistoryByUrl);
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const settingsRef = useRef(settings);
  const ruffleErrorsRef = useRef(new Set<string>());
  const suspensionTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const suspensionPromisesRef = useRef(new Map<string, Promise<void>>());
  useEffect(() => { tabsRef.current = tabs; activeTabIdRef.current = activeTabId; settingsRef.current = settings; });

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const ensureTabView = useCallback(async (tabId: string) => {
    const pending = suspensionPromisesRef.current.get(tabId);
    if (pending) await pending;
    const tab = useTabsStore.getState().tabs.find((item) => item.id === tabId);
    if (!tab?.suspended) return;
    await window.electronAPI.tab.create(tab.id, tab.url, {
      enabled: tab.ruffleMode === 'ruffle',
      source: useDataStore.getState().settings.ruffleSource,
    });
    if (tab.zoomFactor !== 1) await window.electronAPI.tab.zoom(tab.id, tab.zoomFactor);
    if (tab.isMuted) await window.electronAPI.tab.mute(tab.id, true);
    setTabs((previous) => previous.map((item) => item.id === tabId
      ? { ...item, suspended: false, isLoading: true, canGoBack: false, canGoForward: false }
      : item));
  }, [setTabs]);

  // --- Tab switching with debounced bounds calc ---
  const switchTabTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const switchTab = useCallback((tabId: string) => {
    if (switchTabTimerRef.current) clearTimeout(switchTabTimerRef.current);
    setActiveTabId(tabId);
    switchTabTimerRef.current = setTimeout(() => {
      void ensureTabView(tabId).then(() => {
        calcBoundsRef.current(false);
        return window.electronAPI.tab.activate(tabId);
      }).catch((error) => {
        console.warn('[Tabs] suspended tab resume failed:', error);
        pushToast({ message: LLRef.current.error.pageLoadFail(), type: 'error' });
      });
    }, 50);
  }, [setActiveTabId, calcBoundsRef, ensureTabView, pushToast]);
  const switchTabRef = useRef(switchTab);
  useEffect(() => { switchTabRef.current = switchTab; }, [switchTab]);

  const createTab = useCallback((url?: string) => {
    const id = generateId();
    const initialUrl = url || settings.homepage || NEWTAB_URL;
    // Singleton internal pages: activating an existing tab instead of
    // duplicating (plan §5.2).
    if (initialUrl === USERSCRIPTS_URL) {
      const existing = useTabsStore.getState().tabs.find((item) => item.url === USERSCRIPTS_URL);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
    }
    let engineMode = settings.flashEngineMode;
    if (!isNewtabUrl(initialUrl)) {
      try {
        const host = new URL(initialUrl).hostname.toLowerCase();
        const rule = settings.flashEngineRules.find((item) => {
          const domain = item.domain.trim().toLowerCase().replace(/^\./, '');
          return domain.length > 0 && (host === domain || host.endsWith('.' + domain));
        });
        if (rule) engineMode = rule.mode;
      } catch { /* normalized navigation will handle invalid input */ }
    }
    const ruffleMode: 'ppapi' | 'ruffle' = engineMode === 'prefer-ruffle' ? 'ruffle' : 'ppapi';
    const tab: TabState = {
      id, url: initialUrl,
      title: initialUrl === 'about:userscripts' ? LLRef.current.tab.userscripts() : LLRef.current.tab.newTab(),
      zoomFactor: 1, isLoading: false, isAudible: false, isMuted: false,
      canGoBack: false, canGoForward: false, createdAt: Date.now(),
      ruffleMode,
      crashed: false,
    };
    setTabs((prev) => [...prev, tab]);
    const useRuffle = ruffleMode === 'ruffle';
    window.electronAPI.tab.create(id, initialUrl, {
      enabled: useRuffle,
      source: settings.ruffleSource,
    });
    switchTab(id);
  }, [setTabs, switchTab, settings.flashEngineMode, settings.flashEngineRules, settings.homepage, settings.ruffleSource]);

  const historyTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pendingHistoryRef = useRef<{ tabId: string; url: string; title?: string } | null>(null);

  const closeTab = useCallback((tabId: string) => {
    // 关闭标签页时，取消未提交的历史记录（页面未加载完成就关闭，不记录历史）
    if (pendingHistoryRef.current?.tabId === tabId) {
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
      pendingHistoryRef.current = null;
    }
    window.electronAPI.tab.close(tabId);
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = [...prev];
      next.splice(idx, 1);
      if (tabId === activeTabId) {
        if (next.length > 0) {
          const newIdx = Math.min(idx, next.length - 1);
          setActiveTabId(next[newIdx].id);
          void ensureTabView(next[newIdx].id).then(() => window.electronAPI.tab.activate(next[newIdx].id));
        } else {
          setActiveTabId(null);
        }
      }
      return next;
    });
  }, [activeTabId, ensureTabView, setActiveTabId, setTabs]);

  const commitHistory = useCallback(() => {
    const pending = pendingHistoryRef.current;
    pendingHistoryRef.current = null;
    if (!pending) return;
    const currentTab = tabsRef.current.find((t) => t.id === pending.tabId);
    const entry: HistoryEntry = {
      id: generateId(),
      url: sanitizeUrlForPersistence(pending.url),
      title: pending.title || (() => { try { return new URL(pending.url).hostname; } catch { return pending.url; } })(),
      favicon: currentTab?.favicon || '',
      lastVisit: Date.now(),
      visitCount: 1,
    };
    recordHistory(entry);
  }, [recordHistory]);

  const updateTab = useCallback((tabId: string, changes: Partial<TabState>) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...changes } : t)));
    if (tabId === activeTabId && changes.url !== undefined) {
      const url = changes.url;
      setAddressUrl(isNewtabUrl(url) ? '' : url);
    }
    // 历史记录：URL 变化时 debounce 1500ms，重定向只保留最终 URL
    if (changes.url !== undefined && !isNewtabUrl(changes.url) && changes.url !== 'about:blank') {
      pendingHistoryRef.current = { tabId, url: sanitizeUrlForPersistence(changes.url), title: changes.title };
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
      historyTimerRef.current = setTimeout(() => {
        commitHistory();
      }, 1500);
    }
    // 页面停止加载时，重置 timer 但不立即提交（等 1500ms 过期后自动提交）
    // 这样重定向中间的 did-stop-loading 不会提前提交
    // 但如果 URL 没有再变化（非重定向场景），1500ms 后自动提交
    if (changes.title && changes.title !== changes.url) {
      // title 到来时更新 pending 的 title
      if (pendingHistoryRef.current && pendingHistoryRef.current.tabId === tabId) {
        pendingHistoryRef.current.title = changes.title;
      }
    }
    // Update favicon in history
    if (changes.favicon) {
      const rawTabUrl = tabsRef.current.find((t) => t.id === tabId)?.url;
      const tabUrl = rawTabUrl ? sanitizeUrlForPersistence(rawTabUrl) : '';
      if (tabUrl) {
        const existing = useDataStore.getState().history.find((item) => item.url === tabUrl);
        if (existing && !existing.favicon) updateHistoryByUrl(tabUrl, { favicon: changes.favicon! });
      }
    }
    // Update title in history
    if (changes.title && changes.title !== changes.url) {
      const rawTabUrl = tabsRef.current.find((t) => t.id === tabId)?.url;
      const tabUrl = rawTabUrl ? sanitizeUrlForPersistence(rawTabUrl) : '';
      if (tabUrl && !isNewtabUrl(tabUrl)) {
        updateHistoryByUrl(tabUrl, { title: changes.title! });
      }
    }
  }, [setTabs, activeTabId, updateHistoryByUrl, commitHistory]);

  const updateTabRef = useRef(updateTab);
  useEffect(() => { updateTabRef.current = updateTab; });

  useEffect(() => {
    const eligible = new Set(
      settings.suspendInactiveTabs
        ? tabs.filter((tab) => isTabEligibleForSuspension(tab, activeTabId, true)).map((tab) => tab.id)
        : [],
    );
    for (const [tabId, timer] of suspensionTimersRef.current) {
      if (!eligible.has(tabId)) {
        clearTimeout(timer);
        suspensionTimersRef.current.delete(tabId);
      }
    }
    for (const tabId of eligible) {
      if (suspensionTimersRef.current.has(tabId)) continue;
      const timer = setTimeout(() => {
        suspensionTimersRef.current.delete(tabId);
        const current = useTabsStore.getState();
        const tab = current.tabs.find((item) => item.id === tabId);
        if (!tab || current.activeTabId === tabId || tab.suspended || tab.isLoading || tab.isAudible) return;
        const suspension = window.electronAPI.tab.suspend(tabId).then(() => {
          setTabs((previous) => previous.map((item) => item.id === tabId
            ? { ...item, suspended: true, isLoading: false, isAudible: false, canGoBack: false, canGoForward: false }
            : item));
        }).finally(() => {
          suspensionPromisesRef.current.delete(tabId);
        });
        suspensionPromisesRef.current.set(tabId, suspension);
      }, INACTIVE_TAB_SUSPEND_MS);
      suspensionTimersRef.current.set(tabId, timer);
    }
  }, [activeTabId, settings.suspendInactiveTabs, setTabs, tabs]);

  useEffect(() => () => {
    for (const timer of suspensionTimersRef.current.values()) clearTimeout(timer);
    suspensionTimersRef.current.clear();
  }, []);

  // IPC listeners
  useEffect(() => {
    const unsub = window.electronAPI.on('tab:updated', (payload) => {
      const { tabId, ...changes } = payload;
      updateTabRef.current(tabId, changes as Partial<TabState>);
    });
    const unsubErr = window.electronAPI.on('tab:load-error', (payload) => {
      const msg = payload.errorCode === -105 ? LLRef.current.error.dnsFail() : LLRef.current.error.pageLoadFail();
      pushToast({
        key: `tab-load-error:${payload.tabId}:${payload.errorCode}`,
        message: `${msg} (${payload.errorCode})`,
        type: 'error',
      });
    });
    const unsubRuffle = window.electronAPI.on('ruffle:diagnostic', (payload) => {
      if (payload.phase === 'runtime-ready') {
        for (const key of ruffleErrorsRef.current) {
          if (key.startsWith(`${payload.tabId}:`)) ruffleErrorsRef.current.delete(key);
        }
        return;
      }
      if (!['bundled-eval-error', 'cdn-error', 'runtime-error', 'component-error'].includes(payload.phase)) return;
      const detail = String(payload.detail || payload.phase).slice(0, 300);
      const key = `${payload.tabId}:${payload.phase}:${detail}`;
      if (ruffleErrorsRef.current.has(key)) return;
      ruffleErrorsRef.current.add(key);
      pushToast({
        key: `ruffle-error:${payload.tabId}:${payload.phase}`,
        message: LLRef.current.ruffle.loadFailed({ detail }),
        type: 'error',
        duration: null,
        actions: payload.source === 'cdn' ? [{
          label: LLRef.current.ruffle.retryBundled(),
          primary: true,
          onClick: () => {
            const state = useDataStore.getState();
            state.setSettings({ ...state.settings, ruffleSource: 'bundled' });
            window.electronAPI.tab.setRuffleMode(payload.tabId, true, 'bundled');
          },
        }] : undefined,
      });
    });
    return () => {
      try { unsub(); unsubErr(); unsubRuffle(); }
      catch (e) { console.warn('[App] tab event cleanup failed:', e); }
    };
  }, []);

  const createTabRef = useRef(createTab);
  useEffect(() => { createTabRef.current = createTab; }, [createTab]);

  useEffect(() => {
    const u1 = window.electronAPI.on('tab:newwindow', (payload) => {
      const url = payload.url;
      const currentId = activeTabIdRef.current;
      if (settingsRef.current.linkBehavior === 'current-page' && currentId) {
        window.electronAPI.tab.navigate(currentId, url);
      } else {
        createTabRef.current(url);
      }
    });
    const u2 = window.electronAPI.on('tab:crashed', (payload) => {
      updateTabRef.current(payload.tabId, { crashed: true, isLoading: false, isAudible: false, canGoBack: false, canGoForward: false, title: LLRef.current.error.pageCrashed() });
      pushToast({ key: `tab-crashed:${payload.tabId}`, message: LLRef.current.error.pageCrashed(), type: 'error' });
    });
    return () => { try { u1(); u2(); } catch { /* ignore */ } };
  }, [pushToast]);

  // External URL open
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsub = window.electronAPI.on('navigate-url', (url) => {
      const delay = activeTab?.isLoading ? 600 : 0;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        createTabRef.current(String(url));
        timer = null;
      }, delay);
    });

    return () => {
      try { unsub(); } catch { /* ignore */ }
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Keep crash snapshots continuously, but only offer them after an abnormal
  // process exit. A normal window close never restores tabs on the next launch.
  const restoreStartedRef = useRef(false);
  useEffect(() => {
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;

    void (async () => {
      try {
        const [rawSession, storedSettings, recoveryStatus] = await Promise.all([
          loadMeta(TAB_SESSION_META_KEY),
          db.settings.toArray(),
          window.electronAPI.session.recoveryStatus(),
        ]);
        const restoreEnabled = storedSettings[0]?.restoreSession !== false;
        const restoredRuffleSource = storedSettings[0]?.ruffleSource || useDataStore.getState().settings.ruffleSource;
        const snapshot = selectCrashRecoverySession(rawSession, recoveryStatus.abnormalExit, restoreEnabled);
        if (!snapshot) {
          await db.meta.delete(TAB_SESSION_META_KEY).catch(() => {});
          await window.electronAPI.session.resolveRecovery().catch(() => {});
          createTab();
          setSessionReady(true);
          return;
        }

        // Show a usable new tab while the old crash snapshot remains untouched.
        // Snapshot persistence stays paused until the user makes a choice.
        createTab();
        let choiceHandled = false;

        const ignoreRecovery = async () => {
          if (choiceHandled) return;
          choiceHandled = true;
          await db.meta.delete(TAB_SESSION_META_KEY).catch(() => {});
          await window.electronAPI.session.resolveRecovery().catch(() => {});
          setSessionReady(true);
        };

        const restoreRecovery = async () => {
          if (choiceHandled) return;
          choiceHandled = true;
          const createdIds: string[] = [];
          try {
            const currentTabs = useTabsStore.getState().tabs;
            await Promise.all(currentTabs.map((tab) => window.electronAPI.tab.close(tab.id)));
            setTabs(snapshot.tabs);
            for (const tab of snapshot.tabs) {
              await window.electronAPI.tab.create(tab.id, tab.url, {
                enabled: tab.ruffleMode === 'ruffle',
                source: restoredRuffleSource,
              });
              createdIds.push(tab.id);
              if (tab.zoomFactor !== 1) await window.electronAPI.tab.zoom(tab.id, tab.zoomFactor);
              if (tab.isMuted) await window.electronAPI.tab.mute(tab.id, true);
            }
            const restoredActiveId = snapshot.activeTabId || snapshot.tabs[0].id;
            setActiveTabId(restoredActiveId);
            await window.electronAPI.tab.activate(restoredActiveId);
          } catch (error) {
            console.warn('[Tabs] crash session restore failed:', error);
            await Promise.all(createdIds.map((id) => window.electronAPI.tab.close(id).catch(() => {})));
            setTabs([]);
            createTab();
            pushToast({ key: 'session-restore-failed', message: LLRef.current.session.restoreFailed(), type: 'error' });
          } finally {
            await db.meta.delete(TAB_SESSION_META_KEY).catch(() => {});
            await window.electronAPI.session.resolveRecovery().catch(() => {});
            setSessionReady(true);
          }
        };

        pushToast({
          key: 'session-recovery',
          message: LLRef.current.session.restorePrompt({ count: snapshot.tabs.length }),
          type: 'warning',
          duration: null,
          actions: [
            { label: LLRef.current.session.restore(), primary: true, onClick: restoreRecovery },
            { label: LLRef.current.session.ignore(), onClick: ignoreRecovery },
          ],
          onDismiss: (reason) => {
            if (reason !== 'action') void ignoreRecovery();
          },
        });
      } catch (error) {
        console.warn('[Tabs] session recovery check failed:', error);
        await db.meta.delete(TAB_SESSION_META_KEY).catch(() => {});
        await window.electronAPI.session.resolveRecovery().catch(() => {});
        if (tabsRef.current.length === 0) createTab();
        setSessionReady(true);
      }
    })();
  }, [createTab, pushToast, setActiveTabId, setTabs]);

  // Keep a bounded, validated snapshot. Transient loading/navigation flags are
  // normalized by createTabSession and never trusted when restoring.
  const sessionSignature = createTabSessionSignature(tabs, activeTabId);
  useEffect(() => {
    if (!sessionReady) return;
    const timer = setTimeout(() => {
      if (!settings.restoreSession) {
        void db.meta.delete(TAB_SESSION_META_KEY);
        return;
      }
      const latest = useTabsStore.getState();
      const snapshot = createTabSession(latest.tabs, latest.activeTabId);
      if (snapshot) void saveMeta(TAB_SESSION_META_KEY, snapshot);
      else void db.meta.delete(TAB_SESSION_META_KEY);
    }, 1000);
    return () => clearTimeout(timer);
  }, [sessionReady, sessionSignature, settings.restoreSession]);

  useEffect(() => {
    if (sessionReady && tabs.length === 0) createTab();
  }, [sessionReady, tabs.length, createTab]);

  // Sync address bar when active tab changes
  useEffect(() => {
    if (activeTab) {
      setAddressUrl(isNewtabUrl(activeTab.url) ? '' : activeTab.url);
    }
  }, [activeTabId, activeTab]);

  // --- Navigation ---
  const handleNavigate = useCallback((input: string) => {
    const url = normalizeUrl(input, settings.searchEngine);
    if (!activeTabId) { createTab(url); return; }
    updateTab(activeTabId, { url, title: url, crashed: false, isLoading: true });
    setAddressUrl(url);
    if (activeTabId) {
      window.electronAPI.tab.stop(activeTabId);
      window.electronAPI.tab.navigate(activeTabId, url);
    }
  }, [activeTabId, createTab, updateTab, settings.searchEngine]);

  // --- Zoom ---
  const doZoom = useCallback((delta: number) => {
    if (!activeTab) return;
    const lvl = Math.min(5, Math.max(0.25, activeTab.zoomFactor + delta));
    if (activeTabId) window.electronAPI.tab.zoom(activeTabId, lvl);
    updateTab(activeTab.id, { zoomFactor: lvl });
  }, [activeTab, updateTab, activeTabId]);
  const doZoomRef = useRef(doZoom);
  useEffect(() => { doZoomRef.current = doZoom; }, [doZoom]);

  const zoomIn = useCallback(() => doZoom(0.25), [doZoom]);
  const zoomOut = useCallback(() => doZoom(-0.25), [doZoom]);
  const zoomReset = useCallback(() => {
    if (!activeTab) return;
    if (activeTabId) window.electronAPI.tab.zoom(activeTabId, 1);
    updateTab(activeTab.id, { zoomFactor: 1 });
  }, [activeTab, updateTab, activeTabId]);

  const reorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    setTabs((prev) => {
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= prev.length || toIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, [setTabs]);

  // Ctrl+wheel zoom (chrome UI area)
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      doZoomRef.current(e.deltaY < 0 ? 0.25 : -0.25);
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, []);

  // Ctrl+1..9 tab switching
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const num = parseInt(e.key);
        const currentTabs = tabsRef.current;
        if (num >= 1 && num <= Math.min(9, currentTabs.length)) {
          e.preventDefault();
          switchTabRef.current(currentTabs[num - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return {
    tabs, activeTabId, activeTab,
    addressUrl, setAddressUrl,
    createTab, closeTab, switchTab, updateTab, reorderTabs,
    handleNavigate,
    zoomIn, zoomOut, zoomReset,
  };
}
