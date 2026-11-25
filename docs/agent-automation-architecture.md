# BaoFlashBrowser Next：Agent 与自动化架构

> **状态：现行权威文档（SSOT）**
> 生效日期：2026-11-24；最近裁决回填：2026-11-25
> 适用范围：产品定位、浏览器能力接口、Agent、自动化、工作流、CDP、页面感知、坐标系统、任务权限与相关交付顺序。

本文覆盖并取代以下旧结论：

- `discussions/2026-11-22-bfb-next-architecture.md` 的 §1 产品定位与 §5 自动化/Agent；
- `discussions/2026-11-21-bfb-next-architecture.md` 的 §F0–§F10 Agent 设计；
- 旧文档中“CDP Hub、自动化 v3、资源仲裁和 Agent 执行面已经存在或已经 90% 就绪”的判断。

旧文档保留为决策过程和历史证据，不再作为上述主题的实现依据。内核、发布、存储、Flash 双引擎及已经验收的浏览器功能，仍以原有专项 ADR、报告和架构合同为准；与本文冲突时，以本文为准。

---

## 1. 当前事实基线

### 1.1 项目阶段

截至提交 `f87a769`：

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| M0 · 可复现的运行时 | **已通过** | 自编译 Electron 39 / Chromium 142 运行时可供应用使用；独立复建与正式发布门禁仍是发布前遗留 |
| M1 · 浏览器薄切片 | **已验收**（2026-11-23） | 验收对象 `70edb64`；外壳、标签、双引擎、输入、焦点、恢复和成品 smoke 已结项 |
| M2 · 测试版 | **实施中，尚未整体验收** | `70edb64` 之后的设置、叠加层、插件发现、标签休眠等属于 M2 增量 |
| M3 · 专项能力 | **未立项、未验收** | CDP Hub、Page Map、自动化运行时和 Agent Host 从本阶段按独立闸门推进 |

M0–M3 是唯一项目里程碑。本文后面的 A0–A6 是 Agent/自动化架构工作流，不是第二套项目阶段。

### 1.2 已实现能力

Next 已实现的主要能力是：

- Electron 39 / Chromium 142 自编译运行时；
- Vue 外壳、WebContentsView 标签、窗口与弹窗；
- PPAPI / Ruffle 双引擎及切换；
- 全局稳定的标签业务 ID 和 WebContents 绑定代际；
- 页面、外壳、内部页的 Session 隔离；
- 沙箱、权限、导航、弹窗和 IPC 发送者校验；
- SQLite 设置存储、主题/默认引擎/飞窗预热/标签休眠设置和站点引擎规则；
- `bao://settings` 内部设置页和快捷设置叠加层；
- Flash 插件手动导入与有界自动发现；
- 后台标签休眠和用户“保持活跃”标记；
- 标签活动租约：休眠判定的统一权威，`keepAwake` 已映射为 `user` 长期租约，
  标签关闭、窗口关闭与过期均确定性清理（[报告](reports/2026-11-24-activity-lease.md)）；
- 崩溃恢复：默认正常退出后重启不恢复；异常退出时外壳提示，用户确认后才按会话重建标签
  （保留引擎、置顶、静音、`keepAwake`，后台标签以休眠状态恢复）；设置项 `session.startup`
  可改为每次启动都恢复（`continue`）；存储升级到 schema v2
  （[报告](reports/2026-11-24-session-restore.md)）；
- 真实输入、Flash、Ruffle、后台窗口和成品包回归测试。

这些 M2 增量已经交付并有测试证据，但不代表 M2 整体通过。M2 尚未完成的主要产品项是：

- 书签与历史；
- 下载策略与 UI；
- 标签分组与搜索；
- 完整 i18n；
- 两阶段引擎切换；
- 存储清理与异常退出的完整验证；
- 签名、分发、独立复建、兼容矩阵和正式发布门禁。

### 1.3 已设计但尚未实现

下列能力**尚未在正式源码中实现**：

- CDP Hub；
- CDP domain 仲裁与多消费者逻辑会话；
- OOPIF 自动接管；
- `navigationId`；
- Page Map、Target Registry、Surface Registry；
- TargetRef 和统一坐标平面；
- Automation Runtime 和 Workflow Runtime；
- Agent Host、AgentSession、AgentTask；
- Agent 权限管线、任务审计与模型 Adapter。

