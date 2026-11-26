# 新项目反哺老项目：可移植设计清单

2026-11-26 · 代码比对结论

**比对基线**：新项目 `BaoFlashBrowserNext/app`（Electron 39.8.10 / Chromium 142，M2 实施中）↔ 老项目 `BaoFlashBrowser/src`（1.1.2，Electron 11.5.0 / Chromium 87）。

**方向**：只讨论「新项目已有、老项目可借鉴」这一向。老项目反哺新项目的内容（自动化 v3、密码库、用户脚本运行时）不在本文范围。

**来源与置信度**（按新项目文档状态词表）：

| 标记 | 含义 |
| --- | --- |
| 【事实】 | 已核对到代码或文档原文，附 `文件:行号` |
| 【推断】 | 由结构推出的判断，未实测 |
| 【待核】 | 需在 Electron 11 上先验证 API 可用性 |

本文所有「反哺后的形态」都是**设计建议，未实现**；「老项目现状」与「新项目做法」两栏才是代码事实。

---

## 0. 一页结论

14 项候选 + 1 项待决。**5 项零架构风险、可独立提交**；3 项必须按 Electron 11 的 API 面改写；3 项属结构性改造，应先立项。

| ID | 设计 | 老项目缺口 | 成本 | 版本限制 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| F1 | 改动 → 用例映射 + `--only` | 只有全量串行 smoke | 低 | 无 | **P0** |
| F2 | 活动租约表（多持有者） | 休眠判定在渲染层，单一 10 分钟定时器 | 低 | 无 | **P0** |
| F3 | 可注册域边界 + 受控弹窗 | 无公共后缀处理；弹窗无准入门 | 低 | 无 | **P0** |
| F4 | PPAPI 插件 PE 校验 | 只按路径/扩展名接受 | 低 | 无 | **P0** |
| F5 | 决策留痕（`*_TRACE`）约定 | 有日志，无结构化"为什么这样判断" | 低 | 无 | **P0** |
| F6 | 能力合同（稳定码 + 单入口 + 调用记录） | 每 IPC 各自 zod，失败抛 Error | 中 | 需改写 | P1 |
| F7 | 标签代际账本 + 两阶段提交 | `token + wc.id + 映射表`三重校验，无统一代际 | 中高 | 无 | P1 |
| F8 | `crossdomain.xml` 授权 | 对所有 `.swf` 响应注入 `ACAO: *` | 中 | 需改写 | P1 |
| F9 | 存储写入合同 | electron-store + IndexedDB 双轨 | 中 | 无 | P1 |
| F11 | 休眠优先级 ADR + 硬门禁 | 四条件已含 loading/audible，缺 Flash 内容与自动化全局闸 | 中高 | 需改写 | P1 |
| F14 | 文档 SSOT 规则页 | 无冲突登记/状态词表 | 低 | 无 | P1 |
| F10 | 外壳渲染线程心跳 | 有崩溃计数，无"卡顿"判据 | 低 | 无 | P2 |
| F12 | 高敏面板最小桥 | 内部页与外壳共享全桥 | 高 | 无 | P2 |
| F13 | 运行时哈希清单 | `verify:release` 有，开发期无 | 中 | 无 | P2 |
| F15 | 站点级引擎规则 | 无（只能逐标签手切） | 低 | 无 | 待决 |

> 编号是条目 ID，不是优先级顺序；排序以「优先级」列为准（P0 → P1 → P2）。

---

## 1. 两个项目的定位差异（决定了什么能搬）

| 维度 | 老项目 | 新项目 |
| --- | --- | --- |
| 内核 | 锁定 Electron 11.5.0 / Chromium 87，PPAPI 是产品前提（`docs/architecture-overview.md` §6.1） | 自编译 Electron 39.8.10 / Chromium 142，带 PPAPI 补丁 |
| 视图 | `BrowserView`，永远置顶，只能侧边栏或页内注入（同上 §6.2） | `WebContentsView`，可叠加浮层 |
| 外壳 | React + Zustand，内部页是外壳的一部分 | Vue + Pinia，内部页是真实 `bao://` 文档、独立会话 |
| 成熟度 | 已发布 1.1.2，功能面宽（密码库、用户脚本、自动化 v3、下载、OCR） | M2 实施中，功能面窄但**合同与验证密度高** |
| 状态权威 | 部分在渲染层（休眠定时器、视口边界） | 主进程（租约、代际、存储、能力校验） |

