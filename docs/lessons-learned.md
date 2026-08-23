# BaoFlashBrowser v2 开发经验总结

> 历史说明：本文保留早期 Jotai、webpack 和旧模块路径等经验背景，不代表 1.1.1 的当前文件结构。现行模块与构建说明见 [`docs/README.md`](README.md)、[`docs/modules/00-overview.md`](modules/00-overview.md) 和 [`docs/PACKAGE.md`](PACKAGE.md)。

## 1. Flash PPAPI 插件版本兼容性

### Windows
- **可用版本**: `WIN 29,0,0,171`（Adobe 官方正式版，无时间炸弹、无调试弹窗）
- **`.dll` 内部版本字符串不影响 `navigator.plugins.description`**
- Chromium 使用 `--ppapi-flash-version` 命令行开关的值来向网页报告插件版本描述
- 当 DLL 文件名不含版本号时 `extractVersion` 返回 `0.0.0.0`，Chromium 用这个值报告了错误的版本（如 `32.0 r0`），触发了网站的 Flash 检测拦截

### Linux
- **可用版本**: `LNX 32,0,0,371`（Adobe 官方 EOL 前最后一版，正常注册 `navigator.plugins`）
- **不可用版本**: `LNX 32,0,0,465`（Adobe 官方 EOL 终版，内含终止日期检查 + `mms.cfg` 白名单限制）
- 版本 `.465` 在 Linux 上不注册到 `navigator.plugins`，除非创建 `/etc/adobe/mms.cfg`
- Linux PPAPI Flash **原生不注册** `navigator.plugins`——需要 JS 注入

### macOS
- **PPAPI Flash 存在**：Adobe 发布了 macOS 最终版 32.0.0.465 的 DMG 安装包，内含 `PepperFlashPlayer.plugin`
- **未集成**：plugin 文件还在 DMG 中未提取，`flash.ts` 无 `darwin` 分支
- macOS Electron 11 支持 x64，ARM 需 Rosetta 2 转译

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

---

## 3. 淘米游戏门户反 Flash 检测

### 检测机制
淘米站点（`*.61.com`）使用魔改版 SWFObject，包含 `checkUpgrade` 函数：

```javascript
checkUpgrade: function(a) {
  if (getPlayerVersion().major === 32) {
    this.upgrade(a); return true;  // 拦截 Flash 版本 32
  }
  if (navigator.plugins["Shockwave Flash"]) {
    var b = navigator.plugins["Shockwave Flash"];
    if (!/\.dll$/i.test(b.filename)) {
      this.upgrade(a); return true;  // 拦截非 PPAPI 插件
    }
  }
  return false;
}
```

### 解决方案：网络层拦截
```typescript
session.defaultSession.webRequest.onBeforeRequest(
  { urls: ['*://webres.61.com/common/js/swfobject.js*'] },
  (_details, callback) => {
    callback({ redirectURL: 'data:text/javascript;...' });
  },
);
```

将 SWFObject 脚本替换为 `checkUpgrade` 始终返回 `false` 的修补版本。在网络层、页面拿到脚本之前完成替换。

---

## 4. Ruffle WASM 集成

### 架构决策：contextIsolation: false

Ruffle 需要在页面上下文运行（修改 `navigator.plugins`、拦截 DOM 元素）。在 `contextIsolation: true` 下，preload 和页面是两个隔离世界——preload 无法直接操作页面 DOM。

**方案对比**：

| 方案 | 结果 |
|------|------|
| `<script>` 标签注入 | `documentElement` 在 document-start 时为 null，`appendChild` 抛出异常，catch 吞掉导致 Ruffle 未加载 |
| `DOMContentLoaded` 后注入 | Ruffle 加载太晚，Flash `<object>` 已被 PPAPI 接管 |
| `ipcRenderer.sendSync` + `eval()` | **可行**，同步获取 JS 内容后在页面上下文执行 |
| Chrome 扩展 (`loadExtension`) | Electron 11 不支持的 `content_scripts` 自动注入 |

**最终方案**：Ruffle 标签使用 `contextIsolation: false` + `nodeIntegration: false`，preload 用 `ipcRenderer.sendSync('get-ruffle-mode')` 同步获取 Ruffle JS 内容 → `eval()` 在页面上下文立即执行。PPAPI 标签保持 `contextIsolation: true`（安全隔离）。