测试代码直接使用 `webContents.debugger` 只能证明输入路径可行，不代表 CDP Hub 已经完成。

后续文档和报告必须区分：

- **已实现**：正式源码存在，并有相应测试或运行证据；
- **已验证**：探针证明技术可行，但还不是产品模块；
- **已设计**：合同已经裁决，尚未实现；
- **提案**：仍需裁决或实测。

不得把原项目能力、历史探针或设计草图直接写成 Next 已实现能力。

## 2. 产品定位

> BaoFlashBrowser Next 是一个原生支持 Agent 操作网页、标签、窗口和浏览器外壳的通用浏览器；同时，它为重复、长期、后台、视觉和 Flash/游戏任务提供专门优化的自动化能力。

三个关键词分别解决不同问题：

- **通用浏览器**：普通网页、表单、表格、测试平台和多标签任务必须是一等场景；
- **Agent-native**：Agent 使用浏览器提供的语义能力，不依赖模仿用户点击外壳；
- **自动化增强**：长期、重复、后台和视觉任务拥有确定性运行时、资源治理和可复用工作流。

Flash 是重要差异能力，不再作为整个产品的定义。Agent 也不是附加在浏览器上的侧边栏插件，而是与人类 UI、快捷键和工作流并列的浏览器能力调用者。

## 3. 三类角色

### 3.1 Browser Capability

负责浏览器本身能做什么：

- 标签、窗口、弹窗和分组；
- 导航、刷新、历史、下载；
- 引擎、Session、Profile；
- 页面 DOM、Accessibility、输入和截图；
- 外壳设置及可撤销命令。

它不包含模型推理，也不因 Agent 存在而改变核心语义。

### 3.2 Automation Runtime

负责如何稳定、长期和重复地执行：

- 等待、定时、循环、重试和超时；
- 后台运行和唤醒；
- 状态变量、断点和预算；
- 资源租约和冲突处理；
- 轨迹、断言、报告和恢复；
- 确定性 Workflow IR。

### 3.3 Agent Runtime

负责目标理解和动态决策：

- 理解用户意图；
- 选择标签、页面区域和执行通道；
- 调用 Browser Capability；
- 必要时创建或调用自动化工作流；
- 在异常、歧义和权限边界处请求用户处理。

核心关系是：

> Agent 决定做什么以及何时借用自动化；Browser Capability 决定能做什么；Automation Runtime 决定如何长期、重复、稳定地做。

## 4. 逻辑分层与依赖方向

系统采用五层能力面：

```text
Human UI        Agent Host        Workflow Runtime
    \               |                    /
     +------- Browser Capability API ---+
                       |
       +---------------+----------------+
       |               |                |
   Browser/Shell      Page          Perception
       |               |                |
       +---------------+----------------+
                       |
             Core registries / CDP Hub
```

### 4.1 Browser / Shell

提供标签、窗口、导航、引擎、设置等语义命令。外壳是主进程状态的投影，Agent 不点击 Vue DOM，也不依赖外壳屏幕坐标。

### 4.2 Page

提供 DOM、Accessibility、表单、表格、文本、真实输入和受限网络等页面能力。

### 4.3 Perception

提供 Page Map、截图、OCR、模板、颜色、Surface 检测、遮挡和坐标转换。Perception 是通用浏览器能力，不属于 Automation 私有层。

### 4.4 Automation

提供等待、循环、调度、状态、租约、重试、断言和轨迹等确定性执行能力。

### 4.5 Workflow

提供可保存、可审计、可迁移、可回放的任务 IR。Agent 可以生成工作流，但工作流正常运行时不要求模型参与每一步。

依赖方向必须保持：

```text
model adapter -> agent host -> capability API
workflow runtime -----------> capability API
human UI adapter -----------> capability API
capability API -> registries / CDP Hub / platform services
```

核心层不得反向 import Agent、模型 SDK 或 Workflow 实现。

## 5. 统一浏览器能力接口

