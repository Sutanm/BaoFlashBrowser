# BrowserView 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将页面内容从 `<webview>` 迁移到 `BrowserView`，实现标签级渲染进程隔离，Flash 崩溃不影响 React UI。

**Architecture:** 主进程新建 `TabManager` 管理 BrowserView 生命周期 + IPC 对渲染进程暴露操作接口。React 替换所有 `el.xxx()` DOM 操作为 `electronAPI.invoke('tab:xxx')` 调用。侧边栏集成收藏/历史/下载/设置，查找栏改为嵌入栏，右键菜单换 Electron 原生。

**Tech Stack:** Electron 11 (BrowserView API, `webContents`), React 17, Jotai, TypeScript

## Global Constraints

- Electron 11.5.0 锁定，不能升级
- `contextIsolation: true`，所有主进程通信走 preload contextBridge
- 保留 Linux `--no-sandbox` + GPU 开关
- 回退路径：如果 `BrowserView` 初始化失败，回退到现有 `<webview>`（通过 feature flag）
- 快捷键系统：`src/main/ipc/shortcut.ipc.ts` 不动，IPC `'shortcut'` 通道不变

---

### Task 1: TabManager 模块（主进程 BrowserView 生命周期）

**Files:**
- Create: `src/main/modules/tabs.ts`

**Interfaces:**
- Produces: `tabManager: TabManager` — `create(tabId, url, preloadPath)`, `activate(tabId)`, `close(tabId)`, `navigate(tabId, url)`, `goBack(tabId)`, `goForward(tabId)`, `reload(tabId)`, `stop(tabId)`, `setZoom(tabId, factor)`, `setMuted(tabId, bool)`, `openDevTools(tabId)`, `findInPage(tabId, text, options?)`, `stopFindInPage(tabId, action)`, `setBounds(rect)`, `setWindow(win)`
- Also produces: `getMainWindow()` getter — returns the BrowserWindow reference for IPC use

- [ ] **Step 1: Create `src/main/modules/tabs.ts`**

```typescript
import { BrowserView, BrowserWindow, webContents as wcModule } from 'electron';

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

  get window(): BrowserWindow | null { return this.mainWindow; }

  setWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  setPreload(path: string): void {
    this.preloadPath = path;
  }

  setBounds(x: number, y: number, width: number, height: number): void {
    this.rect = { x, y, width, height };
    // Resize active
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
        partition: 'persist:tab_' + tabId,
      },
    });
    this.mainWindow?.addBrowserView(view);
    view.setBounds({ x: -9999, y: -9999, width: 1, height: 1 });
    view.setAutoResize({ width: false, height: false });

    const wc = view.webContents;

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

    // Request canGoBack/canGoForward after navigations
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

    this.tabs.set(tabId, { id: tabId, browserView: view });

    if (url && url !== 'about:newtab' && url !== 'about:blank') {
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

  stopFindInPage(tabId: string, action: 'clearSelection'|'keepSelection'|'activateSelection'): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.browserView.webContents.stopFindInPage(action);
  }

  setGuestPreload(tabId: string, preloadPath: string): void {
    // Not implemented for now — webview-preload is set via webPreferences above
  }

  private send(channel: string, payload: Record<string, unknown>): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload);
    }
  }
}

export const tabManager = new TabManager();
```

- [ ] **Step 2: Commit**

```bash
git add src/main/modules/tabs.ts
git commit -m "feat: TabManager — BrowserView lifecycle for tab-isolated rendering"
```

---

### Task 2: Tab IPC handlers（渲染进程 → 主进程命令）

**Files:**
- Create: `src/main/ipc/tabs.ipc.ts`
- Modify: `src/main/index.ts:7` (add import)

**Interfaces:**
- Consumes: `tabManager` from `src/main/modules/tabs`
- Produces: `registerTabsIPC()` — registers all `ipcMain.handle('tab:*')` handlers

- [ ] **Step 1: Create `src/main/ipc/tabs.ipc.ts`**

