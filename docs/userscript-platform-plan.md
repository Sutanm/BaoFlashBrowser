# BaoFlashBrowser 用户脚本平台实施计划

> 状态：设计/实施计划  
> 日期：2026-08-04  
> 目标环境：Electron 11.5.0 / Chromium 87（锁定，不升级）

## 1. 目标与结论

BaoFlashBrowser 将实现一个面向自身架构的用户脚本平台，而不是完整移植 Violentmonkey，也不实现完整的 Chrome 扩展兼容层。

平台兼容通用 `.user.js` 元数据和常用 Greasemonkey/Tampermonkey/Violentmonkey API，通过现有 BrowserView preload、主进程服务和 React 内部页面完成脚本安装、匹配、注入、存储、权限控制和管理。

主要目标：

- 稳定支持旧站修复、DOM/CSS 修改、自动操作、跨域请求等常见脚本。
- 代表性目标脚本集兼容率达到 70% 以上。
- 旧站和 Flash 辅助类目标脚本兼容率争取达到 80% 以上。
- 不破坏 PPAPI、Ruffle、密码捕获、标签恢复和现有会话策略。
- 用户脚本不得获得 Node.js、Electron IPC 或本地文件系统的直接访问能力。

预计结果：

| 指标 | 预期 |
|---|---:|
| 完成稳定可用平台的成功率 | 85%–90% |
| 代表性目标脚本兼容率 | 70%–80% |
| 旧站/Flash 辅助脚本兼容率 | 75%–85% |
| 随机第三方脚本直接兼容率 | 55%–70% |
| 完整 Violentmonkey 等价兼容 | 不作为目标 |

## 2. 范围与非目标

### 2.1 第一阶段范围

- `.user.js` 安装、删除、启用、禁用和编辑。
- `@name`、`@namespace`、`@version`、`@description`。
- `@match`、`@include`、`@exclude`、`@exclude-match`。
- `@run-at document-start/document-body/document-end/document-idle`。
- `@grant`、`@connect`、`@noframes`。
- 主框架和可行范围内的子框架执行。
- 隔离环境执行和受控的页面主世界执行。
- 基础 GM API、脚本值存储、跨域请求和错误诊断。
- 用户脚本管理内部标签页和轻量侧边栏面板。
- 从 Violentmonkey/Tampermonkey 导出的脚本文件中导入脚本源码。

### 2.2 明确非目标

- 不升级 Electron 或 Chromium。
- 不重写现有标签栏 UI。
- 不实现完整 `chrome.tabs/windows/browserAction/contextMenus` 扩展平台。
- 不保证所有 GreasyFork 脚本无需修改即可运行。
- 不在第一版实现云同步、外部编辑器和完整扩展 popup。
- 不使用常驻 CDP 调试器作为主要注入机制。
- 不试图通过用户脚本补齐 Chromium 87 缺失的底层渲染、媒体、TLS、WASM 或 Web API。

## 3. 设计原则

1. **兼容协议，不移植扩展外壳**：复用 userscript 元数据和 GM API 语义，不依赖 Chrome 扩展 UI。
2. **主进程为权威数据源**：脚本、权限、值和资源由主进程保存并缓存。
3. **document-start 只访问内存**：注入路径不得同步读取磁盘或 IndexedDB。
4. **安全默认值**：脚本默认在隔离环境执行，页面主世界必须显式或自动判定启用。
5. **按真实脚本驱动兼容**：以目标脚本测试集衡量成功，不以实现 API 数量衡量。
6. **生命周期优先**：引擎切换、挂起恢复、iframe 重载和 SPA 导航不得导致重复注入或旧上下文回调。
7. **渐进实现**：高风险技术探针通过后再投入完整管理界面。

## 4. 总体架构