现有 `BrowserCommand` 是 Vue 外壳 IPC 合同，不作为 Agent 或工作流的核心接口。新的能力调用必须显式携带操作者、目标和代际。

```ts
type ActorKind = 'human-ui' | 'agent' | 'workflow' | 'system'

interface ActionContext {
  actor: ActorKind
  profileId: string
  taskId?: string
  sessionId?: string
}

interface BrowserTarget {
  tabId: number
  expectedBindingId?: number
  expectedNavigationId?: number
}

interface BrowserCapabilityService {
  execute(
    context: ActionContext,
    target: BrowserTarget | undefined,
    action: BrowserAction
  ): Promise<BrowserActionResult>
}
```

约束如下：

1. 页面和标签动作不得隐式依赖当前活动标签；
2. UI 可以在适配层把当前活动标签转换成显式 `tabId`；
3. Agent 和工作流不得持有 Electron 对象；
4. 每次调用都经过 schema、身份、代际、权限、资源和站点上下文检查；
5. 返回稳定错误码，不以模型能够理解异常字符串为前提；
6. 人类输入、Agent、工作流最终调用同一业务服务，避免三套实现漂移。

## 6. 核心注册表与身份

### 6.1 TabRegistry

管理稳定的逻辑标签身份和元数据，不负责窗口布局。

### 6.2 WindowRegistry

管理 BrowserWindow、标签归属、活动标签和窗口生命周期。

### 6.3 BrowsingContextRegistry

覆盖：

- 普通标签；
- `window.open` 弹窗；
- 内部页；
- 后续需要独立管理的嵌入式页面上下文。

弹窗不能只登记为“允许的 WebContents”，必须拥有稳定上下文身份，才能被观察、审计和安全关闭。

### 6.4 TargetRegistry

维护逻辑标签与物理 CDP target、frame、文档代际之间的映射。

```ts
interface TargetRefBase {
  tabId: number
  bindingId: number
  navigationId: number
  frameId?: string
  observationId: string
  targetId: string
}

type TargetRef =
  | (TargetRefBase & { kind: 'dom' | 'ax' })
  | (TargetRefBase & { kind: 'surface'; surfaceId: string })
  | (TargetRefBase & {
      kind: 'visual'
      surfaceId: string
      captureId: string
      transformVersion: number
    })

interface DurableTargetSpec {
  kind: 'dom' | 'ax' | 'surface' | 'visual'
  locator: LocatorSpec
  frameHops?: FrameLocatorRecipe[]
  anchor?: Anchor
  selection?: SelectionPolicy
}

// LocatorSpec、FrameLocatorRecipe、Anchor、SelectionPolicy
// 是 A3 需要冻结的可序列化联合类型；不得包含运行时 DOM/CDP 对象。
```

身份语义：

- `TargetRef` 是观察快照内的**短期解析句柄**，不得作为跨导航或跨重启的持久化配方；
- `DurableTargetSpec` 是可序列化的语义定位配方，每次执行时必须重新解析，成功与否取决于当时页面；
- Page Map 临时目标不要求一定能反推出 `DurableTargetSpec`；
- `tabId`：稳定业务身份，跨窗口移动不变；
- `bindingId`：WebContents 绑定代际，休眠、崩溃恢复、引擎切换后变化；
- `navigationId`：同一绑定内主文档导航代际；
- `frameId`：frame/OOPIF 身份；
- `observationId`：产生短引用的观察快照；
- `targetId`：只在对应观察上下文内有效的短目标 ID。

Shell 命令使用独立的 Browser/Shell target，不得伪装成页面 `TargetRef`。不得把 `webContents.id` 当作长期稳定的 Agent target。所有消费短引用的能力必须经过统一的 `validateTargetRef(action, target)`；校验规则至少覆盖 binding、navigation、observation 和 frame/surface 有效性，视觉坐标还必须校验 capture 和 transform。

## 7. 标签生命周期与活动租约

自动休眠功能保留，但 `keepAwake: boolean` 不足以承载 Agent 和自动化生命周期。

引入统一活动租约：

