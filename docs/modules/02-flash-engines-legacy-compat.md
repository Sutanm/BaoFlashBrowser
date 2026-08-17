# 02 · Flash 双引擎与旧站兼容

## 1 范围与目标

让现代系统（Chromium 87 / OS 补丁）继续运行老貂 Flash 内容：
- **PPAPI**：加载原生插件（含正确版本号伪装），处理 `mms.cfg`；
- **Ruffle**：内置 WASM 运行时 + 可选 CDN 后备，通过特权 scheme 在任意会话加载；
- **旧站兼容层**：SWFObject 重定向、Flash 版本检测伪报、跨域 CORS、ES2022 chunk 转译、权限收窄。

**边界**：渲染生命周期归 01，CSS 修复归 04，Ruffle/Flash 诊断事件归此处与 08。

## 2 静态结构

| 文件 | 职责 |
|---|---|
| `src/main/modules/flash.ts` | PPAPI DLL/SO 加载路径、版本提取/伪报、`mms.cfg` 写入 |
| `src/main/modules/ruffle-bundle.ts` | 从 `dist/lib/ruffle`（构建期复制）解析 Ruffle 运行时入口与 wasm |
| `src/main/modules/ruffle-session-protocol.ts` | `ruffle-resource:` 特权 scheme 注册（default + persist 两个 session） |
| `src/main/modules/session-manager.ts` | 每分区一次性配置：UA、权限、webRequest（js-patch + 61.com + GM 分发）、SWF CORS 头、下载处理器 |
| `src/main/modules/js-patch-service.ts` | ES2022 语法 chunk 检测与 `bf-js-patch:` 重写重定向 |
| `src/main/modules/js-patch-transform.ts` | 单个 chunk 转译（调用 esbuild/脚本） |
| `src/webview-preload/index.ts` | BrowserView preload：Ruffle 模式取源码 + `eval()` 注入，Web API polyfill 注入，用户脚本运行时挂载点 |
| `src/webview-preload/web-api-polyfills-entry.ts` / `.generated.ts` | 构建期生成的现代 Web API polyfill |
| `src/main/ipc/tabs.ipc.ts` | `get-ruffle-mode`（sendSync）、`ruffle:diagnostic` 转发 |
| `src/renderer/components/navigation/RuffleToggle.tsx` | 顶部栏引擎切换控件 |

## 3 核心流程

### 3.1 引擎与视图

标签 `isRuffle` 决定 `BrowserView` 的 `plugins`/`contextIsolation`；切换引擎 = 销毁重建（见 01）。Ruffle 模式下 preload `sendSync('get-ruffle-mode')` 取源码与来源（bundled/cdn），`contextIsolation:false` 下直接 `eval()` Ruffle 初始化脚本，使其在页面主世界运行（Ruffle 需要访问 DOM/全局）。

### 3.2 特权 scheme

`ruffle-resource:`（+`bf-js-patch:`）在 `app.whenReady()` **之前** `registerSchemesAsPrivileged`（standard/secure/fetch/cors/stream），再在 whenReady 后按会话注册 handler（default + persist 都要），否则 Ruffle 组件 fetch/wasm 会受 CORS/Worker 限制。

### 3.3 旧站网络层（`session-manager.ts` 单一 onBeforeRequest）

Electron 11 的 webRequest listener **重复注册会互相替换**，因此同一回调内顺序分流：

1. `chunkRedirectUrl(url)` —— ES2022 chunk → `bf-js-patch:` 重定向；
2. `webres.61.com/common/js/swfobject.js` → `data:text/javascript` patched SWFObject（**去除对 Flash 32 的版本门槛**，保留完整 SWFObject 语义，含 getPlayerVersion 伪装路径）;
3. `getWebRequestObserver().notifyBeforeRequest(...)` —— GM_webRequest 观测（URL 已红action，见 04）；
4. 否则放行。

