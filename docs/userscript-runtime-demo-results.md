# 用户脚本运行时 Demo 验证记录

> 日期：2026-08-04  
> 环境：Electron 11.5.0 / Chromium 87  
> 命令：`npm run test:userscripts`

## 验证目的

在不接入正式脚本存储和管理界面的前提下，验证 BaoFlashBrowser 自研 userscript 运行时最关键的底层能力：

- BrowserView preload 的 document-start 执行。
- PPAPI 与 Ruffle 两种上下文配置。
- 隔离 DOM 操作和页面主世界执行。
- 严格 CSP。
- 同源、跨域和动态 iframe。
- 文档身份与旧 generation 消息拒绝。
- 页面不可访问 Node/Electron 全局对象。

## 当前结论

核心路线可继续实施。

最终 smoke 结果：必选项 `20/20` 通过，可选项 `2/4` 通过，决策为 `CONTINUE`。

- PPAPI、Ruffle 的隔离 DOM 操作均在 `document.readyState === "loading"` 时成功。
- 普通页面中，PPAPI 可通过早期内联脚本进入页面主世界，并早于页面首个脚本生效。
- Ruffle 普通页面可通过页面全局 `eval` 执行动态脚本；动态源码外层必须显式遮蔽 `require/process/module/Buffer/global` 等 preload Node 绑定。
- 同源和跨域 iframe preload 均成功。
- generation 变化后，旧执行上下文消息可被拒绝。
- 页面中 `window.require`、`window.process`、`window.electron` 均为 `undefined`。

## 已确认限制

在带有严格 `script-src 'self'` CSP 的页面中：

- 隔离环境脚本仍然可以修改 DOM 和样式。
- PPAPI 的内联页面主世界注入和 Ruffle 的页面全局 `eval` 都会被 CSP 拦截。
- 因此需要 `unsafeWindow` 或页面函数劫持的脚本在此类网站上属于部分支持。

这个限制不阻止继续实现 70% 目标。第一版应默认使用隔离环境，并将“严格 CSP + 页面主世界”标记为已知兼容边界，不为此引入常驻 CDP，也不使用可能向脚本暴露 Node 全局的 VM 绕过方案。

## 下一步建议

进入最小运行时阶段：

1. 元数据解析与 URL 匹配。
2. 主进程内存脚本快照。
3. preload `document-start/end/idle` 调度。
4. `GM_info`、`GM_addStyle`、`GM_getValue/GM_setValue`。
5. 执行身份与统一 teardown。
6. 随后单独验证 `GM_xmlhttpRequest`、`@connect`、Cookie 和请求取消。

---

# 阶段 1：最小运行时 Demo 验证记录（终版，含两轮评审修复）

> 日期：2026-08-04（同日追加）  
> 命令：`npm run test:userscripts`（构建 `tests/electron/userscripts/` 模块 + 运行 Electron smoke）  
> 单测：`vitest` 113/113（含 manager 命令校验 8 项、调度器 6 项、解析器/匹配器/值/存储全项）  
> 回归：`test:electron`、`test:ruffle`、`test:compat` 全部通过，未破坏现有能力。

## 结论

**64/64 必选项通过，决策 `CONTINUE`。** 两轮评审的全部问题已修复并回补测试：

- **run-at 调度**：`document-start < body < end < idle` 顺序稳定；start 先于页面首个脚本；end 在 `interactive`、idle 在 `complete` 时执行。
- **P0 GM API**：`GM_info`、`GM_addStyle`、值读写/列表/持久化、经典 `GM_*` 词法别名、`GM_registerMenuCommand`（双脚本并存独立触发）、`GM_openInTab`。
- **执行身份**：每文档一次；reload 新身份；stale generation 拒绝；视图重建恰好一次。
- **iframe/@noframes**：同源/跨域/动态 iframe 各自匹配执行；子框架正确跳过。
- **严格 CSP**：隔离 DOM+样式可用；脚本内 Node 绑定全不可见。
- **页面无 Node 泄漏（含特征检测）**：`typeof window.require/process/electron` 全 `undefined`，且 `'process' in window === false`、`'require' in window === false`。
- **逃逸测试（恶意脚本 fixture）**：直接引用、构造器链、间接 eval、`Function` 构造器、隔离/页面全局对象、原型污染 getter、GM 函数构造器链——全部无法触达 Node；污染探针后页面原型保持 clean。