```ts
interface ActivityLeaseBase {
  leaseId: string
  tabId: number
  preventsDiscard: boolean
  expiresAt?: number
  reason: string
}

type ActivityLease = ActivityLeaseBase & (
  | {
      owner: 'user' | 'session-restore' | 'download' | 'devtools' | 'system'
      holderId?: string
    }
  | {
      owner: 'agent' | 'workflow' | 'capture' | 'audio'
      holderId: string
    }
)
```

规则：

1. `leaseId` 是租约唯一身份；调用方做幂等续租时复用原 `leaseId`，且不得把同一 ID 重新绑定到不同 tab、owner 或 holder；
2. 正常生命周期结束和任务取消必须按 `leaseId` 释放，单个 Session/Workflow 不得按 owner 类别批量释放；
3. `releaseOwner(tabId, owner)` 只用于有明确产品语义的策略型批量操作，例如用户关闭该标签的“保持活跃”；
4. 多实例 owner（至少 `agent`、`workflow`、`capture`、`audio`）接入时必须提供实例级 `holderId` 或等价的 holder→lease 索引；holder 崩溃时只清理该 holder 的租约，不能按 owner 类别清理；当前可选 `holderId` 的 owner 若出现多实例或需要实例级崩溃清理，必须先升级为同样的 required-holder 合同；
5. 超时租约由统一 sweep 清理；崩溃清理无法确定完成时，租约必须有 TTL 兜底；
6. AgentSession、Workflow、录制、视觉监控、音频活动和 DevTools 在需要时申请租约；
7. 用户“保持活跃”映射为无期限用户租约；
8. 存在 `preventsDiscard` 租约时不得销毁 WebContents；
9. discard、revive、engine switch 和 crash rebuild 都产生生命周期事件；
10. 生命周期事件必须先通知消费者，再使旧 binding 失效；
11. Agent 不得通过持有活动标签来隐式阻止休眠。
12. **会话级闸门**（补充规则 11，不属于"持有标签"）：存在任何自动化会话（CDP 连接、AgentSession、运行中的 Workflow）时，自动休眠扫描整体停摆；Agent 要省内存只能**显式请求**指定标签的丢弃，并说明 reason。理由：Agent 常在等待尚未绑定到具体标签的事件（游戏内回调、网络响应），按 tabId 的租约表达不了这种"等待中"。
13. **游戏连续性优先**：休眠/回收的优先级是 **游戏连续性 > 自动化可重复性 > 内存回收**（[ADR-0004](adr/0004-liveness-over-memory-reclaim.md)）。含 Flash 内容的标签、加载中的标签一律不休眠；允许休眠时也必须先 `save → ack` 成功再销毁，无 ack 不丢。内存压力不得成为绕过这条的理由。

休眠判定至少包含：用户设置、活动标签、租约、音频、页面类型、可恢复性和 TTL，以及会话级闸门、Flash 内容判定、加载状态、`save → ack`。不得用“看起来像挂机”替代明确租约；也不得用“看起来没人用”（长时间无音频的静默期、长时间无输入）作为销毁一个正在跑游戏的标签的依据。注意静音本身**不是**这个判据的来源：`isCurrentlyAudible()` 在静音后仍为真。

## 8. CDP Hub

Core registries 与 CDP Hub 是并列基础设施，不是所有 Browser/Shell 能力都依赖 CDP。任何需要 `webContents.debugger` attachment 或 CDP domain 的正式能力都必须经 Hub；不需要 debugger 的 `webContents` 原生能力不得仅为形式统一而绕行 Hub。Hub 必须早于依赖 DOMSnapshot、Accessibility CDP、OOPIF 或其他 CDP domain 的 Page、Perception、Automation 和 Agent 能力。

职责：

- 每个 WebContents 维护唯一物理 debugger attachment；
- 为多个消费者提供逻辑 session；
- 按 domain 做引用计数和副作用仲裁；
- 统一接管 `Target.setAutoAttach({ autoAttach: true, flatten: true })`；
- 管理 OOPIF、worker 和子 target 生命周期；
- 保证响应配对及事件有序派发；
- 在 binding 销毁、DevTools detach、崩溃和关闭时显式失效；
- 对 Input 等有副作用 domain 提供排他或协作策略；
- 只记录指标，不记录 CDP 参数、响应和敏感载荷。

