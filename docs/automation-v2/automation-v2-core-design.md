# Automation 2.0 Core 设计

> 状态：Approved  
> 当前批次：P1-T08 — 接口草案、ADR与场景评审  
> 最后更新：2026-08-30  
> 约束：本文和配套ADR是Phase 1设计产物；禁止据此提前修改产品代码

## 1. 设计目标

Automation 2.0把Blockly、JavaScript和Recorder降为前端，把执行语义集中在Automation Core。Core以正交概念组合能力：

```text
Frontend document / API call
          ↓ compile/validate
Workflow IR or Core command
          ↓
Action / Query + Locator + ExecutionContext
          ↓
LocatorResolver / ActionExecutor
          ↓
Capture │ Vision │ Text Recognition │ Input │ Browser
          ↓
CoordinateResolver
          ↓
BrowserView target
```

## 2. 非目标

- Phase 1不实现代码，不改变现有Workflow、Blockly、Driver或`.baoauto`。
- Blockly DSL不成为完整编程语言。
- 不设计try/catch、class、closure、复杂对象系统或高级数组API。
- 不在本轮实现或选择Pixel OCR。
- 不升级Electron 11.5.0/Chromium 87，不更换BrowserView。
- 不保留永久Automation 1.x compatibility layer。

## 3. 术语与唯一职责

| 概念 | 唯一职责 | 明确不负责 |
|---|---|---|
| Action | 产生输入、导航、通知等副作用 | 识别具体Locator kind |
| Locator | 描述如何找到可交互目标 | 发送输入、控制循环 |
| Query | 读取/判断世界并返回Value | 隐式执行Action |
| Value | Runtime中可存储/计算的有界数据 | 宿主对象、任意JS对象 |
| Space | 给Point/Region定义坐标参照 | 发现页面元素 |
| SurfaceSpec | 可持久化的视觉区域定位意图 | 持有WebContents或实时矩阵 |
| ResolvedSurface | 某一target generation上的Surface快照 | 跨generation永久有效 |
| Region | 某Space中的轴对齐半开区域 | 隐式代表另一Space |
| ExecutionContext | 作用域化Surface/Region/deadline/frame策略/变量环境 | 持有全局可变page/game开关 |
| Recognizer | 从CaptureFrame产生候选/evidence | 截图、输入或坐标猜测 |
| CaptureFrame | target+surface generation上的不可变像素与变换 | 作为无界长期缓存 |
| LocatedTarget | Locator解析后的统一交互结果 | 记住resolver实现类型 |
| Operation/Run | 资源、取消、deadline、事件与owner边界 | 依赖前端轮询才能清理 |

## 4. 依赖方向与禁止依赖

允许：

```text
Workflow IR → Core contracts
Frontend codec → Workflow IR
Runtime → Core dispatch ports
Locator resolver → Capture/Recognizer/Coordinate
Action executor → Input/Browser + LocatedTarget
Adapters/providers → BrowserView/Electron/OpenCV/OCR sidecar
```

禁止：

- Core types导入renderer、Blockly、Electron、BrowserView或Node类型。
- Recognizer导入具体Driver frame类型。
- Action switch `locator.kind`。
- Locator直接调用InputService。
- Point/Region/Match缺少Space或generation。
- Frontend获得WebContents、raw IPC、CDP、Node filesystem或provider实例。
- manifest capability直接等同于用户授权。

## 5. 全局不变量

`INV2-001`：每个长操作有唯一`operationId`、owner、target、AbortSignal和deadline。  
`INV2-002`：资源只有一个owner，或通过显式lease共享；dispose幂等且可等待。  
`INV2-003`：Point与Region必须携带SpaceRef，不能靠字段名/调用位置解释单位。  
`INV2-004`：ResolvedSurface、CaptureFrame、LocatedTarget共享可校验的target/surface generation。  
`INV2-005`：CaptureFrame不可变；RecognitionResult必须引用产生它的frame identity。  
`INV2-006`：Action只消费LocatedTarget，不判断Coordinate/Image/Text locator kind。  
`INV2-007`：TextLocator、ReadText和ReadNumber是三种不同语义。  
`INV2-008`：Context使用不可变派生和词法作用域，退出嵌套scope后自动恢复。  
`INV2-009`：cancel完成意味着operation所属资源已清理；只发信号的API不得命名为cancel completion。  
`INV2-010`：CDP只有Browser Adapter/Input协调层可租用，导航前必须detached。  
`INV2-011`：capability declaration、user grant与host enforcement分离。  
`INV2-012`：新增Locator只注册resolver，不修改Action类型、Action executor或Runtime action dispatch。  
`INV2-013`：所有序列化document均有显式formatVersion，拒绝未知major version。  
`INV2-014`：Core error有稳定code/category，frontend文案不进入Core语义。  
`INV2-015`：shutdown是resource barrier，完成后没有owned operation、lease、worker、sidecar request或timer。

## 6. Geometry 基础选择

### 6.1 坐标数值

Core运行时几何统一使用有限`number`，允许小数。禁止`NaN`、`Infinity`和负零序列化。坐标不是像素整数；只有在调用Electron capture/CDP边界时才执行明确舍入。

持久化Point/Region默认使用`ratio`单位，范围`[0,1]`，相对所属Space。选择ratio而不是旧`0..10000`整数的原因：

- 表达语义直接，不把精度约束伪装成坐标系；
- JSON可读；
- 可与运行时logical unit明确区分；
- Recorder可按配置量化，Core不强制旧精度。

Core同时允许运行时`logical`单位；持久Workflow中的CoordinateLocator必须显式声明unit，默认生成器使用ratio。