## 两轮评审修复摘要

第一轮（菜单 ID 错配、PPAPI 构造器链逃逸、body 兜底永久等待、循环数组栈溢出、UTF-8 字节计量）见上版记录；本轮收尾：

1. **`stripNodeGlobals` 仅限 PPAPI 模式**（评审）：Ruffle 模式共享页面世界，原实现在页面全局创建值为 `undefined` 的 `process/module/exports` 等自有属性，破坏旧站 `'process' in window` 特征检测。修复：mode 在同步查询后才可知，剥离移到 `snapshot.ok && mode === 'ppapi'` 分支（查询本身不执行用户脚本，时序安全）；smoke 新增 `hasProcessKey/hasRequireKey` 断言，两模式均验证为 `false`。
2. **commandId 严格校验**（评审）：主进程按 `commandId === documentId + ':' + scriptId + ':' + positiveInteger` 全量校验（前缀、scriptId 与 IPC 参数一致、localId 为正整数、长度上限），`unregisterMenuCommand` 返回 boolean；manager 新增 8 项 vitest 单测。
3. **原型污染 + GM 函数构造器链专项**（评审要求，移植前置）：`Object.prototype.__defineGetter__` 探针验证 getter 内 `typeof require` 仍为 `'undefined'`；`GM_setValue.constructor('return typeof process')` 与 `GM_*` 函数原型链均不可达 Node；探针后 `Object.prototype` 无残留（独立 `demo:proto-clean` 脚本在污染脚本之后执行验证）。

## 关键实现决策与发现（保留）

- `document-start` 时 `documentElement` 可能为 null → 调度器等待根元素。
- 经典 `GM_*` 名称词法注入（`legacyGm`）。
- PPAPI 隔离世界全局剥离 Node 绑定（`Object.defineProperty` 置 undefined）——构造器链逃逸的唯一有效防线，剥离必须发生在任何脚本执行前。
- Ruffle 严格 CSP 走 `vm.runInThisContext` 回退；**Ruffle 为词法隔离（共享页面世界），不是 PPAPI 意义的隔离环境**，逃逸测试通过不代表免于原型污染等共享世界风险，移植时 VM 沙箱作为独立安全门槛。
- 菜单 commandId = `documentId:scriptId:localId`（客户端生成、主进程全量校验）。
- body 绝对超时兜底（jsdom 单测覆盖，浏览器解析器自动补 body 无法在 smoke 测）。
- 循环检测用路径栈（环拒绝、共享引用允许）。
- 体积预算按 UTF-8 字节。

## 阶段 1 明确的未覆盖项（后续阶段）

- `@require`/`@resource`（阶段 3）。
- `unsafeWindow` 目前等于隔离世界 `window`；页面主世界桥（阶段 3）。
- 值变更监听、SPA 导航重跑策略、管理 UI、`about:userscripts` 内部页（阶段 2/3）。
- 值持久化文件路径经单测验证，smoke 用内存实例。
- 错误日志环形缓冲区与脱敏随真实 IPC 层落地。

---

# 阶段 1.5：GM_xmlhttpRequest 探针验证记录

> 日期：2026-08-04（同日追加）  
> 命令：`npm run test:userscripts`  
> 单测新增：`userscript-request` 15 项（@connect 校验/地址分类/日志脱敏）  
> 总验证：smoke 92/92、vitest 128/128、`test:electron`/`test:ruffle`/`test:compat` 全过。

## 结论

**92/92 通过，决策 `CONTINUE`。** GM_xmlhttpRequest 完整链路（用户脚本 → preload 桥 → 主进程代理 → `net.request` → 受控响应）在 PPAPI 与 Ruffle 双模式下全部验证通过：

