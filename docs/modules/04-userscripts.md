# 04 · 用户脚本平台

> 状态：按 **1.1.2（2026-11-02）** 源码核对，取代 `docs/archive/modules-v1/04-userscripts.md`。

## 1 范围与目标

提供油猴风格的安装、匹配、运行时与受控 GM API。脚本在 BrowserView preload 的沙箱中
运行；需要页面主世界时经显式 page bridge，不获得 Node、任意 Electron IPC 或本地文件
系统权限。

**边界**：自动化浮窗的两条通道见 03；CSS Fixer 的样式规则见本文 6；GM 值持久化归
`script-store`。

## 2 静态结构

### 2.1 主进程

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/userscripts/index.ts` | 单例与服务聚合、`BUNDLED_SCRIPTS` 自动安装 |
| `userscript-manager.ts` / `userscript-parser.ts` / `userscript-matcher.ts` | 安装数据、元数据、URL/iframe 匹配快照 |
| `userscript-store.ts` / `script-store.ts` / `userscript-values.ts` | 脚本、设置、GM 值持久化 |
| `userscript-require-cache.ts` | `@require` / `@resource` 抓取与缓存（总量 512 KiB） |
| `userscript-request.ts` / `userscript-request-service.ts` | 受控跨域请求（5 重定向 / 2 MiB / 每脚本 4 并发 / 全局 16） |
| `userscript-download.ts` / `userscript-download-service.ts` | `GM_download` |
| `userscript-background.ts` / `userscript-crash-tracker.ts` | 每脚本后台窗口、崩溃退避与停止 |
| `userscript-cookie-service.ts` / `userscript-web-request.ts` | 只读 cookie、只观察 webRequest |
| `userscript-versions.ts` / `userscript-export.ts` / `userscript-sidebar.ts` | 版本比较、导出、侧边栏数据 |

### 2.2 preload 运行时

| 路径 | 职责 |
| --- | --- |
| `bootstrap.ts` | 启动期 `sendSync('userscript:get-config')`、执行器、菜单/值桥 |
| `scheduler.ts` | `run-at` 四档调度 |
| `sandbox.ts` / `unsafe-proxy.ts` | 隔离执行与 `unsafeWindow` 代理 |
| `gm-api.ts` | GM 经典/现代双拼写、`GM_webRequest` 观察实现 |
| `page-bridge.ts` | 主世界注入桥（`executeJavaScript`） |

### 2.3 内置脚本（构建期文本资产）

| 源 | 产物/用途 |
| --- | --- |
| `bundled-scripts/css-fixer-entry.ts` + `css-fixer-core.ts` / `-color.ts` / `-github.ts` | `npm run build:css-fixer` 生成 `css-fixer.user.js` |
| `bundled-scripts/automation-frame-assistant.user.js` | 自动化浮窗 UI；同时被原生助手 `?native` 导入（见 03） |
| `bundled-scripts/vendor/` | CSS Fixer 的容器查询等 polyfill |
| `asset.d.ts` | 文本模块类型声明 |

## 3 执行流程

1. 页面创建时 preload **同步**请求 `userscript:get-config`，manager 按 URL、frame、
   启用状态与预算生成快照。
2. `scheduler` 按 `runAt` 排队：

| 档位 | 触发方式 |
| --- | --- |
| `document-start` | 有 `documentElement` 立即执行；否则 MutationObserver 等根元素出现（仍早于页面脚本） |
| `document-body` | `body` 出现即执行；5s 兜底强制执行，防止页面永远不建 body |
| `document-end` | `DOMContentLoaded`（已过则 `queueMicrotask`） |
| `document-idle` | `requestIdleCallback({timeout:500})`；不支持时 250ms |

3. 每个脚本只执行一次（`pending` 集合去重）。`runAtPriority` 目前只导出、**未参与
   实际排序**，不要据此假设跨档位有全局执行顺序。
4. SPA 软导航由 `did-navigate-in-page → manager.spaNavigate` 记录，不重复创建文档脚本。
5. 脚本本体由 `sandbox.ts` 执行：PPAPI（隔离世界）用 `new Function`，页面 CSP 管不到；
   Ruffle（页面世界）在严格 CSP 下回退 `vm.runInThisContext`。Node 绑定以同名参数
   shadow 为 `undefined`，GM API 以词法变量注入，不挂到全局。
6. `unsafeWindow` 走页世界桥：`webFrame.executeJavaScript(PAGE_BRIDGE_SOURCE)` 注入
   主世界引导，之后用 `window.postMessage` 同步转发。**不要改回 CDP**
   `Page.addScriptToEvaluateOnNewDocument`：调试器 detach 后注册会丢失，长期附着又会
   冻结导航。

## 4 背景脚本、菜单与值

- 每个 `@background` 脚本使用独立隐藏 BrowserWindow，`backgroundThrottling:false`；
  `userscript:get-config` 按 `event.sender.id` 找到对应脚本。
- 崩溃退避：1s → 2s → 4s → 8s → 60s；连续 5 次后停止该脚本，直到
  `userscripts:background-restart`。**只影响该脚本**，不波及其他后台脚本。
- 子帧可执行脚本，但 `webContents.send` 只到主框架 preload；菜单命令按脚本 + 标题
  去重，只保留主框架条目。
- GM 值必须可 JSON 序列化，单值/总量受限；管理页值方法有意绕过 view gate，但仍保留
  序列化、大小与持久化校验。

## 5 安全边界

- `@connect` 控制请求与 cookie 目标；私网/回环地址、敏感请求头、响应体和超时均受预算
  限制（响应体 2 MiB，超时与并发见 2.1）。
- `GM_cookie` 只支持 `list` / `get`，**不提供 set/delete**。
- `GM_webRequest` 只观察，不拦截、不改写；由 `session-manager.ts` 的唯一
  `onBeforeRequest` 回调分发（见 02）。
- `unsafeWindow` 仅在脚本声明 `@grant unsafeWindow` 时暴露；`GM_info` 为非特权兼容项。
- 无参数 IPC schema 用 `z.object({}).optional()` 或 `undefined` schema，避免拒绝
  preload 的空 payload。
- 脚本不能直接访问 Node、Electron IPC、文件系统；跨域只能走 `GM_xmlhttpRequest`。

## 6 内置脚本的安装语义

- 首次启动自动安装；之后与普通脚本同等对待：可编辑、禁用、删除。
- **删除的内置脚本下次启动会重新出现**（缺失即安装）。
- 版本升级只覆盖未被编辑的安装（`edited=false`）；用户保存过的脚本永不覆盖。
- **只升不降**：旧构建（陈旧 `dist`）不得把已存的更高版本降级。
- CSS Fixer 的源码改动必须先 `npm run build:css-fixer` 重新生成 `.user.js`；
  冒烟专用 bundle 由 `ensure:smoke-bundles` 按清单自动重建（见 09）。

## 7 构建与测试

```bash
npm run test:userscripts        # 运行时、GM API、PPAPI/Ruffle、子帧
npm run test:userscripts-admin  # 安装、管理、内置脚本与浮窗助手
npm run test:css-fixer          # CSS Fixer 两条注入路径
npm run build:css-fixer         # 改 css-fixer-entry.ts 后必跑
```

- 单元：`tests/userscripts/*.test.ts`（解析、匹配、值、请求、require、崩溃退避、
  GitHub 模块相关）。
- Electron smoke：`tests/electron/userscripts-*-smoke.cjs`、`userscript-css-fixer-smoke.cjs`；
  所有 smoke 前都会跑 `ensure:smoke-bundles`。
- 2026-10-28（`200420d`）补了 document-start 模式下 smoke 的配置查询处理，避免冒烟
  用例把"脚本未执行"误判为回归。

## 8 雷区

1. **不要改回 CDP 注入页世界**：detach 丢注册、长期附着冻结导航。
2. **`sendSync` 必须在任何视图导航前注册**：`userscript:get-config` 缺失会让渲染层
   IPC 累积损坏、后续导航挂死（与 01 同源）。
3. **内置脚本不要直接改 `.user.js`**：CSS Fixer 由 `css-fixer-entry.ts` 生成，改错文件
   会在下次构建被覆盖。
4. **后台脚本的 `@connect` 不能省**：后台页面没有来源域名，同源放行不适用。
5. **GM 值不要存不可序列化对象**：跨进程后只剩 JSON，函数/循环引用会静默丢失。
6. **新增 GM API 必须同时提供 `GM_x` 与 `GM.x` 两种拼写**（按 `gm-api.ts` 的
   `expose()` 约定），否则老脚本不兼容。
7. `page-bridge.ts` 顶部注释仍写着"real product 用 CDP 注入"，**与实现不符**：产品路径
   是 `bootstrap.ts:73` 的 `webFrame.executeJavaScript`。以代码为准，不要按注释改回去。