```text
ratio point/region in Space
          ↓ CoordinateResolver
logical point/region in same Space
          ↓ FrameTransform / Surface transform
viewport logical CSS/DIP
          ↓ BrowserView live scale
display CSS/DIP for capture/CDP
```

### 6.2 Point

Point表示Space内位置，不携带“点击”语义：

- ratio Point要求`0 <= x <= 1`、`0 <= y <= 1`。
- logical Point允许在查询中表示Space外点，但CoordinateLocator持久化默认要求落在bounds内。
- anchor是Locator/LocatedTarget语义，不进入Point类型。
- offset必须声明Space/unit；不允许无品牌`offsetX/offsetY`。

### 6.3 Region

Region采用`x/y/width/height`和半开边界：`[x, x+width) × [y, y+height)`。

- width/height必须大于0。
- ratio Region要求完整区域位于`[0,1]²`。
- intersection返回`Region | null`；不制造零面积Region。
- containment对最右/最下边界使用半开规则。
- polygon OCR box保留为evidence polygon，交互bounds另投影为轴对齐Region。

### 6.4 舍入规则

Core内部不舍入。Adapter边界规则固定为：

- Point → CDP：保留有限小数；若Electron版本要求整数，由Input adapter使用nearest，ties away from zero。
- Region → `capturePage`：左/上`floor`，右/下`ceil`，以保证不裁掉目标像素。
- Bitmap crop：先将完整logical region映射到bitmap，再对near edge floor、far edge ceil并clamp。
- 逆变换不承诺bit-exact；测试约束最大误差为目标Space的半个最终device pixel。

舍入只允许存在于命名函数：`roundPointForInput`、`coverRegionForCapture`、`coverRegionForBitmap`。禁止散落`Math.round/floor/ceil`解释geometry。

## 7. Space 模型

### 7.1 Space种类

Core只定义两类公共Space：

```text
ViewportSpace
SurfaceSpace(surfaceId, generation)
```

`ViewportSpace`是某个Automation target当前文档viewport的logical坐标域，不等同于screen、window bounds或bitmap。`SurfaceSpace`是ResolvedSurface本地坐标域，原点为Surface bounds左上。

Frame bitmap space是CaptureFrame内部实现细节，通过FrameTransform访问，不作为Workflow可引用Space。Screen/device pixel同样只属于Adapter。

### 7.2 Identity与generation

Space identity包含：

- `targetId`：Run内稳定的目标引用，不是裸WebContents id；
- `targetGeneration`：navigation、engine replacement、WebContents replacement时变化；
- ViewportSpace再包含`viewportGeneration`：zoom/bounds/logical viewport transform变化时变化；
- SurfaceSpace包含`surfaceId`与`surfaceGeneration`：重新resolve、移动/缩放超阈值或locator结果变化时变化。

持久文档只能保存`viewport`或`surfaceRef`，不能保存generation。generation只存在于运行时结果，防止旧Match跨导航复用。

### 7.3 Space转换

所有转换由`CoordinateResolver`完成并要求同target generation：

```text
ratio ↔ logical in same Space
SurfaceSpace logical ↔ ViewportSpace logical
ViewportSpace logical ↔ BrowserView display
Frame bitmap ↔ captured Space logical (through FrameTransform)
```

不存在通用“任意Space自动转换”。无共同ancestor、generation过期或transform不可逆时返回typed error，不猜测。

## 8. Surface 模型

### 8.1 SurfaceSpec与ResolvedSurface分离

`SurfaceSpec`是可持久化定位意图；`ResolvedSurface`是一次运行时解析结果。

```text
SurfaceSpec
  ├─ viewport
  ├─ element(selector/frame path + hints)
  ├─ visual(kind/fingerprint/hints)
  ├─ region(parent + region)
  └─ named(profile reference)
          ↓ SurfaceResolver
ResolvedSurface
  target/viewport/surface generations
  bounds in parent Space
  local size
  transform to ViewportSpace
  evidence + resolvedAt
```

Workflow不能序列化DOM handle、WebContents、CDP node id、raw matrix或最近candidate对象。

### 8.2 支持对象如何表达

| 用户概念 | SurfaceSpec表达 |
|---|---|
| 整个页面 | `viewport` |
| Flash object/embed | `element` + element kind hint `flash`；可带visual fallback |
| Ruffle player | `element` + kind hint `ruffle`；可定位host/container |
| Canvas | `element` + kind hint `canvas` |
| iframe内容 | `element` frame path解析为parent Surface，再解析child viewport/element |
| 普通container | `element` selector/semantic hints |
| 用户指定区域 | `region`，引用parent Surface并带ratio Region |
| 站点配置中的“游戏区域” | `named`引用profile中的SurfaceSpec |

kind hint用于resolver策略与诊断，不改变Space/Action语义。Action永远不出现`page/game`分支。

### 8.3 组合与parent关系

Surface组成有向无环树：

```text
Viewport
  └─ iframe/container Surface
       └─ Canvas/Ruffle/Flash Surface
            └─ user Region Surface
```

- 每个非viewport Surface有且仅有一个parent Space。
- SurfaceSpec最大嵌套深度默认8，解析时检测cycle。
- region Surface不能超出parent；策略默认`clip`，也可显式`strict`拒绝。
- named Surface在profile expansion后参与cycle/depth校验。
- iframe跨域不改变Core模型；Browser Adapter选择DOM或CDP resolver实现。

### 8.4 失效与重定位

ResolvedSurface在以下事件失效：

- target generation变化；
- viewport generation变化且transform无法只刷新；
- resolver报告element/frame消失；
- bounds/transform变化超过配置阈值；
- parent Surface generation变化；
- navigation或engine replacement。