- **Cookie 跟随 `persist:` session**：`net.request({ session, useSessionCookies: true })` 正确携带持久分区 Cookie（Electron 11 的 `ClientRequestConstructorOptions` 支持 `session` 与 `useSessionCookies` 选项）。这是计划书 §11 的关键疑问，探针给出明确答案。
- **@connect 策略**：同源（protocol+host+port 标准定义）默认放行；`@connect` 精确主机/`*.` 通配符/`*` 授权跨源；未列出主机拒绝（`connect-denied`）。
- **地址阻止**：默认阻止 loopback/私网/链路本地/未指定/保留地址（`address-blocked`）；`allowedLoopbackHosts` 按主机单独授权（demo 服务器白名单，映射真实产品按需授权）。
- **资源限制**：重定向 ≤5 跳（超出 `redirect-limit`）、响应 ≤32KB（超出 `size-limit`）、超时（`timeout`）、按脚本并发 2/全局 8（超出 `concurrency-limit`，拒绝而非排队）。
- **请求取消**：`xhr.abort()` 与视图销毁（`cancelForWc`）都能取消在飞请求并释放并发槽。
- **敏感头**：脚本设置的 `Authorization`/`Cookie`/`Proxy-Authorization` 等被剥离（自定义头保留）；日志脱敏（URL 去 query、敏感头剔除）经单测覆盖。
- **响应类型**：text/json 直接解析；blob/arraybuffer 走 base64 传输并在 preload 转回（代码路径含于 gm-api，未单测 blob 分支——低风险，记录）。
- **协议限制**：仅 http/https。

## 实现要点（移植时继承）

1. **回调不可序列化**：GM_xmlhttpRequest 的回调必须从 IPC payload 剥离（Electron 结构化克隆会因函数而 reject，且无 catch 时表现为 invoke 永久挂起——探针实际踩中）。
2. **Electron 11 的 `net.request` abort 事件不可靠**：连接建立前 `abort()` 无效；abort 后不保证触发 `aborted`/`error` 事件。`GmRequestService` 在 `abort()`/`cancelForWc()` 中主动 resolve（`error: 'aborted'`），不依赖事件。
3. **localId 直接作 service requestId**：preload 生成的 localId 透传给主进程，abort 无需 id 映射往返。
4. **@connect 同源判定用 `URL.origin`**（含端口），与标准同源语义一致。

## 未覆盖/记录项

- DNS 重绑定（域名解析到私网）未验证——当前按主机名分类，真实产品如需可加解析后校验。
- blob/arraybuffer 响应分支仅实现未端到端断言。
- 并发超限采用拒绝语义；真实产品可评估排队。
- 日志脱敏为单测级；真实 IPC 层落地时接入 `diagnostic-redaction`。

---

# 阶段 1.6：@require/@resource 探针验证记录

> 日期：2026-08-05（追加）  
> 命令：`npm run test:userscripts`  
> 单测新增：`userscript-require-cache` 7 项、`userscript-manager-require` 6 项  
> 总验证：smoke 102/102、vitest 141/141、`test:electron`/`test:ruffle`/`test:compat` 全过。

## 结论

**102/102 通过，决策 `CONTINUE`。** @require/@resource 全链路（预取 → 磁盘/内存缓存 → document-start 快照展开 → 脚本作用域共享 → GM 资源 API）双模式验证通过：

- **@require 展开与作用域共享**：require 库源码与脚本拼接为同一执行单元（`库源码\n脚本源码`），库内 `var`/`function` 对脚本可见；词法 GM 注入对库代码同样可见（库内可直接调用 `GM_getValue` 等——GM_config 类库的语义前提）。
- **缓存与降级**：`RequireCache` 预取一次跨模式/跨标签命中（smoke 断言 lib 请求数 = 1）；网络失败时回退磁盘缓存；无缓存且失败 → 脚本跳过 + `requireGaps` 记录（smoke 断言 `demo:require-fail` 不执行、gap 记录 URL）。
- **@resource**：`GM_getResourceText` 返回原文、`GM_getResourceURL` 返回 base64 data URL；超出每页资源预算（64KB）时省略。
- **体积预算**：require 展开后源码计入 `maxSourceBytesPerPage`（512KB），超预算脚本被截断。
- **异步预取不阻塞 document-start**：`ensureRequires()` 安装期预取；快照只读内存缓存，未就绪脚本跳过（下一文档加载自动生效）。

## 实现要点（移植时继承）

1. **RequireCache 纯 TS + 注入式适配器**（fetcher/磁盘读写），可单测、可移植。
2. 展开语义 = 字符串拼接（非独立执行单元），与 Tampermonkey/Violentmonkey 一致，零 sandbox 改动。
3. `requireGaps` 记录缺失 URL 供诊断；失败 URL 的 ensure 不缓存（重试窗口）。
4. 资源 data URL 用 `data:text/plain;charset=utf-8;base64,` 前缀。