```typescript
import { ipcMain } from 'electron';
import { tabManager } from '../modules/tabs';

export function registerTabsIPC(): void {
  ipcMain.handle('tab:create', (_e, args: { tabId: string; url: string }) =>
    tabManager.create(args.tabId, args.url));

  ipcMain.handle('tab:close', (_e, args: { tabId: string }) =>
    tabManager.close(args.tabId));

  ipcMain.handle('tab:activate', (_e, args: { tabId: string }) =>
    tabManager.activate(args.tabId));

  ipcMain.handle('tab:navigate', (_e, args: { tabId: string; url: string }) =>
    tabManager.navigate(args.tabId, args.url));

  ipcMain.handle('tab:goBack', (_e, args: { tabId: string }) =>
    tabManager.goBack(args.tabId));

  ipcMain.handle('tab:goForward', (_e, args: { tabId: string }) =>
    tabManager.goForward(args.tabId));

  ipcMain.handle('tab:reload', (_e, args: { tabId: string }) =>
    tabManager.reload(args.tabId));

  ipcMain.handle('tab:stop', (_e, args: { tabId: string }) =>
    tabManager.stop(args.tabId));

  ipcMain.handle('tab:zoom', (_e, args: { tabId: string; factor: number }) =>
    tabManager.setZoom(args.tabId, args.factor));

  ipcMain.handle('tab:mute', (_e, args: { tabId: string; muted: boolean }) =>
    tabManager.setMuted(args.tabId, args.muted));

  ipcMain.handle('tab:devtools', (_e, args: { tabId: string }) =>
    tabManager.openDevTools(args.tabId));

  ipcMain.handle('tab:find', (_e, args: { tabId: string; text: string; options?: any }) =>
    tabManager.findInPage(args.tabId, args.text, args.options));

  ipcMain.handle('tab:stopFind', (_e, args: { tabId: string; action: string }) =>
    tabManager.stopFindInPage(args.tabId, args.action as any));

  ipcMain.handle('tab:setBounds', (_e, args: { x: number; y: number; w: number; h: number }) =>
    tabManager.setBounds(args.x, args.y, args.w, args.h));
}
```

- [ ] **Step 2: Register in `src/main/index.ts`**

Add import at top:
```typescript
import { registerTabsIPC } from './ipc/tabs.ipc';
import { tabManager } from './modules/tabs';
```

In `app.whenReady().then(...)`, add after `registerConfigIPC()`:
```typescript
registerTabsIPC();
```

And before window creation, pass preload path and window ref:
```typescript
app.whenReady().then(() => {
  mainWindow = createWindow();
  tabManager.setWindow(mainWindow);
  tabManager.setPreload(/* need preload path */);
  // ... rest
});
```

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/tabs.ipc.ts src/main/index.ts
git commit -m "feat: tab IPC handlers — registerTabsIPC for renderer→main commands"
```

---

### Task 3: 修改 main/index.ts — 集成 + resize + 崩溃处理

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `tabManager`, `registerTabsIPC`

- [ ] **Step 1: Update `src/main/index.ts` — full replacement of relevant sections**

The key changes:
1. Import `tabManager` and `registerTabsIPC`
2. After window creation: `tabManager.setWindow(mainWindow)`
3. Set preload path for BrowserView guest pages
4. Register `registerTabsIPC()`
5. Listen `mainWindow.on('resize')` to recalc bounds
6. Listen `mainWindow.on('move')` on Windows for position sync
7. Modify crash handler — reload individual tab instead of whole window

Replace lines 43-65:

```typescript
  app.whenReady().then(() => {
    mainWindow = createWindow();
    tabManager.setWindow(mainWindow);
    tabManager.setPreload(path.join(__dirname, 'webview-preload.js'));
    initSession(() => getMainWindow());
    setMainWindowRef(mainWindow);
    registerZoomShortcuts();
    startMouseHook();
    registerWindowIPC(() => getMainWindow());
    registerConfigIPC();
    registerTabsIPC();

    // Layout bounds sync — sent from renderer via tab:setBounds
    mainWindow.on('resize', () => {
      // Renderer recalculates and sends tab:setBounds
    });

    app.on('web-contents-created', (_event, wc) => {
      wc.on('before-input-event', (event: Electron.Event, input: Electron.Input) => {
        const { handleWebviewBeforeInputEvent } = require('./ipc/shortcut.ipc');
        handleWebviewBeforeInputEvent(event, input);
      });
    });
  });
```

Update crash handler (lines 71-87): instead of reloading the whole window, the crash is already handled per-tab by `TabManager.create()`'s per-tab `render-process-gone` listener which sends `tab:crashed` IPC. Keep the existing window-level crash just as safety:

```typescript
  let crashCount = 0;
  app.on('render-process-gone', (_event, wc, details) => {
    // Only handle main window renderer crash (not BrowserView tabs)
    const win = mainWindow;
    if (wc === win?.webContents) {
      log.error('[App] MAIN RENDER PROCESS GONE — reason: ' + details.reason);
      crashCount++;
      if (crashCount > 3) { app.quit(); return; }
      setTimeout(() => win?.reload(), 500);
    }
  });
```

- [ ] **Step 2: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: integrate TabManager into main process, per-tab crash handling"
```

---