```text
.user.js / 导入包 / 安装 URL
              │
              ▼
     UserscriptManager（主进程）
     ├─ 元数据解析与规则编译
     ├─ 脚本/资源/值持久化
     ├─ URL 与 frame 匹配
     ├─ 权限与 @connect 校验
     └─ 运行时内存快照
              │
              ▼
      BrowserView preload
     ├─ document-start 查询
     ├─ run-at 调度
     ├─ 隔离环境执行器
     ├─ 页面主世界执行桥
     └─ GM API 客户端
              │
              ▼
     页面 DOM / 页面 JavaScript

React 主界面
├─ about:newtab
├─ about:userscripts（完整管理）
└─ 侧边栏 UserscriptMiniPanel（当前页快捷控制）
```

### 4.1 推荐模块

```text
src/main/modules/userscripts/
├─ userscript-manager.ts       # 生命周期与内存索引
├─ userscript-parser.ts        # 元数据解析与校验
├─ userscript-matcher.ts       # URL/frame 匹配
├─ userscript-store.ts         # 原子持久化
├─ userscript-values.ts        # GM 值命名空间
├─ userscript-resources.ts     # @require/@resource 缓存
├─ userscript-request.ts       # GM_xmlhttpRequest
├─ userscript-updater.ts       # 更新检查（后期）
└─ userscript-types.ts

src/main/ipc/userscripts.ipc.ts

src/webview-preload/userscripts/
├─ bootstrap.ts                # 最早期入口
├─ scheduler.ts                # run-at 调度
├─ sandbox.ts                  # 隔离环境
├─ page-world.ts               # 页面主世界桥
├─ gm-api.ts                   # GM API 实现/代理
└─ runtime-types.ts

src/renderer/components/userscripts/
├─ UserscriptsPage.tsx         # about:userscripts
├─ UserscriptList.tsx
├─ UserscriptEditor.tsx
├─ UserscriptDetails.tsx
├─ UserscriptLogs.tsx
└─ UserscriptMiniPanel.tsx
```

## 5. 标签和内部页面设计

### 5.1 内部页面

将用户脚本管理器作为虚拟内部标签页处理：

- `about:newtab`：新标签页。
- `about:userscripts`：用户脚本管理页。
- 普通 `http/https/file` 地址：创建 BrowserView。

内部页面由主 React 渲染器直接渲染，不创建 BrowserView，也不运行用户脚本。

应将现有新标签页判断逐步统一为：

```ts
type InternalPageKind = 'newtab' | 'userscripts';

function resolveInternalPage(url: string): InternalPageKind | null;
function needsBrowserView(url: string): boolean;
```

### 5.2 管理页单例

`about:userscripts` 默认只保留一个标签：

1. 请求打开时查找现有管理标签。
2. 已存在则激活并更新内部路由状态。
3. 不存在则创建虚拟标签。
4. 编辑指定脚本时传递 `section` 和 `scriptId`，不创建重复标签。

建议的内部状态：

```ts
interface UserscriptPageState {
  section: 'installed' | 'editor' | 'updates' | 'data' | 'logs' | 'settings';
  scriptId?: string;
}
```

### 5.3 未保存修改保护

由于内部标签页不会触发普通网页的 `beforeunload`，应用必须自行维护编辑器脏状态。在以下操作前显示保存确认：

- 关闭管理标签。
- 切换正在编辑的脚本。
- 恢复/替换会话。
- 退出程序。

## 6. 界面职责

### 6.1 侧边栏轻面板

只提供当前页面的即时信息和低风险操作：

- 当前 URL 匹配和已运行脚本数量。
- 当前页面匹配的脚本列表。
- 快速启用/禁用脚本。
- 当前站点暂停运行。
- `GM_registerMenuCommand` 命令。
- 最近错误摘要。
- “管理所有脚本”和“编辑此脚本”跳转按钮。

脚本源码、权限、匹配规则、更新和数据修改均跳转到管理标签页。

### 6.2 专属管理标签页

首版栏目：

- 已安装：搜索、筛选、启停、删除、编辑。
- 编辑器：源码、元数据解析结果、保存和错误提示。
- 安装确认：来源、匹配范围、授权、跨域域名和外部资源。
- 导入/导出：单脚本和批量备份。
- 日志：最近执行错误、脚本和 frame 信息。

后续栏目：

- 更新管理。
- 脚本数据查看和重置。
- 全局运行设置。
- 站点级启停规则。

