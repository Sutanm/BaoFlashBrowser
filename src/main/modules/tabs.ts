import { BrowserView, Menu } from 'electron';
import log from 'electron-log';
import { getMainWindow } from './window';
import { setupSessionOnce } from './session-manager';
import { setupCapture, teardownCapture } from './password-capture';
import { fillPasswordsInWebContents, PasswordFillResult } from './password-fill';
import { getFillCredentialForUrl, isAutoFillEnabled } from './password-store';
import { getUserscriptManager } from './userscripts';
import type { AutomationViewport } from '../../shared/automation/types';

interface TabEntry {
  id: string;
  browserView: BrowserView | null;
  isRuffle: boolean;
  ruffleSource?: 'bundled' | 'cdn';
  lastTargetUrl: string;
  zoomFactor: number;
  muted: boolean;
  crashed: boolean;
}

interface ContainerRect { x: number; y: number; width: number; height: number }
const HIDDEN_BOUNDS: ContainerRect = Object.freeze({ x: -9999, y: -9999, width: 1, height: 1 });

export interface AutomationTabHandle {
  readonly tabId: string;
  readonly webContents: Electron.WebContents;
  readonly engine: 'ppapi' | 'ruffle';
  readonly ready: Promise<void>;
  getCssViewport(): { width: number; height: number };
  getViewportTransform(): AutomationViewportTransform;
  getViewportRevision?(): number;
  waitForViewport?(): Promise<void>;
  assertCurrent(): void;
  release(): void;
}

export interface AutomationViewportTransform {
  logicalSize: { width: number; height: number };
  displaySize: { width: number; height: number };
  scaleX: number;
  scaleY: number;
}

interface AutomationViewportLease {
  token: symbol;
  webContentsId: number;
  viewport: AutomationViewport;
  transform: AutomationViewportTransform;
  refreshVersion: number;
}

function needsBrowserView(url: string): boolean {
  return Boolean(url && url !== 'about:newtab' && url !== 'about:userscripts' && url !== 'about:automation' && url !== 'about:blank');
}

export function legacySiteFavicon(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === '7k7k.com' || host.endsWith('.7k7k.com')) return `${parsed.origin}/favicon.ico`;
  } catch { /* invalid URL */ }
  return null;
}

class TabManager {
  private tabs = new Map<string, TabEntry>();
  private wcToId = new Map<number, string>();
  private activeId: string | null = null;
  private rect: ContainerRect = { x: 0, y: 0, width: 0, height: 0 };
  private preloadPath = '';
  private userscriptGeneration = 0;
  private passwordFillTimers = new Map<number, Set<ReturnType<typeof setTimeout>>>();
  private passwordFormSignalTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private passwordFillInFlight = new Set<number>();
  private automationTargets = new Map<string, AutomationViewportLease>();

  private _isCurrentWebContents(tabId: string, wc: Electron.WebContents): boolean {
    const tab = this.tabs.get(tabId);
    return !!tab?.browserView && tab.browserView.webContents.id === wc.id && this.wcToId.get(wc.id) === tabId;
  }