一句话：**老项目该拿的是"合同与判定权"，不是"新架构"**。凡是需要换 Electron 版本、换视图模型、换渲染框架的，一律不进这份清单（见 §5）。

---

## 2. P0：零架构风险，可独立提交

### F1 改动 → 用例映射表（测试）

| 项 | 内容 |
| --- | --- |
| 老项目现状 | 6 个 smoke 构件走 `scripts/smoke-bundles.cjs` + `run-smokes.cjs` 串行（`docs/modules/09-build-release-test.md` §6），日常没有"只跑受影响用例"的入口，也没有超时现场 dump 【事实】 |
| 新项目做法 | `app/scripts/test-map.cjs:1-17` 手写"改动 → 用例"近似依赖，命中不了就全量；`test.cjs` 支持 `--only=` / `--changed` / `--jobs=N`；失败自动 dump 进程分布与外壳状态；两套跑法（隐藏并行 ~80 s / 前台闸门 ~165 s）见 `app/README.md:45-51,96-100` 【事实】 |
| 反哺后的形态 | 复用既有 `smoke-bundles.cjs` 作为"用例全集"，新增 `scripts/test-map.cjs` + `scripts/run-tests.cjs`，把"改 `automation/*` → 跑 automation smoke；改 `index.ts`/`package.json` → 全量"写成表 |
| 为什么值得 | 老项目模块多、smoke 串行，改一行要等全套；这类工具没有任何产品行为风险 |
| 风险 | 映射表是近似的，**必须保留"拿不准就全量"**；`BAO_MODULES` 裁剪矩阵会让映射更复杂，先只在全模块路径上生效 |
| 验收 | 改 `src/main/modules/automation/service-v3.ts` 只起 automation smoke；改 `src/main/index.ts` 起全量 |

### F2 活动租约表

| 项 | 内容 |
| --- | --- |
| 老项目现状 | 休眠由渲染层 10 分钟定时器驱动（`src/renderer/hooks/useTabManager.ts:18`，`221-251`；四条件判定在 `239` 行）；主进程 `suspend()` 只拒绝活动标签（`src/main/modules/tabs.ts:800-804`）。没有"谁正在用它"的登记能力 【事实】 |
| 新项目做法 | `app/src/main/activity-lease.ts`：租约按稳定 `tabId` 归属、多 owner（`27`）、可续租（`95-127`）、过期确定性回收、`blocksDiscard()` 任一有效即阻止（`173-179`）；模块级单例（`206-212`），标签跨窗口拖出不丢 【事实】 |
| 反哺后的形态 | 该文件不 import electron，可整文件搬。老项目 `tabId` 是 `string`，租约表类型改成 `string`；先只做**否决票**——保留现有四条件，`suspend()` 前加一条 `blocksDiscard()`；渲染层定时器改为申请 `owner: 'user'` 租约 |
| 为什么值得 | 自动化运行中、下载中、密码填充中的标签现在都可能被定时器睡掉；判定权在渲染层意味着外壳重载一次，定时器全部重置、状态丢失 |
| 风险 | 若把休眠整体迁到主进程，要同步改 `tab:updated` 投影；建议分两步，先加否决票 |
| 验收 | 单测：续租不叠加、过期可回收、标签关闭清空；smoke：自动化句柄存在时后台超时不休眠 |

### F3 站点边界：可注册域 + 受控弹窗

