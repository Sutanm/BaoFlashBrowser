# BrowserView 迁移设计

> 日期: 2026-07-29  
> 状态: 待实施  
> 概述: 将 Flash 页面内容从 `<webview>` 迁移到 `BrowserView`，根治渲染进程崩溃导致的全局白屏问题。

## 1. 动机

### 1.1 当前问题

项目使用 Electron 11 的 `<webview>` 标签承载 Flash 页面。当用户在一个页面加载 Flash 期间打开新标签或导航到另一个 Flash 页面时，渲染进程（renderer process）发生原生崩溃（`reason: crashed, exitCode: undefined`），导致整个窗口白屏——所有标签、工具栏、地址栏一并消失。

### 1.2 根因

`<webview>` 的 DOM 元素由渲染进程管理。当页面 Flash 加载/卸载流程冲突时，渲染进程内部的 `BrowserPlugin` 竞态条件触发 segfault。由于所有 webview 元素和 React UI 共享同一个渲染进程，一个崩溃就全灭。

### 1.3 已有防御措施（未根治）

- `--process-per-site` 已删除
- `--enable-gpu-rasterization` / `--enable-zero-copy` 仅 Linux 启用
- `--disable-gpu-process-crash-limit` 已添加
- `webview` partition 隔离（`persist:tab_<id>`）
- 导航前 `stop()` + 200ms 延迟创建新标签
- 崩溃后自动重载窗口（最多 3 次）

## 2. 目标

| 目标 | 说明 |
|------|------|
| 崩溃隔离 | 每个标签的页面内容跑在独立渲染进程中，互不影响 |
| 不丢 UI | 标签栏、地址栏、侧边栏永远不受页面崩溃影响 |
| 可恢复 | 单个标签崩溃后自动恢复，不影响其他标签 |
| 功能不退化 | 所有现有功能（缩放、静音、查找、右键等）保持可用 |

## 3. 架构

### 3.1 进程模型

```
┌── 主进程 (Main Process) ──────────────────────────────┐
│  TabManager: Map<tabId, BrowserView>                   │
│  resize 编排、IPC 分发、崩溃监听                        │
└────────────────────────────────────────────────────────┘
         │                    │
    IPC  │              IPC   │
         ▼                    ▼
┌── 渲染进程 A ────┐  ┌── 渲染进程 B ────┐
│ React UI 壳       │  │ BrowserView tab1 │
│ TabBar NavBar     │  │ 页面内容 + Flash │
│ 侧边栏 查找栏     │  └─────────────────┘
│ 缩放指示          │
└──────────────────┘  ┌── 渲染进程 C ────┐
                      │ BrowserView tab2 │
                      │ 页面内容 + Flash │
                      └─────────────────┘
```

- React UI 壳：1 个 BrowserWindow webContents
- 页面内容：N 个 BrowserView（每个标签一个）

### 3.2 核心模块

| 模块 | 文件 | 角色 |
|------|------|------|
| `TabManager` | `src/main/modules/tabs.ts` | BrowserView 生命周期、导航、事件转发 |
| `tabs.ipc.ts` | `src/main/ipc/tabs.ipc.ts` | 渲染进程 → 主进程命令 |
| `App.tsx` | `src/renderer/App.tsx` | 所有 `el.xxx()` → IPC 调用 |
| 删除 | `src/renderer/components/tabs/WebviewContainer.tsx` | 不再需要 |

### 3.3 IPC 接口

#### 渲染进程 → 主进程 (invoke)

| 通道 | 参数 | 动作 |
|------|------|------|
| `tab:create` | `{ tabId, url }` | 创建 BrowserView |
| `tab:close` | `{ tabId }` | 销毁 BrowserView |
| `tab:activate` | `{ tabId }` | 交换活跃 BrowserView |
| `tab:navigate` | `{ tabId, url }` | 导航到新 URL |
| `tab:goBack` | `{ tabId }` | 后退 |
| `tab:goForward` | `{ tabId }` | 前进 |
| `tab:reload` | `{ tabId }` | 刷新 |
| `tab:stop` | `{ tabId }` | 停止加载 |
| `tab:zoom` | `{ tabId, factor }` | 设置缩放 |
| `tab:mute` | `{ tabId, muted }` | 静音切换 |
| `tab:devtools` | `{ tabId }` | 打开 DevTools |
| `tab:find` | `{ tabId, text, options? }` | 页面内查找 |
| `tab:stopFind` | `{ tabId, action }` | 清除查找 |
| `tab:setBounds` | `{ x, y, w, h }` | 调整 BrowserView 区域 |

#### 主进程 → 渲染进程 (send)

| 通道 | 负载 | 触发时机 |
|------|------|---------|
| `tab:updated` | `{ tabId, title?, url?, favicon?, isLoading?, isAudible?, canGoBack?, canGoForward? }` | 页面状态变化 |
| `tab:crashed` | `{ tabId }` | BrowserView 渲染进程崩溃 |

## 4. UI 设计

### 4.1 布局

