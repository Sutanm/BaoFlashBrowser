# Agent 与自动化设计收敛记录

2026-11-24 · 讨论记录。本文整理本轮关于产品定位、Agent、自动化、DOM、视觉、坐标、复杂 iframe、表单/表格、元素拾取和社区调研的结论，供后续架构裁决。本文尚未替代现行架构文档，也不表示相关模块已经实现。

## 1. 产品定位

建议将产品定位收敛为：

> BaoFlashBrowser Next 是一个原生支持 Agent 操作网页、标签、窗口和浏览器外壳的浏览器；同时，它为重复、长期、后台、视觉和 Flash/游戏任务提供专门优化的自动化能力。

这里有两个互不冲突的维度：

- **覆盖范围**：Agent 是通用浏览器操作者，不局限于 Flash、挂机或预编译脚本。
- **技术倾向**：自动化能力对重复、后台、长期和视觉任务做特殊优化，是产品差异化能力。

Flash 是重要差异能力，不应成为 Agent 的全部产品边界。自动化是特殊执行模式和能力加速器，不应成为所有浏览器工具的总称。

## 2. 三个核心角色

### 2.1 Browser Capability

浏览器能够做什么：

- 页面观察、点击、输入和导航；
- 标签、窗口、设置和引擎；
- 下载、历史、书签；
- DOM、AX tree、frame 与截图；
- Flash、Canvas 和视觉 surface；
- 真实鼠标、键盘和焦点输入。

### 2.2 Automation Runtime

任务如何长期、重复、稳定运行：

- wait；
- trigger；
- repeat；
- schedule；
- assert；
- pause/resume/cancel；
- workflow；
- 视觉事件；
- 轨迹和失败证据。

### 2.3 Agent Runtime

如何理解用户目标和处理未知情况：

- 目标解析和任务分解；
- 选择 Browser Capability；
- 决定是否使用 Automation Runtime；
- 解释结果；
- 修复失效定位；
- 将成功操作固化为工作流；
- 遇到敏感或不确定情况时请求用户。

一句话：

> Agent 决定做什么以及何时借用自动化；浏览器能力负责能做什么；自动化运行时负责如何长期、重复、稳定地做。

## 3. 推荐分层

原设计把 DOM、视觉、userscript、工作流和浏览器外壳都称作自动化工具面，职责容易混淆。建议调整为：

### 3.1 Browser / Shell

- `browser.tabs.*`
- `browser.windows.*`
- `browser.settings.*`
- `browser.engine.*`
- `browser.downloads.*`
- `browser.history.*`
- `browser.bookmarks.*`

浏览器外壳由项目自己控制，不让 Agent 点击 Vue DOM 或依赖外壳视觉坐标。主进程语义命令更快、稳定、可审计，也便于撤销。

### 3.2 Page

- `page.map`
- `page.observe`
- `page.inspect`
- `page.query`
- `page.navigate`
- `action.click`
- `action.fill`
- `action.scroll`
- `action.keypress`

### 3.3 Perception

- `capture`
- `findTemplate`
- `findColors`
- `ocrLocate`
- `ocrRead`
- `surface.detect`

Perception 不是 Automation 的私有层。普通 Agent 操作 Flash、Canvas、地图、图表和非标准页面时同样需要视觉能力。

### 3.4 Automation

- `waitFor`
- `repeat`
- `schedule`
- `trigger`
- `assert`
- `cancel`

### 3.5 Workflow

- `workflow.create`
- `workflow.validate`
- `workflow.run`
- `workflow.pause`
- `workflow.resume`
- `workflow.version`
- `workflow.inspectTrace`

## 4. Agent 与自动化的关系

```text
                    用户目标
                       │
                       ▼
                  Agent Host
            理解目标、选择执行策略
                 /             \
                /               \
       一次性普通操作          可复用/长期任务
              │                    │
              ▼                    ▼
 Browser Capability API    Automation Runtime
 页面、标签、窗口、外壳     等待、触发、循环、工作流
              │                    │
              └─────────┬──────────┘
                        ▼
               浏览器主进程能力
```

示例：