## 7. 执行模型

### 7.1 运行时快照

主进程启动时加载并编译：

- 已启用脚本和元数据。
- URL 匹配规则。
- 站点黑名单。
- `@require` 和 `@resource` 缓存。
- GM 值快照。

preload 在 document-start 通过本地 IPC 获取匹配结果。同步查询只允许访问内存快照，并设置响应体和耗时上限。

### 7.2 执行身份

每个脚本执行上下文必须包含：

```ts
interface UserscriptExecutionKey {
  scriptId: string;
  webContentsId: number;
  frameId: number;
  documentId: string;
  navigationId: string;
}
```

用途：

- 防止同一文档重复注入。
- 区分 iframe 重载和 SPA 导航。
- 标签挂起、崩溃或引擎切换时使旧上下文失效。
- 取消旧上下文的请求、监听器和菜单命令。

### 7.3 运行时机

| 元数据 | 执行点 |
|---|---|
| `document-start` | preload 获得匹配结果后立即执行 |
| `document-body` | `document.body` 首次可用 |
| `document-end` | `DOMContentLoaded` 前后按兼容语义执行 |
| `document-idle` | 页面空闲或兜底定时器触发 |

调度器必须处理 preload 启动时文档已经超过对应阶段的情况。

### 7.4 SPA 导航

第一版至少监听：

- `history.pushState`。
- `history.replaceState`。
- `popstate`。
- `hashchange`。
- Electron `did-navigate-in-page`。

默认不在每次软导航后重新运行传统脚本，除非脚本声明平台扩展选项或运行时规则要求。管理器应向已运行脚本发出 URL 变化事件，并提供后续兼容策略。

## 8. 沙箱和页面主世界

### 8.1 隔离环境（默认）

- 用户脚本可访问 DOM 和受控 GM API。
- 不可访问 `require`、`process`、Electron 对象或真实 IPC。
- GM API 通过词法作用域注入，不挂到可被页面任意替换的全局对象。
- 脚本异常被隔离、记录，不阻断后续脚本和 Ruffle 初始化。

### 8.2 页面主世界

用于需要以下能力的脚本：

- `unsafeWindow`。
- 修改页面函数或框架实例。
- 拦截页面 `fetch/XMLHttpRequest`。
- 在站点脚本执行前安装补丁。

支持模式：

```text
content  默认隔离环境
page     页面主世界
auto     根据授权和兼容规则选择
```

页面主世界不得直接获得主进程 IPC。GM 调用通过带执行身份、随机通道标识和严格消息校验的桥转发。

### 8.3 PPAPI 与 Ruffle

- PPAPI 标签保持 `contextIsolation: true, plugins: true`。
- Ruffle 标签保持 `contextIsolation: false, plugins: false`。
- 用户脚本 bootstrap 必须独立于 Ruffle 初始化，任一方失败不能阻止另一方。
- Ruffle 页面主世界中必须特别检查 `require`、IPC 引用和内部配置不会泄漏给页面或用户脚本。

## 9. iframe 策略

第一技术探针验证 `nodeIntegrationInSubFrames: true` 在 Electron 11 中能否让 preload 稳定覆盖：

- 同源静态 iframe。
- 跨域 iframe/OOPIF。
- 动态创建 iframe。
- iframe 内部导航和重载。
- PPAPI 和 Ruffle 两种标签。
- Windows x64、Windows x86 和 Linux 支持范围内的行为。

处理规则：

- `@noframes` 只运行在主框架。
- 每个 frame 独立匹配其真实 URL。
- 子 frame 不继承主 frame 的脚本匹配结果。
- frame 销毁时取消该 frame 的请求和监听器。

若 Electron 11 的跨域子框架 preload 不稳定：

1. 先保证主框架和同源 iframe。
2. 将跨域 iframe 标记为部分支持。
3. 仅对明确目标网站实现有限补偿。
4. 不引入常驻 CDP 作为通用方案。

## 10. API 实施优先级

### 10.1 P0：基础执行