### Ruffle polyfill 的激活条件

Ruffle 源码中的 `polyfill()` 函数有两个激活条件（任一满足即可）：

1. `window.RufflePlayer.config.favorFlash` 为 `false`
2. `navigator.plugins.namedItem("Shockwave Flash")?.filename === "ruffle.js"`

在 `contextIsolation: false` 下，`eval(ruffle.js)` 在页面上下文执行，Ruffle 的 `pluginPolyfill()` 自动修补 `navigator.plugins`，将 Flash 插件的 `filename` 改为 `"ruffle.js"`，条件 2 自动满足。

### CDN 模式：`documentElement` 为 null 的时机问题

CDN 脚本通过 `<script src="...">` 异步加载。和 bundled 模式一样，`documentElement` 在 document-start 时为 null。**解决方案**：用 `requestAnimationFrame` 轮询等待 `documentElement` 出现后再 `appendChild`。

### CDN 模式的版本匹配

`publicPath: 'ruffle-resource://'` 用于 bundled 模式（本地 WASM）。CDN 模式下 **不应** 设 `publicPath`——让 Ruffle 从 CDN 自动加载配套的 WASM，避免版本不匹配导致白屏。

### 中文字体

- `fontSources` 指向 `ruffle-resource://SourceHanSansCN-Regular.otf`（OFL-1.1 思源黑体）
- `defaultFonts` 将 Flash 默认字体族（`_sans`/`_serif`/`_typewriter`）和中文名（宋体/黑体/微软雅黑）全部映射到 Source Han Sans CN
- `deviceFontRenderer: 'embedded'`（默认值）使用 Ruffle 内建字体渲染器
- SWF 内嵌字体（非设备字体）不受 `fontSources` 影响——这是 Ruffle 底层限制

### 画质与缩放

- `quality: 'best'`：Ruffle 最高画质渲染
- `forceScale: true`：强制 SWF 填满容器
- **不要**加 CSS `width:100% !important` 到 `ruffle-object`——会干扰 Ruffle 自建布局，导致白屏

---

## 5. 渲染进程隔离（BrowserView）

### 架构
BrowserView 为每个标签页创建独立渲染进程：
```
PPAPI 标签: contextIsolation: true, plugins: true
Ruffle 标签: contextIsolation: false, plugins: false
```

### 标签页引擎切换
`setRuffleMode` 通过**销毁旧 BrowserView → 创建新 BrowserView** 来切换引擎（不能仅 reload——`plugins` 和 `contextIsolation` 在 BrowserView 创建时就固定了）。

---

## 6. 下载功能

### Chromium 87 下载的固有问题
- `will-download` 监听在 `session.defaultSession` 上，但 BrowserView 使用 `partition: 'persist:'`——需要**双 session 监听**
- `getReceivedBytes()` 在慢速网络下频繁抖动（30→0→30）
- 下载超时无恢复机制
- **结论**：不做自定义进度跟踪，仅用 `once('done')` 监听完成/取消，Chromium 原生处理下载

### 侧边栏通知
- 下载面板按文件扩展名显示图标（zip/rar/swf/exe）
- 侧边栏下载图标右上角红点（有活跃下载）/ 绿点（有新完成下载）
- 启动时自动清理 `filename` 为空的损坏下载记录

---

## 7. CORS 跨域处理

### 问题场景
Ruffle 通过 `fetch()` 加载跨域 SWF（如 `sda.4399.com` 的 SWF 在 `www.4399.com` 页面播放）。浏览器默认拦截跨域 fetch。

### 解决方案
在 `session.ts` 和 `tabs.ts` 的 session 初始化中注入 `Access-Control-Allow-Origin: *`：

```typescript
sess.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, cb) => {
  const headers = { ...details.responseHeaders };
  headers['access-control-allow-origin'] = ['*'];
  headers['access-control-allow-methods'] = ['GET, POST, OPTIONS'];
  headers['access-control-allow-headers'] = ['*'];
  cb({ responseHeaders: headers });
});
```

**注意**：`defaultSession` 和 `persist:` session 是**两个独立的 session**——需要分别加拦截器。

