import { BrowserView, BrowserWindow, Menu } from 'electron';
import { patchedSWFObject } from './session';

interface TabEntry {
  id: string;
  browserView: BrowserView;
}

interface ContainerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

class TabManager {
  private tabs = new Map<string, TabEntry>();
  private activeId: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private rect: ContainerRect = { x: 0, y: 0, width: 0, height: 0 };
  private preloadPath = '';
  private sessionSetup = false;

  get window(): BrowserWindow | null { return this.mainWindow; }

  setWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  setPreload(path: string): void {
    this.preloadPath = path;
  }

  setBounds(x: number, y: number, width: number, height: number): void {
    this.rect = { x, y, width, height };
    if (this.activeId) {
      const tab = this.tabs.get(this.activeId);
      if (tab) tab.browserView.setBounds({ x, y, width, height });
    }
  }

  create(tabId: string, url: string): void {
    const view = new BrowserView({
      webPreferences: {
        preload: this.preloadPath,
        plugins: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'persist:',
      },
    });
    this.mainWindow?.addBrowserView(view);
    view.setBounds(this.rect.width > 0 ? this.rect : { x: -9999, y: -9999, width: 1, height: 1 });
    view.setAutoResize({ width: false, height: false });

    const wc = view.webContents;

    // Setup session handlers once (first BrowserView)
    if (!this.sessionSetup) {
      this.sessionSetup = true;
      const sess = wc.session;
      sess.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36',
      );
      // Taomee SWFObject bypass
      sess.webRequest.onBeforeRequest(
        { urls: ['*://webres.61.com/common/js/swfobject.js*'] },
        (_details: any, cb: any) => {
          cb({ redirectURL: 'data:text/javascript;charset=utf-8,' + encodeURIComponent(patchedSWFObject()) });
        },
      );
    }

    wc.on('page-title-updated', (_e, title) => this.send('tab:updated', { tabId, title }));
    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons && favicons.length > 0) this.send('tab:updated', { tabId, favicon: favicons[0] });
    });
    wc.on('did-start-loading', () => this.send('tab:updated', { tabId, isLoading: true }));
    wc.on('did-stop-loading', () => this.send('tab:updated', { tabId, isLoading: false }));
    wc.on('did-navigate', (_e, navUrl) => {
      if (navUrl === 'about:blank') return;
      this.send('tab:updated', { tabId, url: navUrl });
    });
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame && navUrl !== 'about:blank') this.send('tab:updated', { tabId, url: navUrl });
    });
    wc.on('-media-started-playing', () => this.send('tab:updated', { tabId, isAudible: true }));
    wc.on('-media-paused', () => this.send('tab:updated', { tabId, isAudible: false }));

    const updateNav = () => {
      try {
        this.send('tab:updated', { tabId, canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() });
      } catch {}
    };
    wc.on('did-navigate', updateNav);
    wc.on('did-navigate-in-page', updateNav);
    wc.on('did-stop-loading', updateNav);

    wc.on('found-in-page', (_e, result) => {
      this.send('tab:found', { tabId, activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches });
    });

    wc.on('did-fail-load', (_e, errorCode, _desc, validatedURL) => {
      if (errorCode === -3) return;
      const errorHtml = `<html><body style="font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff;color:#333"><div style="text-align:center"><h1 style="font-weight:300">${errorCode === -105 ? 'DNS not found' : 'Page failed to load'}</h1><p style="opacity:0.6">${validatedURL}</p><p style="opacity:0.4;font-size:0.85rem">Error: ${errorCode}</p></div></body></html>`;
      wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml));
    });

    wc.on('render-process-gone', () => {
      this.send('tab:crashed', { tabId });
    });

    wc.on('new-window', (e, url) => {
      e.preventDefault();
      this.send('tab:newwindow', { url });
    });

    wc.on('context-menu', (_e, params) => {
      const template: Electron.MenuItemConstructorOptions[] = [
        { label: '↩ 后退', enabled: wc.canGoBack(), click: () => wc.goBack() },
        { label: '↪ 前进', enabled: wc.canGoForward(), click: () => wc.goForward() },
        { label: '⟳ 刷新', click: () => wc.reload() },
        { type: 'separator' },
        { label: '复制', enabled: params.selectionText.length > 0, role: 'copy' },
        { label: '粘贴', role: 'paste' },
      ];
      if (params.linkURL) {
        template.push(
          { type: 'separator' },
          { label: '在新标签页打开链接', click: () => this.send('tab:newwindow', { url: params.linkURL }) },
        );
      }
      template.push(
        { type: 'separator' },
        { label: '检查元素', click: () => wc.openDevTools({ mode: 'detach' }) },
      );
      Menu.buildFromTemplate(template).popup({ window: this.mainWindow! });
    });

    this.tabs.set(tabId, { id: tabId, browserView: view });

    if (url && url !== 'about:newtab' && url !== 'about:blank') {
      wc.loadURL(url);
    }
  }

  activate(tabId: string): void {
    if (tabId === this.activeId) return;
    if (this.activeId) {
      const old = this.tabs.get(this.activeId);
      if (old) old.browserView.setBounds({ x: -9999, y: -9999, width: 1, height: 1 });
    }
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.setBounds(this.rect);
    this.activeId = tabId;
  }

  close(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.mainWindow?.removeBrowserView(tab.browserView);
    try { (tab.browserView.webContents as any).destroy(); } catch {}
    this.tabs.delete(tabId);
    if (this.activeId === tabId) this.activeId = null;
  }

  navigate(tabId: string, url: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.loadURL(url);
  }

  goBack(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab && tab.browserView.webContents.canGoBack()) tab.browserView.webContents.goBack();
  }

  goForward(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab && tab.browserView.webContents.canGoForward()) tab.browserView.webContents.goForward();
  }

  reload(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.reload();
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
    if (tab) tab.browserView.webContents.openDevTools({ mode: 'detach' });
  }

  findInPage(tabId: string, text: string, options?: any): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.findInPage(text, options);
  }

  stopFindInPage(tabId: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.stopFindInPage(action);
  }

  setGuestPreload(tabId: string, preloadPath: string): void {
    // Not implemented for now
  }

  private send(channel: string, payload: Record<string, unknown>): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload);
    }
  }
}

export const tabManager = new TabManager();