```
┌────────────────────────────────────────────────┐
│ Tab Bar                                        │
├────────────────────────────────────────────────┤
│ Nav Bar  ◀ ▶ ↻ [________地址栏________]        │
├────────────────────────────────────────────────┤  ← 查找栏插入位置 (可选)
│ ┌────┬──────────────────────────────────────┐  │
│ │ ⭐ │                                      │  │
│ │ 🕐 │   BrowserView (当前标签页面)          │  │
│ │ ⬇ │                                      │  │
│ │ ⚙ │                                      │  │
│ └────┴──────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

React 通过 `tab:setBounds` 调整 BrowserView 的 `{x,y,w,h}`，实现：
- 侧边栏展开：BrowserView x 偏移 +280px，w 减小 280px
- 查找栏展开：BrowserView y 偏移 +32px，h 减小 32px

### 4.2 侧边栏

**收起状态**：48px 图标列（⭐ 收藏 🕐 历史 ⬇ 下载 ⚙ 设置）

**展开状态**：280px 全宽面板，包含当前选中面板的完整内容。BrowserView 宽度同步缩小 280px。

所有面板内容集成在一个侧边栏内，点击不同图标切换面板内容（不发生 DOM 重建，只替换内容区）。

### 4.3 查找栏（Ctrl+F）

嵌入在导航栏下方、BrowserView 上方。出现时 BrowserView 高度缩小 32px 让位。

| 元素 | 说明 |
|------|------|
| 输入框 | 输入即搜 |
| 匹配计数 | `1/15` 格式 |
| ▴▾ 按钮 | 上一个/下一个匹配 |
| ✕ 按钮 | 关闭查找栏 |

Ctrl+F 全局 toggle（地址栏聚焦也生效）。`found-in-page` 事件由主进程收到后转 IPC 给渲染进程更新计数。

### 4.4 右键菜单

主进程原生 `Menu.buildFromTemplate()`，三个选项：

| 选项 | 条件 | 动作 |
|------|------|------|
| 在新标签页打开链接 | 右键在链接上 | 创建新标签 |
| 复制 | 有选中文本 | 写入剪贴板 |
| 检查元素 | 始终 | 对应当前标签打开 DevTools |

不显示图标、分隔线，功能极简。

### 4.5 缩放指示

Ctrl+=/Ctrl+-/Ctrl+滚轮触发缩放时，导航栏地址栏输入框内临时替换为百分比文字（如 `125%`），1.5 秒后恢复显示 URL。

### 4.6 去掉的 UI

| 组件 | 原因 |
|------|------|
| 快捷操作栏 | 功能已被导航栏覆盖 |
| 缩放中央浮层 (`ZoomOverlay`) | BrowserView 不可叠加 |
| 右键菜单浮层 (`ContextMenu`) | BrowserView 不可叠加 |
| `WebviewContainer.tsx` | 不再使用 webview DOM |

## 5. 崩溃恢复

BrowserView 渲染进程崩溃时：

1. 主进程 `webContents.on('render-process-gone')` 触发
2. 向渲染进程发送 `tab:crashed` IPC
3. 渲染进程显示崩溃占位符（⛔ 图标 + "页面崩溃了" + 刷新按钮）
4. 渲染进程保留侧边栏和导航栏，用户可切换到其他标签
5. 用户点击刷新 → `tab:reload` → BrowserView 重载

## 6. 风险

| 风险 | 缓解 |
|------|------|
| Electron 11 BrowserView API 稳定性 | 已通过 Demo 验证基本可行 |
| BrowserView resize 性能 | CSS transition 0.25s 平滑动画 |
| Linux/WSL BrowserView 兼容性 | 保留 webview 回退路径（通过 feature flag） |
| IPC 延迟影响交互响应 | 所有操作 < 5ms 往返，用户无感 |

## 7. 文件清单

### 新增

| 文件 | 行数 (估) |
|------|----------|
| `src/main/modules/tabs.ts` | ~150 |
| `src/main/ipc/tabs.ipc.ts` | ~100 |

### 修改

| 文件 | 行数 (估) |
|------|----------|
| `src/main/index.ts` | ~30 |
| `src/renderer/App.tsx` | ~80 |
| `src/renderer/components/overlays/FindBar.tsx` | ~30 |
| `src/renderer/styles.css` | ~40 |

### 删除

| 文件 | 行数 |
|------|------|
| `src/renderer/components/tabs/WebviewContainer.tsx` | 199 |
| `src/renderer/components/overlays/ZoomOverlay.tsx` | ~50 |
| `src/renderer/components/overlays/ContextMenu.tsx` | ~100 |

## 8. 测试计划

| 场景 | 验收标准 |
|------|---------|
| 单个标签浏览 | 导航、后退、前进、刷新正常 |
| 多个标签切换 | 标签切换无闪烁，页面状态保持 |
| Flash 页面快速切换 | 渲染进程不崩溃，崩溃后自动恢复 |
| 侧边栏展开/收起 | BrowserView 区域平滑调整 |
| Ctrl+F 查找 | 查找栏出现/消失，BrowserView 同步调整高度 |
| Ctrl+=/-/滚轮缩放 | 缩放功能正常，地址栏指示百分比 |
| 右键菜单 | 菜单弹出、选项功能正常 |
| Linux 兼容性 | WSLg 下基本功能可用 |

## 9. 参考资料

- 侧边栏交互 Demo: `docs/sidebar-demo.html`
- 现有快捷键系统: `src/main/ipc/shortcut.ipc.ts`
- Flash 配置: `src/main/modules/flash.ts`