| 项 | 内容 |
| --- | --- |
| 老项目现状 | 代码里没有公共后缀 / 可注册域处理（全仓无 `registrableDomain` / `eTLD` / `publicsuffix`）【事实】；`new-window` 只把 URL 转给渲染层决定（`src/main/modules/tabs.ts:707-709`），主进程不做同站准入 【事实】 |
| 新项目做法 | `app/src/shared/site.ts:12-37` 精简多段后缀表 + `registrableDomain()`；`isSameSite()` 要求协议一致（`66-72`）；弹窗只允许同站 http(s)，跨站与非 http(s) 拒绝（`app/README.md:78`）【事实】 |
| 反哺后的形态 | 新增 `src/shared/site.ts`（纯函数，可直接单测），三处接：① `new-window` 的同站准入；② 站点规则键（引擎、缩放、密码填充范围）；③ 自动化站点范围判定 |
| 为什么值得 | `a.com.cn` 与 `b.com.cn` 末两段相同但不同站，按 host 末两段比较会把两个站点判成同一个；弹窗目前等于没有主进程准入 |
| 风险 | 后缀表不完整是有意取舍（未收录按末两段）；不要引完整 PSL（~80KB 且需定期更新） |
| 验收 | 表驱动单测：`a.com.cn` ≠ `b.com.cn`，`www.x.com` = `game.x.com`（同协议），https→http 不同站；smoke：跨站弹窗被拒、同站弹窗开新标签 |

### F4 插件 PE 校验与来源信任边界

| 项 | 内容 |
| --- | --- |
| 老项目现状 | 插件按固定通道/路径解析（`docs/modules/02-flash-engines-legacy-compat.md` §3.4 表）；全仓无 PE 头、机器类型或导出表校验（无 `PPP_GetInterface` / `0x8664`）【事实】 |
| 新项目做法 | `app/src/main/pe-plugin.ts:73-97` 解 PE 头 + **解析导出表**确认 `PPP_GetInterface`（不做字节搜索，避免 `electron.exe` 误判）；自动发现只扫安装位置，**默认不扫 Downloads/Desktop**（`flash-discovery.ts:94-102`）；结果按 `path + size` 缓存（`139-169`）【事实】 |
| 反哺后的形态 | 新增 `src/main/utils/pe-plugin.ts`（纯 Node，可单测）；`resolveFlashPlugin()` 对**非随包**候选路径过 `isUsablePepperPlugin()`，失败给出具体码（`not-pe` / `not-x64` / `no-pepper-export`），诊断报告直接显示原因 |
| 为什么值得 | 老项目允许用户替换 `plugins/` 下的 DLL（实验通道）；现在放一个 32 位或非 Pepper 的 DLL，要到"加载失败"才暴露，且没有原因 |
| 风险 | 随包插件已确定，不必每次启动读 30 MB；只对用户路径做校验，随包路径按清单跳过 |
| 验收 | 三个夹具：正常 x64 插件通过；32 位 DLL 报 `not-x64`；改名 `electron.exe` 报 `no-pepper-export` |

### F5 决策留痕：`*_TRACE` 约定

| 项 | 内容 |
| --- | --- |
| 老项目现状 | `electron-log` 统一日志 + 诊断导出脱敏（`docs/modules/08-session-diagnostics.md` §4），但没有"这次为什么没休眠 / 为什么没填充 / 为什么拦了这个脚本"的结构化留痕 【事实】 |
| 新项目做法 | 统一约定：环境变量指向文件才落盘，未设置即空操作；每行带**具体命中项**。`BAO_DISCARD_TRACE`（`docs/adr/0004-liveness-over-memory-reclaim.md` §5）、`BAO_SELFHEAL_TRACE`、`BAO_OVERLAY_TRACE`（`app/src/main/shell-overlays.ts:34-45`）、`BAO_HEARTBEAT_TRACE` 【事实】 |
| 反哺后的形态 | 定义 `BAO_TRACE_DIR` 或分主题变量；在休眠判定、密码填充跳过、自动化拒绝、用户脚本拦截四处各打一行 `[t] subject=... decision=... reason=<命中项>` |
| 为什么值得 | 误杀/失效类问题的第一问永远是"它凭什么这么判断"；日志里只有结果没有判据时，只能靠复现 |
| 风险 | 默认关闭；单文件上限 + 轮转，避免长期开启写爆磁盘 |
| 验收 | 设变量后一次休眠决策落一行，含 `reason=hasFlash|loading|lease|audible` 之一 |

---

## 3. P1：需要改造，收益明确

