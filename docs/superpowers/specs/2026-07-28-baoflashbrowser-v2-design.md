# BaoFlashBrowser 2.0 — 完整设计文档

> 日期：2026-07-28
> 状态：设计阶段，待审批
> 基于：BaoFlashBrowser v1.0.0（Electron 11 / Chromium 87）

---

## 1. 背景与动机

当前 v1.0.0 版本经全面审计，检出 **60+ 项问题**。核心矛盾：

- **Flash PPAPI 需要 Chromium 87**（Electron 11），这是最后一个支持原生 Flash 的内核
- **现代浏览器体验需要更新内核**，但二者在 Electron 中互斥
- 当前项目 vanilla JS + DOM 操作架构无法支撑扩展性需求

### 核心理念

**主浏览器锁定 Electron 11 / Chromium 87**，全部功能在其上实现。HTML5 性能瓶颈场景通过「用新内核打开」独立窗口远期解决。Flash 游戏是首先场景，不能降级为二等公民。

---

## 2. 架构决策

### 2.1 技术栈变更

| 层级 | v1.0.0（旧） | v2.0（新） | 变更原因 |
|------|------------|-----------|---------|
| 语言 | JavaScript | **TypeScript** | IPC 契约 / 状态原子 / API 调用全面类型安全 |
| UI 框架 | vanilla JS + DOM | **React 17** | 30+ 新 UI 组件手动 DOM 操作不可维护 |
| 状态管理 | 全局可变对象 `state.js` | **Jotai** | 原子化、零 Provider 模板、跨多 React root 共享 |
| 本地存储 | localStorage | **nedb** (内嵌) | 数据量增大后 localStorage 无查询能力 |
| 构建 | Webpack 5 | Webpack 5（从零配置） | 保留但配置重写 |
| 样式 | Tailwind CSS | Tailwind CSS（保留） | 不变 |
| 测试 | 无 | **Jest + React Testing Library + Playwright** | 从第 0 天就位 |

### 2.2 Electron 版本锁定

**Electron 11.5.0 / Chromium 87** 不可升级。Chromium 88 从源码删除了 Flash PPAPI 管道，87 是硬天花板。

### 2.3 全新项目 vs 旧项目重构

**选择：全新项目。** 旧项目 2,570 行 renderer 代码在 React + TypeScript 下会大幅压缩（DOM 操作行数砍掉 60%），开发时间与重构持平但得到类型安全、测试、零遗留。需从旧项目复制的仅有 4 个独立 main 进程模块 + 资源文件。

---

## 3. 项目结构