失效不会静默修改旧对象。旧对象保持不可变并在使用时返回`TARGET_STALE`或`SURFACE_STALE`。Context可按其resolution policy重新resolve SurfaceSpec，得到新`surfaceGeneration`；旧Frame/LocatedTarget仍然失效。

### 8.5 Resolution policy

Surface resolution属于Operation，继承AbortSignal/deadline：

- `once`：只解析一次，失败立即返回。
- `wait`：在deadline内轮询/观察，默认用于Workflow进入`with surface`。
- `refresh-if-stale`：已有ResolvedSurface有效则复用，否则解析新generation。

禁止在创建Run之前进行不可取消surface wait。Run/Operation先获得owner，再解析target与surface。

## 9. P1-T01 决策摘要

1. 公共Space只有ViewportSpace与SurfaceSpace；bitmap/display/screen是Adapter内部Space。
2. 持久几何默认ratio `[0,1]`，运行时使用logical浮点；旧`0..10000`不进入Core。
3. Region使用半开边界，舍入集中在Input/Capture/Bitmap adapter边界。
4. Space runtime identity包含target、viewport和surface generation。
5. SurfaceSpec可序列化；ResolvedSurface不可序列化且不可变。
6. Flash、Ruffle、Canvas、iframe、container和用户区域通过同一SurfaceSpec组合模型表达。
7. target/surface stale显式失败；自动重定位产生新generation，不修改旧Match。
8. surface wait必须属于可取消Operation，修复旧系统pre-session等待缺口。

## 10. 待后续批次补充

- P1-T02：Locator与LocatedTarget。
- P1-T03：Action、Query、TextLocator/ReadText/ReadNumber。
- P1-T04：Value、Expression与Context继承。
- P1-T05：CaptureFrame、Recognizer与复用策略。
- P1-T06：Runtime IR与预算。
- P1-T07：frontend、安全、package v3。
- P1-T08：TypeScript草案、ADR和评审门禁。

## 11. Locator 与统一结果

### 11.1 Locator是可持久化查询描述

Core首批Locator：

```text
LocatorSpec
  ├─ CoordinateLocator
  ├─ ImageLocator
  └─ TextLocator
```

LocatorSpec只描述“什么算匹配”，不包含副作用、循环、变量赋值或错误文案。Resolver通过registry按`kind`注册；Runtime和Action executor不穷举Locator kind。

### 11.2 CoordinateLocator

CoordinateLocator引用一个带Space的Point：

- 持久文档通常使用当前Context Space的ratio Point。
- 可显式引用viewport或命名surface，未写时继承Context。
- 它解析为一个没有visual bounds的LocatedTarget，activation point就是该Point。
- 不执行截图，不伪造confidence。

### 11.3 ImageLocator

ImageLocator包含：

- asset reference，不嵌入任意本地路径；
- threshold；
- scale policy；
- alpha/mask policy；
- selection policy所需的候选排序信息；
- 可选search region，默认继承Context。

多图片fallback不再用每个Image Action复制`alternatives`字段。通用`firstOf`/`anyOf` query combinator组合多个Locator；首批Workflow可只公开`firstOf`，Core registry保留组合扩展点。

### 11.4 TextLocator

TextLocator用于定位可交互文字，例如“找到购买并点击”。它包含：

- query text；
- `exact | contains | normalized`匹配模式；
- minimum recognition confidence；
- language/provider hint仅作可选优化；
- search region与候选选择策略。

TextLocator返回文字候选的交互bounds/activation point，但不把完整ROI OCR文本作为变量值。读取内容使用ReadText/ReadNumber Query。

### 11.5 timeout、retry、selection的归属

| 选项 | 所属层 | 原因 |
|---|---|---|
| threshold、text match、mask、scale | Locator | 定义什么算匹配 |
| first/last/best/nearest/index | ResolveRequest selection | 从候选选哪个，不改变匹配定义 |
| timeout、poll interval、backoff | Query/Wait或Context policy | 同一Locator可用于立即find与等待 |
| search region | Context默认；Locator可收窄 | 允许复用Locator，不能越过Context边界 |
| anchor、offset | TargetRef | 定义动作使用目标哪个位置 |
| click button/count/modifiers | Action | 输入副作用参数 |
| verify/reacquire before input | Action execution policy | 处理识别到输入之间的stale窗口 |

### 11.6 TargetRef与LocatedTarget

Workflow Action不直接持有已解析结果，而持有TargetRef：

```text
TargetRef
  locator
  anchor?   center/top-left/.../ratio point
  offset?   branded vector + unit/space
  selection?
```

LocatorResolver统一产生LocatedTarget：

- identity：`locatedTargetId`；
- target/viewport/surface generation；
- SpaceRef；
- activationPoint：Action可直接消费；
- bounds：CoordinateLocator可为空，Image/Text通常有值；
- confidence：仅识别Locator有值；
- frameRef/evidenceRef：可选、受生命周期和权限控制；
- resolvedAt与locator fingerprint；
- provider details仅进入diagnostics，不进入Action分派。

Action executor只读取activationPoint、validity和可选bounds，不读取`locatorKind`。

### 11.7 多候选与无候选

底层Resolver返回`LocateResult`：

```text
matched: LocatedTarget[]
not-found: reason + diagnostics
```

- `findOne`使用selection policy把候选收敛为一个；候选不足时返回typed miss。
- `findAll`返回有上限列表，默认最多100，防止OCR/vision结果失控。
- `exists`把not-found映射为false，但不会吞掉permission/provider/target stale错误。
- Locator miss不是异常崩溃；Action需要目标但miss时产生`TARGET_NOT_FOUND`执行错误。