### F6 能力合同：稳定失败码 + 单一校验入口 + 调用记录

| 项 | 内容 |
| --- | --- |
| 老项目现状 | 三张 IPC 白名单 + zod（`src/main/utils/ipc-wrapper.ts:58-70`）+ 窄桥 + `view-gate`（`docs/architecture-overview.md` §4）；但每个通道各自校验，失败 `throw new Error`（渲染层只能解析 message），没有统一的"谁在调用 / 目标代际 / 动作策略"，也没有调用记录 【事实】 |
| 新项目做法 | `app/src/shared/capability.ts`：`ActorKind`（`26`）、`TargetRef`/`ShellRef`（`64-93`）、21 个稳定失败码与文案（`138-207`）、只记身份不记载荷的 `CapabilityCallRecord`（`226-243`）；`capability-contract.ts` 纯函数校验，**校验顺序本身是合同**（结构→操作者→存在性→身份→代际→观察/frame/surface→动作级门），策略表集中（`99-114`，`tab.tearoff` 只允许 `human-ui`，`tab.discard` 不允许 `human-ui`，`199-258`）；`CapabilityCallLog` 环形 500 条（`298-343`）【事实】 |
| 反哺后的形态 | 不要求老项目改成 Capability 架构，先取三件：① **稳定失败码表**（`{ code, message }` 替掉裸 `Error`）；② **单一校验入口**（zod 之后的一致性/身份检查集中一处，顺序固定）；③ **调用记录环**（谁、什么动作、成败、原因码、耗时），接进现有诊断导出 |
| 为什么值得 | 自动化 v3、密码填充、用户脚本三类"外部调用者"现在各写一套判定；前端按码分支才能不解析文案；调用记录是"事后审计"的唯一低成本入口 |
| 版本限制 | 【待核】Electron 11 无 `event.senderFrame`（老项目自己的注释也确认无 `mainFrame`，`src/main/modules/devtoolbox-probe.ts:5`），所以"发起帧 origin"拿不到；老项目只能先做 **binding 级**代际 + `wc.getURL()` 身份，页面级短引用等 Electron 能力或 preload 上报 |
| 风险 | 老项目 20+ IPC 模块，一次性改造不可行；先落 `automation-*` 与 `password-*` 两组，其余渐进 |
| 验收 | 同一非法调用在两条链返回同一 `code`；诊断报告能看到最近 N 条调用记录 |

### F7 标签代际账本 + 两阶段提交

| 项 | 内容 |
| --- | --- |
| 老项目现状 | 每视图用 `token + wc.id + 映射表` 三重校验防旧事件污染（`docs/modules/01-browser-shell-tabs.md` §3.4）；`generation` 只用于用户脚本（`src/main/modules/tabs.ts:134,542`），绑定/导航没有统一代际；引擎切换是"销毁 → 重建"，失败只能整体回滚 【事实】 |
| 新项目做法 | `app/src/main/tab-registry.ts`：`bindingId` / `navigationId` 只能从账本推进，每次推进产生生命周期事件（`40-48`）；**先通知消费者、再使旧代际失效**（`144-152`）；`reserveBinding()` / `commitReserved()` 让候选视图先按 `+1` 代际运行，提交前它的所有事件都因 `binding-stale` 作废（`160-176`）；跨窗口 `migrate()` 不动代际（`188-198`）【事实】 |
| 反哺后的形态 | 把三重校验收敛成 `registry.resolve(tabId, { bindingId })`；引擎切换改两阶段：候选视图按预留代际创建 → 成功 `commit`、失败销毁候选（旧视图未动），不再依赖"重建失败再恢复" |
| 为什么值得 | 现有"注册表替换 + 三重校验"能挡旧事件，但**注册表替换那一刻**的语义靠读代码推断；两阶段提交让"准备失败不影响旧视图"成为结构保证 |
| 风险 | `tabs.ts` 1400+ 行，代际推进点分散；先只加只读账本与 `resolve()`，不改写路径，再逐条迁 `bump` 点 |
| 验收 | 单测穷举 5 种转换 + 监听器内改账本的派发顺序；smoke：构造引擎切换失败，旧视图仍可交互 |