```
bao-flash-browser-v2/
├── package.json
├── tsconfig.json
├── tsconfig.main.json
├── tsconfig.renderer.json
├── webpack.main.config.js
├── webpack.renderer.config.js
├── .eslintrc.js
├── .prettierrc
├── tailwind.config.js
├── postcss.config.js
│
├── src/
│   ├── shared/                         # 主进程 + 渲染进程共享的类型
│   │   └── types/
│   │       ├── ipc.ts                   # IPC 通道名 & 契约类型
│   │       ├── tab.ts                   # 标签页数据结构
│   │       ├── bookmarks.ts             # 书签
│   │       ├── history.ts              # 历史记录
│   │       ├── downloads.ts            # 下载项
│   │       └── settings.ts             # 设置项
│   │
│   ├── main/                            # Electron 主进程
│   │   ├── index.ts                     # app 入口
│   │   ├── ipc/                         # IPC handler 注册
│   │   │   ├── shortcut.ipc.ts          # 快捷键白名单 → renderer 转发
│   │   │   ├── tabs.ipc.ts              # 标签页操作
│   │   │   ├── data.ipc.ts              # 持久化数据 CRUD
│   │   │   ├── page.ipc.ts              # 页面操作（打印/保存/检查）
│   │   │   └── window.ipc.ts            # 窗口操作
│   │   ├── modules/                     # 从旧项目复制的独立模块
│   │   │   ├── flash.ts                 # PPAPI Flash 加载器（+ 类型注解）
│   │   │   ├── session.ts              # Chrome 87 UA + 缓存
│   │   │   ├── dpapi.ts                # Windows DPAPI 封装
│   │   │   ├── password-store.ts       # AES-256-GCM 密码库
│   │   │   ├── config.ts               # electron-store 封装
│   │   │   └── window.ts               # BrowserWindow 创建 + DevTools
│   │   └── services/
│   │       ├── history.store.ts         # nedb 历史记录
│   │       ├── bookmark.store.ts        # nedb 书签
│   │       ├── download.manager.ts      # 下载队列管理
│   │       └── browser-data.ts          # 清除浏览数据
│   │
│   ├── preload/
│   │   └── index.ts                     # 主窗口 contextBridge API 契约
│   │
│   ├── webview-preload/
│   │   └── index.ts                     # 注入 <webview> 内部（登录捕获、表单填充）
│   │
│   ├── renderer/                        # React 应用
│   │   ├── index.html
│   │   ├── index.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── shell/
│   │   │   │   ├── TitleBar.tsx
│   │   │   │   └── WindowControls.tsx
│   │   │   ├── tabs/
│   │   │   │   ├── TabBar.tsx
│   │   │   │   ├── TabItem.tsx
│   │   │   │   ├── TabAudioIndicator.tsx
│   │   │   │   ├── TabContextMenu.tsx
│   │   │   │   ├── NewTabButton.tsx
│   │   │   │   └── WebviewContainer.tsx
│   │   │   ├── navigation/
│   │   │   │   ├── NavigationBar.tsx
│   │   │   │   ├── AddressBar.tsx
│   │   │   │   ├── AddressSuggestions.tsx
│   │   │   │   ├── BackForwardButtons.tsx
│   │   │   │   ├── ReloadButton.tsx
│   │   │   │   ├── BookmarkStar.tsx
│   │   │   │   └── HomeButton.tsx
│   │   │   ├── newtab/
│   │   │   │   ├── NewTabPage.tsx         # 新标签页（React 组件，替换 webview 渲染区）
│   │   │   │   ├── SearchBox.tsx
│   │   │   │   ├── QuickLinks.tsx
│   │   │   │   └── BookmarkBar.tsx
│   │   │   ├── panels/
│   │   │   │   ├── FavoritesPanel.tsx
│   │   │   │   ├── HistoryPanel.tsx
│   │   │   │   ├── DownloadsPanel.tsx
│   │   │   │   ├── SettingsPanel.tsx
│   │   │   │   └── PasswordPanel.tsx
│   │   │   ├── overlays/
│   │   │   │   ├── FindBar.tsx
│   │   │   │   ├── ZoomOverlay.tsx
│   │   │   │   ├── ContextMenus.tsx
│   │   │   │   └── LoadingProgress.tsx
│   │   │   └── dialogs/
│   │   │       ├── ClearDataDialog.tsx
│   │   │       ├── CertificateViewer.tsx
│   │   │       └── AboutDialog.tsx
│   │   ├── atoms/                       # Jotai 状态原子
│   │   │   ├── tabs.atom.ts
│   │   │   ├── navigation.atom.ts
│   │   │   ├── ui.atom.ts
│   │   │   └── data.atom.ts
│   │   ├── services/                    # preload API 的类型安全封装
│   │   │   ├── tabs.service.ts
│   │   │   ├── navigation.service.ts
│   │   │   ├── data.service.ts
│   │   │   └── keyboard.service.ts
│   │   └── hooks/
│   │       ├── useWebviewEvent.ts
│   │       ├── useAutoSave.ts
│   │       └── useTheme.ts
│
├── plugins/                             # 从旧项目直接复制
│   ├── linux64/libpepflashplayer64.so
│   ├── win64/pepflashplayer.dll
│   └── win32/pepflashplayer32_32_0_0_156.dll
│
├── build/                               # 图标资源（从旧项目复制）
│   ├── icon.ico
│   ├── icon.png
│   └── icon.svg
│
└── tests/
    ├── unit/
    │   ├── atoms/
    │   ├── components/
    │   └── services/
    └── e2e/
        ├── keyboard.spec.ts
        └── tab-lifecycle.spec.ts
```

---

## 4. 组件树

