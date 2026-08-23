# 04 · 用户脚本平台

## 1 范围

平台提供油猴风格的安装、匹配、运行时和受控 GM API。脚本在 BrowserView preload 的沙箱中运行；需要访问页面主世界时通过明确的 page bridge，不获得 Node.js、任意 Electron IPC 或本地文件系统权限。

## 2 当前结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/userscripts/index.ts` | 单例与服务聚合，保持 `electron-store` 懒加载 |
| `userscript-manager.ts`、`userscript-parser.ts`、`userscript-matcher.ts` | 安装数据、元数据、URL/iframe 匹配与运行快照 |
| `userscript-store.ts`、`script-store.ts`、`userscript-values.ts` | 脚本、设置和 GM 值持久化/序列化 |
| `userscript-require-cache.ts` | `@require` / `@resource` 网络与磁盘缓存、总量预算 |
| `userscript-request-service.ts`、`userscript-download-service.ts` | 受控跨域请求和下载 |
| `userscript-background.ts`、`userscript-crash-tracker.ts` | 每脚本独立后台窗口、节流关闭、崩溃退避 |
| `userscript-cookie-service.ts`、`userscript-web-request.ts` | 只读 cookie 与仅观测 webRequest |
| `src/webview-preload/userscripts/` | bootstrap、scheduler、sandbox、GM API、page bridge 和 unsafe proxy |
| `src/main/ipc/userscripts.ipc.ts` | 文档运行时 IPC；`get-config` 是启动期 sendSync |
| `src/main/ipc/userscripts-admin.ipc.ts` | 管理页安装、编辑、更新、导出、值和后台控制 |
| `src/main/modules/userscripts/bundled-scripts/` | CSS Fixer 与自动化悬浮助手 |

## 3 执行流程

页面创建时 preload 同步请求 `userscript:get-config`，manager 按 URL、frame、启用状态和预算生成快照。scheduler 在 `document-start/body/end/idle` 运行脚本；SPA 软导航由 `did-navigate-in-page → manager.spaNavigate` 记录，不重复创建文档脚本。

页世界桥通过 preload 的 `webFrame.executeJavaScript` 注入主世界。不要用 CDP `Page.addScriptToEvaluateOnNewDocument`：调试器 detach 后注册会丢失，长期附着又会冻结导航。

`@require` 与 `@resource` 可从元数据 URL 获取并缓存，不是 Node `require`。缓存有单项/总量限制，网络访问仍受安装权限和请求服务边界约束。

## 4 背景、子帧与菜单

- 每个 `@background` 脚本使用自己的隐藏 BrowserWindow，`backgroundThrottling:false`；`userscript:get-config` 必须按 `event.sender.id` 找到对应脚本。
- 连续 5 次崩溃后停止该脚本，直到 `userscripts:background-restart`。
- 子帧可执行脚本，但 `webContents.send` 只到主框架 preload；菜单命令按脚本和标题去重，只保留主框架条目。

## 5 安全边界

- `@connect` 控制请求和 cookie 目标；私网地址、敏感请求头、响应体和超时均受预算限制。
- `GM_cookie` 只支持 list/get；不提供 set/delete。
- `GM_webRequest` 只观察，不拦截或修改；由 `session-manager.ts` 的唯一 `onBeforeRequest` 回调分发。
- GM 值必须可 JSON 序列化并通过单值/总量限制。管理端值方法有意绕过 view gate，但仍保留序列化、大小与持久化校验。
- 无参数 IPC schema 使用 `z.object({}).optional()` 或等价的 undefined schema，避免拒绝 preload 的空 payload。

## 6 构建与测试

- `npm run test:userscripts`：运行时、GM API、PPAPI/Ruffle 与子帧。
- `npm run test:userscripts-admin`：安装、管理、内置脚本和悬浮助手。
- `npm run test:css-fixer`：CSS Fixer 两条注入路径。
- 修改 `bundled-scripts/css-fixer-entry.ts` 后先运行 `npm run build:css-fixer`；smoke 专用 bundle 由各自的 `build-*.mjs` 生成，`npm run build` 不会刷新它们。

详细 API、容量和扩展步骤见 [`../userscript-developer-guide.md`](../userscript-developer-guide.md)。