### F8 `crossdomain.xml` 授权替代全局 `ACAO: *`

| 项 | 内容 |
| --- | --- |
| 老项目现状 | 对所有 `.swf` 响应注入 `Access-Control-Allow-Origin: *` + `Allow-Methods/Headers: *`（`src/main/modules/session-manager.ts:202-216`，注入在 `212`），注释写明"避免 Ruffle 跨域 fetch 失败"；主进程不读目标站 `crossdomain.xml` 【事实】 |
| 新项目做法 | 主进程 broker 按目标站策略判定：同源按完整 origin、跨源要求 `allow-access-from` 命中、`secure` 禁止 http→https 降级（`app/src/main/crossdomain.ts:176-198`）；策略读取 10 分钟缓存、64KB 上限、超限**整份丢弃**（`118-137`）；只信同可注册域的跳转（`94-107`）；重定向逐跳重授权、32MB/5 跳/20s 上限（`net-broker.ts:168-187`）；`Referer` 用启动随机令牌的私有头还原并按 `strict-origin-when-cross-origin` 裁剪（`broker-token.ts:14-32`、`sessions.ts:101-123`）【事实】 |
| 反哺后的形态 | 分两步。① **短期收窄**：把注入条件从"所有 `.swf`"改为"仅 Ruffle 视图发起的 `.swf` 请求"，其他资源恢复真实响应头；② **中期换模型**：Ruffle 的字节读取走主进程 broker，按策略授权，页面 `fetch` 不受影响 |
| 为什么值得 | 现在是"对所有目标站放弃同源策略"：影响面限于 `.swf` 公共资源（`ACAO: *` 不带凭证），风险不算高，但它无法回答"这个站允许谁读"，也无法覆盖重定向到第三方的场景；新项目的模型能回答，且真实站点（4399、淘米）已验证可用 |
| 版本限制 | 【待核】`onHeadersReceived` 只能按 URL 过滤，老项目拿不到发起者 → 步骤①需用 `isRuffle` 视图维度挂载/卸载监听，而不是按请求判定；步骤②的发起者 origin 同样受 `senderFrame` 缺失限制 |
| 风险 | 老项目"绝不重定向 `crossdomain.xml`"这条雷区必须保留（PPAPI 会把 `data:` 视作 aborted，`docs/modules/02` §8-3）；不要顺手改成跟随跳转 |
| 验收 | Ruffle 在 4399 / 淘米仍能读字节；构造"B 站策略 302 到 C 站"用例必须被拒；非 Ruffle 视图的 `.swf` 响应无 `ACAO` 头 |

### F9 存储写入合同

| 项 | 内容 |
| --- | --- |
| 老项目现状 | `electron-store`（JSON）+ 渲染层 IndexedDB 双轨；架构文档已明令"主进程推送的状态不得再用 IndexedDB 回灌推导"（`docs/architecture-overview.md` §3，09-04 下载事故根因），但写入失败语义没有统一（各模块自行 `try/catch`）【事实】 |
| 新项目做法 | 主进程单写者；`db/sqlite.ts:6-20` 五件事：参数校验（`Date`/`NaN` 拒绝静默写 NULL）、WAL + busy timeout、SAVEPOINT 可嵌套事务、语句缓存、错误码归一；`storage.ts:127-144` 先校验再落库、**写成功才更新内存快照**；库打不开 → 默认设置 + 拒绝写入 + 稳定错误码，绝不偷偷写第二份（`19-20`）；迁移前备份、幂等标记、旧文件改名归档不删（`db/store.ts:30-45`）；退出标记与载荷分开存（`79-89`）【事实】 |
| 反哺后的形态 | 不必换掉 electron-store，先取四条合同：① 唯一写入口（主进程），渲染层只读投影；② 写成功才更新内存与 UI；③ 失败三档 `invalid / unavailable / save-failed` + 稳定码；④ 迁移先备份、幂等标记、归档不删 |
| 为什么值得 | "UI 显示成功但没落盘"和"两套数据源"是同类事故的两个方向，老项目已经踩过一次 |
| 风险 | `config.ts` 字段多、写入点分散，需要先盘点写入点再收口 |
| 验收 | 只读目录/磁盘满：UI 提示失败且回读旧值；重启后无重复迁移；旧 JSON 变成 `.migrated-1` 仍在 |

