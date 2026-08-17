# 04 · 用户脚本平台

## 1 范围与目标

提供以 GM_* API 为界面的页面脚本运行时，兼容 Tampermonkey 系生态：
- **host**：主进程管理（安装/清单/更新/授权/持久化 store）；
- **runtime**：注入 Ruffle/PPAPI/内部游戏的页面主世界，GM_* 桥接主进程；
- **safe require**：限制于 bundled require-cache，不支持任意 require；
- **GM_cookie 只读**；GM_webRequest 观测式。

**边界**：不参与密码捕获（05）；不参与 Flash 引擎（02）；悬浮助手与 CSS Fixer 是两个内置脚本。

## 2 静态结构

主进程 `src/main/modules/userscripts/`:
| 文件 | 职责 |
|---|---|
| `index.ts` | 聚合：加载/保存/启用/删除/注册菜单/值读写/授权审批/背景脚本调度，`loadIncludeFromFiles` |
| `userscript-manager.ts` | 管理器，存脚本+文档+规则，匹配与过滤 |
| `userscript-parser.ts` | 头部元数据解析（name/version/description/noframes/…、`@match`/`@grant`/`@run-at`/`@connect`） |
| `userscript-matcher.ts` | 规则匹配（`matchPattern`）与授权判断 |
| `userscript-values-store.ts` | GM_* 值读写（serializable 校验 + size 预算 + noteValueWrite 持久化） |
| `userscript-require-cache.ts` | bundled require 缓存（受控模块表） |
| `userscript-request-service.ts` | GM_xmlhttpRequest 服务（host 代理，跨跨源 fetch） |
| `userscript-background.ts` | `@background` 脚本的独立隐蔽窗口运行时（每个脚本自己窗口、背景节流关闭、崩溃 5 次停止） |
| `src/main/modules/userscripts/bundled-scripts/` | CSS Fixer、自动化悬浮助手（构建期嵌入文本） |

preload `src/webview-preload/userscripts/`:
| 文件 | 职责 |
|---|---|
| `bootstrap.ts` | 挂载 svelte 式入口：初始化、暴露 `__AM_USERS` API |
| `scheduler.ts` | `run-at` 时间点调度 |
| `sandbox.ts` | 页面上下文沙箱（包装 e. g. document/window） |
| `gm-api.ts` | 对页面暴露 GM_* proxy（sendSync/invoke 受限） |
| `page-bridge.ts` | 页面世界 ↔ preload 桥 |
| `unsafe-proxy.ts` | `unsafeWindow` 代理，@grant-none 脚本拿到之 |

IPC `src/main/ipc/userscripts.ipc.ts`（zod 校验，`get-config` 为 sendSync，响应受 snapshot 预算限制）与 `userscripts-admin.ipc.ts`（管理端接口）。

## 3 核心流程

### 3.1 注入管线

```
页面导航 → webFrame.executeJavaScript(pageBridge)（主世界，不用 CDP Page.addScript——会随 debugger 死掉）
  ├─ 读取 userscripts:get-config（按 host+路径匹配）→ 计划 run-at
  └─ scheduled → sandbox.eval 脚本源码 → GM_* 经 bridge 到主进程
```

### 3.2 授权与连接

`@connect` 白名单控制 GM_xmlhttpRequest 目标 host；`@include`/`@match` 走 manager.match；`enable` 时校验可执行来源（安装/文件更新安全约束）。规则匹配是程序化确定性：`matchPattern(url)` 三元（scheme/host/path），`@exclude` 优先。

### 3.3 值存储

`GM_setValue` → 主进程 `values-store`：JSON 反序列化 → type/size（64KB 条目预算）、serializable gate 校验 → noteValueWrite 持久化（`electron-store`）。管理端 `listScriptValues/setScriptValue/deleteScriptValue` 绕过视图门禁但保留 serializable/size 校验（AGENTS.md 记有专门审查结论：设计如此）。

### 3.4 背景脚本

`@background` → `userscript-background` 为每个脚本**独立隐蔽 BrowserWindow**（`backgroundThrottling:false`），配置经 `userscript:get-config` 按 `event.sender.id` 分发（绝不假设单窗口）；crashes → 1s/2s/…/60s 退避，5 次停止至手动 `userscripts:background-restart`。

### 3.5 子帧与菜单

`webContents.send` 只达主帧 preload → 菜单命令在主帧汇总、按 script+title 去重；`isMainFrame` 传 preload 排除子帧注册。

## 4 数据模型与接口

- `ScriptConfig`：`{ source, enabled, meta, runAt, noframes, grant[], connect[], match[], include[], namespace, version }`。
- `UserscriptRuntime`（preload）/ `ManagerAction`（主进程）区分内部使用。
- IPC 通道：`userscripts:list / enable / remove / install-url / evaluate / inspect / config / setConfig / get-config(sendSync) / menu-register / menu-click / values / require / puppeteer / background-* / js-patch:get`。
- 空通道校验须用 `z.object({}).optional()` 默认（**裸 `z.object({})` 会拒 undefined**）。

## 5 安全边界与不变量

- grant 不足/未授权 → GM_* 调用被拒并 console 记录。
- GM_cookie 只读：list/get 由 `@connect` host 门控，**无 set/delete**（安全审查明确保留）。
- GM_webRequest 观测式：不拦截、URL 红action 且按 `@match` 过滤。
- values 通过 serializable/size 两个硬闸；requ页永不被 eval 到主进程（sandbox 包装全局）。
- require 仅允许 require-cache 白名单模块；任意外部 require 拒绝。

## 6 兼容性

- 两个引擎都注入：Ruffle（contextIsolation:false，页面世界直接 eval）与 PPAPI（contextIsolation:true，桥经 preload）。
- 子帧脚本：`nodeIntegrationInSubFrames` + bridge `isMainFrame` 语义（新 new-tab/game 页无 iframe badge）。
- i18n 文案仅在渲染层，不影响运行时。

## 7 测试策略

- Vitest：parser/matcher/values-store/manager 单测（`tests/userscript-*.test.ts`、`userscript-values-store.test.ts`）。
- Electron smoke：`test:userscripts`（userscript-runtime-preload）、`test:userscripts-admin`（管理端 E2E）。
- 覆盖 CGI：run-at 时序、noframes store、cookie 只读、@connect 门禁、背景脚本崩溃退避。

## 8 雷区与注意事项

1. sendSync 通道必须预注册（任何视图导航前），否则 IPC 损坏卡导航。
2. `@background` 配置按 `event.sender.id` 分发——每脚本独自窗口。
3. 菜单命令从子帧不触发：主帧收集 + 去重。
4. preload IPE 只进主帧——子帧脚本只能 `webFrame.executeJavaScript`。
5. 改 `bundled-scripts/css-fixer-entry.ts` 后必须 `npm run build:css-fixer`，否则 bundle 测 STALE。
6. `link.disabled` 不重载 css——整段替换 `<style>`；CSSOM 不存在的规则要在 CSS 文本层重写。

## 9 演进建议

- 值 store 的 64KB 条目预算尚无配置面：可给 GM_setValue 加配额提示。
- `@background` 与大主进程并发：观察多背景脚本内存占用的探针（08 可挂）。