### 11.8 stale与复核

LocatedTarget使用前必须验证generation。Action可选择：

- `use-if-current`：generation有效则立即使用；
- `reacquire-if-stale`：用原TargetRef重新定位一次；
- `verify-before-input`：在最大age或frame freshness超限时重新定位。

复核产生新的LocatedTarget；禁止更新旧对象或替换它引用的Frame。

## 12. Action 模型

### 12.1 Action只表示副作用

首批Action：

```text
Pointer:  click, move, drag
Keyboard: keyPress, keyHold, textInput
Viewport: scroll
Browser:  navigate, reload
Host:     log, notify
```

Wait、Find、Exists、ReadText、ReadNumber属于Query/控制语义，不伪装成Action。

### 12.2 Pointer Action

- `ClickAction.target: TargetRef`
- `MoveAction.target: TargetRef`
- `DragAction.from/to: TargetRef`

公共executor流程：

```text
TargetRef
  ↓ LocatorRegistry.resolve
LocatedTarget
  ↓ validity/reacquire policy
activationPoint in branded Space
  ↓ CoordinateResolver
Viewport logical point
  ↓ InputService
CDP transient lease + dispatch
```

这一流程不随Locator类型变化。新增`AccessibilityLocator`或测试Locator时，不新增click/move/drag类、block或executor case。

### 12.3 Input细节

- Click包含button、count、modifiers、press duration；默认primary/1。
- Move包含duration/easing；InputService负责插值和AbortSignal。
- Drag包含from/to、button、duration、holdBefore/After；任一target stale按整体Action policy重新解析或失败。
- keyHold必须用`finally`释放按键；cancel/shutdown也必须补发release。
- textInput接受字符串Value，长度和速率受Host budget限制；不模拟Node clipboard。
- scroll作用于当前Context Surface或显式TargetRef，delta带unit。

### 12.4 Browser与Host Action

- navigate只接受schema验证的http(s) URL或未来获授权scheme；执行前Browser Adapter保证CDP detached。
- reload使target generation变化，旧Surface/Frame/LocatedTarget全部失效。
- notification需要permission enforcement，Core Action不直接使用Electron Notification。
- log接受结构化level/message/有限字段，默认不允许raw OCR evidence或像素。

## 13. Query 模型

### 13.1 Find与Exists

- `FindOne(locator)` → `LocatedTargetValue`，miss为`TARGET_NOT_FOUND`。
- `FindAll(locator)` → 有上限的只读target list；首批Blockly不必暴露list操作。
- `Exists(locator)` → Boolean；只把确定的not-found变为false。
- `WaitUntil(query, predicate, policy)` → Query结果；timeout语义由调用节点决定。

### 13.2 TextLocator与ReadText严格分离

```text
TextLocator("购买") → target bounds/activation point → Click

ReadText(region) → TextReadValue
  text
  lines/items (bounded)
  confidence summary
  frame/evidence reference (permission-controlled)
```

ReadText source可以是：

- 当前Context region；
- 显式RegionRef；
- Locator解析出的bounds；若Locator没有bounds则报`TARGET_HAS_NO_REGION`。

ReadText不自动寻找某个固定字符串，也不发送点击。

### 13.3 ReadNumber

ReadNumber是“recognize + deterministic parse” Query，不是TextLocator别名。它返回：

- parsed finite number；
- normalized source text；
- parse metadata，如decimal/grouping/currency/unit；
- confidence summary；
- 可选evidence ref。

NumberParsePolicy显式声明：

- locale或decimal/grouping separators；
- sign与parentheses策略；
- 可接受currency/unit；
- OCR字符纠错表是否启用，例如`O→0`、`l→1`；
- multiple numbers时的selection；
- minimum confidence。

无法识别文本为`RECOGNITION_EMPTY`；识别到但无法唯一解析为`NUMBER_PARSE_FAILED`；多个候选未指定selection为`NUMBER_AMBIGUOUS`。不得悄悄返回0或NaN。

### 13.4 Query错误软化

是否把miss/timeout转为Boolean、null或分支由Workflow节点显式决定：

- `exists`只软化not-found；
- `wait`可配置timeout branch；
- `try/catch`不进入Blockly Workflow；
- provider unavailable、permission denied、target stale、internal错误不自动软化。

## 14. Value 模型

### 14.1 可存储Value

Workflow Runtime支持有界、可验证值：

```text
null
boolean
finite number
bounded string
PointValue
RegionValue
LocatedTargetValue
TextReadValue
NumberReadValue
```

只读有限列表只允许由特定Query临时返回；Blockly首批不提供通用数组API。禁止函数、class instance、Date、RegExp、Map、Set、DOM/Electron/Node对象、cyclic object和任意JSON object。

### 14.2 变量

- `let`在当前词法scope声明，必须带静态type和初始值。
- `set`只能更新已声明且type兼容的变量。
- 内层可显式shadow外层；同scope重复声明错误。
- 读取未声明变量是compile error；未初始化状态不存在。
- loop body变量每次迭代创建新block scope；外层变量的显式set保留。
- LocatedTarget等runtime handle不能写入package/profile或跨Run持久化。

### 14.3 Expression

Expression是纯AST，无副作用、无隐式host访问：

- literal、variable；
- boolean not/and/or（短路）；
- number unary minus、`+ - * / %`；
- equality与同类型比较；
- string concat、length、有限的contains/startsWith/endsWith；
- 从NumberReadValue取`value`、从TextReadValue取`text`的显式field projection；
- Point/Region只允许受控projection和geometry helper，不允许任意对象访问。

除显式string concat外不做类型强制。除零、溢出到非有限数、非法projection均为typed evaluation error。