- `GM_info`
- `GM_addStyle`
- `GM_addElement`
- `GM_getValue`
- `GM_setValue`
- `GM_deleteValue`
- `GM_listValues`
- `GM_registerMenuCommand`
- `GM_unregisterMenuCommand`
- `GM_openInTab`

### 10.2 P1：70% 兼容目标

- `GM_xmlhttpRequest`
- `GM_getResourceText`
- `GM_getResourceURL`
- `GM_setClipboard`
- `GM_addValueChangeListener`
- `GM_removeValueChangeListener`
- `@require`
- `@resource`
- `unsafeWindow`
- 传统 `GM_*` 和 Promise 风格 `GM.*` 的基础映射

### 10.3 P2：体验完善

- `GM_download`
- `GM_notification`
- 脚本自动更新
- 站点级开关
- 更多响应类型和请求细节

### 10.4 暂缓/按需实现

- `GM_cookie`
- 高级 WebRequest 拦截
- 云同步
- 外部编辑器
- 浏览器扩展专属 API
- Violentmonkey 私有 API 和全部边缘行为

## 11. GM_xmlhttpRequest 设计

请求链：

```text
用户脚本 → preload 参数校验 → 主进程请求代理 → Electron net.request → 受控响应
```

必须实现：

- 根据脚本 `@connect` 校验目标主机。
- 仅允许明确支持的协议。
- 默认阻止 loopback、局域网敏感地址和内部应用协议；确有需求时单独授权。
- 限制重定向次数、响应大小、超时和并发数。
- 支持标签/frame/脚本卸载时取消请求。
- 过滤或单独授权敏感请求头。
- 不在日志中记录 Cookie、Authorization、完整查询字符串和响应正文。
- 明确 Cookie 跟随 `persist:` session 的策略并测试。
- 第一版支持 text/json/blob/arraybuffer 的有限集合。

## 12. 数据与持久化

### 12.1 数据模型

```ts
interface InstalledUserscript {
  id: string;
  source: string;
  enabled: boolean;
  metadata: ParsedUserscriptMetadata;
  installUrl?: string;
  updateUrl?: string;
  installedAt: number;
  updatedAt: number;
  revision: number;
}
```

额外存储：

- 脚本值：按 `scriptId + key` 隔离。
- 外部资源：按 URL、内容哈希和脚本引用关系缓存。
- 站点规则：全局和按脚本的启停状态。
- 错误日志：固定容量环形缓冲区，禁止保存敏感正文。

### 12.2 写入要求

- 使用原子替换或现有可靠存储能力，避免部分写入。
- 保存前验证元数据和源码大小。
- 保留最近一个可恢复版本或备份。
- 脚本更新不得覆盖用户本地修改，除非用户明确确认。
- 内存索引更新与持久化提交必须有明确顺序和失败回滚。

## 13. 安装和权限流程

### 13.1 安装来源

- 本地 `.user.js` 文件。
- 拖放或粘贴源码。
- 用户主动打开的 `.user.js` URL。
- Violentmonkey/Tampermonkey 导出包中的脚本源码。

禁止未经确认自动安装或执行远程脚本。

### 13.2 安装确认页

显示：

- 名称、作者、版本、来源。
- `@match/@include` 范围。
- `@grant` 权限。
- `@connect` 域名。
- `@require/@resource` 外部地址。
- 更新地址。
- 源码和明显风险提示。

脚本更新新增权限或扩大匹配范围时必须重新确认。

## 14. 分阶段实施

### 阶段 0：技术探针（必须先完成）

目标：验证架构中决定成败的能力，不制作完整 UI。

任务：

- 建立最小脚本 fixture 和本地测试站点。
- 验证主框架 `document-start` 注入顺序。
- 验证隔离环境 DOM 操作。
- 验证页面主世界执行和 `unsafeWindow`。
- 验证严格 CSP 页面。
- 验证同源/跨域/动态 iframe。
- 验证 PPAPI 与 Ruffle 两种标签。
- 验证引擎切换、挂起恢复、刷新和前进后退。
- 验证不附着常驻 CDP 时的可行注入路径。

通过标准：