- “整理这些标签”直接使用 Browser/Shell tools；
- “填写当前页面的表单”使用 Page Map 和表单加速器；
- “以后掉线就提醒并重连”编译为工作流；
- “把刚才操作再做 20 次”将已验证动作转成循环；
- 工作流正常运行时不需要模型参与每一步，异常时再唤醒 Agent。

## 5. DOM、视觉和坐标的结论

DOM 与坐标不是互斥方案。应拆分“如何找到目标”和“如何实际操作目标”。

### 5.1 结构化通道

DOM/CDP/Accessibility 适合：

- 表单；
- 按钮和链接；
- 文本与列表；
- 表格；
- 可访问性良好的现代网页；
- 需要精确字段语义的任务。

优势是速度快、token 少、语义丰富、布局改变后可重新定位。

### 5.2 视觉通道

视觉和坐标适合：

- Flash；
- Canvas/WebGL；
- 游戏画面；
- 地图和图表；
- 视频帧；
- 无 ARIA 的自绘控件；
- DOM 严重失真或读取成本过高的页面。

### 5.3 Hybrid 通道

复杂游戏站常见的最佳路径是：

```text
DOM/CDP 找到 iframe、embed、canvas 或大区域
                   │
                   ▼
          建立稳定 SurfaceSession
                   │
                   ▼
       游戏内部使用视觉和局部坐标
```

因此视觉不是 DOM 失败后的低等级 fallback；在 Flash/Canvas 和复杂嵌套游戏站中，它是一等通道。

### 5.4 最终输入

DOM 找到元素后，实际点击仍可通过真实坐标输入完成：

```text
DOM/AX 定位目标
   ↓
重新读取当前 bounding box
   ↓
检查可见性、遮挡和导航代际
   ↓
转换为统一内容坐标
   ↓
CDP Input / webContents.sendInputEvent
```

不建议以 `element.click()` 或合成 DOM 事件作为通用执行方式，因为它们可能绕过命中测试、用户激活、默认行为和插件进程输入。

## 6. 坐标平面的定位

老项目的坐标浮层应保留其核心价值，但重新定义为底层 **Automation Coordinate Plane**，负责统一：

- WebContentsView 内容原点；
- CSS viewport 坐标；
- 设备像素和 DPR；
- 页面缩放；
- Windows 显示器 DPI；
- 屏幕坐标；
- iframe 祖先偏移；
- 各层滚动偏移；
- Flash/Canvas surface 局部坐标；
- 截图裁剪原点；
- 输入注入坐标。

坐标平面是共同执行底座，不应成为 AI 唯一的认知接口。

```text
DOM locator ──────────┐
                      │
AX locator ───────────┼── TargetRef ── Coordinate Plane ── Input
                      │
视觉 locator ─────────┘
```

AI 不应直接持有裸屏幕 `x/y`。坐标结果必须绑定来源、surface、capture 和 transform 版本。

## 7. TargetRef

不同定位通道最终返回统一的目标引用。

```ts
interface TargetRef {
  kind: 'dom' | 'visual' | 'surface'

  tabId: number
  bindingId: number
  navigationId: number
  observationId: number
  targetId: string

  frameId?: string
  backendNodeId?: number
  surfaceId?: string
  captureId?: string
  transformVersion?: number

  rect: { x: number; y: number; width: number; height: number }
  confidence?: number
}
```

三个身份必须分开：

- `tabId`：用户看到的稳定业务标签；
- `bindingId`：当前 WebContents 绑定代际，引擎切换或崩溃重建时改变；
- `navigationId`：同一 WebContents 内主文档导航代际。

执行写操作前必须验证代际。旧意图不能隐式重新定位后继续执行到新页面。

## 8. 复杂 iframe 的处理

Agent 可以判断 DOM 路径成本过高，但不应依靠模型每次反复试错。Host 应主动计算通道成本。

### 8.1 结构化通道信号

- frame 数量和最大深度；
- cross-origin/OOPIF 数量；
- DOM 节点数；
- AX tree 的有效交互元素数量；
- selector 稳定性；
- 元素可见性；
- layout box 与 hit-test 一致性；
- 预计需要的工具调用数。