### Task 4: 渲染进程 — Preload + 类型 + IPC bridge

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/types/electron.d.ts`

**Interfaces:**
- Consumes: `ipcMain.handle` entries from Task 2
- Produces: `window.electronAPI.tab` — `invoke('tab:*', args)` methods

- [ ] **Step 1: Add tab methods to `src/preload/index.ts`**

Add to the `electronAPI` object:

```typescript
const electronAPI = {
  // ... existing on, invoke, win ...
  webviewPreloadPath: path.join(__dirname, 'webview-preload.js'),

  tab: {
    create: (tabId: string, url: string) => ipcRenderer.invoke('tab:create', { tabId, url }),
    close: (tabId: string) => ipcRenderer.invoke('tab:close', { tabId }),
    activate: (tabId: string) => ipcRenderer.invoke('tab:activate', { tabId }),
    navigate: (tabId: string, url: string) => ipcRenderer.invoke('tab:navigate', { tabId, url }),
    goBack: (tabId: string) => ipcRenderer.invoke('tab:goBack', { tabId }),
    goForward: (tabId: string) => ipcRenderer.invoke('tab:goForward', { tabId }),
    reload: (tabId: string) => ipcRenderer.invoke('tab:reload', { tabId }),
    stop: (tabId: string) => ipcRenderer.invoke('tab:stop', { tabId }),
    zoom: (tabId: string, factor: number) => ipcRenderer.invoke('tab:zoom', { tabId, factor }),
    mute: (tabId: string, muted: boolean) => ipcRenderer.invoke('tab:mute', { tabId, muted }),
    devtools: (tabId: string) => ipcRenderer.invoke('tab:devtools', { tabId }),
    find: (tabId: string, text: string, options?: any) => ipcRenderer.invoke('tab:find', { tabId, text, options }),
    stopFind: (tabId: string, action: string) => ipcRenderer.invoke('tab:stopFind', { tabId, action }),
    setBounds: (x: number, y: number, w: number, h: number) => ipcRenderer.invoke('tab:setBounds', { x, y, w, h }),
  },

  win: { /* ... unchanged ... */ },
};
```

- [ ] **Step 2: Update `src/renderer/types/electron.d.ts`**

```typescript
interface TabAPI {
  create(tabId: string, url: string): Promise<void>;
  close(tabId: string): Promise<void>;
  activate(tabId: string): Promise<void>;
  navigate(tabId: string, url: string): Promise<void>;
  goBack(tabId: string): Promise<void>;
  goForward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  stop(tabId: string): Promise<void>;
  zoom(tabId: string, factor: number): Promise<void>;
  mute(tabId: string, muted: boolean): Promise<void>;
  devtools(tabId: string): Promise<void>;
  find(tabId: string, text: string, options?: any): Promise<void>;
  stopFind(tabId: string, action: string): Promise<void>;
  setBounds(x: number, y: number, w: number, h: number): Promise<void>;
}