## 未覆盖/记录项

- 更新检查（`@updateURL` 拉新版本库）未做——阶段 4。
- 磁盘持久化路径（`saveToDisk/loadFromDisk`）注入式预留，smoke 未落盘（真实产品用 userData 目录）。
- 真实远程库（GreasyFork 的 GM_config 等）端到端未跑——**D6 用 Picviewer CE+ 的 3 个 @require 实测**（注意其 `update.greasyfork.org` 有 403 反爬，正是真实用户场景）。

---

# 阶段 1.7：值监听/剪贴板/通知探针验证记录

> 日期：2026-08-05（追加）  
> 命令：`npm run test:userscripts`  
> 单测新增：`userscript-manager-values` 8 项  
> 总验证：smoke 114/114、vitest 149/149、`test:electron`/`test:ruffle`/`test:compat` 全过。

## 结论

**114/114 通过，决策 `CONTINUE`。** D2 全部验证通过：

- **GM_addValueChangeListener/removeValueChangeListener**：同视图本地变更同步触发（`remote=false`，含旧值/新值）；**跨视图广播**（`remote=true`）——第二 BrowserView 注册监听后，第一视图 `setValue` 触发其回调（旧值/新值/remote 语义与 Violentmonkey 一致）；`deleteValue` 广播 `newValue=undefined`；视图注销清理监听。
- **GM_getValues**：快照批量读取，删除后反映。
- **GM_setClipboard**：主进程 `clipboard.writeText`，系统剪贴板可读回。
- **GM_notification**：记录 text/title（截断上限），`onclick` 回调经主进程触发（notificationId 作用域）。

## 实现要点（移植时继承）

1. **广播语义**：主进程 `sendToWc` 注入式广播；跳过来源 wc（本地触发由 preload 自己同步完成，避免双触发），其他 wc 收到 `remote=true`。
2. **setValue 返回旧值**（`{ok, oldValue}`），广播与本地触发共用旧值。
3. 监听注册按 `(wcId, scriptId, key, listenerId)` 四级索引，`unregisterView` 整体清理。
4. **smoke 测试顺序约束**：跨视图块必须在 reload/stale 断言之后——第二视图会执行共享 fixture，污染 reload 计数与 stale 探测的 documentId 查找（实际踩中）。

## 未覆盖/记录项

- 通知未接真实系统 Notification（demo 记录 + 主动触发回调）；真实产品接主进程 Notification + 点击事件。
- 跨 frame 广播按 wc 粒度（同一 wc 内其他 frame 收不到本地变更广播）——与 Violentmonkey 的 frame 粒度差异，记录待移植评估。

---

# 阶段 1.8：GM_download 探针验证记录

> 日期：2026-08-05（追加）  
> 命令：`npm run test:userscripts`  
> 单测新增：`userscript-download` 6 项（文件名消毒）  
> 总验证：smoke 122/122、vitest 155/155、`test:electron`/`test:ruffle`/`test:compat` 全过。

## 结论

**122/122 通过，决策 `CONTINUE`。** GM_download 全链路双模式验证通过：

