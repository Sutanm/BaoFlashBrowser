import { useCallback, useState, useEffect, useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { tabsAtom, activeTabIdAtom } from '../atoms/tabs.atom';
import { historyAtom, pushToastAtom, settingsAtom } from '../atoms/data.atom';
import { normalizeUrl, generateId } from '../services/id.service';
import type { TabState } from '../atoms/tabs.atom';
import type { HistoryEntry } from '@shared/types/history';

const NEWTAB_URL = 'about:newtab';

function isNewtabUrl(url: string): boolean {
  return !url || url === 'about:blank' || url === NEWTAB_URL || url.startsWith('data:');
}

export interface UseTabManagerReturn {
  tabs: TabState[];
  activeTabId: string | null;
  activeTab: TabState | null;
  addressUrl: string;
  setAddressUrl: React.Dispatch<React.SetStateAction<string>>;
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
  const settings = useAtomValue(settingsAtom);
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom);
  const [addressUrl, setAddressUrl] = useState('');
  const setHistory = useSetAtom(historyAtom);
  const pushToast = useSetAtom(pushToastAtom);
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; });

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // --- Tab switching with debounced bounds calc ---
  const switchTabTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const switchTab = useCallback((tabId: string) => {
    if (switchTabTimerRef.current) clearTimeout(switchTabTimerRef.current);
    setActiveTabId(tabId);
    switchTabTimerRef.current = setTimeout(() => {
      calcBoundsRef.current(false);
      window.electronAPI.tab.activate(tabId);
    }, 50);
  }, [setActiveTabId, calcBoundsRef]);

  const createTab = useCallback((url?: string) => {
    const id = generateId();
    const ruffleMode: 'ppapi' | 'ruffle' = settings.flashEngineMode === 'prefer-ruffle' ? 'ruffle' : 'ppapi';
    const tab: TabState = {
      id, url: url || NEWTAB_URL, title: '新标签页',
      zoomFactor: 1, isLoading: false, isAudible: false, isMuted: false,
      canGoBack: false, canGoForward: false, createdAt: Date.now(),
      ruffleMode,
    };
    setTabs((prev) => [...prev, tab]);
    const useRuffle = ruffleMode === 'ruffle';
    window.electronAPI.tab.create(id, url || NEWTAB_URL, {
      enabled: useRuffle,
      source: settings.ruffleSource,
    } as any);
    switchTab(id);
  }, [setTabs, switchTab, settings.flashEngineMode, settings.ruffleSource]);

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
          window.electronAPI.tab.activate(next[newIdx].id);
        } else {
          setActiveTabId(null);
        }
      }
      return next;
    });
  }, [activeTabId, setActiveTabId, setTabs]);

  const commitHistory = useCallback(() => {
    const pending = pendingHistoryRef.current;
    pendingHistoryRef.current = null;
    if (!pending) return;
    const currentTab = tabsRef.current.find((t) => t.id === pending.tabId);
    const entry: HistoryEntry = {
      id: generateId(),
      url: pending.url,
      title: pending.title || (() => { try { return new URL(pending.url).hostname; } catch { return pending.url; } })(),
      favicon: currentTab?.favicon || '',
      lastVisit: Date.now(),
      visitCount: 1,
    };
    setHistory((prev) => {
      const existing = prev.find((h) => h.url === entry.url);
      if (existing) {
        return prev.map((h) => h.url === entry.url
          ? { ...h, lastVisit: Date.now(), visitCount: h.visitCount + 1, title: entry.title || h.title, favicon: entry.favicon || h.favicon }
          : h
        );
      }
      return [entry, ...prev];
    });
  }, [setHistory]);

  const updateTab = useCallback((tabId: string, changes: Partial<TabState>) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...changes } : t)));
    if (tabId === activeTabId && changes.url !== undefined) {
      const url = changes.url;
      setAddressUrl(isNewtabUrl(url) ? '' : url);
    }
    // 历史记录：URL 变化时 debounce 1500ms，重定向只保留最终 URL
    if (changes.url !== undefined && !isNewtabUrl(changes.url) && changes.url !== 'about:blank') {
      pendingHistoryRef.current = { tabId, url: changes.url, title: changes.title };
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
      const tabUrl = tabsRef.current.find((t) => t.id === tabId)?.url;
      if (tabUrl) {
        setHistory((prev) => {
          const idx = prev.findIndex((h) => h.url === tabUrl);
          if (idx >= 0 && !prev[idx].favicon) {
            return prev.map((h) => h.url === tabUrl ? { ...h, favicon: changes.favicon! } : h);
          }
          return prev;
        });
      }
    }
    // Update title in history
    if (changes.title && changes.title !== changes.url) {
      const tabUrl = tabsRef.current.find((t) => t.id === tabId)?.url;
      if (tabUrl && !isNewtabUrl(tabUrl)) {
        setHistory((prev) => {
          const idx = prev.findIndex((h) => h.url === tabUrl);
          if (idx >= 0) {
            return prev.map((h) => h.url === tabUrl ? { ...h, title: changes.title! } : h);
          }
          return prev;
        });
      }
    }
  }, [setTabs, activeTabId, setHistory, commitHistory]);

  const updateTabRef = useRef(updateTab);
  useEffect(() => { updateTabRef.current = updateTab; });

  // IPC listeners
  useEffect(() => {
    const unsub = window.electronAPI.on('tab:updated', (payload: any) => {
      const { tabId, ...changes } = payload;
      updateTabRef.current(tabId, changes as Partial<TabState>);
    });
    const unsubErr = window.electronAPI.on('tab:load-error', (payload: any) => {
      const msg = payload.errorCode === -105 ? 'DNS 解析失败' : '页面加载失败';
      pushToast({ message: `${msg} (-${payload.errorCode})`, type: 'error' });
    });
    return () => { try { unsub(); unsubErr(); } catch (e) { console.warn('[App] tab event cleanup failed:', e); } };
  }, [pushToast]);

  useEffect(() => {
    const u1 = window.electronAPI.on('tab:newwindow', (payload: any) => {
      createTab(String((payload as any).url || payload));
    });
    const u2 = window.electronAPI.on('tab:crashed', (payload: any) => {
      updateTabRef.current(payload.tabId, { url: 'about:crash', title: '页面崩溃了' });
      pushToast({ message: '页面崩溃了', type: 'error' });
    });
    return () => { try { u1(); u2(); } catch {} };
  }, [createTab, pushToast]);

  // External URL open
  useEffect(() => {
    let pendingUrl: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsub = window.electronAPI.on('navigate-url', (url: any) => {
      const delay = activeTab?.isLoading ? 600 : 0;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        createTab(String(url));
        timer = null;
      }, delay);
    });

    return () => {
      try { unsub(); } catch (_) {}
      if (timer) clearTimeout(timer);
    };
  }, [createTab, activeTab]);

  // Initial tab
  useEffect(() => {
    if (tabs.length === 0 || activeTabId === null) {
      if (tabs.length === 0) {
        createTab();
      } else {
        setActiveTabId(tabs[0].id);
      }
    }
  }, [tabs.length, activeTabId, createTab, setActiveTabId, tabs]);

  // Sync address bar when active tab changes
  useEffect(() => {
    if (activeTab) {
      setAddressUrl(isNewtabUrl(activeTab.url) ? '' : activeTab.url);
    }
  }, [activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Navigation ---
  const handleNavigate = useCallback((input: string) => {
    const url = normalizeUrl(input, settings.searchEngine);
    if (!activeTabId) { createTab(url); return; }
    updateTab(activeTabId, { url, title: url });
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

  const zoomIn = useCallback(() => doZoom(0.25), [doZoom]);
  const zoomOut = useCallback(() => doZoom(-0.25), [doZoom]);
  const zoomReset = useCallback(() => {
    if (!activeTab) return;
    if (activeTabId) window.electronAPI.tab.zoom(activeTabId, 1);
    updateTab(activeTab.id, { zoomFactor: 1 });
  }, [activeTab, updateTab, activeTabId]);

  // Ctrl+wheel zoom (chrome UI area)
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      doZoom(e.deltaY < 0 ? 0.25 : -0.25);
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, [doZoom]);

  // Ctrl+1..9 tab switching
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const num = parseInt(e.key);
        if (num >= 1 && num <= Math.min(9, tabs.length)) {
          e.preventDefault();
          switchTab(tabs[num - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, switchTab]);

  return {
    tabs, activeTabId, activeTab,
    addressUrl, setAddressUrl,
    createTab, closeTab, switchTab, updateTab,
    handleNavigate,
    zoomIn, zoomOut, zoomReset,
  };
}
