import { useCallback, useState, useEffect, useRef } from 'react';
import { useTabsStore } from '../store/useTabsStore';
import { useDataStore } from '../store/useDataStore';
import { useI18nContext } from '../i18n/i18n-react';
import { normalizeUrl, generateId } from '../services/id.service';
import type { TabState } from '../store/useTabsStore';
import type { HistoryEntry } from '@shared/types/history';
import type { TabSnapshotEntry } from '@shared/types/ipc';
import { db, loadMeta, saveMeta } from '../services/db';
import { createTabSession, createTabSessionSignature, planLegacySessionMigration, selectCrashRecoverySession, TAB_SESSION_META_KEY, tabSessionKey } from '../services/tab-session';
import { sanitizeUrlForPersistence } from '@shared/utils/url-privacy';
import { isTabEligibleForSuspension } from '../services/tab-suspension';
import { PendingHistoryRegistry } from '../services/pending-history';
import { AUTOMATION_URL, USERSCRIPTS_URL, isNewtabUrl } from '../services/url-utils';
import { createInitialTabState, resolveInitialTabUrl } from '../services/tab-initial-state';
import { mergeTabSnapshot, pickActiveTabId } from '../services/tab-snapshot';

const INACTIVE_TAB_SUSPEND_MS = 10 * 60 * 1000;

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
  const replaceTabs = useTabsStore((s) => s.replaceTabs);
  const [addressUrl, setAddressUrl] = useState('');
  const [sessionReady, setSessionReady] = useState(false);
  /** P5：本窗口的会话快照 key（	ab-session:<windowKey>；拿不到上下文时退回旧全局 key）。 */
  const sessionKeyRef = useRef<string>(TAB_SESSION_META_KEY);
  /** P7 tear-off：新窗口的标签由主进程迁入，渲染层不得自建默认标签。 */
  const adoptingRef = useRef(false);
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
      source: tab.ruffleSource ?? useDataStore.getState().settings.ruffleSource,
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
    const initialUrl = resolveInitialTabUrl(url, settings.homepage);
    // Singleton internal pages: activating an existing tab instead of
    // duplicating (plan §5.2).
    if (initialUrl === USERSCRIPTS_URL || initialUrl === AUTOMATION_URL) {
      const existing = useTabsStore.getState().tabs.find((item) => item.url === initialUrl);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
    }
    const tab = createInitialTabState(id, initialUrl, settings, {
      newTab: LLRef.current.tab.newTab(),
      userscripts: LLRef.current.tab.userscripts(),
      automation: LLRef.current.tab.automation(),
    });
    setTabs((prev) => [...prev, tab]);
    const useRuffle = tab.ruffleMode === 'ruffle';
    window.electronAPI.tab.create(id, initialUrl, {
      enabled: useRuffle,
      source: settings.ruffleSource,
    });
    switchTab(id);
  }, [setTabs, switchTab, settings, settings.homepage, settings.ruffleSource]);

  const historyTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingHistoryRef = useRef(new PendingHistoryRegistry());

  const closeTab = useCallback((tabId: string) => {
    // 关闭标签页时，取消未提交的历史记录（页面未加载完成就关闭，不记录历史）
    const historyTimer = historyTimersRef.current.get(tabId);
    if (historyTimer) clearTimeout(historyTimer);
    historyTimersRef.current.delete(tabId);
    pendingHistoryRef.current.delete(tabId);
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

  const commitHistory = useCallback((tabId: string) => {
    historyTimersRef.current.delete(tabId);
    const pending = pendingHistoryRef.current.take(tabId);
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
      pendingHistoryRef.current.set({ tabId, url: sanitizeUrlForPersistence(changes.url), title: changes.title });
      const previousTimer = historyTimersRef.current.get(tabId);
      if (previousTimer) clearTimeout(previousTimer);
      const timer = setTimeout(() => {
        commitHistory(tabId);
      }, 1500);
      historyTimersRef.current.set(tabId, timer);
    }
    // 页面停止加载时，重置 timer 但不立即提交（等 1500ms 过期后自动提交）
    // 这样重定向中间的 did-stop-loading 不会提前提交
    // 但如果 URL 没有再变化（非重定向场景），1500ms 后自动提交
    if (changes.title && changes.title !== changes.url) {
      // title 到来时更新 pending 的 title
      pendingHistoryRef.current.updateTitle(tabId, changes.title);
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

  useEffect(() => () => {
    for (const timer of historyTimersRef.current.values()) clearTimeout(timer);
    historyTimersRef.current.clear();
    pendingHistoryRef.current.clear();
  }, []);

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

  /**
   * P7：用主进程快照重建本窗口标签列表。
   *
   * tear-off 新窗口、跨窗迁入、以及"事件可能丢了"的兜底共用这一条路径——标签列表
   * 在主进程里是权威的，渲染层只负责呈现，不再靠单个事件推断。
   */
  const applyTabSnapshot = useCallback((snapshot: TabSnapshotEntry[]) => {
    if (!snapshot.length) return;
    const labels = {
      newTab: LLRef.current.tab.newTab(),
      userscripts: LLRef.current.tab.userscripts(),
      automation: LLRef.current.tab.automation(),
    };
    const nextTabs = mergeTabSnapshot(useTabsStore.getState().tabs, snapshot, settingsRef.current, labels);
    const activeId = pickActiveTabId(snapshot);
    // 列表与活动 id 必须原子替换（见 replaceTabs 注释）。
    replaceTabs(nextTabs, activeId);
    if (activeId) {
      void ensureTabView(activeId).then(() => {
        if (useTabsStore.getState().activeTabId === activeId) return window.electronAPI.tab.activate(activeId);
      }).catch((error) => {
        console.warn('[Tabs] adopted tab resume failed:', error);
      });
    }
  }, [replaceTabs, ensureTabView]);

  const createTabRef = useRef(createTab);
  useEffect(() => { createTabRef.current = createTab; }, [createTab]);

  useEffect(() => {
    const u1 = window.electronAPI.on('tab:newwindow', (payload) => {
      const url = payload.url;
      if (payload.disposition === 'new-window') {
        void window.electronAPI.win.newWindow({ url });
        return;
      }
      const currentId = activeTabIdRef.current;
      if (settingsRef.current.linkBehavior === 'current-page' && currentId) {
        window.electronAPI.tab.navigate(currentId, url);
      } else {
        createTabRef.current(url);
      }
    });
    const u3 = window.electronAPI.on('tab:detached', (payload) => {
      setTabs((prev) => {
        const next = prev.filter((item) => item.id !== payload.tabId);
        if (activeTabIdRef.current === payload.tabId) {
          const nextActiveId = next[0]?.id ?? null;
          setActiveTabId(nextActiveId);
          // 主进程摘除活动标签后 rect 归属为空：显式激活下一个，避免页面白屏。
          if (nextActiveId) void window.electronAPI.tab.activate(nextActiveId).catch(() => {});
        }
        return next;
      });
    });
    const u4 = window.electronAPI.on('tab:adopted', (payload) => {
      // 整窗快照优先：以主进程的权威列表重建，而不是靠单条 url 猜状态。
      if (Array.isArray(payload.snapshot) && payload.snapshot.length > 0) {
        applyTabSnapshot(payload.snapshot);
        return;
      }
      // 没有快照（异常/旧路径）：直接问主进程要权威列表。
      // 绝不退回"用 url 猜"——猜出 about:newtab 会被写进会话快照，
      // 于是刷新也还是新标签页，等于把错误固化下来。
      void (async () => {
        try {
          const snapshot = await window.electronAPI.tab.list();
          if (snapshot.length > 0) {
            applyTabSnapshot(snapshot);
            return;
          }
        } catch { /* window gone */ }
        if (!payload.url) return;
        const tab = createInitialTabState(payload.tabId, payload.url, settingsRef.current, {
          newTab: LLRef.current.tab.newTab(),
          userscripts: LLRef.current.tab.userscripts(),
          automation: LLRef.current.tab.automation(),
        });
        setTabs((prev) => [...prev.filter((item) => item.id !== tab.id), tab]);
        setActiveTabId(tab.id);
        // 迁入的视图在主进程里初始为隐藏：激活后才会按容器 rect 显示。
        void window.electronAPI.tab.activate(tab.id).catch(() => {});
      })();
    });
    const u2 = window.electronAPI.on('tab:crashed', (payload) => {
      updateTabRef.current(payload.tabId, { crashed: true, isLoading: false, isAudible: false, canGoBack: false, canGoForward: false, title: LLRef.current.error.pageCrashed() });
      pushToast({ key: `tab-crashed:${payload.tabId}`, message: LLRef.current.error.pageCrashed(), type: 'error' });
    });
    return () => { try { u1(); u2(); u3(); u4(); } catch { /* ignore */ } };
  }, [pushToast, applyTabSnapshot]);

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
        // 多窗口 P5：先拿窗口上下文，再决定快照 key；旧全局 key 只由 primary 窗口认领。
        let windowContext: { windowKey: string; isPrimary: boolean; initialUrl?: string; adopting?: boolean } | null = null;
        try {
          windowContext = await window.electronAPI.win.getContext();
        } catch { /* 拿不到上下文时退回旧全局 key */ }
        if (windowContext?.adopting) {
          // tear-off 新窗口：标签即将由 tab:adopted 迁入，不建默认标签、不弹恢复。
          adoptingRef.current = true;
          sessionKeyRef.current = windowContext.windowKey ? tabSessionKey(windowContext.windowKey) : TAB_SESSION_META_KEY;
          setSessionReady(true);
          // 兜底对账：adopted 若在监听就绪前发出（或整个丢了），窗口会一直是空壳。
          // 主进程是权威源，隔两拍主动拉一次就能自愈。
          void (async () => {
            for (const delay of [600, 1600]) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              try {
                const snapshot = await window.electronAPI.tab.list();
                if (snapshot.length > 0) {
                  applyTabSnapshot(snapshot);
                  return;
                }
              } catch { /* window gone */ }
            }
          })();
          return;
        }
        const sessionKey = windowContext?.windowKey ? tabSessionKey(windowContext.windowKey) : TAB_SESSION_META_KEY;
        sessionKeyRef.current = sessionKey;
        if (windowContext?.windowKey) {
          try {
            const [legacySnapshot, ownSnapshot] = await Promise.all([
              loadMeta(TAB_SESSION_META_KEY),
              loadMeta(sessionKey),
            ]);
            const plan = planLegacySessionMigration({
              windowKey: windowContext.windowKey,
              isPrimary: windowContext.isPrimary === true,
              hasShardedSession: Boolean(ownSnapshot),
              legacyExists: Boolean(legacySnapshot),
            });
            if (plan && legacySnapshot) {
              await saveMeta(plan.toKey, legacySnapshot);
              await db.meta.delete(plan.fromKey).catch(() => {});
            }
          } catch (error) {
            console.warn('[Tabs] legacy session migration failed:', error);
          }
        }

        const [rawSession, storedSettings, recoveryStatus] = await Promise.all([
          loadMeta(sessionKey),
          db.settingsSingleton.get('default'),
          window.electronAPI.session.recoveryStatus(),
        ]);
        const restoreEnabled = storedSettings?.restoreSession !== false;
        const restoredRuffleSource = storedSettings?.ruffleSource || useDataStore.getState().settings.ruffleSource;
        const snapshot = selectCrashRecoverySession(rawSession, recoveryStatus.abnormalExit, restoreEnabled);
        if (!snapshot) {
          await db.meta.delete(sessionKeyRef.current).catch(() => {});
          await window.electronAPI.session.resolveRecovery().catch(() => {});
          createTab(windowContext?.initialUrl);
          setSessionReady(true);
          return;
        }

        // Show a usable new tab while the old crash snapshot remains untouched.
        // Snapshot persistence stays paused until the user makes a choice.
        createTab(windowContext?.initialUrl);
        let choiceHandled = false;

        const ignoreRecovery = async () => {
          if (choiceHandled) return;
          choiceHandled = true;
          await db.meta.delete(sessionKeyRef.current).catch(() => {});
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
            await db.meta.delete(sessionKeyRef.current).catch(() => {});
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
        await db.meta.delete(sessionKeyRef.current).catch(() => {});
        await window.electronAPI.session.resolveRecovery().catch(() => {});
        if (tabsRef.current.length === 0 && !adoptingRef.current) createTab();
        setSessionReady(true);
      }
    })();
  }, [createTab, pushToast, setActiveTabId, setTabs, applyTabSnapshot]);

  // Keep a bounded, validated snapshot. Transient loading/navigation flags are
  // normalized by createTabSession and never trusted when restoring.
  const sessionSignature = createTabSessionSignature(tabs, activeTabId);
  useEffect(() => {
    if (!sessionReady) return;
    const timer = setTimeout(() => {
      const sessionKey = sessionKeyRef.current;
      if (!settings.restoreSession) {
        void db.meta.delete(sessionKey);
        return;
      }
      const latest = useTabsStore.getState();
      const snapshot = createTabSession(latest.tabs, latest.activeTabId);
      if (snapshot) void saveMeta(sessionKey, snapshot);
      else void db.meta.delete(sessionKey);
    }, 1000);
    return () => clearTimeout(timer);
  }, [sessionReady, sessionSignature, settings.restoreSession]);

  useEffect(() => {
    if (sessionReady && tabs.length === 0 && !adoptingRef.current) createTab();
  }, [sessionReady, tabs.length, createTab]);

  // Sync address bar when active tab changes
  useEffect(() => {
    if (activeTab) {
      setAddressUrl(isNewtabUrl(activeTab.url) ? '' : activeTab.url);
    }
  }, [activeTabId, activeTab]);

  // Re-assert page focus once loading finishes. The BrowserView loses keyboard
  // focus while the new document commits (measured: isFocused() false ~200ms
  // after the navigation), which would otherwise leave a Flash plugin
  // unreachable until the user clicks it. Skipped while the shell holds the
  // caret so this can never interrupt address-bar typing.
  const activeLoading = activeTab?.isLoading ?? false;
  useEffect(() => {
    if (!activeTabId || activeLoading) return;
    const el = document.activeElement as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
    void window.electronAPI.tab.focusActive().catch(() => {});
  }, [activeTabId, activeLoading]);

  // --- Navigation ---
  const handleNavigate = useCallback((input: string) => {
    const url = normalizeUrl(input, settings.searchEngine);
    if (!activeTabId) { createTab(url); return; }
    updateTab(activeTabId, { url, title: url, crashed: false, isLoading: true });
    setAddressUrl(url);
    if (activeTabId) {
      window.electronAPI.tab.stop(activeTabId);
      window.electronAPI.tab.navigate(activeTabId, url);
      // Navigation is committed: hand keyboard focus to the page. At the moment
      // of commit, not on did-stop-loading — the latter would yank focus back
      // mid-typing if the user starts editing the address bar while loading.
      void window.electronAPI.tab.focusActive().catch(() => {});
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