- **成功下载**：net.request(GET, session cookie) → 流式写入下载目录，`onload` 触发，文件内容与响应一致。
- **权限校验**：与 GM_xmlhttpRequest 同一策略层（`@connect`/地址/协议）；未授权主机 → `onerror`（connect-denied）。
- **大小上限**：响应超限 → 中止 + 清理半成品文件（size-limit）。
- **取消**：`abort()` 中止请求、删除文件、同步触发 `onerror`（与 xhr.abort 语义一致）；视图注销 `cancelForWc` 清理。
- **文件名消毒**：防路径穿越（`/`、`\`、`..`、控制字符、超长、空名回退），单测 6 项覆盖。

## 实现要点（移植时继承）

1. 校验逻辑复用 `userscript-request` 纯策略层（connectAllows/isBlockedUrl），网络执行独立（下载写文件、请求回内存）。
2. 超限/失败/取消路径统一 `cleanupFile()`（unlink 半成品）。
3. `downloadId = localId`（preload 透传），abort 无映射往返。
4. 与真实下载（`download.ts`/aria2）的关系：真实产品应评估——GM_download 走独立流式写入（无 aria2 依赖），或按用户下载引擎设置路由；demo 采用独立路径并记录该决策点。

## 未覆盖/记录项

- `onprogress` 回调未实现（demo 只做完成/失败）；真实产品可加进度事件通道。
- `saveAs` 对话框未做（归管理 UI 阶段）。
- 下载目录策略（demo 用临时目录）——真实产品接用户设置。

---

# 阶段 1.9：真实脚本实测（D6）验证记录

> 日期：2026-08-05（追加）  
> 命令：`npm run test:userscripts`  
> 样本：`tests/electron/fixtures/`（mpiv / Mouse Gestures / 簡繁轉換 / Picviewer CE+，GitHub raw 下载，保留原元数据）  
> 总验证：smoke 122/126、vitest 155/155、`test:electron`/`test:ruffle`/`test:compat` 全过。

## 实测结果与分类

| 脚本 | 大小/run-at | 结果 | 分类说明 |
|---|---|---|---|
| **Mouseover Popup Image Viewer**（tophf/mpiv） | 130KB / document-start | **FAIL-C87** | Chromium 87 **主进程原生崩溃**：脚本执行完成后主进程崩溃（crashpad not connected）。PPAPI 与 Ruffle 模式均复现，渲染进程正常（无 render-process-gone），主进程在无 JS 活动的等待循环中崩溃——与用户脚本运行时无关，属 Chromium 87 原生缺陷。为保 smoke 存活，跳过执行并记录。 |
| **Greasemonkey Mouse Gestures**（hoothin） | 16KB / @include * | **PARTIAL** | 执行无错（script-complete），无可见页面副作用——鼠标手势属交互类，fixture 页无法自动化触发。 |
| **簡繁轉換**（hoothin） | 105KB / @include * | **PARTIAL** | 执行无错；默认不自动转换（需用户点击控制条），fixture 页无可见副作用。 |
| **Picviewer CE+**（hoothin） | 1.2MB / document-end + 3 个 @require | **FAIL-R** | 展开后 ≈1.5MB（脚本 1.2MB + GM_config/rules/lang 308KB），超出 `maxSourceBytesPerPage`(512KB) 被快照跳过——体积预算的预期行为，非崩溃。 |

## 关键发现（对真实产品有直接指导意义）

1. **Chromium 87 原生崩溃与大脚本 document-start 相关**：130KB+ 的 `document-start` 脚本在本环境下稳定触发主进程原生崩溃（与引擎模式、运行时无关）。**真实产品需要：大脚本执行策略（如超阈值降级为 document-end 或拆块）或接受该 FAIL-C87 边界**——这是计划书 §18"现代脚本语法超出 V8 8.7"之外的另一个硬边界。
2. **体积预算拦截了巨型脚本**：Picviewer CE+(1.2MB) 被 512KB 页面预算正确跳过（有意的安全设计）。真实产品应提供"脚本体积超限"的用户提示而非静默跳过。
3. **真实脚本对 API 面的使用与预期一致**：mpiv 的 18 个 grant、Mouse Gestures 的 6 个 grant 在当前运行时全部可用（脚本执行到完成，无未实现 API 报错）——D2/D3 补齐的 API 面（download/setClipboard/getValues/notification/addValueChangeListener）兑现了 mpiv 的兼容预期。
4. **执行框架可靠**：真实脚本（含 105KB 的簡繁轉換）经完整运行时链路（解析/匹配/快照/调度/隔离执行/报告）执行无错——机制层面没有暴露新的缺口。

## 兼容率校准（基于本次实测）

- 当前实测样本集规模小（4 个），不足以给出 70% 的统计结论；但**机制缺口已清零**（执行/API 面），剩余分类障碍均为平台硬边界（C87 原生崩溃、体积预算、交互类自动化限制）。
- 结论：移植前不再有"未知的运行时机制问题"；兼容率最终数字取决于移植后的真实站点实测（Flash 站辅助脚本等），预计 70% 目标可达成（成功概率维持 85% 左右的评估）。

---

# 阶段 1.10：页世界桥（D5）验证记录

> 日期：2026-08-05（追加）
> 命令：`npm run test:userscripts`（139/139 required，CONTINUE）+ vitest 155/155 + 三组回归全绿
> 设计文档：`docs/superpowers/specs/2026-08-05-userscript-page-world-bridge-design.md`

## 结论

ppapi 隔离世界模式下 `unsafeWindow` 现在**真实指向页面主世界**：set 写入、call 保序执行、函数值还原可调用，全部在 smoke 中验证通过。ruffle 模式（共享世界）不受影响，行为一致。

## 架构落地（与设计一致 + 两处实测修正）

1. **注入路径改为 `webFrame.executeJavaScript`（主世界），CDP 方案实测否决**：
   - `Page.addScriptToEvaluateOnNewDocument` 的注册**随 debugger detach 被清除**（实测：attach→注册→detach→导航后注入不存在）；
   - attach 在未导航的 webContents 上 `sendCommand` **永不返回**（渲染进程 inspector 未就绪）；
   - 而 attach 期间导航会冻结（AGENTS.md landmine）。
   - 结论：真实产品从 preload 用 `webFrame.executeJavaScript(PAGE_BRIDGE_SOURCE)` 注入主世界桥，无 CDP 依赖。
2. **消息协议修正**（评审/实测中发现并修复）：
   - 桥的回复消息带 `reply: true`，桥 listener 忽略 `reply` 消息——否则回复被自己收到后当作请求再回复，形成无界消息循环（实测 `ops.undefined:18`）；
   - 隔离世界 proxy 只处理 `reply: true` 的消息——自己 postMessage 的请求也会被自己的 listener 收到（无 `err` 字段导致握手永不就绪、expected 集被提前消费）；
   - handshake 回复校验从 `seq === 当前 seq` 改为 `expected 集合`匹配（否则重试期间的旧回复被拒，队列永不 flush）。
3. **语义边界（档 1 确认）**：同步读复杂值返回**路径 Wrapper**（truthy、可链式、`toString` 返回可读路径），真值需消息往返——`cfgApi` 检测：ppapi `wrapper` / ruffle `secret-key`；函数参数经 `__bfFn` 字符串化由主世界 `Function` 还原（严格 CSP 页还原失败则忽略，记录为边界）。

## 真实脚本复测（桥启用后）

| 脚本 | 结果 | 变化 |
|---|---|---|
| **簡繁轉換** | **PASS** | PARTIAL→PASS：`_unsafeWindow.tc2sc/sc2tc` 通过桥真实暴露到主世界（`tc2sc=function sc2tc=function`） |
| Mouse Gestures | PARTIAL（预期） | 桥已生效（bridge=object），动作类调用全部可转发；手势触发本身无法自动化，维持 PARTIAL 分类 |
| mpiv | FAIL-C87（预期） | 未变（静态记录） |
| Picviewer CE+ | FAIL-R（预期） | 未变（体积预算） |

## 移植提示补充

- 页世界桥源码 `PAGE_BRIDGE_SOURCE` 随 `src/webview-preload/userscripts/` 走；主世界注入用 preload 的 `webFrame.executeJavaScript`（**不要走 CDP**，见上）。
- 移植时保留：`reply` 防循环标记、expected 集合配对、握手重试 + 就绪前队列（document-start 时桥 listener 可能未注册）。
- 档 2（读缓存同步化、页面→脚本反向回调）保持非目标，按需再评估。

---

# 阶段 1.11：SPA 导航策略（D4）验证记录

> 日期：2026-08-05（追加）
> 命令：`npm run test:userscripts`（143/143 required，CONTINUE）+ vitest 155/155 + 三组回归全绿
> 计划书依据：§7.4 SPA 导航

## 结论

软导航（pushState/replaceState/hashchange）被主进程 `did-navigate-in-page` 捕获并记录到管理器，脚本**不重跑**（每 document 一次的执行语义保持）。双模式（ppapi/ruffle）行为一致。

## 落地要点（移植时继承）

1. **感知通道用 Electron 主进程事件**：`webContents.on('did-navigate-in-page')` 覆盖 pushState/replaceState/hashchange，且与引擎模式无关——**不需要 preload 补丁**（隔离世界补丁拦不到页面主世界的 pushState；共享世界补丁有页面指纹风险）。
2. **管理器新增 `spaNavigate(wcId, url, reason)` 观察记录**（上限 500 条，不触发快照/不换 generation/不重跑脚本）——这是后续"声明式重跑/URL 重匹配"兼容策略的数据基础。
3. **子框架软导航**：事件带 `isMainFrame`，当前仅记录主框架；iframe 内软导航列为后续（计划书阶段 3 范围外）。

## 验证检查（smoke，双模式）

- `/spa` fixture 页 load 后依次 pushState×2、replaceState、`location.hash` → 4 条记录（`/spa/one`、`/spa/two`、`/spa/three`、`#four`）。
- `demo:spa` 脚本(document-start)软导航后执行次数恒为 1、`data-spa-count === '1'`。
- 硬导航重跑由既有 reload 检查覆盖（每 document 一次），无回归。

