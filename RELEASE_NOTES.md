# BaoFlashBrowser v1.0.1

基于 Electron 11 (Chromium 87) + React 17 + TypeScript 的跨平台 Flash 浏览器。

## 下载

| 架构 | 安装包 | 大小 |
|------|--------|------|
| **x64** | [BaoFlashBrowser-1.0.1-x64.exe](https://gitee.com/sutanm/BaoFlashBrowser/releases/download/v1.0.1/BaoFlashBrowser-1.0.1-x64.exe) | 72 MB |
| **ia32** | [BaoFlashBrowser-1.0.1-ia32.exe](https://gitee.com/sutanm/BaoFlashBrowser/releases/download/v1.0.1/BaoFlashBrowser-1.0.1-ia32.exe) | 69 MB |

## 更新内容

### 界面重构
- **抽屉侧边栏 + 合并顶栏** — TabBar + NavigationBar 合并为 TopBar，UnifiedSidebar 替换为 48px 图标条 + 280px 滑动抽屉面板
- Apple 风格浅色主题 / Catppuccin 深色主题
- 窗口控件改用 SVG 图标
- 设置面板卡片式布局，优化字段间距

### 核心架构
- **BrowserView 页面隔离** — 每个标签页独立渲染进程，Flash 崩溃不影响其他标签
- **为什么不用 webview** — webview 多标签共享渲染管道，Flash GPU 纹理抢占导致全局崩溃；BrowserView 从根本上隔离渲染管线

### 功能
- 历史记录面板（自动录制、日期分组、网站图标、搜索筛选）
- 页面内查找 Ctrl+F（浮动胶囊、匹配计数、上下导航）
- 下载管理器（会话捕获、进度条）
- 网页右键菜单
- 标签页拖拽排序 + F11 全屏切换
- Alt+Left/Right 导航快捷键
- 低性能设备模式（减少 GPU 纹理缓存）
- IndexedDB (Dexie) 持久化存储

### Flash 体验
- Ctrl+滚轮缩放穿透至 Flash Player 区域（Windows WH_MOUSE_LL / Linux XRecord）
- 淘米 61.com 反 Flash 检测绕过（SWFObject + 版本伪装）
- Flash 渲染进程稳定性修复（崩溃恢复、进程隔离、指针事件防护）

### 开发
- 开发环境启动：`npm install && npm run dev`
- x64 打包：`npm run build:win64`
- ia32 打包：`npm run build:win32`
- 需要 [Electron 11.5.0](https://npmmirror.com/mirrors/electron/11.5.0/) 运行环境

### 已知限制
- Windows ia32 版本未测试，仅提供编译产物
- 需要 Flash Player PPAPI 插件（已内置 29.0.0.171 x64）
- Electron 11 不支持 Windows on ARM