首版只需要服务一个确定性消费者和一个探针，但 API 必须允许多消费者。正式源码不得绕过 Hub 直接 attach；测试探针可以直接 attach，但必须标明它不代表产品所有权模型。

## 9. Page Map 与观察

Agent 不直接消费完整 DOM，也不要求用户逐个选择元素。Host 生成跨 frame 的 Page Map：

```ts
interface PageMap {
  observationId: string
  tabId: number
  bindingId: number
  navigationId: number
  frames: FrameSummary[]
  regions: RegionSummary[]
  forms: FormSummary[]
  tables: TableSummary[]
  surfaces: SurfaceSummary[]
  recommendedChannel: 'dom' | 'visual' | 'hybrid'
  warnings: string[]
}
```

Page Map 至少表达：

- 主文档及相关 iframe/OOPIF；
- Shadow DOM；
- 可交互元素及短标签；
- 表单分组和字段关系；
- 表格、重复行和可编辑单元格；
- Canvas、WebGL、Flash/Ruffle surface；
- frame、surface 与顶层内容坐标的关系；
- 可见性、遮挡、面积、交互密度和深度；
- DOM、视觉或 hybrid 的推荐理由。

采用两阶段观察：

1. **Overview**：低成本页面结构和区域摘要；
2. **Inspect**：按任务相关区域获取细节。

Host 保留 selector、backendNodeId、frame 链和坐标；Agent 使用短 `targetId/fieldId/regionId`。

## 10. DOM、视觉、Hybrid 与坐标

DOM 和视觉不是互斥执行器。系统分别决定“如何找到目标”和“如何注入真实操作”。

### 10.1 DOM/AX 优先场景

- 普通表单；
- 表格和测试平台；
- 文本提取；
- 标准按钮、链接、输入框；
- 可稳定读取的跨 frame 页面。

### 10.2 视觉优先场景

- PPAPI Flash；
- Canvas/WebGL；
- 地图、远程桌面、图片编辑器；
- DOM 信息明显错误或定位成本过高；
- 视觉状态与 DOM 状态不一致。

### 10.3 Hybrid 场景

先用 DOM/CDP 找到 iframe、canvas、embed 或主交互区域，再在 surface 内使用视觉定位和局部坐标。

### 10.4 通道选择

Host 计算候选通道成本，不让模型每次从原始 CDP 结果重新试错。参考因素包括：

- frame 深度和跨源程度；
- DOM/AX 可用性；
- 可交互目标数量；
- 区域面积、可见性和遮挡；
- surface 类型；
- 观察 token 和截图成本；
- 历史定位成功率。

Agent 可以覆盖推荐，但 Host 必须提供明确理由。

### 10.5 Coordinate Plane

坐标平面统一管理：

- 页面 CSS viewport；
- 顶层内容坐标；
- WebContentsView 坐标；
- 窗口客户区坐标；
- 屏幕坐标；
- iframe 祖先偏移和滚动；
- device scale factor 和页面缩放；
- surface 局部/归一化坐标；
- 输入注入坐标。

裸 `x/y` 不是稳定目标引用。视觉结果必须绑定 capture、surface、transform 和 binding 代际。

## 11. 表单、表格和测试平台

这些场景使用批量语义能力，而不是逐元素拾取。

建议能力：

- `form.list` / `form.describe`；
- `form.fillBatch` / `form.validate`；
- `table.describe` / `table.readRange`；
- `table.editBatch`；
- `page.inspectRegion`；
- `assert.semantic` / `assert.visual`。

`fillBatch` 接收字段短 ID、值和观察代际。Host 决定每个字段最终使用 DOM、AX、CDP node、frame 内坐标还是视觉定位，并返回逐字段结果。

测试步骤应从语义轨迹生成：

```text
打开“新增用例”
填写前置条件
新增步骤 1
填写操作和预期结果
保存
验证成功提示与新增行
```

轨迹中的每一步包含目标语义、动作、前置/后置状态、证据、断言和失败原因。不要把坐标点击日志直接当作测试用例。

## 12. 人工选择器的定位

元素或区域拾取器保留，但只用于：

