import React, { useRef, useEffect, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import type { TabState } from '@renderer/atoms/tabs.atom';
import { contextMenuAtom } from '@renderer/atoms/ui.atom';
import { historyAtom } from '@renderer/atoms/data.atom';
import { generateId } from '@renderer/services/id.service';

interface WebviewContainerProps {
  tabs: TabState[];
  activeTabId: string | null;
  onTabUpdate: (tabId: string, changes: Partial<TabState>) => void;
}

const WebviewContainer: React.FC<WebviewContainerProps> = ({ tabs, activeTabId, onTabUpdate }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const webviewRefs = useRef<Map<string, HTMLElement>>(new Map());
  const setContextMenu = useSetAtom(contextMenuAtom);
  const setHistory = useSetAtom(historyAtom);

  const createWebview = useCallback(
    (tab: TabState) => {
      const el = document.createElement('webview') as HTMLElement & {
        src: string;
        loadURL: (url: string) => void;
        reload: () => void;
        goBack: () => void;
        goForward: () => void;
        stop: () => void;
        setZoomFactor: (level: number) => void;
        setAudioMuted: (muted: boolean) => void;
        openDevTools: () => void;
      };

      el.setAttribute('src', tab.url || 'about:blank');
      el.setAttribute('preload', (window as any).electronAPI?.webviewPreloadPath || '../../dist/webview-preload.js');
      el.setAttribute('plugins', 'true');
      el.setAttribute('allowpopups', 'true');
      el.setAttribute('data-tab-id', tab.id);

      // Apply stored zoom factor when webview is ready
      el.addEventListener('dom-ready', () => {
        const current = tabs.find((t) => t.id === tab.id);
        const zoom = current?.zoomFactor ?? 1;
        if (zoom !== 1) {
          try { el.setZoomFactor(zoom); } catch (_e) {}
        }
      });

      el.addEventListener('did-start-loading', () => {
        onTabUpdate(tab.id, { isLoading: true });
      });

      el.addEventListener('did-stop-loading', () => {
        onTabUpdate(tab.id, { isLoading: false });
        // Apply stored zoom factor on every page load
        const current = tabs.find((t) => t.id === tab.id);
        const zoom = current?.zoomFactor ?? 1;
        if (zoom !== 1) {
          try { el.setZoomFactor(zoom); } catch (_e) {}
        }
        try {
          onTabUpdate(tab.id, { canGoBack: el.canGoBack(), canGoForward: el.canGoForward() });
        } catch (_e) { /* webview may not be ready */ }
      });

      el.addEventListener('page-title-updated', (e: any) => {
        onTabUpdate(tab.id, { title: e.title });
        const pageUrl = el.src;
        if (e.title && pageUrl && !pageUrl.startsWith('about:') && !pageUrl.startsWith('data:')) {
          setHistory((prev) => {
            const updated = prev.map((h) => h.url === pageUrl ? { ...h, title: e.title } : h);
            try { localStorage.setItem('baoflash_history', JSON.stringify(updated)); } catch {}
            return updated;
          });
        }
      });

      el.addEventListener('page-favicon-updated', (e: any) => {
        if (e.favicons && e.favicons.length > 0) {
          onTabUpdate(tab.id, { favicon: e.favicons[0] });
          const favicon = e.favicons[0];
          const pageUrl = el.src;
          if (pageUrl && !pageUrl.startsWith('about:') && !pageUrl.startsWith('data:')) {
            setHistory((prev) => {
              const updated = prev.map((h) => h.url === pageUrl ? { ...h, favicon } : h);
              try { localStorage.setItem('baoflash_history', JSON.stringify(updated)); } catch {}
              return updated;
            });
          }
        }
      });

      el.addEventListener('did-navigate', (e: any) => {
        if (e.url === 'about:blank') return;
        onTabUpdate(tab.id, { url: e.url });
        try {
          onTabUpdate(tab.id, { canGoBack: el.canGoBack(), canGoForward: el.canGoForward() });
        } catch (_e) {}
        // Record history
        if (e.url && !e.url.startsWith('about:') && !e.url.startsWith('data:')) {
          setHistory((prev) => {
            const existing = prev.find((h) => h.url === e.url);
            const next = existing
              ? prev.map((h) => h.url === e.url ? { ...h, lastVisit: Date.now(), visitCount: h.visitCount + 1 } : h)
              : [{ id: generateId(), url: e.url, title: e.title || e.url, favicon: '', visitCount: 1, lastVisit: Date.now() }, ...prev];
            try { localStorage.setItem('baoflash_history', JSON.stringify(next)); } catch {}
            return next;
          });
        }
      });

      el.addEventListener('did-navigate-in-page', (e: any) => {
        if (e.isMainFrame && e.url !== 'about:blank') {
          onTabUpdate(tab.id, { url: e.url });
          try {
            onTabUpdate(tab.id, { canGoBack: el.canGoBack(), canGoForward: el.canGoForward() });
          } catch (_e) {}
        }
      });

      el.addEventListener('context-menu', (e: any) => {
        e.preventDefault();
        const p = e.params || {};
        setContextMenu({
          visible: true,
          x: p.x,
          y: p.y,
          tabId: tab.id,
          linkURL: p.linkURL,
          selectionText: p.selectionText,
          isEditable: p.isEditable,
        });
      });

      el.addEventListener('-media-started-playing', () => {
        onTabUpdate(tab.id, { isAudible: true });
      });

      el.addEventListener('-media-paused', () => {
        onTabUpdate(tab.id, { isAudible: false });
      });

      (el as any).addEventListener('did-fail-load', (e: any) => {
        if (e.errorCode === -3) return;
        const errorHtml = `<html><body style="font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff;color:#333"><div style="text-align:center"><h1 style="font-weight:300">${e.errorCode === -105 ? 'DNS not found' : 'Page failed to load'}</h1><p style="opacity:0.6">${e.validatedURL || e.url}</p><p style="opacity:0.4;font-size:0.85rem">Error: ${e.errorCode} — ${e.errorDescription}</p></div></body></html>`;
        el.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml));
      });

      return el;
    },
    [onTabUpdate, setContextMenu, setHistory],
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const existingIds = new Set(webviewRefs.current.keys());
    const currentIds = new Set(tabs.map((t) => t.id));

    for (const id of existingIds) {
      if (!currentIds.has(id)) {
        const el = webviewRefs.current.get(id);
        if (el) {
          el.remove();
          webviewRefs.current.delete(id);
        }
      }
    }

    for (const tab of tabs) {
      if (tab.url === 'about:newtab') continue;
      if (!webviewRefs.current.has(tab.id)) {
        const el = createWebview(tab);
        if (tab.id === activeTabId) el.classList.add('active');
        containerRef.current.appendChild(el);
        webviewRefs.current.set(tab.id, el);
      }
    }
  }, [tabs, createWebview]);

  useEffect(() => {
    for (const [id, el] of webviewRefs.current) {
      if (id === activeTabId) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    }
  }, [activeTabId]);

  return React.createElement('div', {
    ref: containerRef as any,
    id: 'webview-container',
  });
};

export default WebviewContainer;