```
<App>
├── <TitleBar />
├── <TabBar>
│   └── <TabItem> *
│       ├── <TabFavicon />
│       ├── <TabTitle />
│       ├── <TabAudioIndicator />    # 标签页级静音（取代旧版全局静音）
│       ├── <TabCloseButton />
│       └── <TabContextMenu />
│   └── <NewTabButton />
├── <WindowControls />
├── <NavigationBar>
│   ├── <BackForwardButtons />
│   ├── <ReloadButton />
│   ├── <AddressBar>
│   │   ├── SSL 锁图标
│   │   └── <AddressSuggestions />
│   ├── <BookmarkStar />
│   └── <HomeButton />
├── <WebviewContainer>                  # 活跃标签的内容区
│   ├── <NewTabPage />                   # 无 webview 时显示（React 组件，非独立页面）
│   ├── <webview />                      # 活跃标签的 webview（有 URL 时）
│   ├── <LoadingProgress />
│   ├── <ZoomOverlay />
│   └── <FindBar />
├── <FavoritesPanel />
├── <HistoryPanel />
├── <DownloadsPanel />
├── <SettingsPanel />
├── <PasswordPanel />
├── <ContextMenus />                   # 右键菜单（统一渲染入口）
├── <CookieManager />
└── <GlobalModals>
    ├── <ClearDataDialog />
    ├── <CertificateViewer />
    └── <AboutDialog />
```

---

## 5. 状态管理（Jotai）

### 核心原子

```typescript
// atoms/tabs.atom.ts
export const tabsAtom = atom<Tab[]>([]);
export const activeTabIdAtom = atom<string | null>(null);
export const activeTabAtom = atom((get) => get(tabsAtom).find(t => t.id === get(activeTabIdAtom)));
export const tabCountAtom = atom((get) => get(tabsAtom).length);

// atoms/navigation.atom.ts
export const addressBarUrlAtom = atom('');
export const canGoBackAtom = atom(false);
export const canGoForwardAtom = atom(false);
export const isLoadingAtom = atom(false);
export const zoomLevelAtom = atom(1.0);

// atoms/ui.atom.ts
export const activePanelAtom = atom<PanelType | null>(null);
export const findBarVisibleAtom = atom(false);
export const findBarTextAtom = atom('');
export const themeAtom = atom<'light' | 'dark'>('light');
export const showZoomOverlayAtom = atom(false);
export const contextMenuAtom = atom<ContextMenuState | null>(null);

// atoms/data.atom.ts
export const favoritesAtom = atom<BookmarkEntry[]>([]);
export const historyAtom = atom<HistoryEntry[]>([]);
export const downloadsAtom = atom<DownloadItem[]>([]);
export const settingsAtom = atom<Settings>(defaultSettings);
```

### 持久化策略

nedb 作为持久层，写时自动同步：

```
[用户操作] → [Jotai atom 写入] → [useAutoSave hook 检测] → [nedb 写入]
                                      ↑
订阅 atom 变化的组件 → 自动 rerender
```

应用启动时：`nedb 全量读取` → `atom 初始化` → `UI 渲染`。

### nedb 数据存储策略

```
app.getPath('userData')/
└── data/
    ├── bookmarks.db          # 书签集合
    ├── history.db            # 浏览历史集合
    ├── downloads.db          # 下载记录集合
    └── tabs-session.db       # 会话恢复数据
```

每个业务域一个独立 nedb 文件，避免锁竞争，方便单独清除某类数据：

```typescript
// src/main/services/database.ts
import { app } from 'electron';
import path from 'path';
import Datastore from 'nedb-promises';

const dbPath = path.join(app.getPath('userData'), 'data');

export const bookmarksDb = Datastore.create({ filename: path.join(dbPath, 'bookmarks.db'), autoload: true });
export const historyDb   = Datastore.create({ filename: path.join(dbPath, 'history.db'),   autoload: true });
export const downloadsDb  = Datastore.create({ filename: path.join(dbPath, 'downloads.db'),  autoload: true });
export const sessionDb    = Datastore.create({ filename: path.join(dbPath, 'tabs-session.db'), autoload: true });
```