### F11 休眠优先级 ADR + 硬门禁

| 项 | 内容 |
| --- | --- |
| 老项目现状 | 四条件（非活动、非 suspended、非 loading、非 audible）+ 固定 10 分钟（`useTabManager.ts:239`）；已有 loading / audible 门禁，**缺的是** Flash 内容门禁与自动化全局闸，且判定在渲染层 【事实】 |
| 新项目做法 | `docs/adr/0004-liveness-over-memory-reclaim.md`：优先级"游戏连续性 > 自动化可重复性 > 内存回收"（§1）；四条硬门禁——含 Flash 内容、加载中、存在自动化会话、`isCurrentlyAudible` 不再单独作为判据（§2）；自动回收必须 `save → ack`（300ms 上限，无 ack 放弃本次）（§3）；显式动作（引擎切换/关标签）不走握手（§3b）；自动化存在时扫描器整体提前返回（§4）；内存压力不得绕过门禁（§6）【事实】 |
| 反哺后的形态 | 采纳优先级与门禁，实现按 Electron 11 改写：<br>① Flash 内容探测：Electron 11 无 `mainFrame`/`framesInSubtree`（老项目注释已确认），改为 **preload 上报**——`webview-preload` 本就进每个子帧（`nodeIntegrationInSubFrames: true`），在子帧里检测 `embed/object/ruffle-player` 并上报，顶层与跨源 iframe 都能覆盖；<br>② `save → ack` 先不做：Ruffle 与 PPAPI 都无法可靠 flush `SharedObject`，先只保证"含 Flash 的标签不自动休眠"；<br>③ 自动化全局闸用现有 `beginAutomation` 句柄作为判据 |
| 为什么值得 | 老项目跑的就是 Flash 游戏，"静默期（读条/菜单/回合制）+ 无人操作 + 超时"正好被判成垃圾；误杀代价是几小时的存档，比省 100MB 贵得多 |
| 风险 | **收益会下调**：含 Flash 的标签回收量归零，这是决策的一部分（新项目 ADR 已明确接受）；不要用"内存告急"当绕过理由 |
| 验收 | 静音 Flash 页后台 15 分钟不休眠；加载中不休眠；自动化运行中所有标签不休眠；普通页仍按时休眠；trace 里理由落在具体命中项 |

### F14 文档 SSOT 规则页

| 项 | 内容 |
| --- | --- |
| 老项目现状 | `docs/modules/00-11` + `archive/` + `AGENTS.md` + 多份日期诊断；只有"状态：按 1.1.2 源码核对"，没有冲突登记、状态词表、"推翻不删旧文"规则 【事实】 |
| 新项目做法 | `docs/README.md`：四类文档（现行合同 / 现行记录 / 过程存档 / 依据证据）、SSOT 表、冲突登记 C1–C7、状态词表（已定/待审计/冻结/待决/事实/推断/待核）、新增与编号规则 【事实】 |
| 反哺后的形态 | 新增 `docs/README.md` 作为规则页，把现有 modules 归入"现行记录"、archive 归入"过程存档"、reports/specs 归入"依据"；建冲突登记表；**不重写任何现有文档**，只加索引与规则 |
| 为什么值得 | 老项目文档量已到"同一结论散落三处"的阶段；AI 协作时读错文档的代价比人多一倍（它不会怀疑来源） |
| 风险 | 一次性整理成本；规则页本身要保持短，否则又变成一份需要维护的长文 |
| 验收 | 任取一个结论，能按规则页找到唯一权威文档；新文档知道该放哪一类 |

---

## 4. P2：结构性，先立项再动

### F10 外壳渲染线程心跳