### 8.2 视觉通道信号

- 大面积 `canvas/embed/object`；
- 候选 surface 覆盖率；
- 画面变化率；
- 模板、找色或 OCR 置信度；
- 已知游戏区域配方；
- 当前截图完整性；
- 输入能否可靠回注。

### 8.3 推荐输出

```json
{
  "structuredScore": 0.31,
  "visualScore": 0.91,
  "recommendedMode": "hybrid",
  "reasons": [
    "主交互区域位于第 7 层跨源 iframe",
    "可访问性树没有暴露游戏控件",
    "候选 embed 占可见区域 78%"
  ]
}
```

AI 可以覆盖推荐，但不负责从原始 CDP 结果自行计算所有成本。

## 9. Surface Detect 与 Surface Session

建议提供：

```ts
surface.detect({ tabId, purpose: 'game' })
```

内部组合 frame tree、DOMSnapshot、layout、AX tree、截图变化率、canvas/embed/object、遮挡和已知站点配方。

一旦找到游戏区域，创建稳定会话：

```ts
interface SurfaceSession {
  surfaceId: string
  tabId: number
  bindingId: number
  navigationId: number
  frameId?: string
  bounds: Rect
  transformVersion: number
  mode: 'flash' | 'canvas' | 'visual-region'
}
```

只在以下事件发生时重新检测：

- 主文档或目标 frame 导航；
- iframe bounds 改变；
- 页面滚动；
- WebContentsView 大小变化；
- zoom/DPI 变化；
- 引擎切换；
- surface 连续失配；
- 进入或退出全屏。

游戏内部定位优先保存 surface 局部坐标或归一化坐标，不持久化屏幕绝对坐标。

## 10. 普通任务需要 Page Map，而不是元素拾取

“选取元素向 AI 提问”只适合指代和纠错，不能作为普通 Agent 主流程。用户说“填写这些表单”时，不应要求逐个点击元素。

Agent 首先需要浏览器自动生成跨 frame 页面地图：

```ts
interface PageMap {
  page: {
    tabId: number
    bindingId: number
    navigationId: number
  }
  frames: FrameSummary[]
  regions: RegionSummary[]
  targets: TargetSummary[]
  surfaces: SurfaceSummary[]
}
```

Page Map 应自动发现：

- 主文档和全部相关 iframe/OOPIF；
- 表单和字段；
- 表格和列表；
- 标题与内容区域；
- 模态框和遮罩；
- Canvas/Flash/Embed；
- 可见和屏幕外区域；
- 滚动容器；
- 页面和 frame 的坐标关系。

## 11. 两阶段观察

不能把全部 frame 的完整 DOM 发给模型。

### 11.1 页面地图

先返回低成本摘要：

- regionId；
- 类型；
- 标题；
- frame；
- 控件数量；
- 可见性；
- 大致位置；
- DOM/视觉置信度。

### 11.2 任务相关深入

AI 再按任务检查特定区域：

```ts
form.inspect({ formId })
table.inspect({ regionId })
page.inspect({ regionId })
```

Host 保留完整 selector、backendNodeId、frame 链和坐标。AI 使用短 `targetId/fieldId/regionId`。

## 12. 表单加速器

表单是“通用 Agent 使用自动化专用能力提高效率”的典型场景。

建议能力：

```text
form.detect
form.inspect
form.fill
form.validate
```

表单分组不能只依赖 `<form>`。应综合：

- `<form>`、`fieldset`；
- 标题、卡片和分隔区域；
- label/for；
- aria-labelledby；
- 字段空间关系；
- 共同祖先；
- 保存/下一步按钮；
- frame 边界；
- 验证提示；
- 视觉卡片边界。

示例：

```ts
form.fill({
  formId: 'region-address',
  values: {
    'field-name': '张三',
    'field-phone': '13800000000',
    'field-province': '广东'
  }
})
```

Host 决定每个字段使用 DOM、AX、CDP node、frame 内坐标还是视觉定位，并返回未填写、校验失败和页面变化结果。

## 13. 表格与测试平台

测试平台任务通常包含：

