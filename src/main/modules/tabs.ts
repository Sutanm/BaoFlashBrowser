import { uiText } from './ui-language';
import { BrowserView, Menu } from 'electron';
import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import { getMainWindow } from './window';
import { setupSessionOnce } from './session-manager';
import { withTimeout } from '../utils/with-timeout';
import type { PasswordFillResult } from './password-fill';
import type { FillCredential } from './password-store';
import type { UserscriptManager } from './userscripts/userscript-manager';

export interface OptionalTabServices {
  passwords?: {
    setupCapture(wc: Electron.WebContents): void;
    teardownCapture(wc: Electron.WebContents): void;
    fillPasswords(
      wc: Electron.WebContents,
      resolveCredential: (frameUrl: string) => FillCredential | null,
    ): Promise<PasswordFillResult>;
    getFillCredentialForUrl(pageUrl: string, requestedId?: string, automatic?: boolean): FillCredential | null;
    isAutoFillEnabled(): boolean;
    /** 按需自愈（规格 D6）：填充前确保密钥已就绪，瞬时失败可在会话内恢复。 */
    ensureKeyLoaded?(): Promise<unknown>;
  };
  getUserscriptManager?: () => UserscriptManager | null;
}

let optionalServices: OptionalTabServices = {};

/** Configure optional integrations before the first BrowserView is created. */
export function configureOptionalTabServices(services: OptionalTabServices): void {
  optionalServices = { ...services };
}

const passwordCapture = {
  setup(wc: Electron.WebContents): void { optionalServices.passwords?.setupCapture(wc); },
  teardown(wc: Electron.WebContents): void { optionalServices.passwords?.teardownCapture(wc); },
};

function userscriptManager(): UserscriptManager | null {
  return optionalServices.getUserscriptManager?.() ?? null;
}

export type AutomationViewport = { readonly mode: 'fixed'; readonly width: number; readonly height: number };

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
const AUTOMATION_VIEWPORT_PROBE_TIMEOUT_MS = 500;
const AUTOMATION_VIEWPORT_PROBE_TIMEOUT = 'automation viewport probe timed out';

export interface AutomationTabHandle {
  readonly tabId: string;
  readonly webContents: Electron.WebContents;
  readonly engine: 'ppapi' | 'ruffle';
  readonly ready: Promise<void>;
  getCssViewport(): { width: number; height: number };
  getViewportTransform(): AutomationViewportTransform;
  getViewportRevision?(): number;
  waitForViewport?(): Promise<void>;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
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
  private preloadPath: string;
  private userscriptGeneration = 0;
  private passwordFillTimers = new Map<number, Set<ReturnType<typeof setTimeout>>>();
  private passwordFormSignalTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private passwordFillInFlight = new Set<number>();
  private automationTargets = new Map<string, AutomationViewportLease>();
  private hostRestoreTimer?: NodeJS.Timeout;

  /**
   * 一窗口一实例（P3）。preload 路径是构造参数而不是事后 setter：漏注入会让
   * 该窗口的标签失去 Ruffle / userscript / 密码桥。
   */
  constructor(
    private readonly win: () => BrowserWindow | null,
    preloadPath: string,
  ) {
    this.preloadPath = preloadPath;
  }

  /** 宿主窗口（迁移与归属解析用；窗口销毁后返回 null）。 */
  getHostWindow(): BrowserWindow | null {
    return this.win();
  }