---

## 8. IndexedDB 持久化

### hydration 竞态条件
启动时的 hydration 是异步的（Dexie → Jotai atom），如果在 hydration 完成前用户操作修改了 atom，persist effect 会覆盖用户的修改。**解决方案**：

```typescript
const hydrationDone = useRef(false);

// 启动加载
loadAll().then(data => { setFavorites(...); hydrationDone.current = true; });

// persist effect
useEffect(() => {
  if (!hydrationDone.current) return;  // 启动未完成不写 DB
  db.favorites.bulkPut(favorites);
}, [favorites]);
```

### 清空数据的持久化
数组清空时（`length === 0`）必须调 `db.table.clear()`——`bulkPut([])` 不会清空已有数据。清空操作**立即**执行（无需 debounce），避免用户关 app 前数据未同步。

### 多 effect 共享 timer ref 的 bug
三个 persist effect 不能共享同一个 `useRef<timer>`——A 的 `clearTimeout` 会把 B 的 timer 也清掉，导致 B 的写入永不执行。**每个 effect 需要独立 ref。**

---

## 9. webpack 打包注意事项

### production mode
- 开发用 `mode: 'development' + devtool: 'source-map'`
- 打包前必须切 `mode: 'production'`（移除 source maps，JS 压缩）
- 打包后恢复 `mode: 'development'`

### 运行时资源路径
- `node: { __dirname: false }` 保持 webpack 输出的 `__dirname` 为真实文件路径
- `extraResources` 将 `plugins/`、`native/`、`bin/` 复制到打包目录
- Ruffle 文件通过 `CopyPlugin` 复制到 `dist/lib/ruffle/`
- Ruffle WASM 通过自定义 `ruffle-resource://` 协议加载

### 图标
- Windows 需要 ICO 文件包含**多尺寸**（16/32/48/64/128/256）
- 单尺寸 ICO（仅 256px）在任务栏和标题栏不显示
- 使用 `sharp` + `png-to-ico` 生成多尺寸 ICO

### CDN 依赖
- `@ruffle-rs/ruffle` 和 `copy-webpack-plugin` 是构建时依赖，应放 `devDependencies`
- 放 `dependencies` 会导致 electron-builder 打包进安装包，增加体积

---

## 10. Electron 安全模型

### contextIsolation 的取舍
- PPAPI 标签：`contextIsolation: true`（标准安全）
- Ruffle 标签：`contextIsolation: false`（功能需求 > 隔离）
- 始终 `nodeIntegration: false`

### Electron 11 扩展支持局限
- 支持 DevTools 扩展（React DevTools 等）
- **不支持** `content_scripts` 自动注入（Chrome 扩展的核心机制）
- 油猴（Tampermonkey）等扩展无法在 Electron 11 中使用
- Ruffle 扩展不能直接加载——需自建注入机制

---

## 11. 关键文件位置

| 用途 | 文件 |
|------|------|
| Flash 插件注册 | `src/main/modules/flash.ts` |
| 会话/webRequest/CORS 拦截 | `src/main/modules/session.ts` |
| BrowserView 标签管理 + 下载 | `src/main/modules/tabs.ts` |
| Ruffle JS 预加载 | `src/main/modules/ruffle-bundle.ts` |
| Ruffle 注入（preload） | `src/webview-preload/index.ts` |
| Ruffle 引擎切换按钮 | `src/renderer/components/navigation/RuffleToggle.tsx` |
| 侧边栏面板 | `src/renderer/components/layout/DrawerSidebar.tsx` |
| 顶部导航栏 | `src/renderer/components/layout/TopBar.tsx` |
| 下载面板 | `src/renderer/components/panels/DownloadsPanel.tsx` |
| 设置面板 | `src/renderer/components/panels/SettingsPanel.tsx` |
| 错误边界 | `src/renderer/components/ErrorBoundary.tsx` |
| IndexedDB 数据层 | `src/renderer/services/db.ts` |
| 打包手册 | `docs/PACKAGE.md` |
| Flash 插件目录 | `plugins/linux64/`, `plugins/win64/` |
| 中文字体 | `assets/SourceHanSansCN-Regular.otf`（OFL-1.1） |