## 15. ExecutionContext

### 15.1 不可变派生

Context包含：

- operation/run identity与owner；
- target ref/generation；
- current SurfaceSpec/ResolvedSurface；
- effective search Region；
- deadline/timeout policy与AbortSignal；
- frame reuse scope/policy；
- variable environment；
- capability grant view；
- diagnostics/logger facade。

进入`with surface/region/timeout`创建child Context；退出只丢弃child，不手工恢复Driver mutable字段。

### 15.2 继承规则

| 字段 | 子scope规则 |
|---|---|
| AbortSignal | 继承；父取消必然取消所有子scope |
| deadline | 取父deadline与子deadline较早者，不能延长父deadline |
| Surface | 未指定则继承；指定则resolve新Surface并重置默认region |
| Region | 默认继承；子region与父effective region求交，不能扩大 |
| frame policy | 可收紧freshness，不能超出Host上限 |
| grants | 只读继承，可进一步收窄，不能扩大 |
| variables | 词法child environment |

### 15.3 `with surface`

```text
with surface "game"
  click(...)
  find(...)
  readText(...)
```

进入时按resolution policy解析SurfaceSpec，产生ResolvedSurface与SurfaceSpace。body内未显式Space的Point/Region/Locator均以该Space为默认。嵌套surface相对当前surface解析，除非显式从viewport root开始。

### 15.4 `with region`

Region属于当前Space。嵌套region按父effective region裁剪；空交集在进入scope时失败`REGION_EMPTY`。切换surface后旧region不会被误继承到新Space，除非通过CoordinateResolver显式转换。

### 15.5 deadline与frame scope

- 普通Action/Query使用当前deadline。
- Wait节点可创建更早child deadline。
- 一个condition evaluation或显式`with frame` scope可复用兼容Frame。
- Action前复核可以要求fresh frame，但不会修改父Context。
- Context结束时释放其拥有的frame leases和provider requests。

## 16. CaptureFrame 与 FrameTransform

### 16.1 CaptureRequest

CaptureRequest明确包含：

- target与ResolvedSurface generation；
- requested Region及Space；
- output pixel policy/scale/color format；
- freshness/maxAge；
- purpose hints仅用于调度，不改变geometry；
- operation/deadline/signal。

### 16.2 CaptureFrame

CaptureFrame是不可变资源：

- `frameId`；
- target/viewport/surface generations；
- captured Region与Space；
- bitmap size/format；
- `FrameTransform`；
- capturedAt/sequence；
- read-only pixel handle；
- owner/ref-counted lease，不允许consumer直接销毁共享底层buffer。

Frame像素不能默认序列化到Workflow、log或JS sandbox。

### 16.3 FrameTransform

FrameTransform提供命名转换：

- bitmap point/region → captured Space logical；
- captured Space logical → bitmap；
- captured Space → ViewportSpace；
- generation validation。

RecognitionResult使用`frameId + bitmap geometry`记录evidence，并在构造LocatedTarget时通过FrameTransform投影。Action不再读取Driver `lastFrame`。

### 16.4 复用策略

FrameCache属于ExecutionContext/Operation，不是全局隐式last frame。兼容复用要求：

1. target/viewport/surface generation完全相同；
2. frame未过maxAge；
3. capture region覆盖请求region；
4. pixel scale/format满足consumer最低要求；
5. policy允许复用且没有navigation/input invalidation barrier。

较大Frame可派生只读FrameView供ROI consumer使用，共享同一frameId与底层lease；变换记录不同view region。一次Image/Text/复核组合可以共帧。Pointer input、scroll、navigation、reload默认建立freshness barrier；纯log/计算不建立。

## 17. Recognizer 服务

### 17.1 服务边界

```text
CaptureService → CaptureFrame
VisionService.match(frame, request)
TextRecognitionService.recognize(frame, request)
```

Recognizer不自行截图、不读取BrowserView、不发送输入。Service负责provider选择、budget、timeout、cancel、restart和diagnostics。

### 17.2 Vision provider

Vision provider输入FrameView、template asset和match options，输出bounded候选：bitmap polygon/bounds、score、provider evidence。VisionService负责FrameTransform投影、selection和LocatedTarget构造。

### 17.3 TextRecognizer provider

Provider接口以FrameView输入，输出标准化`RecognizedTextItem[]`：text、confidence、polygon、可选language。TextRecognitionService负责normalize/filter/layout与Core TextReadValue；TextLocator resolver负责query matching和LocatedTarget。

Provider层次：

```text
TextRecognizer
  ├─ PaddleOCR-json + PP-OCRv3 (baseline)
  ├─ RapidOCR/ONNX + PP-OCRv6 small (candidate)
  ├─ RapidOCR/ONNX + PP-OCRv6 tiny (candidate)
  └─ PixelGlyphRecognizer (future, out of scope)
```

### 17.4 OCR选择规则

Phase 1不宣布新默认provider。Phase 4以相同接口benchmark：

- 中文UI、纯数字、价格、低分辨率/像素字体、透明/复杂背景；
- ROI与1280×720全帧；
- cold start、warm p50/p95、吞吐；
- peak/steady RSS、CPU、安装体积；
- cancel latency、request timeout、crash/hang restart；
- Windows x64/当前Electron宿主兼容。

候选必须在准确率、恢复性和资源上达到批准门槛后才能替换baseline。tiny与small分别记录，不能只按模型代际推断。

## 18. Runtime 2.0 IR

### 18.1 支持节点

```text
workflow
sequence
if
loop: repeat / while
break
continue
wait
action
query assignment
let / set
expression
```