- 主框架 start/end/idle 顺序稳定。
- 页面主世界探针能在目标测试页抢先安装钩子。
- 脚本异常不阻止网页和 Ruffle。
- 引擎切换后旧执行上下文不会回传有效消息。
- 至少明确记录子框架支持边界。

若页面主世界 document-start 完全不可行，应重新评估 70% 目标，而不是直接进入完整开发。

### 阶段 1：最小可用运行时

任务：

- 元数据解析器和 URL 匹配器。
- 主进程脚本存储与内存快照。
- preload 调度器和隔离执行器。
- P0 GM API。
- 执行身份和清理机制。
- 最小开发/诊断 IPC。
- 单元测试和 Electron smoke。

通过标准：

- 固定的 DOM/CSS/值存储测试脚本全部通过。
- 刷新、切换、挂起、恢复不重复执行。
- 不影响现有 `npm run test:compat`、`test:electron` 和 `test:ruffle`。

### 阶段 2：管理标签页与安装流程

任务：

- 注册 `about:userscripts` 内部页面。
- 内部页面单例和路由状态。
- 脚本列表、启停、安装、删除、基础编辑。
- 未保存修改保护。
- 安装权限确认页。
- 导入/导出基础功能。
- 侧边栏轻面板和跳转。

通过标准：

- 内部页面不创建 BrowserView、不运行用户脚本。
- 侧边栏和管理页状态来自同一主进程数据源。
- 管理标签关闭或崩溃不丢失已提交数据。

### 阶段 3：70% 兼容能力

任务：

- 页面主世界桥和 `unsafeWindow`。
- `GM_xmlhttpRequest` 及权限控制。
- `@require/@resource`。
- 值变化监听。
- 剪贴板。
- iframe 完善。
- SPA 导航策略。

通过标准：

- 代表性目标脚本集中至少 70% 达到核心功能可用。
- 未通过脚本有明确分类：运行时缺陷、Chrome 87 限制或未支持 API。
- 网络代理通过权限、取消、大小和敏感日志测试。

### 阶段 4：产品化和按需兼容

任务：

- 自动更新和权限变化确认。
- 下载、通知。
- 日志与诊断导出。
- 脚本资源缓存维护。
- 性能和内存优化。
- 针对重要旧站和 Flash 游戏逐站补偿。

停止边界：达到代表性目标集 70%–80% 后，不继续为了少量高级脚本复制完整浏览器扩展平台。

## 15. 测试计划

### 15.1 代表性脚本集

建立至少 20 个、建议 30–50 个脚本的固定测试集，覆盖：

- DOM/CSS 修改。
- 自动点击和表单增强。
- `@run-at` 各阶段。
- 值存储和跨标签值变化。
- `@require` 和资源。
- `GM_xmlhttpRequest` GET/POST/重定向/取消。
- 页面主世界和 `unsafeWindow`。
- SPA。
- 同源和跨域 iframe。
- 下载和剪贴板。
- PPAPI 游戏页辅助。
- Ruffle 页面辅助。
- 语法或 API 超出 Chrome 87 的负面样例。

### 15.2 兼容结果分类

每个脚本记录：

```text
PASS     核心功能全部可用
PARTIAL  核心功能可用，次要功能缺失
FAIL-R   运行时实现缺陷
FAIL-API 缺少 GM/浏览器 API
FAIL-C87 Chromium 87 或 V8 限制
FAIL-SITE 目标网站自身已失效
```

兼容率使用核心功能通过率，不以“脚本没有抛异常”计算。

### 15.3 自动化测试

单元测试：

- 元数据解析。
- match/include/exclude 规则。
- grant/connect 权限。
- 值命名空间和序列化。
- 响应大小、重定向和请求取消。
- 内部页面解析。

Electron smoke：

- document-start 顺序。
- 主框架和 iframe。
- PPAPI/Ruffle 两种配置。
- CSP。
- engine switch。
- suspend/resume。
- BrowserView 销毁后的清理。

每个里程碑至少运行：

```bash
npm run i18n
npm run typecheck
npm run lint
npm test -- --run
npm run test:compat
npm run test:electron
npm run test:ruffle
npm run build
```