**从旧版 localStorage 迁移**：首次启动时检测旧 `localStorage` key `baoflash_favorites`，若存在且 nedb 为空则自动导入，完成后删除旧 key。

### 新标签页实现方式

新标签页是 **React 组件 `<NewTabPage />`**，不是独立页面或 `<webview src="newtab.html">`。

- 当用户创建新标签或访问 `about:newtab` 时，`activeTabAtom` 指向一个 `url` 为空的 Tab
- `<WebviewContainer>` 检测到空 URL → 隐藏 `<webview>` → 渲染 `<NewTabPage />`
- `<NewTabPage>` 与 `<App>` 共享**同一个 Jotai store**，直接读写 `favoritesAtom`、`historyAtom`
- 搜索框输入 URL 并回车 → Jotai 更新 `activeTabAtom.url` → `<WebviewContainer>` 销毁 `<NewTabPage />` → 挂载 `<webview src={url}>`

无需独立 React root、无需跨进程 IPC。新标签页就是主窗口内的一段 React UI。

---

## 6. 快捷键架构

### 问题

webview 内部是独立渲染进程，键盘事件不冒泡到外层 renderer DOM。必须通过 Electron API 拦截。

### 方案：`before-input-event` + 白名单表

```typescript
// src/main/ipc/shortcut.ipc.ts

const BROWSER_SHORTCUTS: Record<string, ShortcutAction> = {
  // 标签页管理
  'Control|t':              'new-tab',
  'Control|w':              'close-tab',
  'Control|Tab':            'next-tab',
  'Control|Shift|Tab':      'prev-tab',
  'Control|1':              'switch-tab-1',
  'Control|2':              'switch-tab-2',
  'Control|3':              'switch-tab-3',
  'Control|4':              'switch-tab-4',
  'Control|5':              'switch-tab-5',
  'Control|6':              'switch-tab-6',
  'Control|7':              'switch-tab-7',
  'Control|8':              'switch-tab-8',
  // 导航
  'F5':                     'reload',
  'Control|r':              'reload',
  'Escape':                 'stop-or-dismiss',
  'Control|l':              'focus-address',
  'Alt|d':                  'focus-address',
  // 功能
  'F11':                    'fullscreen',
  'F12':                    'devtools',
  'Control|Shift|i':        'devtools',
  'Control|d':              'bookmark',
  'Control|h':              'history-panel',
  'Control|f':              'find-in-page',
  'Control|s':              'save-page',
  'Control|p':              'print-page',
  'Control|u':              'view-source',
  'Control|n':              'new-window',
  'Control|Shift|Delete':   'clear-data',
};

app.on('web-contents-created', (_event, wc) => {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const combo = [
      input.control && 'Control',
      input.shift && 'Shift',
      input.alt && 'Alt',
      input.meta && 'Meta',
      input.key.length === 1 ? input.key.toLowerCase() : input.key,
    ].filter(Boolean).join('|');

    const action = BROWSER_SHORTCUTS[combo];
    if (action) {
      event.preventDefault();
      mainWindow.webContents.send('shortcut', action);
    }
  });
});
```

### 两层覆盖

| 焦点位置 | 处理方式 |
|---------|---------|
| webview 内部（网页） | `before-input-event` 拦截 → IPC → renderer |
| chrome 区域（地址栏/面板） | React `useEffect` 全局 `keydown` 监听 |

两层注册同一快捷键，确保任何焦点状态都生效。不在白名单中的组合键自动放行给页面处理（Ctrl+C/V/A 等）。

---

## 7. IPC 通信契约

### 原则

renderer 不直接碰 `ipcRenderer`。所有 IPC 走 preload 层暴露的类型化 API。

### preload API

