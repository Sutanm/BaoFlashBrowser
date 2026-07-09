// reword-editor.js — GIT_EDITOR: 替换 commit message
const fs = require('fs');
const msgFile = process.argv[2];

const map = {
    "fix: 收藏夹点击在新标签页打开，标签栏+按钮跟随标签页移动并可压缩": "项目启动：收藏夹点击在新标签页打开，标签栏+按钮跟随标签页移动并可压缩",
    "refactor: UI 回退紫色风格 + 无边框窗口拖拽修复 + 启动性能优化": "UI 回退紫色风格 + 无边框窗口拖拽修复 + 启动性能优化",
    "docs: add BaoFlashBrowser 2.0 complete design spec": "设计规范：BaoFlashBrowser 2.0 完整设计规范",
    "chore: archive v1 code to .old/ — prepare for v2 rewrite": "代码归档：v1 代码归档到 .old/ 目录，为 v2 重写做准备",
    "feat: Phase 1.1-1.2 — keyboard shortcut system, theme toggle, window controls, Jotai atoms, IPC handlers": "Phase 1.1-1.2：快捷键系统 + 主题切换 + 窗口控件 + Jotai 状态管理 + IPC 通信",
    "feat: add purple loading progress bar + TabItem React.memo + optimize switchTab": "标签栏视觉优化：紫色加载进度条 + TabItem React.memo + 标签切换性能优化",
    "feat: Phase 1.7 zoom — Ctrl+wheel, Ctrl++/-/0, zoom percentage overlay": "Phase 1.7：缩放功能 — Ctrl+滚轮/Ctrl+数字键 + 百分比浮窗显示",
    "v2: Phase 1 core fixes + Flash PPAPI cross-platform + Taomee webRequest bypass": "核心修复：Flash PPAPI 跨平台 + 淘米 webRequest 绕过 + 开发经验总结与设置持久化",
    "feat: 低性能设备模式，减少 Flash 游戏卡顿": "功能扩展：低性能模式 + Webview 路径修复 + 右键菜单 + 历史记录 + 下载管理 + 页面查找",
    "feat: 标签页拖拽排序 + F11 全屏切换": "交互增强：标签页拖拽排序 + F11 全屏 + Flash 渲染稳定性 + BrowserView 页面隔离",
    "重构: 抽屉侧边栏 + 合并顶栏布局": "抽屉侧边栏重构 + 合并顶栏布局 + 打包体积优化 + Linux/WSL 支持",
    "重构与功能增强：死代码清理、UI/UX 修复、兼容性升级、Ruffle 双核支持": "重构与功能增强：死代码清理 + UI/UX 修复 + 兼容性升级 + Ruffle 双核 + 下载系统重构",
    "feat: 安全加固与稳定性修复（L02-L46）": "安全与稳定性：安全加固 + 架构解耦 + CDP 密码捕获 + 密码管理器 + aria2 三级保底",
    "refactor: 架构现代化升级——构建工具/框架/类型安全/状态管理全面重构": "架构现代化：Webpack→Vite/esbuild + React 18 + Zustand + Tailwind + 类型安全 + 主题 + bug修复",
};

const oldMsg = fs.readFileSync(msgFile, 'utf-8').trim();
const firstLine = oldMsg.split('\n')[0].trim();
const newMsg = map[firstLine];

if (newMsg) {
    fs.writeFileSync(msgFile, newMsg + '\n', 'utf-8');
}