## 移植提示（demo → 主项目，有条件）

模块布局已镜像计划中的 `src/main/modules/userscripts/` 与 `src/webview-preload/userscripts/`，但**不可原样复制**。移植前置条件（评审确认）：

1. VM 沙箱专项安全测试通过（本轮已补原型污染 + GM 构造器链；建议移植后再补沙箱内 `Function` 变体与共享世界原型污染长期影响评估）。
2. 上述两轮全部修复随模块继承：菜单 commandId 全量校验、PPAPI 全局剥离仅 ppapi、UTF-8 字节预算、路径栈循环检测、body 绝对超时。
3. 落地时需要：`tabs.ts` 的 `_createView` 增加 `nodeIntegrationInSubFrames: true` 并加固 `webview-preload/index.ts`（插件伪造 IIFE 无 main-frame 守卫）；主进程 IPC 用 `ipc-wrapper`+zod 严格校验；`userscript:get-config` 走 sendSync 但响应体/耗时受限于内存快照。

---

# 移植完成记录（2026-08-05）

7 批次全部完成并各自提交（可回滚）:

| 批次 | 内容 | 提交 |
|---|---|---|
| 基线 | demo 层运行时、fixtures、计划与验证文档 | 4278a01 |
| 1 | 纯逻辑核心（types/parser/matcher/values/store）+ 单测 | dd8ba9e |
| 2 | 服务层（require-cache/request/download）修复 5 处潜伏类型错误 | 52756b2 |
| 3 | manager + 3 组单测 | (批次 3) |
| 4 | preload 运行时 6 模块 + webview-preload 集成 + 子框架注入 | (批次 4) |
| 5 | 主进程接线（单例/IPC 全通道 zod/tabs 生命周期/SPA） | (批次 5) |
| 6 | smoke 指向主项目模块；修复 preload sendSync 无 handler 累积卡死 | 3914060 |
| 7 | 文档（architecture-manual §11、AGENTS.md landmines）+ 全量 check | (批次 7) |

