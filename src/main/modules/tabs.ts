import { BrowserView, BrowserWindow } from 'electron';
import path from 'path';

interface TabInfo {
  id: string;
  browserView: BrowserView;
}

class TabManager {
  private tabs = new Map<string, TabInfo>();
  private activeId: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private containerRect = { x: 0, y: 0, width: 0, height: 0 };

  setWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  setContainerBounds(x: number, y: number, width: number, height: number): void {
    this.containerRect = { x, y, width, height };
    // Resize active view
    if (this.activeId) {
      const tab = this.tabs.get(this.activeId);
      if (tab) tab.browserView.setBounds({ x, y, width, height });
    }
  }

  create(tabId: string, url: string, preloadPath: string): void {
    const preload = path.resolve(preloadPath);
    const view = new BrowserView({
      webPreferences: {
        preload,
        plugins: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'persist:tab_' + tabId,
      },
    });

    this.mainWindow?.addBrowserView(view);
    view.setBounds(this.containerRect);
    view.setAutoResize({ width: false, height: false });

    // Set up event forwarding
    const wc = view.webContents;

    wc.on('page-title-updated', (_e, title) => {
      this.send('tab:updated', { tabId, title });
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons && favicons.length > 0) {
        this.send('tab:updated', { tabId, favicon: favicons[0] });
      }
    });

    wc.on('did-start-loading', () => {
      this.send('tab:updated', { tabId, isLoading: true });
    });

    wc.on('did-stop-loading', () => {
      this.send('tab:updated', { tabId, isLoading: false });
    });

    wc.on('did-navigate', (_e, navUrl) => {
      if (navUrl === 'about:blank') return;
      this.send('tab:updated', { tabId, url: navUrl });
    });

    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame && navUrl !== 'about:blank') {
        this.send('tab:updated', { tabId, url: navUrl });
      }
    });

    wc.on('-media-started-playing', () => {
      this.send('tab:updated', { tabId, isAudible: true });
    });

    wc.on('-media-paused', () => {
      this.send('tab:updated', { tabId, isAudible: false });
    });

    wc.on('did-fail-load', (_e, errorCode, _desc, validatedURL) => {
      if (errorCode === -3) return;
      const errorHtml = `<html><body style="font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff;color:#333"><div style="text-align:center"><h1 style="font-weight:300">${errorCode === -105 ? 'DNS not found' : 'Page failed to load'}</h1><p style="opacity:0.6">${validatedURL}</p><p style="opacity:0.4;font-size:0.85rem">Error: ${errorCode}</p></div></body></html>`;
      wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml));
    });

    this.tabs.set(tabId, { id: tabId, browserView: view });

    if (url && url !== 'about:newtab') {
      wc.loadURL(url);
    }
  }

  activate(tabId: string): void {
    if (tabId === this.activeId) return;
    // Hide old
    if (this.activeId) {
      const old = this.tabs.get(this.activeId);
      if (old) old.browserView.setBounds({ x: -9999, y: -9999, width: 1, height: 1 });
    }
    // Show new
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.browserView.setBounds(this.containerRect);
    }
    this.activeId = tabId;
  }

  close(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.mainWindow?.removeBrowserView(tab.browserView);
    (tab.browserView.webContents as any).destroy();
    this.tabs.delete(tabId);
    if (this.activeId === tabId) {
      this.activeId = null;
    }
  }

  navigate(tabId: string, url: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) {
      try { tab.browserView.webContents.stop(); } catch {}
      tab.browserView.webContents.loadURL(url);
    }
  }

  reload(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.reload();
  }

  goBack(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab && tab.browserView.webContents.canGoBack()) {
      tab.browserView.webContents.goBack();
    }
  }

  goForward(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab && tab.browserView.webContents.canGoForward()) {
      tab.browserView.webContents.goForward();
    }
  }

  stop(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.stop();
  }

  setZoom(tabId: string, factor: number): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.setZoomFactor(factor);
  }

  setMuted(tabId: string, muted: boolean): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.setAudioMuted(muted);
  }

  openDevTools(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.openDevTools({ mode: 'bottom' });
  }

  findInPage(tabId: string, text: string, options?: Record<string, unknown>): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.findInPage(text, options);
  }

  stopFindInPage(tabId: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.stopFindInPage(action);
  }

  private send(channel: string, payload: Record<string, unknown>): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload);
    }
  }
}

export const tabManager = new TabManager();