```typescript
// preload/index.ts → contextBridge.exposeInMainWorld('electronAPI', ...)

electronAPI: {
  tabs: {
    create(url: string): Promise<string>;
    close(tabId: string): Promise<void>;
    setActive(tabId: string): Promise<void>;
    reload(tabId: string): Promise<void>;
    stop(tabId: string): Promise<void>;
    goBack(tabId: string): Promise<void>;
    goForward(tabId: string): Promise<void>;
    setZoom(tabId: string, level: number): Promise<void>;
    setMute(tabId: string, muted: boolean): Promise<void>;
    openDevTools(tabId: string): Promise<void>;
    findInPage(tabId: string, text: string): Promise<void>;
    stopFindInPage(tabId: string, clear: boolean): Promise<void>;
    getTitle(tabId: string): Promise<string>;
  },

  win: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    unmaximize(): Promise<void>;
    close(): Promise<void>;
    setFullscreen(fullscreen: boolean): Promise<void>;
    isMaximized(): Promise<boolean>;
  },

  data: {
    // 书签
    getFavorites(): Promise<BookmarkEntry[]>;
    addFavorite(entry: BookmarkEntry): Promise<void>;
    removeFavorite(url: string): Promise<void>;

    // 历史
    getHistory(limit?: number, offset?: number): Promise<HistoryEntry[]>;
    addHistory(entry: HistoryEntry): Promise<void>;
    clearHistory(): Promise<void>;
    searchHistory(query: string): Promise<HistoryEntry[]>;

    // 下载
    getDownloads(): Promise<DownloadItem[]>;

    // 设置
    getSettings(): Promise<Settings>;
    setSettings(partial: Partial<Settings>): Promise<void>;

    // 密码
    getPasswords(): Promise<PasswordEntry[]>;
    savePassword(entry: PasswordEntry): Promise<void>;
    deletePassword(id: string): Promise<void>;

    // 清理
    clearBrowsingData(options: ClearDataOptions): Promise<void>;
  },

  page: {
    viewSource(url: string): Promise<void>;
    savePage(url: string): Promise<void>;
    printPage(url: string): Promise<void>;
  },

  // 主进程主动推送（renderer 订阅）
  on(channel: string, callback: (...args: any[]) => void): () => void;
  // 支持的 channel:
  //   'shortcut'             → { action: ShortcutAction }
  //   'tab:updated'          → { tabId, changes }
  //   'download:progress'   → { id, state, percent, speed, ... }
  //   'webview:context-menu' → { type, url, x, y, tabId }
  //   'webview:new-window'  → { url, disposition }
}
```

### 主进程 Push 事件流

```
webview 事件发生
  → main 进程检测
  → webContents.send('channel', payload)
  → preload 转发
  → renderer electronAPI.on('channel', callback)
  → Jotai atom 写入
  → 组件自动重渲染
```

所有状态变更（标签页标题、favicon、加载状态、下载进度）都走这条单向推送路径，保证数据源唯一。

### IPC 事件订阅与取消

`on()` 返回 `unsubscribe` 函数。React 组件通过 `useEffect` 清理函数保证卸载时释放：

```typescript
// hooks/useShortcut.ts
export function useShortcut(handler: (action: ShortcutAction) => void) {
  useEffect(() => {
    const unsub = window.electronAPI.on('shortcut', handler);
    return unsub; // 组件卸载时自动取消订阅
  }, [handler]);
}

// hooks/useDownloadProgress.ts
export function useDownloadProgress(onProgress: (item: DownloadItem) => void) {
  useEffect(() => {
    const unsub = window.electronAPI.on('download:progress', (e, item) => onProgress(item));
    return unsub;
  }, [onProgress]);
}
```

不做全局单例 listener——每个组件自己订阅自己取消，避免内存泄漏和重复处理。

---

## 8. 会话恢复

### 保存内容

关闭窗口时（`before-quit` 事件），将以下状态写入 `tabs-session.db`：

| 字段 | 说明 |
|------|------|
| `tabId` | 标签页 ID |
| `url` | 当前页面 URL |
| `title` | 页面标题 |
| `favicon` | favicon URL（可选，部分页面无法恢复） |
| `zoomLevel` | 缩放级别（0.25-5.0） |
| `isMuted` | 静音状态 |
| `scrollX / scrollY` | 滚动位置（通过 `executeJavaScript` 获取） |
| `createdAt` | 标签创建时间（决定恢复后排序） |

**不保存**：表单输入（安全风险）、Session Storage（webview 销毁即丢失）。

### 恢复时机与策略

