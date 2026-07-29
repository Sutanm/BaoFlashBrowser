# BaoFlashBrowser v2 开发经验总结

## 1. Flash PPAPI 插件版本兼容性

### Windows
- **可用版本**: `WIN 34,0,0,330`（国产魔改版，去掉了 EOL 时间炸弹）
- **`.dll` 内部版本字符串不影响 `navigator.plugins.description`**
- Chromium 使用 `--ppapi-flash-version` 命令行开关的值来向网页报告插件版本描述
- 当 DLL 文件名不含版本号时 `extractVersion` 返回 `0.0.0.0`，Chromium 用这个值报告了错误的版本（如 `32.0 r0`），触发了网站的 Flash 检测拦截

### Linux
- **可用版本**: `LNX 32,0,0,371`（Adobe 官方 EOL 前最后一版，正常注册 `navigator.plugins`）
- **不可用版本**: `LNX 32,0,0,465`（Adobe 官方 EOL 终版，内含终止日期检查 + `mms.cfg` 白名单限制）
- 版本 `.465` 在 Linux 上不注册到 `navigator.plugins`，除非创建 `/etc/adobe/mms.cfg`
- Linux PPAPI Flash **原生不注册** `navigator.plugins`——需要 JS 注入

### 关键结论
`--ppapi-flash-version` 是 `navigator.plugins["Shockwave Flash"].description` 的唯一数据来源。始终传一个大于 32 的版本号来绕过淘米等游戏门户的反 Flash 检测（如 `34.0.0.330`）。

---

## 2. Linux/WSL Electron 配置

### 必须的开关
```ts
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}
// WSLg 下 GPU 必需：
app.commandLine.appendSwitch('--ignore-gpu-blacklist');
app.commandLine.appendSwitch('--enable-gpu-rasterization');
app.commandLine.appendSwitch('--enable-zero-copy');
```

### WSLg GPU 陷阱
- 移除**任何一个** GPU 开关会导致 `viz_main_impl.cc(150)] Exiting GPU process` → 窗口变白/透明
- `appendSwitch` 上的 `--` 前缀可选——Electron 如果检测到已有的 `--` 则不会重复添加
- `--disable-gpu` 会终止所有渲染（白屏）。永远别用；改用 `--ignore-gpu-blacklist`
- 系统库（libgtk-3-0, libnotify 等）必须在 WSL 发行版中预先安装

### Preload 加载
- Webview preload（`<webview preload="...">`）在 Linux Electron 11 中**完全无法加载**
- `session.setPreloads([...])` 能运行，但由于 `contextIsolation: true`，修改对页面不可见
- `webRequest.onBeforeRequest`（网络层拦截）是唯一可靠的跨平台注入方式

---

## 3. 淘米游戏门户反 Flash 检测

### 检测机制
淘米站点（`*.61.com`）使用魔改版 SWFObject，包含 `checkUpgrade` 函数：

```javascript
checkUpgrade: function(a) {
  if (getPlayerVersion().major === 32) {
    // 拦截 Flash 版本 32——显示升级页
    this.upgrade(a); return true;
  }
  if (navigator.plugins["Shockwave Flash"]) {
    var b = navigator.plugins["Shockwave Flash"];
    // 拦截文件名不以 .dll 或 .plugin 结尾的插件
    if (!/\.dll$/i.test(b.filename) && !/\.plugin$/i.test(b.filename)) {
      this.upgrade(a); return true;
    }
  }
  return false;
}
```

### 为什么之前的方案都失败了

| 方案 | 失败原因 |
|------|---------|
| webview-preload 注入 `navigator.plugins` | Linux 上 preload 完全不加载 |
| `session.setPreloads` | `contextIsolation: true` 将 preload 上下文与页面隔离 |
| 页面加载后 `executeJavaScript` | SWFObject 在注入前已执行完毕 |
| Linux 上 `ppapi-flash-version` 设为 `34.0.0.330` | Chromium 在 Linux 上使用 `.so` 内部版本，忽略开关值 |
| 独立 BrowserWindow 打开游戏 | 新窗口中存在相同的版本/检测问题 |

### 解决方案：网络层拦截
```typescript
session.defaultSession.webRequest.onBeforeRequest(
  { urls: ['*://webres.61.com/common/js/swfobject.js*'] },
  (_details, callback) => {
    callback({ redirectURL: 'data:text/javascript;...' });
  },
);
```

将 SWFObject 脚本替换为 `checkUpgrade` 始终返回 `false` 的修补版本。在网络层、页面拿到脚本之前完成替换，不依赖平台、preload 状态或 `contextIsolation`。

---

## 4. React + Electron Webview 架构

### Webview 生命周期
- **永远不要卸载 WebviewContainer**——React 条件渲染会销毁 webview GPU 表面
- 通过对包装 div 设置 `display:none/flex` 来切换 webview 可见性，而不是卸载组件
- 始终同时渲染 `NewTabPage` 和 `WebviewContainer`，通过 CSS 可见性切换

### Webview 尺寸
- `<webview>` 是 GPU 原生表面——基于 JS 的尺寸操作不可靠
- 使用纯 CSS flex 布局：`body { display: flex; flex-direction: column; }`, `#webview-container { flex: 1; position: relative; }`, `webview { position: absolute; width: 100%; height: 100%; }`
- 用 `visibility: hidden/visible` 切换标签页（而不是 `display:none`）

### 事件安全
- webview-preload 中模块顶层的 `catch { return }` 会导致**整个脚本**提前退出
- 改用 `catch { /* no-op */ }`，或者将关键代码放在 try-catch 块之前

---

## 5. 调试方法论

### 先隔离，再集成
当某个功能在独立 Electron 测试中能运行但在 React 应用中不行时：
1. 创建使用相同 webPreferences 的最小独立测试
2. 测试 `file://` vs `data://` 源差异
3. 测试 `createElement('webview')` vs HTML 声明的 webview
4. 测试有 React 和无 React
5. 测试有 preload 脚本和无 preload 脚本

### Electron 日志限制
- 渲染进程的 `console.log` **不会输出到 stderr**
- 使用 `--enable-logging=stderr --v=2` 获取 Chromium 内部日志
- `document.title` 变化在窗口标题中可见（仅限有边框窗口）
- 无边框窗口使用 `alert()` 或基于 IPC 向主进程发送日志

### WSL 测试现实
- WSLg（WSL2 + GUI）使用 Wayland/XWayland——GPU 兼容性与原生 Linux 不同
- Ubuntu 26.04 对 Electron 11 系统依赖来说太新——生产环境验证应使用 Docker 或原生 Linux VM
- WSL 文件系统性能很差——运行前始终 rsync 到 WSL home

---

## 6. 关键文件位置

| 用途 | 文件 |
|------|------|
| Flash 插件注册 | `src/main/modules/flash.ts` |
| 会话/webRequest 拦截器 | `src/main/modules/session.ts` |
| Linux sandbox + GPU 开关 | `src/main/index.ts` |
| Webview 元素创建 | `src/renderer/components/tabs/WebviewContainer.tsx` |
| navigator.plugins 注入（Linux） | `src/webview-preload/index.ts` |
| Flash 插件目录 | `plugins/linux64/`, `plugins/win64/`, `plugins/win32/` |