  getRuffleForWC(wcId: number): { tabId: string; enabled: boolean; source?: 'bundled' | 'cdn' } | null {
    const tabId = this.wcToId.get(wcId);
    const tab = tabId ? this.tabs.get(tabId) : null;
    return tabId && tab ? { tabId, enabled: tab.isRuffle, source: tab.ruffleSource } : null;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getTabIdForWebContents(wcId: number): string | null {
    return this.wcToId.get(wcId) ?? null;
  }

  getWebContents(tabId: string): Electron.WebContents | null {
    const tab = this.tabs.get(tabId);
    const wc = tab?.browserView?.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }

  isTabActive(tabId: string): boolean {
    return this.activeId === tabId;
  }

  getContainerRect(): ContainerRect {
    return { ...this.rect };
  }

  /** Inspect the active BrowserView with a transient CDP client, without creating a fixed-viewport automation lease. */
  async inspectAutomationTarget<T>(tabId: string, inspect: (webContents: Electron.WebContents) => Promise<T>): Promise<T> {
    if (this.activeId !== tabId) throw new Error('automation can only target the active tab');
    const wc = this.getWebContents(tabId);
    if (!wc) throw new Error('automation target has no live BrowserView');
    if (this.automationTargets.has(tabId)) return inspect(wc);
    teardownCapture(wc);
    try { return await inspect(wc); }
    finally {
      if (!wc.isDestroyed() && this._isCurrentWebContents(tabId, wc) && !this.automationTargets.has(tabId)) setupCapture(wc);
    }
  }

  /** Reserve the active BrowserView for one automation run and pause password CDP capture. */
  beginAutomation(tabId: string, viewport: AutomationViewport): AutomationTabHandle {
    if (this.activeId !== tabId) throw new Error('automation can only target the active tab');
    if (this.automationTargets.has(tabId)) throw new Error('this tab already has an automation run');
    const tab = this.tabs.get(tabId);
    const wc = tab?.browserView?.webContents;
    if (!tab || !wc || wc.isDestroyed()) throw new Error('automation target has no live BrowserView');
    if (this.rect.width <= 0 || this.rect.height <= 0) throw new Error('automation BrowserView has no available display area');
    const token = Symbol(`automation:${tabId}:${wc.id}`);
    const lease: AutomationViewportLease = {
      token,
      webContentsId: wc.id,
      viewport: { ...viewport },
      transform: {
        logicalSize: { width: viewport.width, height: viewport.height },
        displaySize: { width: this.rect.width, height: this.rect.height },
        scaleX: 1,
        scaleY: 1,
      },
      refreshVersion: 0,
    };
    this.automationTargets.set(tabId, lease);
    teardownCapture(wc);
    try { this._applyAutomationViewport(tabId, wc); }
    catch (error) {
      this.automationTargets.delete(tabId);
      setupCapture(wc);
      throw error;
    }
    const ready = this._waitForAutomationViewport(tabId, wc, lease);
    let released = false;
    const assertCurrent = (): void => {
      if (released || this.automationTargets.get(tabId)?.token !== token) throw new Error('automation target was released');
      if (this.activeId !== tabId || wc.isDestroyed() || !this._isCurrentWebContents(tabId, wc)) {
        throw new Error('automation target tab changed while running; keep the script tab active');
      }
    };
    return {
      tabId,
      webContents: wc,
      engine: tab.isRuffle ? 'ruffle' : 'ppapi',
      ready,
      getCssViewport: () => {
        assertCurrent();
        return { ...lease.transform.logicalSize };
      },
      getViewportTransform: () => {
        assertCurrent();
        return {
          logicalSize: { ...lease.transform.logicalSize },
          displaySize: { ...lease.transform.displaySize },
          scaleX: lease.transform.scaleX,
          scaleY: lease.transform.scaleY,
        };
      },
      getViewportRevision: () => lease.refreshVersion,
      waitForViewport: () => this._waitForAutomationViewport(tabId, wc, lease),
      assertCurrent,
      release: () => {
        if (released) return;
        released = true;
        if (this.automationTargets.get(tabId)?.token !== token) return;
        this.automationTargets.delete(tabId);
        if (!wc.isDestroyed() && this._isCurrentWebContents(tabId, wc)) {
          tab.browserView?.setBounds(this.activeId === tabId ? this.rect : HIDDEN_BOUNDS);
          setupCapture(wc);
        }
      },
    };
  }

  private _applyAutomationViewport(tabId: string, wc: Electron.WebContents): void {
    const lease = this.automationTargets.get(tabId);
    const tab = this.tabs.get(tabId);
    if (!lease || lease.webContentsId !== wc.id || !tab?.browserView || this.activeId !== tabId) return;
    if (this.rect.width <= 0 || this.rect.height <= 0) return;
    // Automation uses a virtual logical canvas. Never resize or zoom the live
    // page: doing so causes visible flicker, reflow and closes page overlays.
    tab.browserView.setBounds(this.rect);
    const refreshVersion = ++lease.refreshVersion;
    void this._settleAutomationViewport(tabId, wc, lease, refreshVersion);
  }

  private async _waitForAutomationViewport(tabId: string, wc: Electron.WebContents, lease: AutomationViewportLease): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refreshVersion = lease.refreshVersion;
      await this._settleAutomationViewport(tabId, wc, lease, refreshVersion);
      if (refreshVersion === lease.refreshVersion
        && lease.transform.displaySize.width > 0 && lease.transform.displaySize.height > 0) return;
    }
    throw new Error('automation viewport dimensions are unavailable');
  }

  private async _settleAutomationViewport(tabId: string, wc: Electron.WebContents, lease: AutomationViewportLease, refreshVersion: number): Promise<void> {
    // BrowserView.setBounds returns before Chromium publishes the new
    // innerWidth/innerHeight. Poll briefly so a maximize/windowed transition
    // cannot leave automation using the previous window's transform.
    for (let attempt = 0; attempt < 16; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (wc.isDestroyed() || this.automationTargets.get(tabId)?.token !== lease.token || lease.refreshVersion !== refreshVersion) return;
      try {
        const size = await wc.executeJavaScript('({width:innerWidth,height:innerHeight})') as { width?: number; height?: number };
        if (wc.isDestroyed() || this.automationTargets.get(tabId)?.token !== lease.token || lease.refreshVersion !== refreshVersion) return;
        const width = Number(size.width); const height = Number(size.height);
        if (width <= 0 || height <= 0) continue;
        lease.transform = {
          logicalSize: { width: lease.viewport.width, height: lease.viewport.height },
          displaySize: { width, height },
          scaleX: width / lease.viewport.width,
          scaleY: height / lease.viewport.height,
        };
        const zoom = wc.getZoomFactor();
        const expectedWidth = this.rect.width / zoom;
        const expectedHeight = this.rect.height / zoom;
        if (Math.abs(width - expectedWidth) <= 2 && Math.abs(height - expectedHeight) <= 2) return;
      } catch { /* renderer may be navigating */ }
    }
  }

  setPreload(path: string): void { this.preloadPath = path; }

  getMemoryDiagnostics(): Array<{ tabId: string; pid: number; engine: 'ppapi' | 'ruffle'; active: boolean; host: string }> {
    const result: Array<{ tabId: string; pid: number; engine: 'ppapi' | 'ruffle'; active: boolean; host: string }> = [];
    for (const [tabId, tab] of this.tabs) {
      const wc = tab.browserView?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      let host = '';
      try { host = new URL(wc.getURL() || tab.lastTargetUrl).hostname; } catch { /* no host */ }
      result.push({ tabId, pid: wc.getOSProcessId(), engine: tab.isRuffle ? 'ruffle' : 'ppapi', active: this.activeId === tabId, host });
    }
    return result;
  }

  setBounds(x: number, y: number, width: number, height: number): void {
    this.rect = { x, y, width, height };
    const tabId = this.activeId || '';
    const wc = this.tabs.get(tabId)?.browserView?.webContents;
    if (wc && this.automationTargets.has(tabId)) this._applyAutomationViewport(tabId, wc);
    else this.tabs.get(tabId)?.browserView?.setBounds(this.rect);
  }

  create(tabId: string, url: string, ruffleConfig?: { enabled: boolean; source: 'bundled' | 'cdn' }): void {
    const existing = this.tabs.get(tabId);
    if (existing) {
      existing.lastTargetUrl = url || existing.lastTargetUrl;
      existing.isRuffle = ruffleConfig?.enabled ?? existing.isRuffle;
      existing.ruffleSource = existing.isRuffle ? ruffleConfig?.source || existing.ruffleSource : undefined;
      if (!existing.browserView && needsBrowserView(existing.lastTargetUrl)) {
        const wc = this._createView(existing);
        if (wc) void wc.loadURL(existing.lastTargetUrl);
      }
      return;
    }
    const useRuffle = ruffleConfig?.enabled ?? false;
    const tab: TabEntry = {
      id: tabId,
      browserView: null,
      isRuffle: useRuffle,
      ruffleSource: useRuffle ? ruffleConfig?.source : undefined,
      lastTargetUrl: url || 'about:newtab',
      zoomFactor: 1,
      muted: false,
      crashed: false,
    };
    this.tabs.set(tabId, tab);
    if (needsBrowserView(url)) {
      const wc = this._createView(tab);
      if (wc) void wc.loadURL(url);
    }
  }

  private _createView(tab: TabEntry): Electron.WebContents | null {
    if (tab.browserView) return tab.browserView.webContents;
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      log.warn('[TabManager] mainWindow unavailable for tab ' + tab.id);
      return null;
    }
    const view = new BrowserView({
      webPreferences: {
        preload: this.preloadPath,
        plugins: !tab.isRuffle,
        contextIsolation: !tab.isRuffle,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,   // userscript runtime needs subframe preload
        // Flash games and automation must keep timers/compositing alive while
        // the host window is minimized. The global Chromium switch is kept as
        // a compatibility fallback, but Electron's per-view preference is the
        // authoritative policy for BrowserView renderers.
        backgroundThrottling: false,
        spellcheck: false,
        partition: 'persist:',
      },
    });
    tab.browserView = view;
    tab.crashed = false;
    win.addBrowserView(view);
    view.setBounds(this.activeId === tab.id && this.rect.width > 0 ? this.rect : HIDDEN_BOUNDS);
    view.setAutoResize({ width: false, height: false });
    const wc = view.webContents;
    this.wcToId.set(wc.id, tab.id);
    getUserscriptManager()?.registerView(wc.id, {
      mode: tab.isRuffle ? 'ruffle' : 'ppapi',
      generation: ++this.userscriptGeneration,
      token: tab.id,
    });
    setupSessionOnce(wc.session);
    this._wireBrowserViewEvents(wc, tab.id);
    wc.setZoomFactor(tab.zoomFactor);
    wc.setAudioMuted(tab.muted);
    return wc;
  }

  private _wireBrowserViewEvents(wc: Electron.WebContents, tabId: string): void {
    let mainNavigationPending = false;
    let captureAfterLoad = false;
    const refreshPageMetadata = (delay: number): void => {
      setTimeout(() => {
        if (!this._isCurrentWebContents(tabId, wc) || wc.isDestroyed()) return;
        void wc.executeJavaScript('document.title').then((title) => {
          if (this._isCurrentWebContents(tabId, wc) && typeof title === 'string' && title && title !== 'about:blank') {
            this.send('tab:updated', { tabId, title });
          }
        }).catch(() => log.debug('[Tabs] title metadata refresh failed', { tabId }));
        void wc.executeJavaScript(`(function(){
          var e=document.querySelector('link[rel~="icon" i],link[rel*="icon" i]');
          if(e&&e.href)return e.href;
          var h=location.hostname.toLowerCase();
          if(h==='7k7k.com'||h.endsWith('.7k7k.com'))return location.origin+'/favicon.ico';
          return '';
        })()`).then((favicon) => {
          if (this._isCurrentWebContents(tabId, wc) && typeof favicon === 'string' && favicon) {
            this.send('tab:updated', { tabId, favicon });
          }
        }).catch(() => log.debug('[Tabs] favicon metadata refresh failed', { tabId }));
      }, delay);
    };
    wc.on('destroyed', () => getUserscriptManager()?.unregisterView(wc.id));
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) getUserscriptManager()?.spaNavigate(wc.id, url, 'in-page');
    });
    wc.on('page-title-updated', (_e, title) => this._isCurrentWebContents(tabId, wc) && this.send('tab:updated', { tabId, title }));
    wc.on('page-favicon-updated', (_e, favicons) => {
      if (this._isCurrentWebContents(tabId, wc) && favicons?.[0]) this.send('tab:updated', { tabId, favicon: favicons[0] });
    });
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!this._isCurrentWebContents(tabId, wc) || !isMainFrame || isInPlace) return;
      mainNavigationPending = true;
      captureAfterLoad = true;
      this._detachDebuggerBeforeNavigate(wc);
      this._clearPasswordFillTimers(wc.id);
      this.send('tab:updated', { tabId, isLoading: true, crashed: false });
    });
    wc.on('will-navigate', () => {
      if (this._isCurrentWebContents(tabId, wc)) this._detachDebuggerBeforeNavigate(wc);
    });
    wc.on('dom-ready', () => {
      // SWF file: Chromium's internal plugin viewer sets body{height:100%} but
      // NOT html{height:100%}, so the percentage collapses to the SWF's stage
      // height instead of the viewport. The preload cannot fix this because
      // Chromium's plugin document does not load preload scripts.
      try {
        if (/\.swf(\?|#|$)/i.test(wc.getURL())) {
          void wc.insertCSS(
            'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}' +
            'embed,object{width:100%!important;height:100%!important}',
          );
        }
      } catch { /* must not break navigation */ }
      this._applyAutomationViewport(tabId, wc);
      if (!this._isCurrentWebContents(tabId, wc) || !mainNavigationPending) return;
      // The top-level DOM is usable even if a game/login iframe is still fetching.
      // End the visible spinner here; capture setup remains deferred until did-stop-loading.
      mainNavigationPending = false;
      this.send('tab:updated', { tabId, isLoading: false });
      refreshPageMetadata(50);
    });
    wc.on('did-stop-loading', () => {
      if (!this._isCurrentWebContents(tabId, wc)) return;
      if (!captureAfterLoad) return;
      captureAfterLoad = false;
      if (mainNavigationPending) {
        mainNavigationPending = false;
        this.send('tab:updated', { tabId, isLoading: false });
      }
      refreshPageMetadata(500);
      if (!this.automationTargets.has(tabId)) setupCapture(wc);
      this._schedulePasswordFill(wc, tabId);
    });
    const updateUrl = (navUrl: string) => {
      if (!this._isCurrentWebContents(tabId, wc) || navUrl === 'about:blank' || navUrl.startsWith('data:')) return;
      const tab = this.tabs.get(tabId);
      if (tab) tab.lastTargetUrl = navUrl;
      const favicon = legacySiteFavicon(navUrl);
      this.send('tab:updated', favicon ? { tabId, url: navUrl, favicon } : { tabId, url: navUrl });
    };
    wc.on('did-navigate', (_e, url) => updateUrl(url));
    wc.on('did-navigate-in-page', (_e, url, main) => { if (main) updateUrl(url); });
    wc.on('media-started-playing', () => this._isCurrentWebContents(tabId, wc) && this.send('tab:updated', { tabId, isAudible: true }));
    wc.on('media-paused', () => this._isCurrentWebContents(tabId, wc) && this.send('tab:updated', { tabId, isAudible: false }));
    const updateNav = () => {
      if (!this._isCurrentWebContents(tabId, wc)) return;
      try { this.send('tab:updated', { tabId, canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() }); } catch { /* gone */ }
    };
    wc.on('did-navigate', updateNav);
    wc.on('did-navigate-in-page', updateNav);
    wc.on('did-stop-loading', updateNav);
    wc.on('found-in-page', (_e, result) => {
      if (this._isCurrentWebContents(tabId, wc)) this.send('tab:found', { tabId, activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches });
    });
    wc.on('did-fail-load', (_e, errorCode, _desc, validatedURL, isMainFrame) => {
      if (!this._isCurrentWebContents(tabId, wc) || errorCode === -3 || !isMainFrame) return;
      mainNavigationPending = false;
      captureAfterLoad = false;
      this._detachDebuggerBeforeNavigate(wc);
      this._clearPasswordFillTimers(wc.id);
      this.send('tab:updated', { tabId, isLoading: false, canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() });
      this.send('tab:load-error', { tabId, errorCode, validatedURL });
    });
    wc.on('render-process-gone', (_event, details) => {
      if (!this._isCurrentWebContents(tabId, wc)) return;
      const tab = this.tabs.get(tabId);
      if (!tab?.browserView) return;
      const failedView = tab.browserView;
      tab.browserView = null;
      tab.crashed = true;
      this._disposeView(failedView);
      this.send('tab:crashed', { tabId, reason: details?.reason || 'crashed' });
    });
    wc.on('new-window', (event, url) => {
      event.preventDefault();
      if (this._isCurrentWebContents(tabId, wc)) this.send('tab:newwindow', { url });
    });
    wc.on('context-menu', (_e, params) => {
      if (!this._isCurrentWebContents(tabId, wc)) return;
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      const tab = this.tabs.get(tabId);
      const template: Electron.MenuItemConstructorOptions[] = [
        { label: '↩ 后退', enabled: wc.canGoBack(), click: () => this.goBack(tabId) },
        { label: '↪ 前进', enabled: wc.canGoForward(), click: () => this.goForward(tabId) },
        { label: '⟳ 刷新', click: () => this.reload(tabId) },
        { type: 'separator' }, { label: '复制', enabled: Boolean(params.selectionText), role: 'copy' }, { label: '粘贴', role: 'paste' },
      ];
      if (params.linkURL) template.push({ type: 'separator' }, { label: '在新标签页打开链接', click: () => this.send('tab:newwindow', { url: params.linkURL }) });
      template.push(
        { type: 'separator' },
        { label: tab?.isRuffle ? `Flash 引擎: Ruffle (WASM 模拟)${tab.ruffleSource === 'cdn' ? ' (CDN)' : ''}` : 'Flash 引擎: PPAPI (原生)', enabled: false },
        { label: '检查元素', click: () => wc.openDevTools({ mode: 'detach' }) },
      );
      Menu.buildFromTemplate(template).popup({ window: win, x: params.x, y: params.y });
    });
  }

  setRuffleMode(tabId: string, enabled: boolean, source: 'bundled' | 'cdn'): void {
    const tab = this.tabs.get(tabId); if (!tab) return;
    const currentUrl = tab.browserView?.webContents.getURL() || tab.lastTargetUrl;
    if (tab.browserView) { const old = tab.browserView; tab.browserView = null; this._disposeView(old); }
    tab.isRuffle = enabled;
    tab.ruffleSource = enabled ? source : undefined;
    tab.crashed = false;
    if (needsBrowserView(currentUrl)) {
      const wc = this._createView(tab);
      if (wc) void wc.loadURL(currentUrl);
    }
  }

  activate(tabId: string): void {
    if (this.activeId && this.activeId !== tabId) this.tabs.get(this.activeId)?.browserView?.setBounds(HIDDEN_BOUNDS);
    this.activeId = tabId;
    const wc = this.tabs.get(tabId)?.browserView?.webContents;
    if (wc && this.automationTargets.has(tabId)) this._applyAutomationViewport(tabId, wc);
    else this.tabs.get(tabId)?.browserView?.setBounds(this.rect);
  }

  close(tabId: string): void {
    const tab = this.tabs.get(tabId); if (!tab) return;
    this.automationTargets.delete(tabId);
    if (tab.browserView) { const view = tab.browserView; tab.browserView = null; this._disposeView(view); }
    this.tabs.delete(tabId);
    if (this.activeId === tabId) this.activeId = null;
  }

  suspend(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab?.browserView || this.activeId === tabId) return;
    const view = tab.browserView;
    tab.browserView = null;
    this._disposeView(view);
  }

  private _disposeView(view: BrowserView): void {
    const wc = view.webContents;
    this._clearPasswordFillTimers(wc.id);
    this.passwordFillInFlight.delete(wc.id);
    teardownCapture(wc);
    this.wcToId.delete(wc.id);
    try { getMainWindow()?.removeBrowserView(view); } catch { /* gone */ }
    try { if (!wc.isDestroyed()) (wc as unknown as { destroy(): void }).destroy(); } catch { /* gone */ }
    try { (view as unknown as { destroy(): void }).destroy(); } catch { /* Electron 11 BrowserView */ }
  }

  destroyAll(): void {
    for (const tab of this.tabs.values()) if (tab.browserView) this._disposeView(tab.browserView);
    this.tabs.clear(); this.wcToId.clear(); this.automationTargets.clear(); this.activeId = null;
  }

  refreshPasswordCapture(enabled: boolean): void {
    for (const tab of this.tabs.values()) {
      const wc = tab.browserView?.webContents; if (!wc) continue;
      if (enabled) setupCapture(wc);
      else teardownCapture(wc);
    }
  }

  private _clearPasswordFillTimers(wcId: number): void {
    const timers = this.passwordFillTimers.get(wcId);
    if (timers) for (const timer of timers) clearTimeout(timer);
    this.passwordFillTimers.delete(wcId);
    const signalTimer = this.passwordFormSignalTimers.get(wcId);
    if (signalTimer) clearTimeout(signalTimer);
    this.passwordFormSignalTimers.delete(wcId);
  }

  private async _attemptPasswordFill(wc: Electron.WebContents, tabId: string): Promise<void> {
    if (!isAutoFillEnabled() || wc.isDestroyed() || !this._isCurrentWebContents(tabId, wc) || this.passwordFillInFlight.has(wc.id)) return;
    this.passwordFillInFlight.add(wc.id);
    try {
      const result = await fillPasswordsInWebContents(wc, (url) => getFillCredentialForUrl(url, undefined, true));
      if (result.success && this._isCurrentWebContents(tabId, wc)) {
        this._clearPasswordFillTimers(wc.id);
        this.send('password:filled', { tabId, username: result.usernames[0] || '', count: result.filledCredentials, automatic: true });
      }
    } catch (error) { log.debug('[PasswordFill] automatic attempt failed:', error); }
    finally { this.passwordFillInFlight.delete(wc.id); }
  }

  private _schedulePasswordFill(wc: Electron.WebContents, tabId: string): void {
    this._clearPasswordFillTimers(wc.id); if (!isAutoFillEnabled()) return;
    const timers = new Set<ReturnType<typeof setTimeout>>(); this.passwordFillTimers.set(wc.id, timers);
    for (const delay of [120, 1000, 3000, 10000, 30000]) {
      const timer = setTimeout(async () => { timers.delete(timer); await this._attemptPasswordFill(wc, tabId); if (!timers.size) this.passwordFillTimers.delete(wc.id); }, delay);
      timers.add(timer);
    }
  }

  notifyPasswordFormDetected(wcId: number): void {
    const tabId = this.wcToId.get(wcId); const tab = tabId ? this.tabs.get(tabId) : null; const wc = tab?.browserView?.webContents;
    if (!tabId || !wc || wc.id !== wcId || !isAutoFillEnabled()) return;
    const existing = this.passwordFormSignalTimers.get(wcId); if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { this.passwordFormSignalTimers.delete(wcId); void this._attemptPasswordFill(wc, tabId); }, 100);
    this.passwordFormSignalTimers.set(wcId, timer);
  }

  refreshPasswordFill(): void {
    for (const [tabId, tab] of this.tabs) if (tab.browserView) this._schedulePasswordFill(tab.browserView.webContents, tabId);
  }

  async fillPassword(tabId: string, entryId: string): Promise<PasswordFillResult> {
    const wc = this.tabs.get(tabId)?.browserView?.webContents;
    if (!wc) return { success: false, filledFields: 0, filledCredentials: 0, usernames: [], reason: 'destroyed' };
    const result = await fillPasswordsInWebContents(wc, (url) => getFillCredentialForUrl(url, entryId, false));
    if (result.success) this.send('password:filled', { tabId, username: result.usernames[0] || '', count: result.filledCredentials, automatic: false });
    return result;
  }

  private _detachDebuggerBeforeNavigate(wc: Electron.WebContents): void {
    try { teardownCapture(wc); } catch (error: any) { log.warn('[TabManager] teardownCapture failed:', error?.message); }
  }

  navigate(tabId: string, url: string): void {
    const tab = this.tabs.get(tabId); if (!tab) return;
    tab.lastTargetUrl = url; tab.crashed = false;
    const wc = tab.browserView?.webContents || this._createView(tab);
    if (!wc || !needsBrowserView(url)) return;
    this._detachDebuggerBeforeNavigate(wc);
    this.send('tab:updated', { tabId, crashed: false, isLoading: true });
    void wc.loadURL(url);
  }

  goBack(tabId: string): void { const wc = this.tabs.get(tabId)?.browserView?.webContents; if (wc?.canGoBack()) { this._detachDebuggerBeforeNavigate(wc); wc.goBack(); } }
  goForward(tabId: string): void { const wc = this.tabs.get(tabId)?.browserView?.webContents; if (wc?.canGoForward()) { this._detachDebuggerBeforeNavigate(wc); wc.goForward(); } }

  reload(tabId: string): void {
    const tab = this.tabs.get(tabId); if (!tab || !needsBrowserView(tab.lastTargetUrl)) return;
    const wc = tab.browserView?.webContents || this._createView(tab); if (!wc) return;
    const url = wc.getURL() && wc.getURL() !== 'about:blank' ? wc.getURL() : tab.lastTargetUrl;
    tab.crashed = false; this._detachDebuggerBeforeNavigate(wc);
    this.send('tab:updated', { tabId, crashed: false, isLoading: true });
    void wc.loadURL(url);
  }

  stop(tabId: string): void { this.tabs.get(tabId)?.browserView?.webContents.stop(); }
  setZoom(tabId: string, factor: number): void { const tab = this.tabs.get(tabId); if (tab) { tab.zoomFactor = factor; tab.browserView?.webContents.setZoomFactor(factor); const wc = tab.browserView?.webContents; const lease = this.automationTargets.get(tabId); if (wc && lease) { const refreshVersion = ++lease.refreshVersion; void this._settleAutomationViewport(tabId, wc, lease, refreshVersion); } } }
  setMuted(tabId: string, muted: boolean): void { const tab = this.tabs.get(tabId); if (tab) { tab.muted = muted; tab.browserView?.webContents.setAudioMuted(muted); } }
  openDevTools(tabId: string): void { this.tabs.get(tabId)?.browserView?.webContents.openDevTools({ mode: 'detach' }); }
  findInPage(tabId: string, text: string, options?: Electron.FindInPageOptions): void { this.tabs.get(tabId)?.browserView?.webContents.findInPage(text, options); }
  stopFindInPage(tabId: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void { this.tabs.get(tabId)?.browserView?.webContents.stopFindInPage(action); }

  // Stage 2 sidebar: GM_registerMenuCommand entries for the active view and
  // invocation (sent to the preload, which routes by documentId).
  getUserscriptCommandsForTab(tabId: string): Array<{ commandId: string; title: string; scriptId: string }> {
    const tab = this.tabs.get(tabId);
    const wc = tab?.browserView?.webContents;
    if (!wc || wc.isDestroyed()) return [];
    return (getUserscriptManager()?.commandsFor(wc.id) ?? []).map((command) => ({
      commandId: command.commandId,
      title: command.title,
      scriptId: command.scriptId,
    }));
  }

  invokeUserscriptCommand(tabId: string, commandId: string): boolean {
    const tab = this.tabs.get(tabId);
    const wc = tab?.browserView?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    const registration = getUserscriptManager()?.getRegistration(wc.id);
    const command = getUserscriptManager()?.commandsFor(wc.id).find((item) => item.commandId === commandId);
    if (!command || !registration) return false;
    try {
      wc.send('userscript:menu-invoke', { commandId, documentId: command.documentId });
      return true;
    } catch { /* view gone */ }
    return false;
  }

  private send(channel: string, payload: Record<string, unknown>): void {
    const win = getMainWindow(); if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export const tabManager = new TabManager();