| 项 | 内容 |
| --- | --- |
| 老项目现状 | `memory-monitor` 每 2 秒采样进程指标（`docs/modules/08` §5）；主渲染进程连续崩溃有 30s/3 次阈值 reload（`docs/modules/01` §3.6）；但"渲染线程被同步任务卡住"没有判据——不崩溃 ≠ 不卡 【事实】 |
| 新项目做法 | 主进程每 100ms 发一跳，回执必须由渲染线程发出，因此 **RTT 直接等于被阻塞时长**（空闲 ~2ms，400ms 忙循环 → 402ms）；滑动窗口 p50/p95/p99/stalls（`app/src/main/heartbeat.ts:37-107`）；LoAF 长任务带 `sourceURL`，跨顶层窗口需按帧树归因 【事实】 |
| 反哺后的形态 | 老项目外壳同样是 React 单线程（侧栏动画、自动化面板、日志列表都可能卡）；用同一 RTT 心跳 + 阈值告警，落 `BAO_HEARTBEAT_TRACE`，在诊断面板显示 p95/max |
| 为什么值得 | 把"界面卡死"从用户口述变成可量化指标；自动化面板卡顿可直接归因到长任务 |
| 风险 | 与现有崩溃计数**不要混用**（崩溃是进程没了，卡顿是线程被占）；默认关闭，避免影响低端机 |
| 验收 | 人为 400ms 忙循环，`max ≥ 380`；空闲 p95 < 20 |

### F12 高敏面板的最小桥

| 项 | 内容 |
| --- | --- |
| 老项目现状 | 自动化、用户脚本、密码、下载、设置都是 React 外壳的一部分，共享 `defaultSession` 与 preload 全桥（`docs/modules/01` §2）【事实】 |
| 新项目做法 | `bao://settings` 是真实内部页，跑在 `persist:bao-next-internal`，只拿到 `baoSettings`（read/write/subscribe），拿不到外壳桥；该会话绝不承载 http(s)；已有设置页时复用，当前标签是 NTP 时就地覆盖（`app/README.md:66`、`src/main/internal-pages.ts`、`sessions.ts:20`）【事实】 |
| 反哺后的形态 | 不必改成真标签页，先做"最小桥分区"：把**密码查看**与**自动化编辑**两处拆成独立 preload + 独立 IPC 白名单，外壳只保留打开/关闭 |
| 为什么值得 | 外壳里任何 XSS 或第三方脚本都能拿到全桥，密码门禁与自动化授权都在这条链后面 |
| 风险 | 内部页与 `useTabsStore` 耦合深，拆出去要重做状态注入；只拆两处，不要一次全拆 |
| 验收 | 面板 preload 拿不到 `tab:*` 通道；面板崩溃外壳仍可用 |

### F13 运行时哈希清单

| 项 | 内容 |
| --- | --- |
| 老项目现状 | `verify:release` 有 source/unpacked 两阶段 SHA-256、asar、原生架构、大小校验（`docs/modules/09` §4），`provenance.json` + smoke 新鲜度；但开发/启动路径不校验运行时，用户替换 `plugins/` 下的 DLL 后没有任何提示 【事实】 |
| 新项目做法 | `scripts/runtime-manifest.json` 记录内核 EXE、插件、Ruffle 的 SHA-256；`runtime:check` 校验；`export/import` 带包内清单与关键件校验；`runtime:roundtrip` 双 profile 门禁；打包断言"有且只有一份插件"且哈希与来源一致（`app/README.md:52-55,106-114`）【事实】 |
| 反哺后的形态 | 把 `verify:release` 的资源校验抽成可复用 manifest + `check` 命令；启动后在后台校验（不阻塞首屏），诊断面板显示"运行时与清单一致 / 不一致（unverified）" |
| 为什么值得 | 发布门禁与开发门禁用同一份清单，避免"发布包验过、开发机上的 DLL 早就换了" |
| 风险 | 30MB 哈希约百毫秒级，必须后台做；未签名/自编译二进制会频繁变动，清单要能按版本刷新 |
| 验收 | 替换插件后诊断报告标记 `unverified`；未替换时 `check` 通过 |

---

## 5. 不适用清单（不要搬）