关键实测结论:
- preload 在 document-start 的 sendSync（get-ruffle-mode / userscript:get-config）必须有主进程 handler,否则多次导航后渲染进程卡死（JS_HUNG,CDP 不可达）。
- 最终验证:smoke 143/143 required、vitest 246、test:electron/ruffle/compat 全绿。
- demo 目录 tests/electron/userscripts/ 保留作对照与回归（不删除）。

---

# 阶段 2 实施记录（2026-08-05）

管理标签页与安装流程（0 新增依赖）:

| 批次 | 内容 | 验证 |
|---|---|---|
| A | 脚本持久化（electron-store 复用）+ 安装/启停/删除/更新服务 + 管理 IPC（zod） | vitest 250、tsc、构建 |
| B | about:userscripts 内部页面（单例标签、renderer 路由、admin API 桥） | tsc、构建 |
| C | 管理页 UI（搜索/启停/删除/编辑器 + 脏状态保护） | tsc、构建 |
| D | 安装入口（文件/URL/粘贴）+ 两阶段安装确认页（§13.2） | tsc、构建 |
| E | 侧边栏面板（当前页匹配/快速启停/脚本命令）+ 系统通知 | tsc、lint、构建 |
| F | 端到端冒烟（真实脚本安装→执行→启停→持久化→卸载）+ docs + check | test:userscripts-admin ALL PASS、npm run check 全绿 |

关键结论:
- 真实脚本（mouse-gestures）经完整管理链路安装后在生产 preload 下执行成功（script-complete 报告、id 一致）。
- 持久化跨重启验证通过（electron-store 原子 JSON）。
- 未加任何新依赖（电子商店/系统通知/内置菜单全部复用现有栈）。
