import { BrowserView, BrowserWindow, Menu, shell } from 'electron';
import log from 'electron-log';
import fs from 'fs';
import path from 'path';
import { getMainWindow } from './window';
import { setupSessionOnce } from './session-manager';
import { setupCapture, teardownCapture } from './password-capture';

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
  private rect: ContainerRect = { x: 0, y: 0, width: 0, height: 0 };
  private preloadPath = '';

  getRuffleForWC(wcId: number): { enabled: boolean; source?: 'bundled' | 'cdn' } | null {
    const tabId = this.wcToId.get(wcId);
    if (!tabId) return null;
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    return { enabled: tab.isRuffle, source: tab.ruffleSource };
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
    const win = getMainWindow();
    if (!win) {
      log.warn('[TabManager] create: mainWindow not available, skipping tab ' + tabId);
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
    win.addBrowserView(view);
    view.setBounds(this.rect.width > 0 ? this.rect : { x: -9999, y: -9999, width: 1, height: 1 });
    view.setAutoResize({ width: false, height: false });

    const wc = view.webContents;

    // Setup session handlers once per partition
    setupSessionOnce(wc.session);
    this._wireBrowserViewEvents(wc, tabId);

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

  private _wireBrowserViewEvents(wc: Electron.WebContents, tabId: string): void {
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
        } catch (e: any) { log.warn('[TabManager] fallback title/favicon failed:', e?.message); }
      }, 500);
      setupCapture(wc);
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
      } catch (e: any) { log.warn('[TabManager] updateNav failed:', e?.message); }
    };
    wc.on('did-navigate', updateNav);
    wc.on('did-navigate-in-page', updateNav);
    wc.on('did-stop-loading', updateNav);

    wc.on('found-in-page', (_e, result) => {
      this.send('tab:found', { tabId, activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches });
    });

    wc.on('did-fail-load', (_e, errorCode, _desc, validatedURL) => {
      if (errorCode === -3) return;
      this.send('tab:load-error', { tabId, errorCode, validatedURL });
    });

    wc.on('render-process-gone', () => {
      this.wcToId.delete(wc.id);
      this.send('tab:crashed', { tabId });
    });

    wc.on('new-window', (e, url) => {
      e.preventDefault();
      this.send('tab:newwindow', { url });
    });

    wc.on('context-menu', (_e, params) => {
      const mw = getMainWindow();
      if (!mw || mw.isDestroyed()) return;
      const template: Electron.MenuItemConstructorOptions[] = [
        { label: '↩ 后退', enabled: wc.canGoBack(), click: () => wc.goBack() },
        { label: '↪ 前进', enabled: wc.canGoForward(), click: () => wc.goForward() },
        { label: '⟳ 刷新', click: () => wc.reload() },
        { type: 'separator' },
        { label: '复制', enabled: (params.selectionText?.length ?? 0) > 0, role: 'copy' },
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
      Menu.buildFromTemplate(template).popup({ window: mw, x: params.x, y: params.y });
    });
  }

  setRuffleMode(tabId: string, enabled: boolean, source: 'bundled' | 'cdn'): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const wasActive = this.activeId === tabId;
    const currentUrl = tab.browserView.webContents.getURL();

    this._destroyView(tab);

    const view = new BrowserView({
      webPreferences: {
        preload: this.preloadPath,
        plugins: !enabled,
        contextIsolation: !enabled,
        nodeIntegration: false,
        partition: 'persist:',
      },
    });
    const win = getMainWindow();
    win?.addBrowserView(view);
    view.setBounds(this.rect.width > 0 ? this.rect : { x: -9999, y: -9999, width: 1, height: 1 });
    view.setAutoResize({ width: false, height: false });

    const wc = view.webContents;
    this._wireBrowserViewEvents(wc, tabId);

    tab.browserView = view;
    tab.isRuffle = enabled;
    tab.ruffleSource = enabled ? source : undefined;
    this.wcToId.set(wc.id, tabId);

    if (currentUrl && currentUrl !== 'about:blank' && currentUrl !== 'about:newtab') {
      wc.loadURL(currentUrl);
    }

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
    this._destroyView(tab);
    this.tabs.delete(tabId);
    if (this.activeId === tabId) this.activeId = null;
  }

  // L12: 安全销毁 BrowserView，防止内存泄漏
  private _destroyView(tab: TabEntry): void {
    teardownCapture(tab.browserView.webContents);
    this.wcToId.delete(tab.browserView.webContents.id);
    const win = getMainWindow();
    win?.removeBrowserView(tab.browserView);
    try { (tab.browserView.webContents as Electron.WebContents).destroy(); } catch { /* ignore */ }
    try { (tab.browserView as any).destroy(); } catch { /* ignore */ }
  }

  // L12: 退出时批量销毁
  destroyAll(): void {
    for (const [, tab] of this.tabs) {
      try { this._destroyView(tab); } catch { /* ignore */ }
    }
    this.tabs.clear();
    this.wcToId.clear();
    this.activeId = null;
  }

  // L: 导航前卸载 CDP debugger，防止已附着的 debugger 阻塞 <script> onload
  // 从而导致 did-stop-loading 不触发、标签页卡在 isLoading:true（AGENTS.md landmine）
  // did-stop-loading 会重新调用 setupCapture 挂载 debugger，无需在此重新挂载
  private _detachDebuggerBeforeNavigate(wc: Electron.WebContents): void {
    try { teardownCapture(wc); } catch (e: any) { log.warn('[TabManager] teardownCapture failed:', e?.message); }
  }

  navigate(tabId: string, url: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.lastTargetUrl = url;
      const wc = tab.browserView.webContents;
      this._detachDebuggerBeforeNavigate(wc);
      wc.loadURL(url);
    }
  }

  goBack(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab && tab.browserView.webContents.canGoBack()) {
      this._detachDebuggerBeforeNavigate(tab.browserView.webContents);
      tab.browserView.webContents.goBack();
    }
  }

  goForward(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab && tab.browserView.webContents.canGoForward()) {
      this._detachDebuggerBeforeNavigate(tab.browserView.webContents);
      tab.browserView.webContents.goForward();
    }
  }

  reload(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const wc = tab.browserView.webContents;
    const committedUrl = wc.getURL();
    this._detachDebuggerBeforeNavigate(wc);
    if (tab.lastTargetUrl && (!committedUrl || committedUrl === 'about:blank')) {
      if (tab.lastTargetUrl !== 'about:newtab') {
        wc.loadURL(tab.lastTargetUrl);
      }
      // about:newtab is handled by renderer UI — do nothing
    } else if (committedUrl) {
      // Use loadURL instead of reload for BrowserView compatibility (Electron 11)
      wc.loadURL(committedUrl);
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
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export const tabManager = new TabManager();