log/notify是Action；delay是`wait duration`。Locator、Action、Query和Value是节点payload，不各自复制控制流节点。

### 18.2 控制流语义

- sequence按顺序执行，遇cancel/error/control signal停止。
- if要求Boolean expression。
- repeat次数在进入时求值并验证非负整数/预算。
- while每次迭代重新求Boolean；每轮必须检查cancel并按yield policy让出。
- break/continue只能位于loop lexical scope；编译时校验，运行时使用内部control signal，不暴露为Error。
- wait支持duration或query predicate + deadline/poll policy。
- 不支持goto、递归workflow call、try/catch、throw、function/class/closure。

### 18.3 Dispatch模型

Runtime只对少量IR control node做穷举解释。扩展点分离：

```text
ActionRegistry[action.kind] → ActionExecutor
QueryRegistry[query.kind] → QueryExecutor
LocatorRegistry[locator.kind] → LocatorResolver
```

注册表启动时冻结；未知kind在document validation/compile阶段拒绝。新增Locator只改变Locator registry和schema registration，不改变Action registry与control interpreter。

### 18.4 Run生命周期

`start`返回RunHandle，而不是把acknowledgement与completion混成一个boolean：

- `runId/owner/target/state`；
- `completion: Promise<RunResult>`；
- `cancel(reason): Promise<RunResult>`，完成时资源已释放；
- typed event stream：state、node-start/end、log、diagnostic、permission request；
- bounded history snapshot。

状态：`created → resolving-target → running ↔ paused → cancelling → completed|cancelled|failed`。不允许同一个Runner被两个start调用复用；幂等必须通过显式idempotency key实现。

### 18.5 Budget默认上限草案

Host policy可收紧，package不能放宽：

- AST nesting depth：64；
- executed nodes：100,000/run；
- loop iterations：10,000/loop；
- wall clock：默认30分钟，可由可信UI在Host上调；
- locator candidates：100/request；
- strings：10,000字符/value；
- variables：256 active bindings；
- yield：最多连续100 nodes或8ms后让出事件循环；
- logs：bounded ring + rate/byte budget。

准确默认值在P5实现计划前可基于现有Workflow样本调整，但“必须有Host hard limit”是已冻结设计。

### 18.6 Error taxonomy

| Category | 示例code | 默认可重试 |
|---|---|---|
| Validation | `INVALID_DOCUMENT`, `TYPE_MISMATCH` | 否 |
| Target | `TARGET_NOT_FOUND`, `TARGET_STALE` | locator policy决定 |
| Surface | `SURFACE_NOT_FOUND`, `SURFACE_STALE` | resolution policy决定 |
| Recognition | `RECOGNITION_EMPTY`, `PROVIDER_UNAVAILABLE` | policy决定 |
| Input/Browser | `INPUT_FAILED`, `NAVIGATION_TIMEOUT` | 否/显式策略 |
| Permission | `PERMISSION_DENIED` | 用户授权后新operation |
| Budget | `BUDGET_EXCEEDED`, `DEADLINE_EXCEEDED` | 否 |
| Cancel | `OPERATION_CANCELLED` | 否 |
| Internal | `ADAPTER_FAILURE`, `INVARIANT_VIOLATION` | 否 |

错误包含稳定code、category、operation/node id、safe details和cause chain；用户文案由frontend本地化。敏感OCR文本、路径和URL query默认不进入safe details。

## 19. Frontend 合同

### 19.1 Blockly

- 只编译/反编译受限Workflow IR。
- Locator是value block，Action block接收TargetRef input。
- Context使用statement scope block。
- 不公开provider、Frame、generation、permission token等host细节。
- 无法表达的JS能力不通过新增Blockly语言特性补齐。

### 19.2 JavaScript

- `bao.*`方法调用同一Core command/query facade。
- JS原生控制流不编译为Workflow IR；每次`bao.*`调用仍经过operation/context/grant/budget。
- JS对象不能作为Core Value跨边界；bridge只接受结构化、schema验证payload。
- 脚本持有的LocatedTarget handle带run/generation，失效后明确reject。

### 19.3 Recorder

- 记录用户事件后输出Workflow IR中的Action + Coordinate/可推断Locator + Context。
- Recorder可附候选定位策略，但不能创造独立runtime语义。
- 不确定的Image/Text locator需用户确认；无法稳定定位时输出显式CoordinateLocator。
- Recorder产物通过与Blockly相同的Core schema/conformance tests。

## 20. JavaScript安全模型

### 20.1 信任边界

Node `vm`不是安全边界。脚本不在main process、preload、目标BrowserView page world或拥有Node的renderer中执行。

Phase 7目标架构：

```text
Untrusted script realm in dedicated sandboxed renderer process
  nodeIntegration=false
  contextIsolation=true
  sandbox=true
  no navigation / restrictive CSP
          ↓ narrow structured bridge
Host Capability Broker in main
          ↓ schema + run grant + budgets + ownership
Automation Core facade
```

安全边界是可销毁的进程隔离和Host broker，不是脚本realm中的对象冻结。无限循环时Host可销毁sandbox进程并cancel其所有operation。

### 20.2 Permission与capability分离

- `features`描述package需要vision/ocr/workflow/javascript等能力。
- `permissions`声明潜在副作用：trustedInput、navigation、notifications、clipboardRead、network、fileRead/fileWrite等。
- `grant`保存在package外，由用户/Host policy针对package identity/version签发。
- 每次Core调用由broker执行runtime enforcement；manifest声明本身不授权。

默认策略：无任意network、filesystem、clipboard、raw IPC、Electron、Node、CDP权限。Vision/OCR可读取本次run获准target的Frame，不获得全局screen capture。