  private _isCurrentWebContents(tabId: string, wc: Electron.WebContents): boolean {
    // P7：迁移后旧实例的监听器必须整体失效（新实例会重新绑定）。
    if (tabIndex.get(tabId) !== this) return false;
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

  /** 条目是否存在（渲染进程崩溃后 browserView 为 null，但条目仍在，关闭仍需生效）。 */
  hasTab(tabId: string): boolean {
    return this.tabs.has(tabId);
  }

  /** 当前实例的标签数（P7：拖空后自动关窗）。 */
  getTabCount(): number {
    return this.tabs.size;
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
    passwordCapture.teardown(wc);
    try { return await inspect(wc); }
    finally {
      if (!wc.isDestroyed() && this._isCurrentWebContents(tabId, wc) && !this.automationTargets.has(tabId)) {
        passwordCapture.setup(wc);
      }
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
    // Delayed autofill retries attach their own short-lived debugger client.
    // Once Automation reserves this tab they must stay paused, otherwise a
    // retry can race an input step and make the run stop immediately.
    this._clearPasswordFillTimers(wc.id);
    passwordCapture.teardown(wc);
    try { this._applyAutomationViewport(tabId, wc); }
    catch (error) {
      this.automationTargets.delete(tabId);
      passwordCapture.setup(wc);
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
      navigate: async (url) => {
        assertCurrent();
        tab.lastTargetUrl = url;
        tab.crashed = false;
        this._detachDebuggerBeforeNavigate(wc);
        this.send('tab:updated', { tabId, crashed: false, isLoading: true });
        await wc.loadURL(url);
        assertCurrent();
      },
      reload: async () => {
        assertCurrent();
        const url = wc.getURL() && wc.getURL() !== 'about:blank' ? wc.getURL() : tab.lastTargetUrl;
        tab.crashed = false;
        this._detachDebuggerBeforeNavigate(wc);
        this.send('tab:updated', { tabId, crashed: false, isLoading: true });
        await wc.loadURL(url);
        assertCurrent();
      },
      assertCurrent,
      release: () => {
        if (released) return;
        released = true;
        if (this.automationTargets.get(tabId)?.token !== token) return;
        this.automationTargets.delete(tabId);
        if (!wc.isDestroyed() && this._isCurrentWebContents(tabId, wc)) {
          tab.browserView?.setBounds(this.activeId === tabId ? this.rect : HIDDEN_BOUNDS);
          passwordCapture.setup(wc);
          this._schedulePasswordFill(wc, tabId);
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
        const size = await withTimeout(
          wc.executeJavaScript('({width:innerWidth,height:innerHeight})') as Promise<{ width?: number; height?: number }>,
          AUTOMATION_VIEWPORT_PROBE_TIMEOUT_MS,
          AUTOMATION_VIEWPORT_PROBE_TIMEOUT,
        );
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
      } catch (error) {
        // A Chromium 87 renderer can occasionally stop answering JavaScript
        // probes while its compositor still captures correctly. Keep the last
        // known transform instead of blocking every subsequent capture.
        if (error instanceof Error && error.message === AUTOMATION_VIEWPORT_PROBE_TIMEOUT) return;
        /* renderer may be navigating */
      }
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

  /**
   * Chromium 87 can lose a BrowserView's compositor surface while its host
   * BrowserWindow is minimized. Re-submitting the same bounds is insufficient;
   * force one hidden -> visible transition, just like a successful tab switch.
   *
   * Called from both 'restore' and 'maximize'. The original single-shot version
   * bailed out when isMinimized() was still true at +50 ms — Windows keeps the
   * minimized flag during its restore animation (~200-300 ms) — so the surface
   * stayed lost and the game tab rendered white until the next tab switch.
   * While an automation run is active this is masked by ~20 capturePage calls
   * per second forcing frames; once the run ends nothing forces a repaint and
   * the white screen shows. Poll instead: retry every 150 ms for up to ~1.6 s
   * until the window is actually visible, then run the transition.
   */
  refreshActiveViewAfterHostRestore(): void {
    if (this.hostRestoreTimer) clearTimeout(this.hostRestoreTimer);
    const attempt = (triesLeft: number): void => {
      this.hostRestoreTimer = undefined;
      const win = this.win();
      if (win && !win.isDestroyed() && win.isMinimized()) {
        // 还原动画还没走完：等下一轮再试，别直接放弃
        if (triesLeft > 0) {
          this.hostRestoreTimer = setTimeout(() => attempt(triesLeft - 1), 150);
          this.hostRestoreTimer.unref();
        }
        return;
      }
      const tabId = this.activeId;
      const tab = tabId ? this.tabs.get(tabId) : undefined;
      const view = tab?.browserView;
      const wc = view?.webContents;
      if (!tabId || !view || !wc || wc.isDestroyed() || this.rect.width <= 0 || this.rect.height <= 0) return;
      const expectedWcId = wc.id;
      const lease = this.automationTargets.get(tabId);
      if (lease?.webContentsId === expectedWcId) lease.refreshVersion += 1;
      view.setBounds(HIDDEN_BOUNDS);
      setTimeout(() => {
        const current = this.tabs.get(tabId);
        if (this.activeId !== tabId || current?.browserView !== view || wc.isDestroyed() || wc.id !== expectedWcId) return;
        const currentLease = this.automationTargets.get(tabId);
        if (currentLease?.webContentsId === expectedWcId) this._applyAutomationViewport(tabId, wc);
        else view.setBounds(this.rect);
        try { (wc as unknown as { invalidate?: () => void }).invalidate?.(); } catch { /* Electron 11 best effort. */ }
      }, 0);
    };
    this.hostRestoreTimer = setTimeout(() => attempt(10), 50);
    this.hostRestoreTimer.unref();
  }

  create(tabId: string, url: string, ruffleConfig?: { enabled: boolean; source: 'bundled' | 'cdn' }): void {
    // 全局索引是 tabId → 实例的唯一真相；重复 tabId 会覆盖（并记 warn 由 P3 的
    // create 调用方保证唯一）。
    tabIndex.set(tabId, this);
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
    const win = this.win();
    if (!win || win.isDestroyed()) {
      log.warn('[TabManager] host window unavailable for tab ' + tab.id);
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
    wcIndex.set(wc.id, this);
    userscriptManager()?.registerView(wc.id, {
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
    wc.on('destroyed', () => userscriptManager()?.unregisterView(wc.id));
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) userscriptManager()?.spaNavigate(wc.id, url, 'in-page');
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
      if (!this.automationTargets.has(tabId)) passwordCapture.setup(wc);
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
      const win = this.win();
      if (!win || win.isDestroyed()) return;
      const tab = this.tabs.get(tabId);
      const template: Electron.MenuItemConstructorOptions[] = [
        { label: uiText('↩ 后退', '↩ Back'), enabled: wc.canGoBack(), click: () => this.goBack(tabId) },
        { label: uiText('↪ 前进', '↪ Forward'), enabled: wc.canGoForward(), click: () => this.goForward(tabId) },
        { label: uiText('⟳ 刷新', '⟳ Reload'), click: () => this.reload(tabId) },
        { type: 'separator' }, { label: uiText('复制', 'Copy'), enabled: Boolean(params.selectionText), role: 'copy' }, { label: uiText('粘贴', 'Paste'), role: 'paste' },
      ];
      if (params.linkURL) template.push({ type: 'separator' },
        { label: uiText('在新标签页打开链接', 'Open link in new tab'), click: () => this.send('tab:newwindow', { url: params.linkURL }) },
        { label: uiText('在新窗口打开链接', 'Open link in new window'), click: () => this.send('tab:newwindow', { url: params.linkURL, disposition: 'new-window' }) });
      template.push(
        { type: 'separator' },
        { label: tab?.isRuffle ? `${uiText('Flash 引擎: Ruffle (WASM 模拟)', 'Flash engine: Ruffle (WASM)')}${tab.ruffleSource === 'cdn' ? ' (CDN)' : ''}` : uiText('Flash 引擎: PPAPI (原生)', 'Flash engine: PPAPI (native)'), enabled: false },
        { label: uiText('检查元素', 'Inspect element'), click: () => wc.openDevTools({ mode: 'detach' }) },
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

  /**
   * Hand keyboard focus from the shell renderer to the active page.
   *
   * BrowserView is a separate renderer: a click inside its bounds moves focus
   * through the native hit test, but nothing else does. Without this the shell
   * keeps focus after an address-bar submit, so keystrokes (and therefore the
   * PPAPI plugin's input fields) never see them until the user clicks the page.
   */
  focusActive(): boolean {
    const view = this.activeId ? this.tabs.get(this.activeId)?.browserView : undefined;
    const wc = view?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    if (!wc.isFocused()) wc.focus();
    const focused = wc.isFocused();
    log.info(`[Tabs] focus-active tab=${this.activeId} wc=${wc.id} focused=${focused}`);
    return focused;
  }

  close(tabId: string): void {
    const tab = this.tabs.get(tabId); if (!tab) return;
    this.automationTargets.delete(tabId);
    if (tab.browserView) { const view = tab.browserView; tab.browserView = null; this._disposeView(view); }
    this.tabs.delete(tabId);
    tabIndex.delete(tabId);
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
    passwordCapture.teardown(wc);
    this.wcToId.delete(wc.id);
    wcIndex.delete(wc.id);
    try { this.win()?.removeBrowserView(view); } catch { /* gone */ }
    try { if (!wc.isDestroyed()) (wc as unknown as { destroy(): void }).destroy(); } catch { /* gone */ }
  }

  destroyAll(): void {
    for (const [tabId, tab] of this.tabs) {
      tabIndex.delete(tabId);
      if (tab.browserView) this._disposeView(tab.browserView);
    }
    this.tabs.clear(); this.wcToId.clear(); this.automationTargets.clear(); this.activeId = null;
  }

  refreshPasswordCapture(enabled: boolean): void {
    for (const [tabId, tab] of this.tabs) {
      const wc = tab.browserView?.webContents; if (!wc) continue;
      if (enabled && !this.automationTargets.has(tabId)) passwordCapture.setup(wc);
      else passwordCapture.teardown(wc);
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
    const passwords = optionalServices.passwords;
    if (!passwords?.isAutoFillEnabled() || wc.isDestroyed() || !this._isCurrentWebContents(tabId, wc)
      || this.automationTargets.has(tabId) || this.passwordFillInFlight.has(wc.id)) return;
    this.passwordFillInFlight.add(wc.id);
    try {
      // 按需自愈：密钥若曾因瞬时故障缺席，这里补一次加载（失败则本次照常返回 no-credential）。
      try { await passwords.ensureKeyLoaded?.(); } catch { /* 自愈失败不阻断填充流程 */ }
      const result = await passwords.fillPasswords(wc, (url) => passwords.getFillCredentialForUrl(url, undefined, true));
      if (result.success && this._isCurrentWebContents(tabId, wc)) {
        this._clearPasswordFillTimers(wc.id);
        this.send('password:filled', { tabId, username: result.usernames[0] || '', count: result.filledCredentials, automatic: true });
      }
    } catch (error) { log.debug('[PasswordFill] automatic attempt failed:', error); }
    finally { this.passwordFillInFlight.delete(wc.id); }
  }

  private _schedulePasswordFill(wc: Electron.WebContents, tabId: string): void {
    this._clearPasswordFillTimers(wc.id);
    if (!optionalServices.passwords?.isAutoFillEnabled() || this.automationTargets.has(tabId)) return;
    const timers = new Set<ReturnType<typeof setTimeout>>(); this.passwordFillTimers.set(wc.id, timers);
    for (const delay of [120, 1000, 3000, 10000, 30000]) {
      const timer = setTimeout(async () => { timers.delete(timer); await this._attemptPasswordFill(wc, tabId); if (!timers.size) this.passwordFillTimers.delete(wc.id); }, delay);
      timers.add(timer);
    }
  }

  notifyPasswordFormDetected(wcId: number): void {
    const tabId = this.wcToId.get(wcId); const tab = tabId ? this.tabs.get(tabId) : null; const wc = tab?.browserView?.webContents;
    if (!tabId || !wc || wc.isDestroyed() || wc.id !== wcId || !optionalServices.passwords || this.automationTargets.has(tabId)) return;
    // Re-arm on form discovery/focus rather than waiting for the fill debounce.
    // Never reattach while a login resource is still loading (JSONP onload).
    if (!wc.isLoading()) passwordCapture.setup(wc);
    const existing = this.passwordFormSignalTimers.get(wcId); if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.passwordFormSignalTimers.delete(wcId);
      if (wc.isDestroyed() || !this._isCurrentWebContents(tabId, wc) || this.automationTargets.has(tabId)) return;
      void this._attemptPasswordFill(wc, tabId);
    }, 100);
    this.passwordFormSignalTimers.set(wcId, timer);
  }

  refreshPasswordFill(): void {
    for (const [tabId, tab] of this.tabs) if (tab.browserView) this._schedulePasswordFill(tab.browserView.webContents, tabId);
  }

  async fillPassword(tabId: string, entryId: string): Promise<PasswordFillResult> {
    const wc = this.tabs.get(tabId)?.browserView?.webContents;
    if (!wc) return { success: false, filledFields: 0, filledCredentials: 0, usernames: [], reason: 'destroyed' };
    if (this.automationTargets.has(tabId)) return { success: false, filledFields: 0, filledCredentials: 0, usernames: [], reason: 'debugger-unavailable' };
    const passwords = optionalServices.passwords;
    if (!passwords) return { success: false, filledFields: 0, filledCredentials: 0, usernames: [], reason: 'no-credential' };
    try { await passwords.ensureKeyLoaded?.(); } catch { /* 自愈失败不阻断填充流程 */ }
    const result = await passwords.fillPasswords(wc, (url) => passwords.getFillCredentialForUrl(url, entryId, false));
    if (result.success) this.send('password:filled', { tabId, username: result.usernames[0] || '', count: result.filledCredentials, automatic: false });
    return result;
  }

  private _detachDebuggerBeforeNavigate(wc: Electron.WebContents): void {
    try { passwordCapture.teardown(wc); } catch (error) { log.warn('[TabManager] teardownCapture failed:', (error instanceof Error ? error.message : 'Unknown error')); }
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
    return (userscriptManager()?.commandsFor(wc.id) ?? []).map((command) => ({
      commandId: command.commandId,
      title: command.title,
      scriptId: command.scriptId,
    }));
  }

  invokeUserscriptCommand(tabId: string, commandId: string): boolean {
    const tab = this.tabs.get(tabId);
    const wc = tab?.browserView?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    const registration = userscriptManager()?.getRegistration(wc.id);
    const command = userscriptManager()?.commandsFor(wc.id).find((item) => item.commandId === commandId);
    if (!command || !registration) return false;
    try {
      wc.send('userscript:menu-invoke', { commandId, documentId: command.documentId });
      return true;
    } catch { /* view gone */ }
    return false;
  }

  /**
   * P7：把标签从本实例摘除但不销毁 WebContents（迁移用）。
   * 注意：事件监听仍绑在本实例上；adopt 端需要重新绑定或由全局索引解析宿主，
   * 这部分在 P7 的接线阶段完成（当前仅基础设施，未被 IPC 调用）。
   */
  detachForTransfer(tabId: string): { tabId: string; entry: TabEntry; view: BrowserView | null } | null {
    const entry = this.tabs.get(tabId);
    if (!entry) return null;
    const view = entry.browserView;
    this.tabs.delete(tabId);
    tabIndex.delete(tabId);
    if (view) {
      wcIndex.delete(view.webContents.id);
      this.wcToId.delete(view.webContents.id);
      try { this.win()?.removeBrowserView(view); } catch { /* host gone */ }
    }
    if (this.activeId === tabId) this.activeId = null;
    return { tabId, entry, view };
  }

  /** P7：接收另一个实例摘除的标签（不重建 wc、tabId 不变）。 */
  adoptTransferred(tab: { tabId: string; entry: TabEntry; view: BrowserView | null }, _index?: number): void {
    const host = this.win();
    if (!host || host.isDestroyed()) return;
    this.tabs.set(tab.tabId, tab.entry);
    tabIndex.set(tab.tabId, this);
    if (tab.view) {
      tab.entry.browserView = tab.view;
      this.wcToId.set(tab.view.webContents.id, tab.tabId);
      wcIndex.set(tab.view.webContents.id, this);
      host.addBrowserView(tab.view);
      const rect = this.activeId === tab.tabId && this.rect.width > 0 ? this.rect : HIDDEN_BOUNDS;
      tab.view.setBounds(rect);
      tab.view.webContents.setZoomFactor(tab.entry.zoomFactor);
      tab.view.webContents.setAudioMuted(tab.entry.muted);
      // P7：把事件监听重装到新实例；旧实例的监听器因归属守卫失效，不会双发。
      this._wireBrowserViewEvents(tab.view.webContents, tab.tabId);
    }
  }

  private activeIndexFor(_tabId: string): boolean { return false; }
  private send(channel: string, payload: Record<string, unknown>): void {
    const win = this.win();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
    // P6：窗口标题跟随活动标签（外壳 document.title 固定，只能由主进程 setTitle）。
    if (channel === 'tab:updated' && typeof payload.title === 'string' && payload.title) {
      try { win.setTitle(`${payload.title} — BaoFlashBrowser`); } catch { /* window gone */ }
    }
  }
}

// ---------------------------------------------------------------------------
// 多窗口实例注册表（P3）
//
// 一窗口一 TabManager。这里的三张表是窗口归属的唯一真相：
//   managers: runtimeWindowId → TabManager
//   tabIndex: tabId → TabManager
//   wcIndex:  webContentsId → TabManager
// 索引在 TabManager 内部创建/销毁 tab 与 view 时同步维护。
// ---------------------------------------------------------------------------
const managers = new Map<number, TabManager>();
const tabIndex = new Map<string, TabManager>();
const wcIndex = new Map<number, TabManager>();

/** 为一个窗口创建实例（重复调用返回同一实例）。 */
export function createTabManager(win: BrowserWindow, preloadPath: string): TabManager {
  const existing = managers.get(win.id);
  if (existing) return existing;
  const manager = new TabManager(() => (win.isDestroyed() ? null : win), preloadPath);
  managers.set(win.id, manager);
  return manager;
}

export function getTabManagerForWindow(runtimeId: number): TabManager | undefined {
  return managers.get(runtimeId);
}

export function findTabManagerByTabId(tabId: string): TabManager | undefined {
  return tabIndex.get(tabId);
}

export function findTabManagerByWebContents(wcId: number): TabManager | undefined {
  return wcIndex.get(wcId);
}

/**
 * sender 归属解析：
 * - 标签 BrowserView 的 WebContents 直接在 wcIndex 里；
 * - 窗口外壳的 WebContents 通过注册窗口 → managers 解析。
 */
export function getTabManagerForSender(wc: Electron.WebContents): TabManager | undefined {
  const direct = wcIndex.get(wc.id);
  if (direct) return direct;
  // 外壳 WebContents：直接和实例持有的宿主窗口比对。这样 tabs.ts 只依赖
  // window.getMainWindow()，不把 window.ts 的完整 API 变成子模块契约。
  for (const manager of managers.values()) {
    const win = manager.getHostWindow();
    if (win && win.webContents.id === wc.id) return manager;
  }
  return undefined;
}

export function getTabManagerForTabId(tabId: string): TabManager | undefined {
  return tabIndex.get(tabId);
}

/** 标签归属窗口；崩溃/挂起后没有 WebContents 也能解析（tabId → manager → 窗口）。 */
export function getTabOwnerWindow(tabId: string): BrowserWindow | null {
  return tabIndex.get(tabId)?.getHostWindow() ?? null;
}

/** 窗口关闭时销毁该窗口的全部 BrowserView 并清理三类索引。 */
export function disposeTabManager(win: BrowserWindow): void {
  const manager = managers.get(win.id);
  if (!manager) return;
  manager.destroyAll();
  managers.delete(win.id);
}

/** 仅测试用：销毁全部实例并清空注册表。 */
export function resetTabManagersForTest(): void {
  for (const manager of managers.values()) manager.destroyAll();
  managers.clear();
  tabIndex.clear();
  wcIndex.clear();
}

function fallbackManager(): TabManager | null {
  const focused = getMainWindow();
  const byFocus = focused ? managers.get(focused.id) : undefined;
  if (byFocus) return byFocus;
  return managers.values().next().value ?? null;
}

function managerForTabOrThrow(tabId: string): TabManager {
  const manager = tabIndex.get(tabId);
  if (!manager) throw new Error(`tab not found: ${tabId}`);
  return manager;
}

/**
 * 兼容 facade：保留 `export const tabManager`，让 60 处既有调用点无需改动。
 * 转发规则按计划 §6.2：tabId 作用域 → 归属实例；窗口作用域 → 聚焦窗口实例；
 * 聚合/广播遍历全部实例。
 */
const facade = {
  getRuffleForWC(wcId: number) {
    return wcIndex.get(wcId)?.getRuffleForWC(wcId) ?? null;
  },
  getActiveId() {
    return fallbackManager()?.getActiveId() ?? null;
  },
  getTabIdForWebContents(wcId: number) {
    return wcIndex.get(wcId)?.getTabIdForWebContents(wcId) ?? null;
  },
  getWebContents(tabId: string) {
    return tabIndex.get(tabId)?.getWebContents(tabId) ?? null;
  },
  hasTab(tabId: string) {
    return tabIndex.has(tabId);
  },
  isTabActive(tabId: string) {
    return tabIndex.get(tabId)?.isTabActive(tabId) ?? false;
  },
  getContainerRect() {
    return fallbackManager()?.getContainerRect() ?? { x: 0, y: 0, width: 0, height: 0 };
  },
  inspectAutomationTarget<T>(tabId: string, inspect: (webContents: Electron.WebContents) => Promise<T>): Promise<T> {
    return managerForTabOrThrow(tabId).inspectAutomationTarget(tabId, inspect);
  },
  beginAutomation(tabId: string, viewport: AutomationViewport): AutomationTabHandle {
    return managerForTabOrThrow(tabId).beginAutomation(tabId, viewport);
  },
  setPreload(path: string) {
    for (const manager of managers.values()) manager.setPreload(path);
  },
  getMemoryDiagnostics() {
    return [...managers.values()].flatMap((manager) => manager.getMemoryDiagnostics());
  },
  setBounds(x: number, y: number, width: number, height: number) {
    fallbackManager()?.setBounds(x, y, width, height);
  },
  refreshActiveViewAfterHostRestore() {
    fallbackManager()?.refreshActiveViewAfterHostRestore();
  },
  create(tabId: string, url: string, ruffleConfig?: { enabled: boolean; source: 'bundled' | 'cdn' }) {
    const manager = fallbackManager();
    if (!manager) {
      log.warn('[Tabs] tabManager.create without a window instance: ' + tabId);
      return;
    }
    manager.create(tabId, url, ruffleConfig);
  },
  setRuffleMode(tabId: string, enabled: boolean, source: 'bundled' | 'cdn') {
    tabIndex.get(tabId)?.setRuffleMode(tabId, enabled, source);
  },
  activate(tabId: string) {
    tabIndex.get(tabId)?.activate(tabId);
  },
  focusActive() {
    return fallbackManager()?.focusActive() ?? false;
  },
  close(tabId: string) {
    tabIndex.get(tabId)?.close(tabId);
  },
  suspend(tabId: string) {
    tabIndex.get(tabId)?.suspend(tabId);
  },
  destroyAll() {
    for (const manager of managers.values()) manager.destroyAll();
  },
  refreshPasswordCapture(enabled: boolean) {
    for (const manager of managers.values()) manager.refreshPasswordCapture(enabled);
  },
  notifyPasswordFormDetected(wcId: number) {
    wcIndex.get(wcId)?.notifyPasswordFormDetected(wcId);
  },
  refreshPasswordFill() {
    for (const manager of managers.values()) manager.refreshPasswordFill();
  },
  fillPassword(tabId: string, entryId: string): Promise<PasswordFillResult> {
    const manager = tabIndex.get(tabId);
    if (!manager) {
      return Promise.resolve({ success: false, filledFields: 0, filledCredentials: 0, usernames: [], reason: 'destroyed' });
    }
    return manager.fillPassword(tabId, entryId);
  },
  navigate(tabId: string, url: string) {
    tabIndex.get(tabId)?.navigate(tabId, url);
  },
  goBack(tabId: string) {
    tabIndex.get(tabId)?.goBack(tabId);
  },
  goForward(tabId: string) {
    tabIndex.get(tabId)?.goForward(tabId);
  },
  reload(tabId: string) {
    tabIndex.get(tabId)?.reload(tabId);
  },
  stop(tabId: string) {
    tabIndex.get(tabId)?.stop(tabId);
  },
  setZoom(tabId: string, factor: number) {
    tabIndex.get(tabId)?.setZoom(tabId, factor);
  },
  setMuted(tabId: string, muted: boolean) {
    tabIndex.get(tabId)?.setMuted(tabId, muted);
  },
  openDevTools(tabId: string) {
    tabIndex.get(tabId)?.openDevTools(tabId);
  },
  findInPage(tabId: string, text: string, options?: Electron.FindInPageOptions) {
    tabIndex.get(tabId)?.findInPage(tabId, text, options);
  },
  stopFindInPage(tabId: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection') {
    tabIndex.get(tabId)?.stopFindInPage(tabId, action);
  },
  getUserscriptCommandsForTab(tabId: string) {
    return tabIndex.get(tabId)?.getUserscriptCommandsForTab(tabId) ?? [];
  },
  invokeUserscriptCommand(tabId: string, commandId: string) {
    return tabIndex.get(tabId)?.invokeUserscriptCommand(tabId, commandId) ?? false;
  },
};

export const tabManager = facade as unknown as TabManager;

/**
 * P7：把标签在两个窗口实例之间迁移（不重建 WebContents、tabId 不变）。
 * 返回 false 表示来源/目标实例不存在；同一实例返回 true（由调用方做重排）。
 */
export function transferTabBetweenWindows(tabId: string, targetWin: BrowserWindow, index?: number): boolean {
  const source = tabIndex.get(tabId);
  const target = getTabManagerForWindow(targetWin.id);
  if (!source || !target) return false;
  if (source === target) return true;
  const detached = source.detachForTransfer(tabId);
  if (!detached) return false;
  target.adoptTransferred(detached, index);
  return true;
}