| 设计 | 为什么不能直接搬 |
| --- | --- |
| `WebContentsView` / 单浮层视图 / 预热三档 | Electron 11 只有 `BrowserView` 且永远置顶（`docs/architecture-overview.md` §6.2），没有 `WebContentsView`；浮层方案整体不成立 |
| 撤销关闭用 `navigationHistory.getAllEntries()/restore()` | Electron 11 无该 API；老项目已有自己的 `tab-session` 恢复路径 |
| `setWindowOpenHandler` + `createWindow` | Electron 11 用 `new-window` 事件（老项目已实现 `tab:newwindow`，`tabs.ts:707-709`） |
| `node:sqlite` 薄适配 | Electron 11 的 Node 12 没有该模块；要换只能上 `better-sqlite3`（原生依赖 + 三平台构建成本） |
| 自绘弹窗 chrome | 依赖 `WebContentsView` 与 `frame: false` 的组合；老项目弹窗由渲染层决定，收益不明确 |
| 内核 142 补丁 / PPAPI 沙箱修复 | 老项目锁定 11.5.0，升级等于换产品前提 |
| 浮层几何/DPI 相关实现 | 与 `BrowserView` 模型无关 |

---

## 6. 批次建议

| 批次 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| 1（纯逻辑，可分别提交） | F1 测试映射、F3 站点边界、F4 PE 校验、F5 trace 约定、F2 租约表（先只做否决票） | 无 | 各自单测 + 一条 smoke；不改现有行为 |
| 2（合同收口） | F6 ①②③（先 `automation-*` / `password-*`）、F8 ①（ACAO 收窄到 Ruffle 视图）、F9 四条合同、F14 文档规则页 | 批次 1 的 F1 提供快速验证 | 同一非法调用同码；`ruffle` smoke 通过；只读目录用例通过 |
| 3（状态权威） | F7 代际账本（先只读）、F11 门禁（preload 上报 Flash 内容 + 自动化全局闸）、F10 心跳 | 批次 2 的 F6 稳定码 | 切换失败旧视图可用；静音 Flash 页不睡；p95 可读 |
| 4（需立项） | F12 最小桥、F13 运行时清单、F8 ②（broker 模型） | 批次 2/3 | 面板无全桥；诊断显示 unverified |

**排序理由**：先把"判定与验证"变便宜（F1/F5），再把"判定"从渲染层挪回主进程（F2/F7/F11），最后才动安全边界与界面结构。反过来做，会在没有快速验证手段的情况下改最容易出事故的部分。

---

## 附：可选，需产品决策

**F15 站点级引擎规则**：老项目现在只能逐标签手切引擎（`Config` 里没有站点规则字段，`src/main/modules/config.ts:9-28`）【事实】；新项目有 `engine-rules`（站点 → 引擎，首次启动从 JSON 一次性导入 SQLite，导入成功归档，`db/store.ts`）。若老项目用户确实反复在同几个站点切换，可复用 F9 的迁移合同加一张规则表；否则不做——这是产品问题，不是设计问题。

---

## 核对方法（可复现）

```bash
# 新项目
cd BaoFlashBrowserNext/app/src
wc -l main/*.ts main/db/*.ts shared/*.ts          # 规模
grep -n "POLICIES\|validateCapabilityCall" main/capability-contract.ts
grep -n "blocksDiscard\|ACTIVITY_LEASE_OWNERS" main/activity-lease.ts
grep -n "reserveBinding\|commitReserved\|bumpBinding" main/tab-registry.ts
grep -n "allowsCrossOrigin\|MAX_POLICY_BYTES" main/crossdomain.ts
grep -n "PPP_GetInterface\|isUsablePepperPlugin" main/pe-plugin.ts

# 老项目
cd BaoFlashBrowser
grep -rn "Access-Control-Allow-Origin" src/            # 只有 2 处，均为 '*'
grep -rn "PPP_GetInterface\|0x8664" src/               # 无输出
grep -rn "registrableDomain\|eTLD\|publicsuffix" src/  # 无输出
grep -n "INACTIVE_TAB_SUSPEND_MS" src/renderer/hooks/useTabManager.ts
grep -n "suspend(tabId: string)" src/main/modules/tabs.ts
```

> 本文只做设计比对，不含任何代码改动。落地时按批次逐条开分支，每条改动单独提交并附验收输出。