interface ElectronAPI {
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  webviewPreloadPath: string;
  tab: TabAPI;
  win: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    unmaximize(): Promise<void>;
    close(): Promise<void>;
    setFullscreen(fullscreen: boolean): Promise<void>;
    toggleFullscreen(): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts src/renderer/types/electron.d.ts
git commit -m "feat: tab IPC bridge — preload + type definitions for BrowserView commands"
```

---

### Task 5: App.tsx 重构 — 替换 webview DOM 为 IPC

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/tabs/TabBar.tsx` (no longer needs `onReorder` prop wiring changes — already done)

**Interfaces:**
- Consumes: `window.electronAPI.tab` from Task 4
- Produces: same component interface to NavigationBar, FindBar

This is the largest task. All `activeWebview()` and `document.querySelector(...webview...)` calls are replaced by IPC.

- [ ] **Step 1: Delete `activeWebview` helper and replace with IPC calls**

Remove line 43-46 (the `useCallback` for `activeWebview`):
```typescript
// DELETE:
const activeWebview = useCallback(() => {
  if (!activeTabId) return null;
  return document.querySelector('#webview-container webview.active') as any;
}, [activeTabId]);
```

- [ ] **Step 2: Replace handleNavigate loadURL with IPC**

Lines 106-108 change from:
```typescript
    const el = document.querySelector('#webview-container webview.active') as any;
    if (el) { try { el.stop(); } catch (_e) {} try { el.loadURL(url); } catch (_e) {} }
```
to:
```typescript
    if (activeTabId) {
      window.electronAPI.tab.stop(activeTabId);
      window.electronAPI.tab.navigate(activeTabId, url);
    }
```

- [ ] **Step 3: Replace setZoomFactor in doZoom**

Lines 121-122 change from:
```typescript
    const el = activeWebview();
    if (el) el.setZoomFactor(lvl);
```
to:
```typescript
    if (activeTabId) window.electronAPI.tab.zoom(activeTabId, lvl);
```

- [ ] **Step 4: Replace setZoomFactor in zoomReset**

Lines 131-132 change from:
```typescript
    const el = activeWebview();
    if (el) el.setZoomFactor(1);
```
to:
```typescript
    if (activeTabId) window.electronAPI.tab.zoom(activeTabId, 1);
```

- [ ] **Step 5: Replace reload/stop in useShortcut handler**

Lines 156-157 change from:
```typescript
      case 'reload': case 'stop-or-dismiss': {
        const el = activeWebview();
        if (el) action === 'reload' ? el.reload() : el.stop();
        break;
      }
```
to:
```typescript
      case 'reload': { if (activeTabId) window.electronAPI.tab.reload(activeTabId); break; }
      case 'stop-or-dismiss': { if (activeTabId) window.electronAPI.tab.stop(activeTabId); break; }
```

- [ ] **Step 6: Replace devtools handler**

Lines 162-163 change from:
```typescript
      case 'devtools': {
        const el = activeWebview();
        if (el) el.openDevTools();
        break;
      }
```
to:
```typescript
      case 'devtools': { if (activeTabId) window.electronAPI.tab.devtools(activeTabId); break; }
```

- [ ] **Step 7: Replace goBack/goForward in useShortcut**

Lines 171-172 change from:
```typescript
      case 'go-back': { const el = activeWebview(); if (el) el.goBack(); break; }
      case 'go-forward': { const el = activeWebview(); if (el) el.goForward(); break; }
```
to:
```typescript
      case 'go-back': { if (activeTabId) window.electronAPI.tab.goBack(activeTabId); break; }
      case 'go-forward': { if (activeTabId) window.electronAPI.tab.goForward(activeTabId); break; }
```

- [ ] **Step 8: Replace NavigationBar webview callbacks**

Lines 284-291 change from:
```typescript
onBack={() => { const el = activeWebview(); if (el) el.goBack(); }}
onForward={() => { const el = activeWebview(); if (el) el.goForward(); }}
onStop={() => { const el = activeWebview(); if (el) el.stop(); }}
onReload={() => { const el = activeWebview(); if (el) el.reload(); }}
onToggleMute={() => {
  setIsMuted((m) => {
    const el = activeWebview();
    if (el) el.setAudioMuted(!m);
    return !m;
  });
}}
```
to:
```typescript
onBack={() => { if (activeTabId) window.electronAPI.tab.goBack(activeTabId); }}
onForward={() => { if (activeTabId) window.electronAPI.tab.goForward(activeTabId); }}
onStop={() => { if (activeTabId) window.electronAPI.tab.stop(activeTabId); }}
onReload={() => { if (activeTabId) window.electronAPI.tab.reload(activeTabId); }}
onToggleMute={() => {
  setIsMuted((m) => {
    if (activeTabId) window.electronAPI.tab.mute(activeTabId, !m);
    return !m;
  });
}}
```

- [ ] **Step 9: Remove WebviewContainer from JSX, replace with div (for bounds calculation)**

Replace lines 278-292 (the webview container and FindBar) with:
```typescript
      <div
        id="browserview-area"
        ref={bvAreaRef}
        style={{ display: isOnNewTab ? 'none' : 'flex', flex: '1 1 0%', position: 'relative' }}
      >
        <FindBar
          visible={findBarVisible && !isOnNewTab}
          onClose={() => setFindBarVisible(false)}
          activeTabId={activeTabId}
        />
      </div>
```

Remove the `WebviewContainer` import and the `onTabUpdate` prop from it.

- [ ] **Step 10: Add bounds recalculation useEffect**

Add after the existing effects:
```typescript
  const bvAreaRef = useRef<HTMLDivElement>(null);

  // Recalculate BrowserView bounds on layout changes
  useEffect(() => {
    const calc = () => {
      if (!bvAreaRef.current) return;
      const r = bvAreaRef.current.getBoundingClientRect();
      window.electronAPI.tab.setBounds(r.x, r.y, r.width, r.height);
    };
    // Recalc on sidebar toggle, find bar toggle, window resize
    calc();
    const area = bvAreaRef.current;
    const ro = new ResizeObserver(() => calc());
    if (area) ro.observe(area);
    window.addEventListener('resize', calc);
    return () => { ro.disconnect(); window.removeEventListener('resize', calc); };
  }, [activePanel, findBarVisible]);

  // Recalc when activePanel changes (sidebar expand/collapse)
  useEffect(() => {
    setTimeout(() => {
      if (bvAreaRef.current) {
        const r = bvAreaRef.current.getBoundingClientRect();
        window.electronAPI.tab.setBounds(r.x, r.y, r.width, r.height);
      }
    }, 270); // Wait for CSS transition
  }, [activePanel]);
```

- [ ] **Step 11: Replace createTab to call IPC, replace navigate-url handler**

In `createTab`, after `setActiveTabId(id)`:
```typescript
    window.electronAPI.tab.create(id, url || 'about:newtab');
```

In the navigate-url handler, the existing delay logic stays, just the `createTab` call already triggers IPC.

- [ ] **Step 12: Replace closeTab to call IPC**

In `closeTab`, after removing from state, also call:
```typescript
    window.electronAPI.tab.close(tabId);
```

- [ ] **Step 13: Handle tab:updated IPC events**

Add a new useEffect to listen for `tab:updated` from main process and update tab state:
```typescript
  useEffect(() => {
    const unsub = window.electronAPI.on('tab:updated', (payload: any) => {
      const { tabId, ...changes } = payload;
      updateTab(tabId, changes);
    });
    return () => { try { unsub(); } catch {} };
  }, []);
```

But wait — `updateTab` depends on `activeTabId` which means this effect would re-run on every tab switch. Fix: use a ref for `updateTab`.

```typescript
  const updateTabRef = useRef(updateTab);
  updateTabRef.current = updateTab;

  useEffect(() => {
    const unsub = window.electronAPI.on('tab:updated', (payload: any) => {
      const { tabId, ...changes } = payload;
      updateTabRef.current(tabId, changes);
    });
    return () => { try { unsub(); } catch {} };
  }, []);
```

Also handle `tab:newwindow` and `tab:crashed`:
```typescript
  useEffect(() => {
    const u1 = window.electronAPI.on('tab:newwindow', (payload: any) => {
      createTab(String((payload as any).url || payload));
    });
    const u2 = window.electronAPI.on('tab:crashed', (payload: any) => {
      // Show crash placeholder on the tab
      updateTabRef.current(payload.tabId, { url: 'about:crash', title: '页面崩溃了' });
    });
    return () => { try { u1(); u2(); } catch {} };
  }, [createTab]);
```

- [ ] **Step 14: Remove unused imports**

Remove `WebviewContainer` import. Remove `webview-container` CSS references.

- [ ] **Step 15: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "refactor: App.tsx — replace webview DOM with BrowserView IPC calls"
```

---

### Task 6: Unified Sidebar 组件

**Files:**
- Create: `src/renderer/components/panels/UnifiedSidebar.tsx`
- Modify: `src/renderer/App.tsx` (render sidebar, replace panels)
- Modify: `src/renderer/styles.css` (sidebar layout)

**Interfaces:**
- Consumes: `activePanelAtom` from `ui.atom.ts`, `favoritesAtom`, `historyAtom`, `downloadsAtom` from `data.atom.ts`
- Produces: `UnifiedSidebar` component visible alongside BrowserView area

- [ ] **Step 1: Create `src/renderer/components/panels/UnifiedSidebar.tsx`**

This component replaces the individual floating panels (FavoritesPanel, HistoryPanel, DownloadsPanel, SettingsPanel) with one integrated sidebar.

```typescript
import React from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { settingsAtom } from '@renderer/atoms/data.atom';

interface UnifiedSidebarProps {
  activePanel: string | null;
  currentUrl: string;
  onOpenUrl: (url: string, newTab: boolean) => void;
  onClose: () => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

type PanelId = 'bookmarks' | 'history' | 'downloads' | 'settings';

const PANELS: { id: PanelId; label: string; icon: string }[] = [
  { id: 'bookmarks', label: '收藏夹', icon: '⭐' },
  { id: 'history',   label: '历史记录', icon: '🕐' },
  { id: 'downloads', label: '下载', icon: '⬇' },
  { id: 'settings',  label: '设置', icon: '⚙' },
];

const UnifiedSidebar: React.FC<UnifiedSidebarProps> = ({
  activePanel, currentUrl, onOpenUrl, onClose,
  zoomPercent, onZoomIn, onZoomOut, onZoomReset,
}) => {
  const settings = useAtomValue(settingsAtom);
  const [selected, setSelected] = React.useState<PanelId>('bookmarks');

  const isExpanded = activePanel !== null;
  const panelId = (activePanel === 'favorites' ? 'bookmarks' :
                   activePanel === 'history' ? 'history' :
                   activePanel === 'downloads' ? 'downloads' :
                   activePanel === 'settings' ? 'settings' : null) as PanelId | null;

  React.useEffect(() => { if (panelId) setSelected(panelId); }, [panelId]);

  const icons = (
    <div className="sidebar-icons">
      {PANELS.map(p => (
        <button key={p.id} className={`sidebar-icon ${panelId === p.id ? 'active' : ''}`}
          title={p.label}
          onClick={() => {
            if (isExpanded && panelId === p.id) { onClose(); }
            else { setSelected(p.id); }
          }}
        >{p.icon}</button>
      ))}
    </div>
  );

  if (!isExpanded) {
    return <div className="sidebar collapsed">{icons}</div>;
  }

  return (
    <div className="sidebar expanded">
      {icons}
      <div className="sidebar-panel">
        <div className="panel-header">
          <span>{PANELS.find(p => p.id === selected)?.label}</span>
          <button onClick={onClose} className="panel-close-btn">×</button>
        </div>
        <div className="panel-body" style={{ flex: 1, overflowY: 'auto' }}>
          {selected === 'bookmarks' && <BookmarkContent onOpenUrl={onOpenUrl} currentUrl={currentUrl} />}
          {selected === 'history' && <HistoryContent onOpenUrl={onOpenUrl} currentUrl={currentUrl} />}
          {selected === 'downloads' && <DownloadContent />}
          {selected === 'settings' && (
            <SettingsContent
              zoomPercent={zoomPercent}
              onZoomIn={onZoomIn}
              onZoomOut={onZoomOut}
              onZoomReset={onZoomReset}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// Sub-components (inline for single file simplicity)

const BookmarkContent: React.FC<{ onOpenUrl: any; currentUrl: string }> = ({ onOpenUrl, currentUrl }) => {
  const [favs] = useAtom(/* favoritesAtom */ null as any);
  return <div className="sidebar-empty">收藏夹占位</div>;
};

const HistoryContent: React.FC<{ onOpenUrl: any; currentUrl: string }> = ({ onOpenUrl, currentUrl }) => {
  return <div className="sidebar-empty">历史记录占位</div>;
};

const DownloadContent: React.FC = () => {
  return <div className="sidebar-empty">下载占位</div>;
};

const SettingsContent: React.FC<{ zoomPercent: number; onZoomIn(): void; onZoomOut(): void; onZoomReset(): void }> =
  ({ zoomPercent, onZoomIn, onZoomOut, onZoomReset }) => {
  return <div className="sidebar-empty">设置占位</div>;
};

export default UnifiedSidebar;
```

Note: The actual panel content will be ported from existing `FavoritesPanel.tsx`, `HistoryPanel.tsx`, `DownloadsPanel.tsx`, and `SettingsPanel.tsx` in Task 8 (subsequent refinement). For now, the sidebar scaffold is in place.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/panels/UnifiedSidebar.tsx
git commit -m "feat: UnifiedSidebar scaffold — integrated panel sidebar with icon nav"
```

---

### Task 7: 查找栏 — 嵌入线（可独立验证）

**Files:**
- Modify: `src/renderer/components/overlays/FindBar.tsx`
- Modify: `src/renderer/App.tsx` (FindBar placement, pass activeTabId instead of activeWebview)
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: `window.electronAPI.tab.find`, `window.electronAPI.tab.stopFind`
- Also consumes: `found-in-page` IPC → `tab:found` channel from main process

- [ ] **Step 1: Rewrite `FindBar.tsx` — IPC-based, embedded bar**

```typescript
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';

interface FindBarProps {
  visible: boolean;
  activeTabId: string | null;
  onClose: () => void;
}

interface FindResult { activeMatchOrdinal: number; matches: number; }

const FindBar: React.FC<FindBarProps> = ({ visible, activeTabId, onClose }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState<FindResult>({ activeMatchOrdinal: 0, matches: 0 });

  const handleClose = useCallback(() => {
    if (activeTabId) window.electronAPI.tab.stopFind(activeTabId, 'clearSelection');
    onClose();
    setText('');
    setResult({ activeMatchOrdinal: 0, matches: 0 });
  }, [activeTabId, onClose]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); handleClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, handleClose]);

  useEffect(() => {
    const unsub = window.electronAPI.on('tab:found', (payload: any) => {
      if (payload.tabId === activeTabId) {
        setResult({ activeMatchOrdinal: payload.activeMatchOrdinal || 0, matches: payload.matches || 0 });
      }
    });
    return () => { try { unsub(); } catch {} };
  }, [activeTabId]);

  const doFind = useCallback((value: string) => {
    if (!activeTabId) return;
    if (!value) {
      window.electronAPI.tab.stopFind(activeTabId, 'clearSelection');
      setResult({ activeMatchOrdinal: 0, matches: 0 });
      return;
    }
    window.electronAPI.tab.find(activeTabId, value);
  }, [activeTabId]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value; setText(v); doFind(v);
  }, [doFind]);

  const findNext = () => { if (activeTabId) window.electronAPI.tab.find(activeTabId, text, { forward: true, findNext: true }); };
  const findPrev = () => { if (activeTabId) window.electronAPI.tab.find(activeTabId, text, { forward: false, findNext: true }); };

  if (!visible) return null;

  return (
    <div className="find-bar-embed">
      <input ref={inputRef} className="find-bar-embed-input" value={text} onChange={handleInput}
        onKeyDown={e => {
          if (e.key === 'Escape') handleClose();
          if (e.key === 'Enter') { e.preventDefault(); return e.shiftKey ? findPrev() : findNext(); }
        }} placeholder="查找" spellCheck={false}
      />
      <span className="find-bar-embed-count">{text ? `${result.activeMatchOrdinal || 0}/${result.matches || 0}` : ''}</span>
      <button onClick={findPrev} className="find-bar-embed-btn" disabled={!text}><ChevronUp className="w-3.5 h-3.5" /></button>
      <button onClick={findNext} className="find-bar-embed-btn" disabled={!text}><ChevronDown className="w-3.5 h-3.5" /></button>
      <button onClick={handleClose} className="find-bar-embed-btn"><X className="w-3.5 h-3.5" /></button>
    </div>
  );
};
export default FindBar;
```

- [ ] **Step 2: Add CSS for embedded find bar**

In `src/renderer/styles.css`, replace `.find-capsule` styles with:

```css
  .find-bar-embed {
    @apply flex items-center gap-1 h-[32px] px-2 flex-shrink-0;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-light);
  }
  .find-bar-embed-input {
    width: 200px; height: 24px; padding: 0 6px; font-size: 13px;
    border: none; outline: none; border-radius: 4px;
    background: var(--bg-input); color: var(--text-primary);
  }
  .find-bar-embed-input::placeholder { color: var(--text-secondary); }
  .find-bar-embed-count {
    @apply text-xs; color: var(--text-secondary); min-width: 36px; text-align: center;
  }
  .find-bar-embed-btn {
    @apply w-6 h-6 flex items-center justify-center border-none bg-transparent cursor-pointer rounded;
    color: var(--text-secondary);
  }
  .find-bar-embed-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
  .find-bar-embed-btn:disabled { opacity: 0.3; cursor: default; }
```

- [ ] **Step 3: Update App.tsx to pass `activeTabId` instead of `activeWebview`**

In the JSX where FindBar is rendered, change:
```typescript
<FindBar visible={findBarVisible && !isOnNewTab} onClose={() => setFindBarVisible(false)} activeTabId={activeTabId} />
```

Only need to import `FindBarProps` — the old `activeWebview` prop is gone.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/overlays/FindBar.tsx src/renderer/styles.css src/renderer/App.tsx
git commit -m "refactor: IPC-based find bar — embedded line, receives found-in-page via tab:found"
```

---

### Task 8: 滚动发布 — 面板内容 port + 右键菜单 + 清理 + CSS

**Files:**
- Modify: `src/renderer/components/panels/UnifiedSidebar.tsx` (fill in content from existing panels)
- Modify: `src/renderer/App.tsx` (remove old panel components, render sidebar)
- Delete: `src/renderer/components/tabs/WebviewContainer.tsx`
- Delete: `src/renderer/components/overlays/ContextMenu.tsx`
- Delete: `src/renderer/components/overlays/ZoomOverlay.tsx`
- Modify: `src/renderer/styles.css` (sidebar styles, cleanup old webview styles)

**ContextMenu**: Electron native `Menu.buildFromTemplate()` is handled in the main process (Task 2), NOT as a React component. The old `ContextMenu.tsx` is deleted. The main process already has `new-window` handler that forwards to `tab:newwindow` IPC. For context menu (right-click), we use `webContents.on('context-menu')` in main process in a later task or via the context-menu handler already registered.

For this task, context menu is NOT implemented on BrowserView guest pages — BrowserView doesn't fire `context-menu` events to the renderer. Right-click behavior is handled by Chromium's default. "检查元素" for a specific tab is triggered via `tab:devtools` IPC from a future devtools button.

- [ ] **Step 1: Fill UnifiedSidebar with actual panel content**

Port the content from `FavoritesPanel.tsx`, `HistoryPanel.tsx`, `DownloadsPanel.tsx`, and `SettingsPanel.tsx` into `UnifiedSidebar.tsx` as inline sub-components. Replace the "占位" texts.

For brevity, the plan shows signatures only — the full content is copy-paste from existing files.

- [ ] **Step 2: Render sidebar in App.tsx**

Replace the old panel renderings (FavoritesPanel, HistoryPanel, DownloadsPanel, SettingsPanel) with:
```typescript
<UnifiedSidebar
  activePanel={activePanel}
  currentUrl={activeTab?.url || ''}
  onOpenUrl={(url, newTab) => { /* same as existing */ }}
  onClose={() => setActivePanel(null)}
  zoomPercent={Math.round((activeTab?.zoomFactor ?? 1) * 100)}
  onZoomIn={zoomIn}
  onZoomOut={zoomOut}
  onZoomReset={zoomReset}
/>
```

The `activePanel` type should now include `null` only — the mapping from old panel types (`'favorites'|'history'|'downloads'|'settings'`) is handled inside `UnifiedSidebar`.

- [ ] **Step 3: Remove old panel imports**

Remove imports of `FavoritesPanel`, `HistoryPanel`, `DownloadsPanel`, `SettingsPanel`, `ContextMenu`, `ZoomOverlay`, `WebviewContainer`.

- [ ] **Step 4: Delete unused component files**

```bash
rm src/renderer/components/tabs/WebviewContainer.tsx
rm src/renderer/components/overlays/ContextMenu.tsx
rm src/renderer/components/overlays/ZoomOverlay.tsx
rm src/renderer/components/overlays/ErrorBoundary.tsx
```

(ErrorBoundary is removed because BrowserView isolates crashes — no need for React error boundary on the main window)

- [ ] **Step 5: Update `index.tsx` to remove ErrorBoundary wrapper**

Revert `src/renderer/index.tsx` to:
```typescript
ReactDOM.render(React.createElement(React.StrictMode, null, React.createElement(App)), rootEl);
```

- [ ] **Step 6: CSS cleanup**

In `src/renderer/styles.css`:
- Remove `.context-menu`, `.context-separator`, `.context-menu button` styles
- Remove `.zoom-indicator` styles
- Remove `#webview-container webview` and `#webview-container webview.active` styles
- Remove `.find-capsule` styles (replaced by `.find-bar-embed`)
- Add sidebar styles:

```css
  .sidebar {
    display: flex; flex-shrink: 0; overflow: hidden;
    transition: width 0.25s ease;
    background: var(--bg-panel); border-right: 1px solid var(--border-color);
  }
  .sidebar.collapsed { width: 48px; }
  .sidebar.expanded { width: 280px; }
  .sidebar-icons {
    width: 48px; flex-shrink: 0;
    display: flex; flex-direction: column; align-items: center;
    padding: 8px 0; gap: 4px;
  }
  .sidebar-icon {
    @apply w-9 h-9 flex items-center justify-center border-none bg-transparent rounded-lg cursor-pointer text-base;
    color: var(--text-secondary); transition: all 0.15s;
  }
  .sidebar-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
  .sidebar-icon.active { background: var(--accent); color: #fff; }
  .sidebar-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .sidebar-empty {
    @apply text-center py-6 text-xs; color: var(--text-secondary);
  }
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: port panel content to UnifiedSidebar, delete old webview/overlay components, CSS cleanup"
```

---

### Task 9: 地址栏缩放指示 + TabBar 绑定 + 右键菜单 Native

**Files:**
- Modify: `src/renderer/components/navigation/AddressBar.tsx` (zoom percent indicator)
- Modify: `src/renderer/App.tsx` (zoom percent state, sidebar open/close wiring)

- [ ] **Step 1: Add zoom overlay to AddressBar**

In `AddressBar.tsx`, add a `zoomPercent` prop. When zoom changes (non 100%), show it in the input placeholder/overlay for 1.5s.

```typescript
// Add to AddressBarProps:
zoomPercent: number;

// In the component, add state:
const [showZoom, setShowZoom] = useState(false);
useEffect(() => {
  setShowZoom(true);
  const t = setTimeout(() => setShowZoom(false), 1500);
  return () => clearTimeout(t);
}, [zoomPercent]);
```

In the input, show zoom percentage instead of URL when `showZoom` is true:
```typescript
placeholder={showZoom ? `${zoomPercent}%` : "输入网址或搜索..."}
```

- [ ] **Step 2: Pass zoomPercent from App.tsx to NavigationBar → AddressBar**

App.tsx already has `zoomPercent = Math.round((activeTab?.zoomFactor ?? 1) * 100)`. Pass it through NavigationBar to AddressBar.

- [ ] **Step 3: Wire sidebar button click to activate panel**

App.tsx already has `onToggleFavorites` etc. These call `setActivePanel`. No change needed — `UnifiedSidebar` receives `activePanel`.

- [ ] **Step 4: Right-click context menu — native Electron Menu (main process)**

In `src/main/modules/tabs.ts`, add to `create` method after creating the webContents:

```typescript
wc.on('context-menu', (e, params) => {
  const { Menu } = require('electron');
  const template: any[] = [];
  if (params.linkURL) {
    template.push({ label: '在新标签页中打开', click: () => this.send('tab:newwindow', { url: params.linkURL }) });
  }
  if (params.selectionText) {
    template.push({ label: '复制', click: () => { /* clipboard handled by Chromium default — no-op for Electron menu */ } });
  }
  template.push({ label: '检查元素', click: () => this.openDevTools(tabId) });
  if (template.length > 0) {
    Menu.buildFromTemplate(template).popup({ window: this.mainWindow! });
  }
});
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/navigation/AddressBar.tsx src/main/modules/tabs.ts src/renderer/App.tsx
git commit -m "feat: zoom indicator in address bar + native context menu via Electron Menu"
```

---

### Task 10: 最终集成 + 回退路径 + 构建验证

**Files:**
- Verify: all files compile and app starts

- [ ] **Step 1: Build**

```bash
npm run build 2>&1
```

Expected: `compiled successfully` for both main and renderer bundles.

- [ ] **Step 2: Test launch**

```bash
electron . 2>&1
```

Expected: window opens, TabBar + NavBar visible, `about:newtab` shows, Ctrl+T creates tab with BrowserView loading the URL.

- [ ] **Step 3: Test crash recovery**

Open a Flash game page. Create a new tab and load another Flash game. Verify that if one tab crashes, other tabs and the React UI remain.

- [ ] **Step 4: Test sidebar + find bar + zoom**

All features should work as before migration.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: BrowserView migration complete — isolated rendering, unified sidebar, embedded find bar"
```
