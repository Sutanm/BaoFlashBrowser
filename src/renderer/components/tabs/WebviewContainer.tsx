import React, { useRef, useEffect, useCallback } from 'react';
import type { TabState } from '@renderer/atoms/tabs.atom';

interface WebviewContainerProps {
  tabs: TabState[];
  activeTabId: string | null;
  onTabUpdate: (tabId: string, changes: Partial<TabState>) => void;
}

const WebviewContainer: React.FC<WebviewContainerProps> = ({ tabs, activeTabId, onTabUpdate }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const webviewRefs = useRef<Map<string, HTMLElement>>(new Map());

  const createWebview = useCallback(
    (tab: TabState) => {
      const el = document.createElement('webview') as HTMLElement & {
        src: string;
        loadURL: (url: string) => void;
        reload: () => void;
        goBack: () => void;
        goForward: () => void;
        stop: () => void;
        canGoBack: () => boolean;
        canGoForward: () => boolean;
        setZoomLevel: (level: number) => void;
        setAudioMuted: (muted: boolean) => void;
        isCurrentlyAudible: () => () => void;
        openDevTools: () => void;
        getURL: () => string;
        getTitle: () => string;
      };

      el.setAttribute('src', tab.url || 'about:blank');
      el.setAttribute('preload', '../../dist/webview-preload.js');
      el.setAttribute('plugins', 'true');
      el.setAttribute('allowpopups', 'true');
      el.style.cssText = `
        position: absolute; top: 0; left: 0;
        width: 100%; height: 100%;
        border: none;
        display: ${tab.id === activeTabId ? 'block' : 'none'};
      `;

      // Navigation events
      el.addEventListener('did-start-loading', () => {
        onTabUpdate(tab.id, { isLoading: true });
      });

      el.addEventListener('did-stop-loading', () => {
        onTabUpdate(tab.id, { isLoading: false });
      });

      el.addEventListener('page-title-updated', (e: any) => {
        onTabUpdate(tab.id, { title: e.title });
      });

      el.addEventListener('page-favicon-updated', (e: any) => {
        if (e.favicons && e.favicons.length > 0) {
          onTabUpdate(tab.id, { favicon: e.favicons[0] });
        }
      });

      el.addEventListener('did-navigate', (e: any) => {
        onTabUpdate(tab.id, { url: e.url });
      });

      el.addEventListener('did-navigate-in-page', (e: any) => {
        if (e.isMainFrame) {
          onTabUpdate(tab.id, { url: e.url });
        }
      });

      // Audio detection
      el.addEventListener('-media-started-playing', () => {
        onTabUpdate(tab.id, { isAudible: true });
      });

      el.addEventListener('-media-paused', () => {
        onTabUpdate(tab.id, { isAudible: false });
      });

      // Error handling
      (el as any).addEventListener('did-fail-load', (e: any) => {
        if (e.errorCode === -3) return; // aborted (user navigation)
        const errorHtml = `
          <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff;color:#333">
          <div style="text-align:center">
          <h1 style="font-weight:300;font-size:2rem">${e.errorCode === -105 ? 'DNS not found' : 'Page failed to load'}</h1>
          <p style="color:#888;margin:8px 0">${e.validatedURL || e.url}</p>
          <p style="color:#aaa;font-size:0.85rem">Error code: ${e.errorCode} — ${e.errorDescription}</p>
          </div></body></html>`;
        el.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml));
      });

      return el;
    },
    [activeTabId, onTabUpdate],
  );

  // Sync webviews with tabs array
  useEffect(() => {
    if (!containerRef.current) return;

    const existingIds = new Set(webviewRefs.current.keys());
    const currentIds = new Set(tabs.map((t) => t.id));

    // Remove webviews for closed tabs
    for (const id of existingIds) {
      if (!currentIds.has(id)) {
        const el = webviewRefs.current.get(id);
        if (el) {
          el.remove();
          webviewRefs.current.delete(id);
        }
      }
    }

    // Create webviews for new tabs
    for (const tab of tabs) {
      if (!webviewRefs.current.has(tab.id)) {
        const el = createWebview(tab);
        containerRef.current.appendChild(el);
        webviewRefs.current.set(tab.id, el);
      }
    }

    // Update visibility based on active tab
    for (const [id, el] of webviewRefs.current) {
      el.style.display = id === activeTabId ? 'block' : 'none';
    }
  }, [tabs, activeTabId, createWebview]);

  return (
    <div
      ref={containerRef}
      id="webview-container"
      className="flex-1 relative bg-white dark:bg-gray-900"
    />
  );
};

export default WebviewContainer;