- 用户指代“就是这个”；
- Page Map 定位错误时校准；
- Canvas/Flash 中标记感兴趣区域；
- 创建模板、锚点和断言；
- 调试复杂 iframe。

它不是普通 Agent 的主感知入口，也不是填写多段表单和测试平台的默认交互方式。

人工校准结果可以保存为 Surface Recipe 或页面规则，但必须携带站点、frame、尺寸、缩放和代际条件。

## 13. Profile 与 Session

页面 Session 改为 Profile 注册表管理：

```ts
interface ProfileHandle {
  profileId: string
  kind: 'shared' | 'isolated-persistent' | 'isolated-temporary'
  partition: string
}
```

规则：

- 普通用户标签使用默认 shared profile；
- 不可信任务、测试账号或明确要求隔离的任务使用 isolated profile；
- Agent 不能读取 cookie 明文；
- profile 选择在任务创建时确定，不静默迁移；
- Session 权限、下载、代理和站点规则按 profile 建立明确边界；
- 不为每个普通标签创建独立 Session。

共享登录态是否允许写操作由任务权限决定，不由 Session 单独决定。

## 14. Agent Host

Agent Host 在上述底座完成后实现。

### 14.1 Task 与 Session

- `AgentTask`：用户目标、计划、进度、权限、预算和终态；
- `AgentSession`：绑定单个 browsing context、profile、mode 和租约；
- 一个 Task 可以管理多个 Session；
- Session 不等同于 Electron Session，也不等同于 CDP session。

### 14.2 模式

- `observe`：只读观察；
- `cooperative`：人在场的协作写操作；
- `exclusive`：获得明确输入排他权的无人值守执行。

升级必须显式进行，不得在工具调用中静默升权。

### 14.3 Adapter 边界

模型 SDK、消息格式、流式协议和记忆管理全部位于 Adapter。Host 只提供：

- capability manifest；
- task/session 事件；
- `executeCapability()`；
- 带来源分类的能力结果。

```ts
type CapabilityResult<T> =
  | { source: 'host'; body: T }
  | {
      source: 'untrusted-page'
      tabId: number
      bindingId: number
      navigationId: number
      body: T
    }
```

observe、extract、vision、Page Map 以及其他含页面派生内容的结果，必须在 Host 出口包装成 `source: 'untrusted-page'`；未经来源分类的页面 payload 在类型上不得进入 Adapter。Shell 状态、租约状态、action receipt 和审计结果等 Host 自有事实使用 `source: 'host'`，不得错误标成页面内容。来源标记只降低 prompt injection 风险，不能替代权限、审批、参数边界、停止和审计。

更换 Adapter 不得修改 Browser Capability、Automation Runtime 或 Workflow IR。

## 15. 权限与安全

四类权限机构保持分离：

1. Chromium 站点权限；
2. 浏览器资源与输入仲裁；
3. Agent 意图权限和审批；
4. 密码等用户秘密的独立鉴权。

统一决策管线：

```text
schema
-> actor/target identity
-> binding/navigation generation
-> profile/site context
-> resource lease
-> permission level
-> approval when required
-> execute
-> classify/wrap result provenance
-> audit summary
```

硬边界：

- Agent 无 cookie 读取能力；
- Agent 无密码明文读取能力，只能触发受控 autofill；
- Agent 不代答 Chromium 权限弹窗；
- 页面内容一律标记为不可信来源；
- 页面文本不能直接指定 workflow ID、权限级别或工具控制参数；
- 支付、银行和证券等高风险站点默认禁止写操作；
- 用户停止、关闭标签和撤销权限始终优先；
- 截图、CDP 载荷、密码和认证 URL 不进入普通日志。

## 16. 自动化与 Workflow IR

Automation Runtime 和 Agent Host 是同级消费者，不互相包裹。

Workflow IR 至少包含：

- 输入参数和变量；
- capability action；
- 当前运行内的短期 `TargetRef`，或可持久化并在执行时重新解析的 `DurableTargetSpec`；
- wait/assert/branch/loop；
- timeout/retry/backoff；
- profile 和权限要求；
- activity lease；
- checkpoint；
- evidence 和 report；
- escalation 到 Agent 或用户。

确定性步骤不调用模型。只有以下情况才唤醒 Agent：