- **启动时**：检测 `tabs-session.db` 是否有数据，若有 → 直接恢复全部标签页，URL 指向原始地址（非缓存快照）。第一个标签设为活跃。
- **用户手动恢复**：在历史面板中提供"恢复上次会话"入口，匹配 `tabs-session.db` 中最新一次保存的快照。
- **URL 失效处理**：恢复时若页面返回错误（加载失败 → webview `did-fail-load`），显示错误页而非白屏。用户可手动刷新或关闭标签。

### 冲突处理

若用户关闭浏览器前打开 10 个标签，恢复时仅恢复 8 个（2 个页面服务端已 404）——这 2 个标签显示标准错误页，不阻塞其余 8 个正常加载。恢复成功后 `tabs-session.db` 置空（下次正常退出再写入）。

---

## 9. 依赖清单

| 包名 | 版本 | 用途 | 类型 |
|------|------|------|------|
| `electron` | `11.5.0` | Chromium 87 运行时 | 构建时 |
| `react` | `^17.0.2` | UI 框架 | 运行时 |
| `react-dom` | `^17.0.2` | React DOM 渲染 | 运行时 |
| `jotai` | `^1.x` | 状态管理 | 运行时 |
| `nedb-promises` | `^6.x` | 嵌入式数据库 | 运行时 |
| `sortablejs` | `^1.15` | 标签页拖拽排序 | 运行时 |
| `react-sortablejs` | `^6.x` | SortableJS 的 React 绑定 | 运行时 |
| `fuse.js` | `^6.x` | 地址栏模糊搜索 | 运行时 |
| `@mozilla/readability` | `^0.5` | 阅读模式 | 运行时 |
| `electron-localshortcut` | `^3.2.1` | F12/F11 全局快捷键 | 运行时 |
| `electron-log` | `^4.4.8` | 日志 | 运行时 |
| `electron-store` | `^7.0.3` | 主进程配置（Flash 版本号） | 运行时 |
| `validator` | `^13.x` | URL 安全校验 | 运行时 |
| `tailwindcss` | `^3.x` | 样式工具 | 构建时 |
| `webpack` | `^5.x` | 打包 | 构建时 |
| `ts-loader` | `^9.x` | TypeScript 编译 | 构建时 |
| `@babel/preset-react` | `^7.x` | JSX 编译 | 构建时 |
| `@types/react` | `^17.x` | React 类型 | 构建时 |
| `@types/react-dom` | `^17.x` | React DOM 类型 | 构建时 |
| `@types/sortablejs` | `^1.x` | SortableJS 类型 | 构建时 |
| `eslint` + `@typescript-eslint/*` | latest | 代码规范 | 构建时 |
| `prettier` | latest | 格式化 | 构建时 |
| `jest` + `@testing-library/react` | latest | 单元测试 | 构建时 |
| `playwright` | latest | E2E 测试 | 构建时 |

> React 17 而非 18：Node 12 对 React 18 的部分特性兼容性存疑，且 React 17 在 Electron 11 上经过充分验证。

---

## 10. 阶段实施计划

### 阶段 0：基础设施（~1 天）

- `npm init` 新项目
- webpack 配置（main renderer newtab 三入口 + ts-loader + babel + tailwind + postcss）
- tsconfig（ES2019 target，共享 / main / renderer 三层）
- ESLint + Prettier 落地
- `src/shared/types/` 全部类型定义
- 从旧项目复制 `plugins/` `build/` `src/main/modules/`
- `<App />` 空壳渲染验证

### 阶段 1：核心重写（~6-7 天）

| 顺序 | 模块 | 覆盖清单项 |
|------|------|-----------|
| 1.1 | 快捷键系统（main.js 白名单表 + preload on + React 转发） | #11-29 |
| 1.2 | 主题系统（Jotai `themeAtom` + 广播到 webview） | #51 |
| 1.3 | 书签面板 + 持久化（React + nedb） | — |
| 1.4 | 设置面板 | — |
| 1.5 | 地址栏 + 导航按钮 + 前进后退 | #52-57 |
| 1.6 | 标签页管理（webview 容器 + 标签栏 + 音频指示器） | #44 #58-62 |
| 1.7 | 缩放 | — |
| 1.8 | 窗口控制 + 标题更新 | — |
| 1.9 | 新标签页 React 重写 | — |

