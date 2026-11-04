# 02 · Flash 双引擎与旧站兼容

> 状态：按 **1.1.2（2026-11-02）** 源码核对，取代
> `docs/archive/modules-v1/02-flash-engines-legacy-compat.md`。

## 1 范围与目标

让 Chromium 87 继续运行老旧 Flash 内容与现代站点：

- **PPAPI**：加载原生插件，处理通道选择、版本广告与 `mms.cfg`；
- **Ruffle**：内置 WASM 运行时 + 可选 CDN 后备，经特权 scheme 在任意会话加载；
- **旧站网络兼容**：SWFObject 版本门补丁、SWF CORS、61.com 特判；
- **现代语法/模块兼容**：ES2022 chunk 转译、GitHub ES module 降级、Web API polyfill。

**边界**：渲染生命周期见 01；CSS Fixer 属于 04；代理见 10。

## 2 静态结构

| 文件 | 职责 |
| --- | --- |
| `src/main/modules/flash.ts` | 插件路径解析、stable/experimental 通道、版本广告、`mms.cfg`/`mm.cfg` 写入 |
| `src/main/modules/ruffle-bundle.ts` | 读取 `dist/lib/ruffle/ruffle.js`，记录版本/大小/SHA-256 |
| `src/main/modules/ruffle-session-protocol.ts` | `ruffle-resource://` 特权 scheme（只接受白名单文件名） |
| `src/main/modules/session-manager.ts` | 每分区一次性配置：UA、权限、唯一 `onBeforeRequest` 分流、SWF 头、下载 |
| `src/main/modules/js-patch-service.ts` | `bf-js-patch://` 协议、抓取/改写/缓存 ES2022 chunk |
| `src/main/modules/js-patch-transform.ts` | esbuild 优先、正则兜底；预检只认 `static{` / `using` |
| `src/main/modules/js-compiler.ts` | esbuild 懒加载与 ASAR 解包二进制定位 |
| `src/main/modules/github-module-service.ts` | GitHub 资源转译、import map 收集、CSP 补丁、缓存预算 |
| `src/main/modules/github-module-transform.ts` | `bfb-github-module://` URL 编解码、esbuild 降级、import 说明符改写 |
| `src/webview-preload/index.ts` | Ruffle 注入、Web API polyfill、GitHub import map 桥 |
| `src/webview-preload/github-import-map.ts` | 仅在 `github.com` 顶层文档发布 import map |

## 3 核心流程

### 3.1 引擎与视图

标签 `isRuffle` 决定 BrowserView 的 `plugins` / `contextIsolation`；切换引擎 = 销毁重建
（见 01）。Ruffle 模式下 preload `sendSync('get-ruffle-mode')` 拿到
`{ tabId, enabled, source }`，`contextIsolation:false` 时直接 `eval()` Ruffle 初始化脚本，
使其在页面主世界运行。bundled 失败可回退 CDN（`unpkg`），诊断经 `ruffle:diagnostic`
上报 `config / bundled-eval-* / cdn-* / runtime-* / component-error`。

### 3.2 三个特权 scheme

| scheme | 注册方式 | 用途 |
| --- | --- | --- |
| `ruffle-resource:` | `whenReady` 前 privileged；每个 session 注册 handler | Ruffle 的 JS/WASM/字体 |
| `bf-js-patch:` | 同上 privileged；**全局** `protocol.registerBufferProtocol` | 转译后的 ES2022 chunk |
| `bfb-github-module:` | 仅 `MODULE_JS_PATCH` 时 privileged；每个 session 注册 buffer handler | 转译后的 GitHub ES module |

`ruffle-resource:` 只接受 `[a-zA-Z0-9._-]+` 的 basename；用文件名推 MIME
（js/wasm/map/ttf/otf）。`ruffle-resource:` 与 `bfb-github-module:` 必须注册到
`defaultSession` 与 `persist:`；`bf-js-patch:` 是全局 protocol，不受分区限制。

### 3.3 会话网络层（唯一 `onBeforeRequest`）

Electron 11 重复注册会**互相替换**，因此所有重定向共享同一个回调，顺序为：

1. **GitHub 资源**（`github.githubassets.com/assets/*.js`，且当前 wc 在 github.com）
   → `githubModuleRedirect`，命中则 302 到 `bfb-github-module://`；
2. **ES2022 chunk** → `bf-js-patch://`（用自定义协议而非 `127.0.0.1`，避免 https 页
   被判 mixed content）；
