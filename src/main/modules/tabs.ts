import { BrowserView, BrowserWindow, Menu, shell } from 'electron';
import log from 'electron-log';
import fs from 'fs';
import path from 'path';
import { patchedSWFObject } from './session';
import { setupDownloadHandlers } from './download';

interface TabEntry {
  id: string;
  browserView: BrowserView;
  isRuffle: boolean;
  ruffleSource?: 'bundled' | 'cdn';
  lastTargetUrl: string;
}

interface ContainerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

class TabManager {
  private tabs = new Map<string, TabEntry>();
  private wcToId = new Map<number, string>();
  private activeId: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private rect: ContainerRect = { x: 0, y: 0, width: 0, height: 0 };
  private preloadPath = '';
  private sessionSetup = false;

  getRuffleForWC(wcId: number): { enabled: boolean; source?: 'bundled' | 'cdn' } | null {
    const tabId = this.wcToId.get(wcId);
    if (!tabId) return null;
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    return { enabled: tab.isRuffle, source: tab.ruffleSource };
  }

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

  create(tabId: string, url: string, ruffleConfig?: { enabled: boolean; source: 'bundled' | 'cdn' }): void {
    if (!this.mainWindow) {
      log.warn('[TabManager] create: mainWindow not set, skipping tab ' + tabId);
      return;
    }
    const useRuffle = ruffleConfig?.enabled ?? false;
    const view = new BrowserView({
      webPreferences: {
        preload: this.preloadPath,
        plugins: !useRuffle,
        contextIsolation: !useRuffle,
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
      // Unified download handler (Chromium tracking or aria2)
      setupDownloadHandlers(sess);
    }

    wc.on('page-title-updated', (_e, title) => this.send('tab:updated', { tabId, title }));
    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons && favicons.length > 0) this.send('tab:updated', { tabId, favicon: favicons[0] });
    });
    wc.on('did-start-loading', () => this.send('tab:updated', { tabId, isLoading: true }));
    wc.on('did-stop-loading', () => {
      this.send('tab:updated', { tabId, isLoading: false });
      // Fallback: some pages (Flash etc) never fire page-title-updated / page-favicon-updated
      setTimeout(() => {
        try {
          wc.executeJavaScript('document.title').then((title) => {
            if (typeof title === 'string' && title && title !== 'about:blank') {
              this.send('tab:updated', { tabId, title });
            }
          }).catch(() => {});
          wc.executeJavaScript(
            `(function(){var e=document.querySelector('link[rel*="icon"]');return e?e.href:''})()`
          ).then((favicon) => {
            if (typeof favicon === 'string' && favicon) {
              this.send('tab:updated', { tabId, favicon });
            }
          }).catch(() => {});
        } catch {}
      }, 500);
    });
    wc.on('did-navigate', (_e, navUrl) => {
      if (navUrl === 'about:blank') return;
      if (navUrl.startsWith('data:')) return;
      this.send('tab:updated', { tabId, url: navUrl });
    });
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame && navUrl !== 'about:blank') this.send('tab:updated', { tabId, url: navUrl });
    });
    wc.on('media-started-playing', () => this.send('tab:updated', { tabId, isAudible: true }));
    wc.on('media-paused', () => this.send('tab:updated', { tabId, isAudible: false }));

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
      wc.stop();
      this.send('tab:load-error', { tabId, errorCode, validatedURL });
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
      const tabEntry = this.tabs.get(tabId);
      const isRuffle = tabEntry?.isRuffle ?? false;
      const sourceLabel = tabEntry?.ruffleSource === 'cdn' ? ' (CDN)' : '';
      template.push(
        { type: 'separator' },
        { label: isRuffle ? 'Flash 引擎: Ruffle (WASM 模拟)' + sourceLabel : 'Flash 引擎: PPAPI (原生)', enabled: false },
        { label: '检查元素', click: () => wc.openDevTools({ mode: 'detach' }) },
      );
      Menu.buildFromTemplate(template).popup({ window: this.mainWindow!, x: params.x, y: params.y });
    });

    this.tabs.set(tabId, {
      id: tabId,
      browserView: view,
      isRuffle: useRuffle,
      ruffleSource: useRuffle ? ruffleConfig?.source : undefined,
      lastTargetUrl: url || '',
    });
    this.wcToId.set(wc.id, tabId);

    if (url && url !== 'about:newtab' && url !== 'about:blank') {
      wc.loadURL(url);
    }
  }

  setRuffleMode(tabId: string, enabled: boolean, source: 'bundled' | 'cdn'): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const wasActive = this.activeId === tabId;
    const currentUrl = tab.browserView.webContents.getURL();

    // Remove old BrowserView
    this.wcToId.delete(tab.browserView.webContents.id);
    this.mainWindow?.removeBrowserView(tab.browserView);
    try { (tab.browserView.webContents as Electron.WebContents).destroy(); } catch {}

    // Create new BrowserView with correct plugin setting
    const view = new BrowserView({
      webPreferences: {
        preload: this.preloadPath,
        plugins: !enabled,
        contextIsolation: !enabled,
        nodeIntegration: false,
        partition: 'persist:',
      },
    });
    this.mainWindow?.addBrowserView(view);
    view.setBounds(this.rect.width > 0 ? this.rect : { x: -9999, y: -9999, width: 1, height: 1 });
    view.setAutoResize({ width: false, height: false });

    const wc = view.webContents;
    // Wire up same events as create()
    wc.on('page-title-updated', (_e, title) => this.send('tab:updated', { tabId, title }));
    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons && favicons.length > 0) this.send('tab:updated', { tabId, favicon: favicons[0] });
    });
    wc.on('did-start-loading', () => this.send('tab:updated', { tabId, isLoading: true }));
    wc.on('did-stop-loading', () => {
      this.send('tab:updated', { tabId, isLoading: false });
      setTimeout(() => {
        try {
          wc.executeJavaScript('document.title').then((title) => {
            if (typeof title === 'string' && title && title !== 'about:blank') this.send('tab:updated', { tabId, title });
          }).catch(() => {});
          wc.executeJavaScript(
            `(function(){var e=document.querySelector('link[rel*="icon"]');return e?e.href:''})()`
          ).then((favicon) => {
            if (typeof favicon === 'string' && favicon) this.send('tab:updated', { tabId, favicon });
          }).catch(() => {});
        } catch {}
      }, 500);
    });
    wc.on('did-navigate', (_e, navUrl) => {
      if (navUrl !== 'about:blank' && !navUrl.startsWith('data:')) this.send('tab:updated', { tabId, url: navUrl });
    });
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame && navUrl !== 'about:blank') this.send('tab:updated', { tabId, url: navUrl });
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
        { label: enabled ? ('Flash 引擎: Ruffle (WASM 模拟)' + (source === 'cdn' ? ' (CDN)' : '')) : 'Flash 引擎: PPAPI (原生)', enabled: false },
        { label: '检查元素', click: () => wc.openDevTools({ mode: 'detach' }) },
      );
      Menu.buildFromTemplate(template).popup({ window: this.mainWindow!, x: params.x, y: params.y });
    });

    wc.on('media-started-playing', () => this.send('tab:updated', { tabId, isAudible: true }));
    wc.on('media-paused', () => this.send('tab:updated', { tabId, isAudible: false }));
    wc.on('did-fail-load', (_e, errorCode, _desc, validatedURL) => {
      if (errorCode === -3) return;
      wc.stop();
      this.send('tab:load-error', { tabId, errorCode, validatedURL });
    });
    wc.on('render-process-gone', () => { this.send('tab:crashed', { tabId }); });
    wc.on('new-window', (e, url) => {
      e.preventDefault();
      this.send('tab:newwindow', { url });
    });

    // Update tab entry
    tab.browserView = view;
    tab.isRuffle = enabled;
    tab.ruffleSource = enabled ? source : undefined;
    this.wcToId.set(wc.id, tabId);

    // Reload the same URL (skip newtab/blank pages)
    if (currentUrl && currentUrl !== 'about:blank' && currentUrl !== 'about:newtab') {
      wc.loadURL(currentUrl);
    }

    // Reactivate if was active
    if (wasActive) {
      if (this.activeId) {
        const old = this.tabs.get(this.activeId);
        if (old) old.browserView.setBounds({ x: -9999, y: -9999, width: 1, height: 1 });
      }
      view.setBounds(this.rect);
      this.activeId = tabId;
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
    this.wcToId.delete(tab.browserView.webContents.id);
    this.mainWindow?.removeBrowserView(tab.browserView);
    (tab.browserView.webContents as Electron.WebContents).destroy();
    this.tabs.delete(tabId);
    if (this.activeId === tabId) this.activeId = null;
  }

  navigate(tabId: string, url: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.lastTargetUrl = url;
      tab.browserView.webContents.loadURL(url);
    }
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
    if (!tab) return;
    const wc = tab.browserView.webContents;
    const committedUrl = wc.getURL();
    if (tab.lastTargetUrl && (!committedUrl || committedUrl === 'about:blank')) {
      wc.loadURL(tab.lastTargetUrl);
    } else {
      wc.reload();
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

  private send(channel: string, payload: Record<string, unknown>): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload);
    }
  }
}

export const tabManager = new TabManager();