其它配置：
- `onHeadersReceived(*/*.swf)`：注入宽松 CORS 头（仅 SWF，避免过度宽松）。
- **绝不重定向 `crossdomain.xml` 到 data:**——PPAPI 判为 aborted，游戏登录后白屏；保留原生策略文件。
- 权限 handler 仅放行 `fullscreen`/`pointerLock`。
- UA 固定为 Chrome/87 桌面 UA。

### 3.4 PPAPI 版本伪装

- Win 实际 DLL = 29.0.0.171，Linux = 32.0.0.371；
- DLL 文件名必须含版本号，否则 `extractVersion` 归 0.0.0.0 → 站点误判；
- 对外广告版本默认 34.0.0.330（`config.flashVersion`），旧站版本门槛用它通过；**不得移除伪装**。

### 3.5 SWF 独立页修复

Chromium 插件文档不加载 preload 时，主进程在 `dom-ready` 对 `.swf` URL `insertCSS('html,body{...100%} embed,object{100%}')`，修复 stage 高度坍缩。

## 4 数据模型与接口

- `ruffle-mode` sendSync 返回：`{ tabId, enabled, source: 'bundled'|'cdn' }`（`tabManager.getRuffleForWC`）。
- `ruffle:diagnostic` IPC：zod 校验 phase 枚举后转发 renderer（renderer 用于 CDN 失败提示改用 bundled）。
- `patchedSWFObject()`：返回完整 JS 文本；`chunkRedirectUrl(url)`：命中返回 `bf-js-patch:` URL 否则 null。
- `setupSessionOnce(sess)`:按分区幂等（`setupPartitions` Set），`initSession()` 同时配置 defaultSession 与 persist:。

## 5 安全边界与不变量

- 权限仅 `fullscreen`/`pointerLock`，其余拒绝（不给摄像头/地理位置等）。
- CORS 头只注入 `.swf` 请求。
- 不拦截/修改 `crossdomain.xml`。
- `bf-js-patch:`/`ruffle-resource:` 均为受控 scheme，handler 只接受白名单来源。
- UA 与 Flash 版本的可疑组合是有意为之：**为兼容旧站，不改**。

## 6 兼容性与平台差异

- Linux：`--no-sandbox`；WSLg 需 `--ignore-gpu-blacklist --enable-gpu-rasterization --enable-zero-copy`。
- 平台插件与版本：见 AGENTS.md（Win 29 / Linux 32；DLL 名含版本号）。
- Ruffle bundled 资源由 esbuild-plugin-copy 在构建期拷入 `dist/lib/ruffle`（含中文字体与 LICENSE）。

## 7 测试策略

- Electron smoke：`test:ruffle`（build-automation-m2-visual → automation-m5-ruffle-visual-smoke）、`test:compat`（session-compatibility-smoke）、`tests/electron/ruffle-iframe-smoke.cjs`、`browserview-smoke.cjs`。
- 单测：`tests/version-compare.test.ts`（版本比较）、`tests/legacy-site-favicon.test.ts`。
- 探针：`02-config.cjs`（flashVersion/低端模式等配置快照）、`00-build.cjs`（`dist/lib/ruffle` 新鲜度）。

## 8 雷区与注意事项

1. **webRequest 单监听**：GM_webRequest 必须从 session-manager 单一回调分发，绝不单独注册。
2. **Ruffle 会话注册**：`registerSchemesAsPrivileged` 必须在 whenReady 前；两个 session 都必须注册 handler。
3. **不 redirect crossdomain.xml**：PPAPI 将 data: 视作 aborted。
4. **版本伪报是特性**：DLL 名含版本号、广告版本可配置，勿"修复"。
5. **preload `eval()` 只在 Ruffle 模式**（`sendSync` 注入链路）；ppapi 模式不注入 Ruffle。

## 9 演进建议

- 为 `bf-js-patch:` / `ruffle-resource:` 补充回归清单（哪些站点触发、转译前后对比）到 09 的发布验证。
- 可将 `patchedSWFObject` 与 js-patch 的覆盖规则纳入 `docs/lessons-learned.md` 站点级兼容矩阵。