### 20.3 Run ownership

每个调用绑定sandbox instance、packageId、entrypoint、runId、tab target和grant。普通脚本只能读取/取消自己的run；可信管理UI可通过单独admin capability观察全局run。页面助手现有global status/cancel行为不得自动复制到JS API。

## 21. `.baoauto` v3 草案

新格式固定使用`formatVersion: 3`，不复用旧v2：

```text
example.baoauto
├── manifest.json
├── workflow.json              # 可选，Blockly/Recorder Workflow入口
├── scripts/
│   └── main.js                # 可选，JavaScript入口
├── assets/
└── profiles/
    └── default.json
```

manifest包含：

- package id、name、version、`formatVersion: 3`；
- entrypoints：一个或多个`workflow`/`javascript`入口及默认入口；
- features与permissions分开声明；
- assets/profile roots与integrity metadata；
- Core/API最低兼容版本；
- 可选publisher metadata，但不把它等同于信任。

约束：

- archive path、文件数、压缩/解压大小、单文件大小和类型继续严格限制；
- entrypoint path必须在包内、规范化且无symlink/path traversal；
- script source有独立大小预算；
- grants不写回包内；
- v2包在Phase 8后直接拒绝，不迁移、不保留adapter；
- 重构期间如需内部adapter，登记LEGACY id并在Phase 8零匹配删除。

## 22. P1-T02～P1-T07 决策摘要

1. Locator由registry解析为统一LocatedTarget；Action不读取Locator kind。
2. timeout/retry属于Query/Context，threshold/match属于Locator，anchor/offset属于TargetRef。
3. Wait是Query控制语义；TextLocator、ReadText、ReadNumber严格分离。
4. Value是有界强类型集合，Expression为纯AST，不构建完整语言。
5. Context不可变派生，surface/region/deadline/grant只能继承或收窄。
6. CaptureFrame不可变且带generation；FrameTransform替代`lastFrame`。
7. Vision/TextRecognizer只消费Frame，不自行截图或输入；OCR默认切换必须benchmark。
8. Runtime只switch少量控制节点，Action/Query/Locator通过冻结registry扩展。
9. start返回RunHandle；cancel完成是资源屏障。
10. JS在独立sandboxed renderer中运行，Host capability broker是实际安全边界。
11. 新包格式为v3，features、permissions、grant三者分离。

## 23. 六个端到端模型场景

以下示例是语义草案，不是当前Workflow可执行JSON。

### 23.1 坐标点击

```ts
const action = {
  kind: 'click',
  target: {
    locator: {
      kind: 'coordinate',
      point: { unit: 'ratio', space: { kind: 'context' }, x: 0.5, y: 0.75 },
    },
  },
};
```

Context默认Surface决定坐标参照。CoordinateResolver生成LocatedTarget.activationPoint；Click executor与后续Image/Text场景完全相同。

### 23.2 图片点击

```ts
const action = {
  kind: 'click',
  target: {
    locator: { kind: 'image', asset: 'buy.png', threshold: 0.86, mask: 'auto' },
    anchor: 'center',
  },
  targetPolicy: { stale: 'reacquire', verifyIfOlderThanMs: 150 },
};
```

Image resolver从Context取得Frame，经Vision provider生成候选和LocatedTarget。Action仍只消费activationPoint/generation。

### 23.3 文字点击

```ts
const action = {
  kind: 'click',
  target: {
    locator: { kind: 'text', text: '购买', match: 'exact', minConfidence: 0.75 },
  },
};
```

Text resolver使用TextRecognizer并构造文字bounds。这里不返回价格或整块OCR文本，也不存在`click-text` Action。

### 23.4 ReadNumber参与计算

```text
with surface "trade-panel"
  let price: number = readNumber(
    region = ratio(0.62, 0.18, 0.28, 0.12),
    parse = { locale: "zh-CN", currency: ["¥"], select: "only", corrections: { "O": "0" } }
  ).value

  if price < threshold
    click(image("buy.png"))
```

ReadNumber错误区分recognition empty、parse failed和ambiguous；不会返回NaN/0。Blockly可表达基础比较，JS可直接使用原生控制流。

### 23.5 跨Surface

```text
with surface named("game-frame")
  with surface element({ hint: "canvas", selector: "canvas#game" })
    with region ratio(0.1, 0.1, 0.8, 0.8)
      click(text("进入"))
```

每层Surface相对父Space解析。跨域iframe由Browser Adapter/CDP实现，不改变Core接口。Action收到的LocatedTarget最终通过transform chain落到ViewportSpace，再交给InputService。

### 23.6 Frame stale

```text
t0: CaptureFrame F1(targetGen=7, viewportGen=3, surfaceGen=11)
t1: ImageLocator → LocatedTarget L1(frame=F1, same generations)
t2: navigation / engine switch → targetGen=8
t3: Click(L1)
```

在`t3`，generation validation必须失败：

- policy=`fail` → `TARGET_STALE`，不发送输入；
- policy=`reacquire` → 用原TargetRef在generation 8重新resolve，得到F2/L2后点击；
- 绝不使用L1坐标，也不把L1原地改成generation 8。

## 24. 新增Locator扩展性合同

接口草案使用开放`LocatorSpecMap`和LocatorRegistry。Phase 3必须有类似以下的编译/行为测试：

```ts
declare module './automation-v2-core-interfaces.draft' {
  interface LocatorSpecMap {
    readonly color: {
      readonly kind: 'color';
      readonly rgb: readonly [number, number, number];
      readonly tolerance: number;
    };
  }
}

registry.register(colorLocatorResolver);

await execute({ kind: 'click', target: { locator: colorLocator } });
await execute({ kind: 'move', target: { locator: colorLocator } });
await execute({ kind: 'drag', from: { locator: colorLocator }, to: existingTarget });
```