3. **61.com `swfobject.js`** → `data:text/javascript` 的补丁版，去掉 Flash 32 版本门，
   保留完整 SWFObject 语义；
4. **GM_webRequest 观察** → 只通知，不改请求；
5. 其余放行。

`onHeadersReceived` 只做两件事：对 `.swf` 注入宽松 CORS 头；对 `github.com` 主框架
调用 `patchCsp` 放行转译模块所需的来源。**绝不重定向 `crossdomain.xml`**——PPAPI 会把
`data:` 视为 aborted，登录后白屏。

权限 handler 只放行 `fullscreen` / `pointerLock`；UA 固定 Chrome/87 桌面。

### 3.4 PPAPI 解析与版本（当前实现）

`resolveFlashPlugin(app, channel, configuredVersion)`：

| 通道 | 路径 | 物理版本（实测） | 对外广告版本 |
| --- | --- | --- | --- |
| stable win x64 | `plugins/win64/pepflashplayer64.dll` | **29.0.0.171** | `config.flashVersion`（默认 `34.0.0.330`） |
| stable win ia32 | `plugins/win32/pepflashplayer.dll` | **34.0.0.330** | 同上 |
| stable linux x64 | `plugins/linux64/libpepflashplayer64.so` | **32.0.0.371** | 同上 |
| experimental win x64 | `plugins/experimental/win64/pepflashplayer64_34_0_0_380.dll` | **34.0.0.380** | 同上 |
| experimental mac x64 | 随包或系统的 `PepperFlashPlayer.plugin` | 读 `manifest.json` | 同上 |

物理版本是明确的，可用 Windows 版本资源或 Linux 二进制内嵌串直接读出（上表为实测值，
不是推断）。**但 `FlashPluginResolution.physicalVersion` 只从文件名提取**：
`extractVersion()` 按 `_` 切段匹配 `x.y.z.w`，而当前 stable 三个文件名都不含版本号，
因此该字段返回 `null`。这是**代码可观测性缺口，不代表插件版本未知**——排障时不要因为
字段为 null 就认为版本不明。

- `BAO_FLASH_PLUGIN_VARIANT` 可覆盖 Windows 实验插件文件名（必须匹配 `x.y.z.w`）。
- experimental 请求找不到插件时回退 stable，并记 `fallbackReason:
  experimental-plugin-not-found`；macOS 没有稳定回退，最终可能 `unavailable`。
- `setupFlash` 同时写 `mms.cfg` 与 `mm.cfg`，内容固定为抑制调试弹窗、关闭错误上报与
  产品下载。写入点：cwd、`userData/PepperFlash/System`、Windows 的 Macromedia/Adobe/
  PepperFlashPlayer 目录与插件目录、macOS 的 Application Support。

### 3.5 Chromium 87 的现代 JS 兼容

**js-patch（通用站点）**：预检仅匹配 `static{` / `static {` / `using <ident>`，命中后先用
esbuild `target: chrome87` 转译；esbuild 失败才回退正则改写（只覆盖简单
`static{this.X=ref}`）。转译结果与原文空白归一后相同则视为 verbatim，不注入。
缓存 200 条 / 64 MiB，URL 由打包器内容哈希，可安全复用。

**GitHub 模块（站点专用）**：只处理 `github.com` 文档与
`github.githubassets.com/assets/<file>.js`。

- import map 由 preload 在 `github.com` 顶层文档扫描（≤16 KiB、≤32 项），经
  `github-module:map` 送给主进程；
- 资源经 esbuild 降到 `chrome87`，再用 acorn 只改 import/export/dynamic import 的
  说明符，保留模块身份；
- 单文件上限 12 MiB、缓存上限 64 MiB；抓取使用独立 transport session，并按当前代理配置
  `setProxy`；
- 受 `MODULE_JS_PATCH` 裁剪开关控制，与 js-patch 同生共死。

**Web API polyfill**：`BAO_POLYFILL_MODE` 取 `full`（默认，手工 polyfill + 构建期生成的
`coreApiPolyfills`）/ `handmade` / `off`，在 document-start 注入页面主世界；注入失败
只记日志，绝不阻断页面。

### 3.6 SWF 独立页修复

Chromium 的插件文档不加载 preload，主进程在 `dom-ready` 对 `.swf` URL 注入
`html,body{100%}` 与 `embed,object{100%}`，修复 stage 高度坍缩。