- 目标失效且无法按语义规则恢复；
- 页面结构或视觉状态超出已知规则；
- 多种操作路径存在真实歧义；
- 需要生成新的步骤；
- 权限或业务判断要求用户确认。

录制产物首先是语义轨迹和证据，不是鼠标宏。绝对屏幕坐标不得直接成为可迁移工作流的主要目标。

## 17. 代码重构边界

现有浏览器功能不推翻，采用增量提取：

```text
BrowserWindowController
├── TabRegistry
├── WindowRegistry
├── BrowsingContextRegistry
├── TabLifecycleService
├── EngineService
├── BrowserCapabilityService
├── ActivityLeaseManager
└── BrowserStateProjector
```

`browser-window.ts` 最终只保留原生窗口创建、视图挂载、布局和适配接线。重构过程中必须保持现有 smoke 测试持续通过，不为“目录漂亮”一次性重写稳定功能。

## 18. 交付顺序

### 18.1 里程碑与架构工作流的关系

M0–M3 是项目对外和验收使用的唯一里程碑；A0–A6 只表达 Agent/自动化架构内部的依赖顺序。

| 架构工作流 | 当前状态 | 所属项目阶段 | 进入条件 |
| --- | --- | --- | --- |
| A0 · 文档与合同收敛 | **初次完成（2026-11-24）；最近裁决回填（2026-11-25）** | M2 | 本文成为 SSOT，旧 F 区归档 |
| A1 · 浏览器能力底座 | **M2 当前工作** | M2 | 不阻断已在开发的普通 M2 功能，但相关模块落地前必须接入新底座 |
| A2 · CDP Hub | 未开始 | M3 首个基础闸门 | M2 验收完成，A1 达到退出条件 |
| A3 · Page Map 与坐标 | 未开始 | M3 | A2 通过 OOPIF/生命周期探针 |
| A4 · 确定性自动化 | 未开始 | M3 | A1–A3 可用 |
| A5 · Agent Host | 未开始 | M3 | A1–A4 可用，权限与停止入口完成 |
| A6 · 工作流编译与视觉增强 | 未开始 | M3 后续增量 | A4/A5 的真实任务闭环通过 |

M3 不要求一次性交付 A2–A6。每个工作流都要有独立立项、退出证据和失败回退；M3 的整体验收口径在立项时按已纳入的工作流确定。

### A0：文档与合同收敛【2026-11-24 初次完成；2026-11-25 裁决回填】

- 本文成为 SSOT；
- 旧 Agent F 区归档；
- 新代码不得引用旧 F 区作为实现合同。

### A1：浏览器能力底座【M2 当前工作】

- 提取 Tab/Window/BrowsingContext 注册表；
- 建立显式 actor/target 的 Browser Capability API；
- UI 适配到新 API；
- 加入 binding/navigation 代际；
- 加入 ActivityLeaseManager；
- 现有标签、引擎、休眠测试全绿。

A1 在 M2 中增量实施，不进行一次性重写：

- 书签、历史、会话恢复和标签分组接入 Tab/BrowsingContext 注册表；
- 下载接入显式 actor/profile/target 上下文；
- 会话恢复和标签休眠共用 binding/navigation 生命周期；
- 现有 `keepAwake` 映射成用户长期租约；
- M2 首版 Activity Lease 至少支持 `user`、`session-restore`、`download`、`devtools`、`system`；
- `audio` 在首个音频活动租约生产者落地时接入；`agent`、`workflow`、`capture` 在对应 M3 工作流接入，不为它们提前实现空壳业务；
- 每个多实例 owner 接入时必须同时交付 holder 身份、定向崩溃清理和 TTL 兜底。

A1 退出条件：UI 已通过统一 Capability API 调用关键标签动作；休眠不会销毁持有阻止休眠租约的标签；WebContents 重建和导航代际可被测试观察；现有 smoke 全绿。另提供一个不依赖 UI、Workflow Runtime、CDP Hub 或 Page Map 的 Capability contract/integration harness，直接覆盖 actor、显式 target、binding/navigation 拒绝、租约和稳定错误码；若完整审计模块尚未进入 A1，至少固化可供后续审计消费的结构化调用记录合同。