### 阶段 2：新功能（~5-6 天）

| 顺序 | 功能 | 覆盖清单项 |
|------|------|-----------|
| 2.1 | 右键上下文菜单（页面/链接/图片/选区 + 检查元素） | #2 #33 #56 |
| 2.2 | 页面查找 Ctrl+F（`<FindBar />` + webview.findInPage） | #18 #32 |
| 2.3 | F12 对标签页生效（改一行：`activeWebview.openDevTools()`） | #1 #3 |
| 2.4 | 全屏 F11 | #20 #35 |
| 2.5 | 浏览历史（React 面板 + nedb 存储） | #19 #30 |
| 2.6 | 下载管理器（will-download 监听 + 面板 + 进度/速度） | #31 |
| 2.7 | 密码管理器接入（补 IPC 通道 + React 面板） | #50 |
| 2.8 | 查看源码 Ctrl+U | #7 |

### 阶段 3：质量与完善（~4-5 天）

| 顺序 | 功能 | 覆盖清单项 |
|------|------|-----------|
| 3.1 | 快捷键矩阵测试（webview 内/外全 30+ 快捷键） | — |
| 3.2 | 会话恢复（关闭时保存所有标签页状态 → 启动恢复） | #36 |
| 3.3 | 清除浏览数据 (`<ClearDataDialog />`) | #29 |
| 3.4 | Cookie 查看器 (`<CookieManager />`) | #37 |
| 3.5 | 地址栏智能补全（fuse.js 模糊匹配历史+书签） | #56 |
| 3.6 | 标签页拖拽排序（sortablejs） | #42 #58 |
| 3.7 | 阅读模式 (`@mozilla/readability`) | #47 |
| 3.8 | SSL 安全锁图标 + 证书查看器 | #38 #53 |
| 3.9 | 搜索引擎切换（设置中添加选项） | #55 |
| 3.10 | 前后端鼠标侧键 | #26 |
| 3.11 | 打印 / 截图 | #28 #48 #49 |

### 不纳入范围

| 功能 | 原因 |
|------|------|
| 双内核 / CEF 迁移 | 属于新项目级别，需另开设计 |
| 扩展系统 | Electron 无完整扩展 API，工程量过大 |
| Safe Browsing | 依赖 Google 后端服务 |
| 隐私/无痕模式 | Electron 11 session 隔离可行，但优先级低 |
| macOS 支持 | Flash 插件无 macOS 版本 |
| 旧 `hotkeys-js` 依赖 | 白名单表替代，不再需要 |

---

## 11. 从旧项目复制清单

以下文件直接复制到新项目，仅添加 TypeScript 类型注解：

| 旧路径 | 新路径 | 修改量 |
|--------|--------|--------|
| `src/modules/flash.js` | `src/main/modules/flash.ts` | 加类型注解 |
| `src/modules/session.js` | `src/main/modules/session.ts` | 加类型注解 |
| `src/modules/dpapi.js` | `src/main/modules/dpapi.ts` | 加类型注解 |
| `src/modules/password-store.js` | `src/main/modules/password-store.ts` | 加类型注解 |
| `src/modules/config.js` | `src/main/modules/config.ts` | 加类型注解 + 补 Flash 版本字段 |
| `plugins/` | `plugins/` | 零修改，直接复制 |
| `renderer/webview-preload.js` | `src/webview-preload/index.ts` | 加类型注解 |
| `build/` | `build/` | 零修改，直接复制 |

其余所有文件全新编写。

---

## 12. 里程碑

| 里程碑 | 完成标志 | 预计时间 |
|--------|---------|---------|
| M0 | `<App />` 空壳渲染，webpack 构建通过 | 1 天 |
| M1 | 所有旧功能以 React 方式完整复现，无回归 | 7 天 |
| M2 | 新功能全部可用：历史/下载/密码/查找/右键/F12 | 13 天 |
| M3 | 全部测试通过，清理数据/拖拽/补全/cookie | 17 天 |