## 16. 性能预算

初始建议预算：

- 无匹配脚本页面：运行时启动额外耗时尽量低于 5 ms。
- URL 匹配：只访问已编译内存索引。
- document-start 同步 IPC：目标低于 10 ms，设置超时/失败降级。
- 单页默认限制脚本总源码和 `@require` 展开后体积。
- GM 请求设置按脚本、按 frame 和全局并发上限。
- 错误日志、资源缓存和响应正文设置硬性容量限制。

性能指标必须在低端模式和多个标签同时恢复时验证。

## 17. 安全要求

- 用户脚本永远不能直接访问 Node、Electron、文件系统和任意 IPC。
- 所有 IPC 使用固定通道、严格 schema、执行身份和发送者校验。
- 页面主世界消息不得仅凭可预测事件名获得 GM 权限。
- 管理内部页面不得运行用户脚本。
- 远程脚本安装和更新必须进行来源与权限确认。
- `GM_xmlhttpRequest` 必须实现 SSRF/本机地址限制和 `@connect`。
- 日志不得包含密码、Cookie、Authorization、令牌、完整敏感 URL 或响应正文。
- 脚本值按脚本 ID 隔离，脚本删除时提供保留或清除数据选择。
- 脚本编辑器渲染元数据和日志时必须转义 HTML。

## 18. 主要风险与降级方案

| 风险 | 影响 | 应对 |
|---|---|---|
| 页面主世界无法稳定 document-start | 高级脚本兼容率下降 | 阶段 0 优先验证；默认隔离环境；重要站点定向适配 |
| 跨域 iframe preload 不稳定 | iframe 脚本部分失效 | 明确部分支持；优先主框架；不使用常驻 CDP |
| Ruffle `contextIsolation: false` 泄漏能力 | 安全风险 | 词法封装、无全局 IPC、独立安全测试 |
| GM 请求与 session/Cookie 不一致 | 登录态请求失败 | 使用匹配 session 的 Electron 网络栈并建立 fixture |
| 现代脚本语法超出 V8 8.7 | 脚本解析失败 | 安装时检测；后期可选转译；明确 FAIL-C87 |
| 脚本拖慢页面 | 体验下降 | 体积/并发/响应限制、耗时诊断、按站点禁用 |
| 标签引擎切换造成幽灵回调 | 状态污染 | execution key、generation 校验、统一 teardown |
| UI 和主进程状态分裂 | 配置错乱 | 主进程单一数据源、revision 和失败回滚 |

## 19. 里程碑验收

### M0：可行性确认

- 完成阶段 0 报告。
- 明确主世界和 iframe 支持边界。
- 给出继续、缩减或停止决定。

### M1：最小运行时

- 可手动安装并运行基础脚本。
- P0 API 和生命周期 smoke 通过。

### M2：可用产品

- 管理标签页、轻面板、安装确认和导入导出可用。
- 普通用户无需开发者工具即可管理脚本。

### M3：兼容目标达成

- 代表性脚本集核心功能通过率 ≥ 70%。
- 旧站/Flash 子集目标 ≥ 75%。
- 所有失败项完成分类和文档记录。

### M4：稳定发布

- 完整检查、打包验证和回归通过。
- 安全、性能和数据恢复测试通过。
- 用户文档列出支持 API、限制和排障方式。

## 20. 实施决策摘要

- **做**：为 BaoFlashBrowser 构建专用 userscript 运行时。
- **复用**：通用 userscript 元数据、GM API 语义和导入格式。
- **保留**：现有 React 标签栏和 BrowserView 标签架构。
- **新增**：主进程脚本服务、preload 执行器、`about:userscripts` 管理页和侧边栏轻面板。
- **优先验证**：页面主世界 document-start、iframe、GM 网络代理。
- **不做**：完整 Violentmonkey 扩展移植和完整 Chrome 扩展兼容层。
- **完成标准**：代表性真实脚本的核心功能兼容率达到 70% 以上，同时不破坏现有 Flash、Ruffle、导航、密码和会话能力。