## 4 接口

- `get-ruffle-mode`（sendSync）→ `{ tabId, enabled, source?: 'bundled'|'cdn' }`。
- `ruffle:diagnostic`（send）→ 经 zod 校验 phase 后转发渲染层。
- `github-module:map`（send）→ 文档 import map 文本。
- `githubModuleDiagnostics()` → 文档数、map 数、缓存数、完成/失败统计（诊断面板）。
- `setupSessionOnce(sess)` 按分区幂等；`initSession()` 同时配置 `defaultSession` 与
  `persist:`。

## 5 安全边界与不变量

- 三个自定义 scheme 的 handler 都只接受白名单输入；`ruffle-resource:` 拒绝路径分隔符。
- js-patch 抓取复用 `isBlockedUrl`，阻断私网/回环，避免被页面当成内网探测器。
- GitHub 模块只处理 `github.githubassets.com/assets/*.js`，拒绝查询串、hash、账号信息；
  import map 的键值都过正则，且不接受 `..`。
- CORS 只对 `.swf` 放宽，不对全站注入。
- 权限只给 fullscreen / pointerLock。
- UA 与 Flash 版本组合是刻意伪装的兼容特性，**不要"修正"**。

## 6 平台差异

- Linux：`--no-sandbox`；WSLg 需 `--ignore-gpu-blacklist --enable-gpu-rasterization
  --enable-zero-copy`。
- Windows x64 才有实验 PPAPI 插件；ia32/Linux 请求 experimental 会回退 stable。
- macOS 实验包只有系统/随包插件探测，仓库内 `plugins/experimental/mac` 只有说明文件，
  因此默认不可用；包结构通过不代表真机通过。
- Ruffle 资源由构建期复制到 `dist/lib/ruffle`（含中文字体与 LICENSE）。

## 7 测试

- `npm run test:compat`（session 策略、SWFObject、SWF CORS）。
- `npm run test:ruffle`、`tests/electron/ruffle-iframe-smoke.cjs`。
- Vitest：`session-manager-setup.test.ts`、`flash-plugin-selection.test.ts`、
  `version-compare.test.ts`、`legacy-site-favicon.test.ts`、
  `tests/userscripts/github-module-{service,transform}.test.ts`。
- 探针：`02-config.cjs`（Flash 版本/低端模式）、`14-css-fixer.cjs`（现代 CSS/JS 路径）、
  `00-build.cjs`（`dist/lib/ruffle` 新鲜度）。

## 8 雷区

1. **webRequest 单监听**：任何新的重定向都必须并入 `session-manager` 的同一回调，
   单独注册会替换掉其他逻辑。
2. **scheme 注册顺序**：`registerSchemesAsPrivileged` 必须在 `whenReady` 之前；两个
   session 都要注册 handler。
3. **不 redirect `crossdomain.xml`**：PPAPI 会把 `data:` 当作 aborted。
4. **`physicalVersion` 为 null 不等于版本未知**：它只按文件名解析。真实物理版本以插件
   文件的版本资源为准（Win64 `29.0.0.171` / Win32 `34.0.0.330` / Linux `32.0.0.371`），
   不要把 null 当成"未知"展示，也不要为了迎合解析器去重命名插件文件。
5. **js-patch 预检必须保持严格**：放宽正则会为每个普通 chunk 触发 esbuild，破坏
   "零开销"承诺。
6. **GitHub import map 只在顶层 github.com 发布**：iframe 或非 github 源发布会让
   子模块解析错乱。
7. Ruffle 的 `eval()` 只在 Ruffle 模式执行，PPAPI 模式不得注入。

## 9 演进建议

- `WINDOWS_CN_VERSION` 与 `DEFAULT_FLASH_VERSION` 是两个独立常量（实验物理版本 /
  广告版本），建议在配置页同时展示，避免用户误判"版本没生效"。
- `extractVersion()` 只读文件名，而 stable 插件文件名已不带版本号，导致
  `physicalVersion` 恒为 null。可扩展为读取 PE 版本资源 / ELF 内嵌串（平台分支各一处），
  或在构建时把版本写回文件名——否则任何依赖该字段的 UI 都只能显示"未知"。
- js-patch 与 GitHub 模块各自维护缓存预算（64 MiB），极端页面可能叠加到 128 MiB；
  可考虑共享一个总预算（非阻塞）。