### A2：CDP Hub

- 单物理连接；
- 多逻辑消费者；
- domain 生命周期；
- OOPIF auto-attach；
- detach、崩溃、引擎切换和休眠探针；
- 在 Electron 39 / Chromium 142 实测 debugger、DevTools 与其他客户端的共存/失效行为，并分别记录 DOM 操作、截图、输入的 CDP/native 选路依据。

### A3：Page Map 与坐标

- DOMSnapshot + Accessibility；
- frame/OOPIF/Shadow DOM；
- 短期 `TargetRef`、持久化 `DurableTargetSpec` 与统一校验入口；
- Coordinate Plane；
- 普通表单、复杂 iframe、Canvas/Flash 三类 fixture。

### A4：确定性自动化

- wait/assert/action；
- Workflow IR；
- 租约、预算、取消、轨迹和报告；
- 表单批填和测试平台用例。

### A5：Agent Host

- Task/Session；
- observe/cooperative/exclusive；
- 权限与审批；
- Adapter；
- Agent UI、停止入口和审计摘要。

### A6：工作流编译与视觉增强

- Agent 从成功轨迹生成 Workflow；
- Surface Recipe；
- OCR、模板、视觉断言；
- Flash/Canvas 长期后台任务。

不得在 A1–A3 未完成前，以模型循环直接调用散落的 Electron/CDP 方法构建正式 Agent。M2 不交付正式 Agent、模型 Adapter、Page Map 或无人值守写操作。

## 19. 第一组端到端验收

必须同时覆盖三类任务：

### 普通网页任务

用户要求填写一个被多个 section 和 iframe 分割的表单。Agent 通过 Overview 找到所有字段，使用批量语义能力填写、校验并报告，不要求用户逐个选元素。

### 测试平台任务

Agent 新建测试用例，填写步骤和预期结果，保存后验证结果；输出可读语义轨迹，而不是坐标日志。

### 视觉/游戏任务

Host 先定位游戏 iframe 和 surface，进入 surface 局部坐标；视觉检测器发现事件，Workflow 执行动作，异常时唤醒 Agent。

三类任务必须共用 TabRegistry、Capability API、租约和审计，并在需要 CDP 或页面短引用时共用 CDP Hub、`TargetRef` / `DurableTargetSpec`，不允许各自建立专用旁路。

## 20. 非目标

当前阶段不做：

- 让 Agent 直接点击 Vue 外壳 DOM；
- 把 Playwright、Stagehand 或 browser-use 作为内部浏览器所有者；
- 让模型直接消费完整 DOM 或原始 CDP 流；
- 用屏幕绝对坐标作为所有任务的统一认知接口；
- 把元素拾取器作为普通任务的前置步骤；
- 为了接入 Agent 一次性重写已经稳定的浏览器、Flash 和存储功能；
- 在能力、权限、租约和停止入口完成前开放无人值守写操作。

## 21. 后续裁决规则

1. 本主题的新结论优先修改本文，不再向旧 F 区追加“现行”条款；
2. 大幅推翻本文时新增 ADR，并在本文顶部标注被替代关系；
3. 实现状态变化必须同步第 1 节事实基线或写交付报告；
4. 社区项目只作为算法、schema、测试和产品形态参考，不自动成为依赖；
5. 任何新工具都要说明所属能力层、actor、target、代际、权限、租约和审计行为；
6. 同一能力不得为 UI、Agent 和 Workflow 分别实现三套业务逻辑。

---

## 附录：设计依据

- [本轮设计收敛记录](discussions/2026-11-24-agent-automation-design-clarification.md)
- [社区项目调研](discussions/2026-11-24-agent-browser-community-research.md)
- [旧 Agent 架构记录](discussions/2026-11-21-bfb-next-architecture.md#f-agent-架构已收官-2026-11-22f0f0f1f2含-f2f3f4f5f6-全定)
- [原产品与工程合同](discussions/2026-11-22-bfb-next-architecture.md)
- [反需求与放权边界](discussions/2026-11-23-bfb-next-agent-boundary.md)
- [2026-11-25 架构审计与裁决](discussions/2026-11-25-agent-architecture-audit.md)