1. 自动识别 HTML table、ARIA grid、虚拟列表、Spreadsheet 组件或 Canvas 表格；
2. 填写单元格；
3. 执行保存、运行或提交；
4. 记录语义操作轨迹；
5. 生成测试步骤、预期结果和执行证据。

建议能力：

```text
table.detect
table.inspect
table.read
table.write
trace.summarize
```

每次动作记录语义而非只记坐标：

```json
{
  "action": "fill",
  "target": "测试用例名称",
  "targetId": "target-31",
  "value": "账号为空",
  "result": "success"
}
```

Agent 可以将轨迹转换成人类可读步骤，同时保留 Workflow JSON 和截图证据。

## 14. 元素/区域拾取器的正确位置

元素拾取器适合：

- “解释一下这个”；
- 用户纠正 AI；
- 两个同名区域需要确认；
- 自动检测低置信度；
- 指定视觉监控区域；
- 首次适配异常游戏站；
- 修复失效配方。

它是指代、纠错、校准和示教工具，不是默认页面感知方式。

建议同时提供：

- `user.pickElement`：普通 DOM 元素；
- `user.pickRegion`：任意视觉区域；
- `user.pickSurface`：iframe/canvas/embed/Flash surface；
- `user.confirmTarget`：从候选目标中确认。

默认流程：

```text
自主 Page Map
   ↓
任务专用能力
   ↓
低置信度时结合视觉
   ↓
仍有歧义才请求用户选择
```

## 15. Surface Recipe

一次成功的 AI 或用户定位不应只保存脆弱 selector，应固化为多信号配方：

```json
{
  "site": "*.example-game.com",
  "frameUrlPatterns": ["*/game/*", "*/client/*"],
  "preferredElements": [
    "embed[type='application/x-shockwave-flash']",
    "object",
    "canvas"
  ],
  "minCoverage": 0.4,
  "aspectRatioRange": [1.2, 2.1],
  "visualAnchors": ["game-loading-logo"],
  "fallback": "largest-dynamic-region"
}
```

运行时先快速尝试配方并校验视觉锚点；成功则创建 SurfaceSession，失败才重新探测或唤醒 Agent。

## 16. Workflow 与 Agent

自动化工作流应该在成功后脱离模型独立运行。Agent 主要参与：

- 从用户目标生成草案；
- 从一次成功操作编译工作流；
- 解释异常；
- 修复定位；
- 根据新情况升级配方；
- 将修复结果保存为新版本。

不建议让模型在八小时挂机过程中参与每次点击。Workflow v1 应先覆盖：

- 顺序步骤；
- wait；
- assert；
- timeout；
- cancel；
- 暂停和人工接管；
- target/navigation stale；
- 操作轨迹。

录制视频、四轴轨迹、QuickJS/Wasm 沙箱和复杂 DAG 均应在最小执行合同经过真实用例验证后再扩展。

## 17. 与现有代码的接口改造

当前 `BrowserCommand` 是有价值的语义命令雏形，但执行入口仍绑定 `IpcMainInvokeEvent` 和 UI sender。Agent Host 和 Workflow Runner 不应伪装成渲染层 IPC 调用者。

建议拆出：

```ts
browserService.execute({
  actor: {
    type: 'shell' | 'agent' | 'workflow' | 'internal',
    taskId?: string
  },
  windowId,
  command
})
```

IPC、Agent 和 Workflow 都调用同一个主进程服务。权限由 actor、task、target 和 policy 决定，不由 IPC sender 单独决定。

## 18. 与其他模块的协调要求

### 18.1 标签休眠

后台任务和标签丢弃存在冲突。需要活动租约：

```ts
acquireActivityLease(tabId, {
  owner: taskId,
  requires: ['rendering', 'timers', 'network']
})
```

不能简单规定所有 Agent 标签永不休眠，也不能在活动自动化期间随意丢弃 WebContents。

### 18.2 引擎切换

PPAPI/Ruffle 切换会重建 WebContents，因此必须更新 bindingId，并使旧 frame、CDP session、DOM target、截图坐标和视觉 target 失效。

### 18.3 CDP 所有权