验收要求：添加测试Locator只能新增Locator schema/resolver注册；`ClickAction`、`MoveAction`、`DragAction`、其executors和Runtime control interpreter零修改。Frontend是否显示新Locator是独立产品选择，不影响Core Action。

## 25. 概念依赖无环检查

```text
Finite Value / IDs
    ↓
Geometry + SpaceRef
    ↓
SurfaceSpec → ResolvedSurface
    ↓
ExecutionContext metadata
    ├─ CaptureRequest → CaptureFrame → Recognition candidates
    ├─ LocatorSpec → LocatorResolver ───────────────┐
    └─ CoordinateResolver                          ↓
                                             LocatedTarget
                                                   ↓
ActionSpec → ActionExecutor → Input/Browser Adapter

Workflow IR → Expression/Value + ActionSpec/QuerySpec/ContextSpec
Runtime → registries + Operation/Run lifecycle
Frontend → Workflow IR or Core facade
```

关键断环：

- CaptureFrame不依赖Recognizer；Recognizer依赖Frame。
- Locator不依赖Action；Action只通过TargetRef触发resolver。
- ResolvedSurface不依赖Frame/Match。
- TextRecognizer不依赖BrowserView Driver。
- Core不依赖Workflow frontend。
- grants由Host传入Context，package manifest不生成grant。

## 26. Concurrency与Host policy

Core数据模型允许多个Run存在，但资源冲突由Host policy和target lease显式裁决：

- 同一tab默认只允许一个拥有trusted input的Run。
- 只读识别Run是否并行由Capture/Recognizer资源预算决定，不由Core全局单例硬编码。
- 不同tab可并行，但Electron/CDP、OCR provider和memory budget可限制实际并发。
- 管理UI可以列出全部Run；普通frontend只能访问自己的RunHandle。
- authoring/test也建模为Operation，不再作为Service旁路状态槽。

Phase 2先保持现有“一tab一个automation viewport lease”；是否开放多tab运行属于后续Host policy实现，不阻塞Core类型。

## 27. 设计验证与实现前测试要求

| Contract | Required test |
|---|---|
| ratio/logical往返 | property tests覆盖DPI/zoom/viewport/surface transform |
| half-open Region与cover rounding | edge/crop matrix，不能丢far-edge pixel |
| generation stale | navigation、zoom、surface move、WebContents replacement |
| Action × Locator | 测试ColorLocator零Action修改 |
| Frame reuse | Image/Text/verify同帧；input barrier后强制新帧 |
| cancel barrier | cancel完成后零viewport/CDP/frame/provider/input/timer资源 |
| OCR lifecycle | response timeout、hang restart、queued cancellation |
| Runtime scope | break/continue、shadow、deadline收窄、region交集 |
| Permission | package declaration不授权；broker逐调用enforce |
| Sandbox | Node/Electron/raw IPC/filesystem/network逃逸拒绝与强制销毁 |
| Package v3 | traversal/zip bomb/size/type/entrypoint/grant separation |
| Legacy removal | Phase 8全仓搜索旧Step/page-game/adapter为零 |

## 28. Phase 2 输入边界

Phase 2只实现本设计的Geometry/Space/Surface/CoordinateResolver和Frame geometry基础，不实现Locator、Action、Runtime 2.0或Blockly UI。建议批次：

1. branded IDs、finite geometry validation、Region pure functions；
2. SpaceRef/generation与affine transform；
3. SurfaceSpec/ResolvedSurface及resolver port；
4. BrowserView viewport/display adapter；
5. FrameTransform和stale validation；
6. Automation 1.x临时adapter与属性/Electron测试。

临时adapter必须登记`LEGACY` ID；旧`0..10000`只在adapter边界转换一次，上层新Core不得出现page/game。

## 29. Phase 1 评审清单

- [x] Action、Locator、Value、Space、Surface、Region、Context、Recognizer有唯一职责。
- [x] 依赖图无循环，禁止依赖已列明。
- [x] Coordinate/Image/Text Locator统一为LocatedTarget。
- [x] TextLocator、ReadText、ReadNumber语义分离。
- [x] Frame/Match带identity/generation，不依赖lastFrame。
- [x] Context继承、遮蔽、deadline、region和frame reuse规则明确。
- [x] Runtime IR边界、dispatch、budget、error和RunHandle明确。
- [x] Blockly/JS/Recorder frontend合同明确。
- [x] JS sandbox与permission enforcement提前设计。
- [x] `.baoauto` v3结构和断代策略明确。
- [x] OCR provider接口与benchmark决策规则明确。
- [x] 六个必须场景走通。
- [x] 新增Locator零Action修改可表达为接口测试。
- [x] Phase 2实现范围与临时adapter边界明确。
- [ ] ADR和Core设计经用户批准。

## 30. Phase 1 待批准决策

本设计建议一次批准以下组合，不单独拆成可互相冲突的选项：

1. package format v3；
2. ratio持久geometry + logical runtime geometry + generation-branded Space；
3. SurfaceSpec/ResolvedSurface分离；
4. immutable CaptureFrame/LocatedTarget；
5. Locator registry + unified LocatedTarget；
6. limited control IR + Action/Query/Locator registries；
7. Context-scoped Capture reuse；
8. sandboxed renderer + Host Capability Broker；
9. OCR benchmark后再切换默认；
10. RunHandle/cancel/shutdown resource barrier。

若其中任何一项改变，需要同步修改相应ADR、TypeScript草案、traceability和受影响场景，不能只改局部interface。