Agent、Automation、DevTools、测试和其他消费者可能同时使用 debugger。需要明确 attachment 所有者、域订阅、事件分发、detach 与重连。

### 18.4 Session/Profile

独立 profile、共享登录态、云端模型发送和页面写操作需要分阶段裁决。初期本地 fixture 使用 isolated；shared + write/exclusive 必须单独授权和持续可见。

### 18.5 数据与日志

工作流、任务、审批、截图、轨迹和失败现场需定义：

- 存储位置；
- 默认保留期；
- 敏感字段脱敏；
- 一键删除；
- 崩溃报告边界；
- 隐私模式行为。

## 19. 模型安全边界

云端模型调用本身就是数据出境通道。即使没有 cookie 读取和通用 HTTP 工具，DOM、AX tree、页面文本和截图仍可能发送给模型。

必须声明：

- Adapter 是否本地；
- 当前模型和端点；
- 哪些 origin 允许发送；
- 登录态页面是否允许；
- 截图是否裁剪/脱敏；
- 密码框、token、邮件和私信是否进入上下文；
- vision、tools、streaming、parallel calls 和上下文能力。

建议 Adapter 能力合同：

```ts
interface AdapterCapabilities {
  tools: boolean
  vision: boolean
  streaming: boolean
  parallelToolCalls: boolean
  supportsToolResultImages: boolean
  maxContextTokens?: number
  local: boolean
}
```

## 20. 推荐的首个完整闭环

首个验收不应只做聊天，也不应先做大型工作流平台。建议同时验证普通 Agent 和自动化倾向：

### 普通任务

1. Agent 自动获取跨 frame Page Map；
2. 找到多个表单或表格区域；
3. 使用 targetId/fieldId 批量填写；
4. 操作浏览器标签或外壳语义命令；
5. 不要求用户逐个点选元素。

### 自动化任务

1. 将一次成功操作保存为 Workflow v1；
2. 脱离模型重新执行；
3. 记录语义轨迹和证据；
4. 页面变化导致 target stale 时暂停；
5. 唤醒 Agent 修复并生成新版本。

### 游戏/视觉任务

1. 自动发现或人工校准游戏 surface；
2. 建立 SurfaceSession；
3. 在后台截图和识别；
4. 使用统一坐标回注真实输入；
5. 引擎切换、缩放或 frame 导航后旧 target 明确失效。

## 21. 后续需要裁决的事项

1. 产品定位是否正式从“Flash 浏览器”修订为“通用 Agent 浏览器 + 自动化增强”；
2. Page Map v1 的字段和裁剪规则；
3. CDP Hub 与现有 BrowserWindow controller 的边界；
4. TargetRef 与 binding/navigation 代际；
5. Workflow v1 schema；
6. 表单/表格加速器是否进入首期；
7. structured/visual/hybrid 路由评分；
8. Surface Recipe 的存储与版本；
9. shared/isolated profile 默认值；
10. 云端模型数据发送和审批边界；
11. Agent 面板、停止键和审批队列的 UI 位置；
12. 与标签休眠、引擎切换和 CDP DevTools 的资源仲裁。

## 22. 收口结论

本轮讨论形成的核心结论是：

> BaoFlashBrowser Next 的 Agent 应当自主理解整个浏览器和页面，而不是依赖用户逐个选取元素；浏览器应把复杂 DOM、frame、视觉和坐标转换为 Page Map、TargetRef 和 Surface；Agent 使用通用浏览器能力完成普通任务，并在重复、后台、长期和游戏场景中调用自动化专用能力。成功路径应固化为无需模型逐步参与的工作流，异常时再唤醒 Agent。

对应的技术主线是：

```text
Browser Service
    ↓
CDP Hub / FrameGraph / Coordinate Plane
    ↓
PageMap + TargetRegistry + SurfaceRegistry
    ↓
Browser/Page/Perception Tools
    ↓
Automation Runtime + Workflow
    ↓
Agent Adapter
```

这既保留通用浏览器 Agent 的覆盖面，也把 Flash、Canvas、复杂 iframe、后台视觉和确定性自动化变成项目的差异优势。
