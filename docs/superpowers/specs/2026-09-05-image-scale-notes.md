# Scale 调研记录（识图 Scale Determination — 调研）

> 日期：2026-09-05
> 状态：调研记录；公式已纠正，主项目 Scale 推导已实现并通过自动门禁，待扩大真实游戏手测
> 说明：本文件保留探索过程。较早结论若与 §18 以后冲突，以后文的修订结论为准。

## 1. 问题定义

识图匹配需要 **scale**（模板缩放系数）来对齐"素材"与"运行时帧"里的目标。痛点：scale 若不对，模板匹配不到或凑合到错误档位。

## 2. 已确认的运行时机制（主项目真实管线实测）

### 2.1 帧尺寸恒定

用主项目真实管线 `BrowserViewAutomationCoreSession.capturePreview`（`release/tests/automation-authoring-core.cjs`）在逻辑视口 `1280×720` 下实测：

| 外层 force-device-scale-factor | frame bitmap | captureMs |
|-------------------------------|-------------|-----------|
| 1 / 1.25 / 1.5 / 2 | **恒为 1280×720** | 10–16ms |

`BrowserViewCaptureService`（`browserview-capture-service.ts:100-106`）的 normalize 逻辑：`sourceImage.resize({ ...logicalCaptureSize })` 把 raw capture（含 DPR 物理像素，如 2304×1296）缩到逻辑视口尺寸。
- 依据：`automation-capture-quality-probe.cjs` 实测 raw capture = 2304×1296（DPR 保留，`incrementCapturerCount(1280x720)` 不缩）。
- 主项目管线则在 capture 后 `resize` 到逻辑视口。

### 2.2 推论

- `frame.deviceSize == frame.cssSize == 1280×720` → `captureDensityAdjustedScales`（`vision-service.ts:19-27`）的 `density = 1`。
- **scale 不经 DPR 缩放**（DPR 被 normalize 消化）。
- ~~zoom 不是 scale 变量~~：该早期推论已被 §18 的统一坐标实验推翻。归一化帧尺寸恒定不等于帧内目标尺寸恒定；页面 zoom 会通过 `displaySize/logicalSize` 的变化影响归一化帧内的目标像素尺寸。

## 3. 核心待决问题（scale 的闭环缺口）

scale 的物理意义：`运行时帧里目标像素尺寸 / 素材像素尺寸`。

- **素材物理宽**：已知（PNG 像素宽高）。
- **运行时帧**：恒为逻辑视口 1280×720。
- **目标在帧里的实际宽**：取决于"素材相对游戏画面的比例" × "游戏画面在 1280 帧里的实际尺寸"。

**缺口**：
1. 游戏画面（Flash/Canvas/Ruffle）在 1280 帧里的实际尺寸——可通过 `detectGameSurfaces`（`game-surface-detector.ts`）/ `executeJavaScript` 读取，**待确认是否可作为 scale 基准**。
2. 素材相对游戏画面的比例——用户素材是外部截图，无元数据，**待确认如何取得**。

## 4. 已验证的失败方向

| 方向 | 结果 | 原因 |
|------|------|------|
| 固定档位枚举（识色） | 不可行 | zoom/DPR/截图倍率乘积不可预知，非标准值（如 0.67/1.5/2.5）档位漏，凑合且位置偏移（受控实验 0.67→0.5、1.5→0.6、2.5→2）|
| 粗扫+精收敛 | 部分可行但有陷阱 | 省时 ~80%，但 scale 峰被"错位干扰高压过"，粗扫易困局部峰（日场景 0.273 vs 真实 0.36）|
| 探测游戏画面尺寸算 scale | 未验证成立 | 现有静态场景无法给出可靠 ground truth；识色自身被颜色干扰误导（日场景左上角 0.20 干扰压过真钩 0.66）|
| 依赖素材侧 DPR 推算 | 不可行 | 用户外部截图无 DPR 元数据；取材→打包→分享链路 DPR 丢失（取材写压缩包、用户二次取材 DPR 丢失）|

## 5. 关键次要发现

### 5.1 极小素材难识别 = 签名下限，非可见性

真实 Electron 实测（目标物理尺寸从 48×60 → 18×23 → 12×15 → 9×12）：

| 目标物理尺寸 | 识色签名 | 结果 |
|-------------|---------|------|
| 48×60 | ✅ 3组 | 命中 1.000 |
| 18×23 | ❌ too few | 失败 |
| 12×15 | ❌ too few | 失败 |
| 9×12 | ❌ too few | 失败 |

- **非因压缩到 1280 不可见**（frame 是物理像素，信息保留）。
- 而是 `extractColorPointSignature`（`color-point-matcher.ts:141,148`）的**前景像素 / 颜色组数硬下限**导致小/单调素材无法形成签名。
- 真实鱼钩（18×20）因颜色多样（5 组）能过下限；更小/更单调素材失败。
- **待决**：是否降低签名硬下限（独立议题，暂缓）。

## 6. 当前落地实现（独立于 scale）

`evaluateColorGate`（`color-point-tracker.ts`）：识色置信度门禁，加绝对 rawScore 底线（`rawScoreFloor = threshold×0.45`、`margin≥0.02`、`strongRaw = threshold×0.6`），已通过 `automation-color-gate.test.ts` 4 项。用于"颜色 100% 误判"的修复，不依赖 scale。

## 7. 同 zoom 受控验证：Surface 比例可预测 scale（2026-09-05）

用主项目 `BrowserViewAutomationCoreSession` + 真实 Electron 验证了 scale 闭环：

### 7.1 纯函数验证（vision-policy.surfaceReferenceImageScales）

| 参考(reference) | 当前 | 结果 scale |
|----------------|------|-----------|
| {600,400} | {750,500} | [1.25] ✅ |
| {600,400} | {600,400} | [1] ✅ |
| {600,400} | {750,400}（非等比）| undefined ✅ 正确拒绝 |

### 7.2 完整链路验证（主项目管线）

场景：game surface 600×400 内一个多色"hook"目标（96×64），用户素材模拟为 60×40（不同环境截图）。

```
frame = 1280×720（density=1，CSS==bitmap）
game surface CSS = 600×400（executeJavaScript 可读）
hook 目标实际 = 96×64 @(350,240)
derivedScale = 目标帧内实际宽 / 素材物理宽 = 96/60 = 1.600
匹配(scale=1.60) = 0.816 @(350,240) 命中 ✅
```

### 7.3 结论

**带可信 Surface reference 的素材可预测单一 scale**：目标在 Surface 内的相对比例保持不变时，可由“运行时 Surface 与取材 Surface 的归一化帧内像素尺寸比”推导模板 scale。不能通过 DOM 直接读取 canvas/Flash 内部目标的个体尺寸。
- 已有逻辑路径：素材 `assetMetadata.reference`（kind:'surface'）→ `surfaceReferenceImageScales` → `browserview-core-session.ts` 预测 scales。
- 当前 reference 没有保存取材时 viewport transform，因此跨 zoom 闭环尚未成立。
- 外部导入 PNG 没有可信 reference，不能宣称免枚举或精确计算。

### 7.4 已知边界（仍需处理）

- **canvas/flash 画面内部内容（鱼钩/角色/怪物）不是 DOM 元素**，`getBoundingClientRect` 读不到其个体尺寸。
  - 可用的是**宿主 canvas/游戏容器**的 DOM 尺寸（detectGameSurfaces 能读）+ 素材相对容器的比例。
  - 若素材记录的是"取材时 surface 框尺寸"（reference kind:'surface'），则 scale = 运行时 surface 框尺寸 / 取材时 surface 框尺寸——**素材只要是框内内容，相对比例固定，scale 成立**。
- 用户素材是外部截图、无 DPR 元数据——依赖"取材框 reference"而非素材 DPR 即可绕过（reference 随素材打包存储）。

## 8. 待定 / 建议下一步

- **confirm reference(kind:'surface') 是否精确对应"游戏 surface 框"**：
  - `saveCapturedAsset`（service-v3.ts:489）记录 `reference.width/height = capture.image.getSize()`。
  - `captureAssetFrame`（service-v3.ts:456）`image = cropPreview(fullImage, logicalRegion).image`，`logicalRegion` 来自 `authoringRegion`（用户取材时选的框），经 `authoringDisplayRegionToLogical` 换算。
  - 若 `referenceKind==='surface' && logicalRegion`，则 reference 尺寸 = **用户取材框（游戏 surface 框）**。
  - **需实测确认**：取材框(region) 是否精确等于游戏画面框；运行时 locator.region/surface 是否同源。
- 方案三选：取材框 reference 推算（推荐，已初步验证）/ 现场取校准 / 每次识图校准——未最终定。
- 极小素材签名下限（§5）独立议题，暂缓。

## 10. 素材分辨率对识别的影响（受控实测 2026-09-05）

同一鱼钩素材放在受控场景（目标实际 54×60），用不同物理分辨率素材匹配（scale 补偿）：

| 素材分辨率 | 需 scale | score | 命中 |
|-----------|---------|-------|------|
| 18×20（原始）| 3.0 | 0.999 | ✅ |
| 27×30 | 2.0 | 0.990 | ✅ |
| 54×60（=目标）| 1.0 | 1.000 | ✅ |
| 90×100 | 0.6 | 0.999 | ✅ |
| 108×120 | 0.5 | 0.877 | ✅ |
| 162×180（3x）| 0.33 | 0.880 | ✅ |

**结论**：
- 素材 9 倍分辨率跨度（18→162）都能命中，前提 scale 正确补偿。
- 素材偏小 + 放大补偿（18×20, scale=3）反而最稳（识色不惧放大放大）。
- 素材偏大 + 缩小补偿（3x, scale=0.33）分数略降（0.88），仍可用。
- **识别质量关键 = scale 精确，而非素材分辨率**。素材分辨率不是瓶颈（除非极端失真/丢签名）。

## 12. 真实 canvas 早期探索：buffer 尺寸（结论已被 §18 修正）

`https://dinosaur.game/zh/dinosaur-game` 的 canvas 在不同 zoom 下的 CSS rect 与 buffer（canvas.width/height）：

| zoom | CSS rect | buffer(canvas.width/height) | DPR |
|------|---------|---------------------------|-----|
| 1 | 760×150 | 760×150 | 1.5 |
| 1.25 | 760×150 | 760×150 | 1.88 |
| 1.5 | 760×150 | 1520×300 | 2.25 |
| 2 | 632×150 | 1896×450 | 3.0 |

- **规律：`buffer = CSS × DPR`**（1520=760×2；1896=632×3）。
- CSS rect 不随 zoom 等比变（非等比缩放，页面布局重排），**不代表内容尺寸**。
- **内容真实渲染尺寸 = canvas buffer 尺寸（`canvas.width/height`）**，可被 `executeJavaScript` 读到。

### 当时结论及修正

- 检测真实 canvas 时须区分两类：
  - **非自适应 canvas**：CSS==buffer（自写验证 §7.2 可用 CSS rect 精确算 scale）。
  - **缓冲自适应 canvas**（恐龙游戏，zoom≥1.5）：buffer = CSS×DPR，CSS rect 与内容解耦。此时须读 **buffer 尺寸**（`canvas.width/height`）作为内容尺寸基准。
- `detectGameSurfaces`（`game-surface-detector.ts`）当前读的是 **CSS rect**（`getBoundingClientRect`），**不含 buffer**，对缓冲自适应 canvas 覆盖不足。
- 上述“必须用 buffer”的推论不成立。buffer 是 canvas 内部分辨率，不能直接代表归一化截图中的显示尺寸；以 §18 的实际帧 bbox 和 viewport transform 结论为准。

## 18. 决定性突破：scale 必须用目标实际显示尺寸（物理），非 CSS 逻辑 rect（2026-09-05）

自写 canvas（coordinate 统一到 frame），验证三类：

| canvas 类型 | ref 目标 frame bbox | run(zoom=1.5) 目标 bbox | scale | match 位置 | 结果 |
|------------|--------------------|------------------------|-------|-----------|------|
| fixed(buffer固定) | 132×96 | 198×146 | **1.500** | @737,411 vs 目标@738,412 | **HIT** |
| adaptive(buffer自适应) | 132×98 | 202×150 | **1.530** | @735,410 vs 目标@734,408 | **HIT** |

### 三个决定性结论

1. **scale = 目标在 frame 实际显示尺寸的比值**（198/132≈1.5）。两类 canvas 都**精确命中**。
2. **CSS rect 逻辑尺寸是错的**：`getBoundingClientRect` 返回逻辑尺寸**不含 zoom**（cssRect比=1.000），无法代表 frame 实际尺寸。**必须用物理渲染尺寸**（frame 内目标 bbox）。
3. **buffer 固定 vs 自适应，都不影响显示 scale**：frame 坐标 = 物理渲染，目标显示尺寸 = CSS逻辑尺寸 × zoom，buffer 只是 canvas 内部细节。

### 对 scale 方案的关键含义

**scale 必须基于「目标在 frame 坐标系的实际（物理）显示尺寸」**，不能用 CSS 逻辑 rect，也不能用 buffer。
→ 对应 `vision-policy.ts` 的 `surfaceReferenceImageScales` 初衷，但**必须取物理尺寸而非逻辑尺寸**。

**之前所有混淆的根源**：一直用逻辑 CSS rect（`getBoundingClientRect`）算 scale，忽略了 `setZoomFactor` 的**物理放大**（不只 DPR）。

## 19. 决定性结论（承上）核心认知

- 运行时 frame bitmap = 物理渲染（含 zoom 放大），1280×720 逻辑视口。
- 目标显示尺寸 = CSS逻辑尺寸 × zoom（frame 坐标系）。
- **scale = 运行时目标物理显示尺寸 / 素材物理尺寸** （素材即用户截图的目标实际像素）。
- 可靠获取「运行时目标物理显示尺寸」是关键：需读 canvas 物理显示 rect（含 zoom），而非逻辑 rect。

## 20. 待办续

- 探明如何可靠获取「目标在 frame 的物理显示尺寸」：canvas 物理 rect（含 zoom）vs 逻辑 rect 的映射/换算（`setZoomFactor` → frame 尺寸放大的精确系数）。
- 确认真实游戏（dino）在运行时的物理显示尺寸 vs 逻辑尺寸，验证 scale 在真实游戏的成立性。
- 之前的 `systematic-debugging` 遗留：为何 dino-loop 用 CSS(760×150) 算 scale=1.0 失败——现在明了：CSS 逻辑尺寸不含 zoom，dino zoom=1.5 时物理实际为 1520×300（buffer=CSS×dpr），scale 应为物理比。

## 21. 验证脚本（本批关键）

- `tests/electron/automation-canvas-unify.cjs`：决定性突破（coordinate 统一，证明 scale 用物理显示尺寸，两类 canvas HIT）。含目标 bbox 扫描诊断。
- `tests/electron/automation-canvas-scale.cjs`：非自适应 canvas，CSS rect == buffer，scale 由 detect rect 比算命中。
- `tests/electron/automation-canvas-dual.cjs`：fixed vs adaptive buffer 对比（坐标未统一，有 bug，仅供理解）。
- `tests/electron/automation-canvas-type.cjs`：多站点 canvas 类型探测（网络不稳/崩溃，参考）。
- `tests/electron/automation-dino-buffer.cjs`：dino buffer vs CSS 随 zoom。
- `.cache/vision-benchmark/color-lib.cjs`、`vision-policy-lib.cjs`：识色/scale 纯函数 bundle。

（原 §15「坐标系统一实测：目标显示尺寸跟随 CSS rect」→ 其早期结论已被 §18 决定性突破取代/修正：§15 用逻辑 CSS rect 算出 ratio=1.0 而误判「目标不随 buffer 变」；§18 揭示 frame 是物理渲染（含 zoom），目标物理尺寸随 zoom 变，scale 应取下限物理比。§15 结论作废，以 §18 为准。）

## 22. 状态小结（scale 调研）

**已确定**：
- 运行时 frame bitmap = 物理渲染（含 zoom），逻辑视口 1280×720。
- 目标显示尺寸 = CSS逻辑尺寸 × zoom（frame 坐标系）。
- **scale = 运行时目标物理显示尺寸 / 素材物理尺寸**（素材即用户截图的目标实际像素）。
- CSS 逻辑 rect（getBoundingClientRect）不含 zoom，不能代表 frame 实际尺寸 → **不可作 scale 依据**。
- buffer（canvas 内部分辨率）固定或自适应都不影响显示 scale。
- 素材分辨率对识别影响小，scale 精确才是核心（§10）。
- 识色门禁 `evaluateColorGate` 已实现，测试全绿。

**核心待补（关键）**：
- 如何可靠获取「运行时目标/素材参考面"物理显示尺寸"」（含 zoom 的物理 rect），而非逻辑 rect。这是 scale 落地的最后一环。
- 真实游戏（dino）运行时物理显示尺寸 vs 逻辑尺寸换算。
- 识色 + OpenCV 融合方案选型（形态 A/B，见融合设计文档）。
- 极小素材签名下限（§5，独立议题）。

## 23. Root cause：scale 漏 zoom —— logical vs physical 坐标系（2026-09-05 代码确认）

**完整链路（从源码确认）**：
- **物理渲染尺寸（含 zoom）**：`tabs.ts` `_settleAutomationViewport` → `displaySize = { innerWidth, innerHeight }`。dino zoom=1.5 → innerWidth=853×480。
- **logicalSize 固定** = 逻辑视口（1280×720），**不含 zoom**。
- **zoom 缩放系数**：`scaleX = displaySize.width / logicalSize.width`（browserview-coordinate-adapter.ts:36-37）。dino zoom=1.5 → 853/1280 = 0.667 = 1/1.5。
- **物理坐标 = logical坐标 × scaleX**（browserview-coordinate-adapter.ts:57-61 `logicalPointToDisplay`）。

**Root cause 定位**：
- 素材 `reference`（service-v3.ts:489 `saveCapturedAsset`）：`width = capture.image.getSize()` = **logical 坐标系尺寸**（不含 zoom）。
- `searchRegion`（运行时）：logical 坐标系尺寸。
- `surfaceReferenceImageScales`（vision-policy.ts:46-47）：`current.width / reference.width` = **logical 尺寸比**（不含 zoom）。
- `captureDensityAdjustedScales`（vision-service.ts:23-25）：`deviceSize / cssSize`，但 deviceSize 被 normalize 压回 logical 尺寸（browserview-capture-service.ts:111-112）→ **density=1，捕获不到 zoom**。

**结论**：scale 计算全链路在 **logical 坐标系**（不含 zoom）；而真实需要的目标是**物理显示尺寸**（含 zoom）。**当取材 zoom ≠ 运行 zoom 时，scale 会漏掉物理缩放差**（canvas-unify 已证 ref zoom=1 / run zoom=1.5 → 目标 1.5×，而 logical 算出来是 1.0）。

**物理缩放公式**：
```
归一化帧内像素尺寸 = logical尺寸 / scaleX
scaleX = displaySize/logicalSize = zoom 逆系数
```

**修复方向（待定）**：scale 计算应使用归一化帧内的像素尺寸（`logical / scaleX`），具体分单端/双端：
- 双端（取材 reference + 运行时 searchRegion）都在 logical，换算到归一化帧像素后：`物理比 = logical比 × (scaleX_mat/scaleX_run)`。
- 需确认 `surface.toViewport` affine（coordinateResolver 转换用）是否已含 scaleX，决定修复单端还是双端。

**关键确认（browserview-core-session.ts:305）**：`surface.toViewport = affine(1, 0, 0, 1, bounds.x, bounds.y)` —— **纯平移（无缩放）**。证实 `searchRegion`（经 `toViewport`）在**逻辑坐标系，不含 zoom**。

**结论：修复需记录双端 transform**：
```
scale_帧内 = logical运行尺寸/logical取材尺寸 × scaleX_mat/scaleX_run
scaleX = displaySize/logicalSize = zoom 逆系数
```
素材 `reference` 与 `searchRegion` 都在 logical 坐标系。由于捕获结果被归一化到 logical 大小，帧内像素尺寸与 `scaleX` 反比，而不是与 `scaleX` 相乘。

**scale 落地的核心待补**：把 scale 计算从单纯的 logical 尺寸比改为归一化帧内像素尺寸比（`logical / scaleX`）。
- 运行时 scaleX 自 `handle.getViewportTransform().scaleX/scaleY`（tabs.ts:215-220 已是物理/logical）。
- 取材时 scaleX 自取材当时的 viewport transform（需记录或从 reference 的 logical 尺寸反推）。

## 24. Root cause 复现（red test）与修复决策（2026-09-05）

### 复现成功（tests/automation-vision-policy.test.ts 新增 REPRO 用例，刻意失败）

```bash
npx vitest run tests/automation-vision-policy.test.ts -t "REPRO"
# AssertionError: expected [ 1.25 ] to deeply equal [ 1.875 ]
```

**构造**：取材 zoom=1（reference logical 512×288），运行 zoom=1.5（`getViewportTransform` 返回 `scaleX:853/1280`、`scaleY:480/720`）、searchRegion logical 640×360。
- 现有管线：`surfaceReferenceImageScales([{512,288}],{640,360})` = **1.25**（logical 比）。
- 物理正确值：**1.875** = 1.25 × 1.5（zoom 物理放大）。

**这个测试证明的代码事实**：`locateImage`（browserview-core-session.ts:415-417）的 `predictedScales` **只由 reference + searchRegion（logical）决定，完全不使用 `getViewportTransform().scaleX`**。运行时 transform 给了 scaleX=0.667（zoom=1.5），但 scale 预测仍是 logical 比 1.25 → **管线忽略 zoom 物理放大**。

### 修复方向（明确但暂不实施）

把 scale 计算从「logical 尺寸比」改为「物理显示尺寸比」：
```
归一化帧内像素尺寸 = logical尺寸 / scaleX
物理scale = logical比 × (scaleX_mat / scaleX_run) = logical比 × (zoom_run / zoom_mat)
```

**需补齐的两个缺口**：
1. 取材时记录 viewport transform 的 scaleX（或 zoom）到素材 `reference` —— 目前 `reference` 只存 logical 尺寸（service-v3.ts:489）。
2. `surfaceReferenceImageScales`（vision-policy.ts）改为接收运行时物理缩放因子，把 logical 比换算成物理比。

**关键依据（真实数据）**：canvas-unify 实验已证同一 canvas 运行 zoom=1.5 时 frame 内目标物理尺寸放大 1.5×（132×96 → 198×146），物理 scale 应为 zoom 比 1.5。

### 决策：暂不修改主项目

- **主项目代码不改**（只新增了红色测试文件 `tests/automation-vision-policy.test.ts` 的一个刻意失败的用例，作为修复目标锚点）。
- 等待识色/OpenCV 融合 + scale 全部设计落地并合并后，再统一推进主项目 scale 修复。
- 修复验收标准：让上面 REPRO 测试从 `[1.25]` 转绿为 `[1.875]`，同时不破坏 scale 相关的其他用例。

### 红色测试锚点

- `tests/automation-vision-policy.test.ts` 的 `REPRO: recomputes the Surface scale to include a runtime page zoom that differs from authoring`——当前 9 过 1 红（该用例）。这是后续主项目 scale 修复的回归锚点。

## 25. Scale 重要性的实证 + 替代路线验证（2026-09-05）

### 25.1 质疑：是否互联网早有方案，我们过度设计？

探索前应回答：是否存在更简单的路（免去精确 scale）？
- **SIFT/ORB 特征点匹配**（尺度不变，无需精确 scale）：**不可用**。项目 opencv.js 是官方基础包（`opencv.org/opencv.js`，无 contrib），实测 `SIFT_create`/`ORB_create` 均为 undefined（仅 BFMatcher/KeyPointVector 等基础类在）。引入 contrib 版需重新集成、体积大、Electron 11 兼容风险，**否决**。
- 即便可用，SIFT/ORB 对小像素（18px）、纯色低纹理目标（鱼钩）关键点少，不适配（我们场景是强颜色/小程序目标）。

### 25.2 多档枚举方案实测：对缩放目标失效（关键证据）

用**真实鱼钩素材**（鱼钩.png 18×20）+ 场景（640×360，目标以已知 scale 贴入）+ OpenCV 模板匹配（`vision-worker.cjs`），用现有多档枚举 `[0.75, 1, 1.25]` 匹配：

| 场景里鱼钩实际尺寸 | 多档枚举结果 |
|------------------|------------|
| x1.0（18×20）| ✅ score=1.000 @(200,150) HIT |
| **x1.5** | ❌ **null MISS** |
| **x2.0** | ❌ **null MISS** |

**结论**：现有多档枚举 `[0.75,1,1.25]` **只对 scale=1（素材原尺寸）有效**。目标一旦放大到 1.5×/2×，档位缺（无 1.5、2）→ 完全失效（null、找不到）。

→ 该实验只证明当前稀疏档位 `[0.75,1,1.25]` 会漏掉 1.5 和 2.0，不能单独证明“任何多尺度搜索都不可行”。精确预测仍是带 Surface 元数据素材的优选快路径；外部素材需要有界的粗到细搜索或人工参考信息。

### 25.3 结论

- **准确的 scale 对高精度模板匹配很重要**；当前稀疏档位不足。带可信 Surface 元数据时优先精确预测，缺少元数据时保留有界多尺度兜底。
- SIFT/ORB 替代路线不可行（环境缺模块 + 不适配小像素目标）。
- 方向收敛到：**物理化 scale**（§23/§24 思路），等设计合并后落地。

## 26. contrib 版 OpenCV 实测否决（2026-09-05）

用户质疑"引入 contrib 版能否解决 scale" → 实测。

### 26.1 实测结果（临时目录，未污染项目）

| 候选 | 结果 | 原因 |
|------|------|------|
| `@jgoenetxea/opencv-contrib-js`（4.5.3, deno 向）| 加载即失败 | **缺 `.wasm` 文件**（`opencvWasmBinaryFile='./opencv.wasm'` 但包内无该文件），`fetch failed` |
| `@techstark/opencv-js@5.0`（维护良好，SIFT 4.4+ 已移回主库）| 加载成功但无 SIFT/ORB | `BFMatcher`/`KeyPointVector` 在；**`SIFT_create`/`ORB_create` 仍 undefined** |

### 26.2 决定性结论

grep `@techstark 5.0` 的 `opencv.js` 全文：**无任何特征检测器字段**（`ORB_create`/`AKAZE_create`/`BRISK_create`/`SIFT_create`/`xfeatures2d` 全空）。

**opencv.org 官方 opencv.js（含 @techstark 各版本）对 feature2d 关键点检测模块默认裁剪。** 这不是版本问题，也不只是"没 contrib"——**任何现成 npm opencv.js 都不带 SIFT/ORB 关键点检测**。

要用 SIFT/ORB 需**从源码自行编译带 feature2d 的 OpenCV.js**：
- 需 Emscripten 编译链
- 需校验 Electron 11 / Chromium 87 的 WASM 特性兼容（新 wasm 可能不支持 bulk memory / simd / reference types 等）
- 体积大、集成复杂、维护成本高

### 26.3 结论：否决 contrib 版路线

- **能引入吗**：现成 npm 包不行（缺 wasm / 缺 feature2d），需**自行编译**，风险高。
- **能解决吗**：即便编译出 SIFT/ORB，对 18px 纯色小目标（鱼钩）关键点不足，很可能仍匹配失败（素材强颜色/低纹理，最不适合特征点匹配）。
- **值得吗**：不如先补齐已验证方向的 Surface scale 换算——零新增依赖、不碰 Electron 版本、收益更确定。

→ **"引入 contrib 版绕开 scale"被实测证伪**。方向坚持：物理化 scale（§23/§24）。

## 27. opencv.js 可用能力清单 + 备选方向（2026-09-05, worker_threads 实测）

用项目 `@techstark/opencv-js` 实际导出函数（worker_threads 加载，复现 vision-worker 姿势）。

### 27.1 可用能力实测（决定"别的方法"能否落地）

**不可用（确认无特征点检测）**：`ORB_create`/`SIFT_create`/`KAZE_create`/`AKAZE_create`/`BRISK_create`/`xfeatures2d` 全 undefined；`FlannBasedMatcher`/`DescriptorMatch`/`DFT`(大写) undefined。

**可用**：
- 模板匹配：`matchTemplate` ✓, `minMaxLoc` ✓
- 形状分析（**天然尺度不变**）：`matchShapes` ✓, `HuMoments` ✓, `moments` ✓, `findContours` ✓, `connectedComponents` ✓
- 颜色直方图（免 scale）：`calcHist` ✓, `compareHist` ✓
- 多尺度工具：`pyrDown` ✓, `pyrUp` ✓, `resize` ✓
- 其他：`inRange` ✓（颜色阈值）、`warpAffine`/`warpPerspective` ✓（仿射/透视）、`dft`(小写) ✓, `adaptiveThreshold` ✓, `Canny` ✓

### 27.2 备选"免精确 scale"方向评估

| 方法 | 免scale? | 适配小目标/强颜色? | 前景 |
|------|---------|-----------------|------|
| 形状匹配（matchShapes/Hu 矩）| ✅ 天然不变 | ⚠️ 需先分割目标（18px 复杂背景难）| 中 |
| 图像金字塔（pyrDown）+ 多尺度模板 | ⚠️ 仍是枚举 scale | ✅ | 低（本质同档位枚举）|
| 颜色直方图（calcHist/compareHist）| ✅ | ✅ 强颜色 | 中 |
| 仿射估计（warpAffine/warpPerspective）| ⚠️ 需对应点 | ⚠️ | 低 |

### 27.3 关键反思：scale vs 误报（需与用户确认方向）

探索 scale 很长，但**最初痛点可能是"误报/精确性"，不全是 scale 对齐**：
- 识色报 100% 但非目标 / 极小素材无法判断 → **误报问题**
- OpenCV 给错位高分（同亮度不同色误报）→ **误报问题**

这些主要是“这个候选是真是假”的判定，应由候选生成后的结构验证解决。颜色与 OpenCV 坐标重合只能增加证据，不能直接证明候选为真。**scale 是对齐前提，但不是误报判定器**。

→ 下一步决定：坚持"物理化 scale"，还是转向"融合锁定目标（判真伪）"作为主线，scale 作为对齐前提并行处理。

## 28. reference 语义厘清 + scale 地基收尾（2026-09-05）

### 28.1 reference 到底存什么（关键厘清）

从 `captureAssetFrame`（service-v3.ts:446-468）+ `saveCapturedAsset`（471-495）确认：

- 仅当调用方传入 `authoringRegion` 时，`captureAssetFrame` 才会令 `logicalRegion = authoringRegion`，`image = cropPreview(fullImage, logicalRegion)` 才是框选区域图；未传区域时捕获的是 viewport。
- `saveCapturedAsset` 的 `reference.width = capture.image.getSize()` 保存的是裁取目标前的捕获区域尺寸，不是素材目标本身；它可能是 viewport、普通 region 或 surface。

→ 只有同时传入区域并显式要求 `referenceKind:'surface'` 时，`reference` 才是“作者框选的 game surface 区域尺寸”。其他取材或外部导入素材不能套用 Surface 精确预测。

### 28.2 Scale 链条（修订后）

1. 素材参考 = 作者框选 game surface 区域的 `width`（取材时，logical）。
2. 运行时 `searchRegion` = 当前 game surface 区域 `width`（logical）。
3. `scale`（模板缩放，对齐素材与画面目标）= **归一化帧内像素尺寸比** = `logical比 × (scaleX_mat / scaleX_run)`。
4. 物理缩放系数 `scaleX = displaySize/logicalSize = 1/zoom`（zoom 放大时 displaySize 缩小）。
5. canvas-unify 已验证：ref zoom=1 / run zoom=1.5 → `scaleX_mat/scaleX_run = 1/0.667 ≈ 1.5`；logical 比 1.0 单独使用会漏掉 zoom。

### 28.3 scale 地基收尾（探索到"够用够优秀"）

**已完备**：
- 机制（frame 物理渲染、logical vs physical、scaleX）、根因（全链路 logical 漏 zoom）、正确公式（物理显示尺寸比）、实证（canvas-unify 物理比=zoom 比）、红测试锚点（REPRO 1.25 vs 1.875）。
- reference 语义（surface 框尺寸）已厘清。

**落地状态（2026-09-06）**：
- `AutomationAssetMetadataV3.reference` 已增加可选 `viewportTransform.scaleX/scaleY`，新取材图像与 transform 在同一 viewport revision 内记录。
- `surfaceReferenceImageScales` 已按 `logical比 × scaleX_mat/scaleX_run` 计算；X/Y 非等比、混合新旧素材、非法值均拒绝窄预测并走多尺度兜底。
- Runtime 和作者工具复用同一纯函数；learned scale 缓存键包含 viewport revision 与 transform，窗口/zoom 改变后不会沿用旧值。
- 原红色 REPRO 已由 `[1.25]` 转绿为约 `[1.87537]`（853px 整数视口带来的正常取整）。

## 29. 主项目 Electron 验收（2026-09-06）

新增 `tests/electron/automation-scale-reference-smoke.cjs`，通过项目 BrowserView、Core capture normalization 和 OpenCV Worker 对真实帧进行闭环验证：

| 场景 | 预测 / 实测 | 相对误差 | 框 IoU |
|---|---:|---:|---:|
| zoom 1 → 1 | 1.0000 / 1.0000 | 0.00% | 1.000 |
| zoom 1 → 1.5 | 1.5003 / 1.5000 | 0.02% | 1.000 |
| zoom 1.5 → 1 | 0.6665 / 0.6667 | 0.02% | 1.000 |
| zoom 1.25 → 1.5 | 1.2002 / 1.2000 | 0.02% | 1.000 |
| 窗口化 → 最大尺寸 | 0.7500 / 0.7474 | 0.34% | 1.000 |
| 最大尺寸 → 窗口化 | 1.3333 / 1.3379 | 0.34% | 1.000 |

自动门禁已通过：19 项相关单测、112 文件/679 项全量 unit、3 文件/19 项 integration、typecheck、production build。剩余工作仅是真实游戏素材手测；Scale 修复不处理树叶/状态栏等同色异形误报。

## 30. 外部截图的内容 Scale 估算验证（2026-09-06）

外部 PNG 没有取材时的 viewport transform，不能用 §29 的几何公式唯一反推。新增可重复基准：

```bash
npm run benchmark:vision:scale-estimation
```

基准用真实钓鱼场景与鱼钩、鱼、拉杆、人物素材，将素材按最近邻放大 1.5 倍后放回 1.0 场景，另将运行场景按 `1 → 1.5 → 1 → 0.75 → 1.25` 改变，记录全屏冷估算及命中后迁移耗时。详细结果写入 `.cache/vision-benchmark/scale-estimation-poc-*.json`。

代表结果：

| 路径 | 正确定位 | 平均耗时 | 结论 |
|---|---:|---:|---|
| OpenCV 有界冷扫（素材 1.5 → 运行 1.0） | 3/4 | 1905.7ms | 鱼钩被错误局部峰压过，不可作为默认方案 |
| 颜色候选 Scale（素材 1.5 → 运行 1.0） | 4/4 | 378.7ms | 可用于提出 Scale/位置，首次鱼钩包含 worker/签名冷成本 |
| OpenCV 有界冷扫（运行时 zoom 序列） | 4/5 | 1829.0ms | 1.25 场景被低 Scale 假峰压过 |
| 已命中 Scale 按 zoom 比迁移 + 三档微调 | 5/5 | 349.5ms | 可用于运行期间 zoom 改变后的快速恢复 |
| 颜色候选 Scale（运行时 zoom 序列） | 5/5 | 135.0ms | 本组正样本提议正确，仍不能单独验真 |

重要边界：

- 将盲扫放宽到 `0.25–3.2` 时，归一化模板分数会偏爱极小模板：鱼钩错误位置达 99.7%，冷扫 2–4.5 秒。因此普通恢复范围限制为 `0.5–2.0`；范围外只能作为明确的慢速恢复或由用户提供参考。
- 颜色候选在这 9 个正样本上均给出了正确 Scale 和位置，但既有困难负样本已证明“同色异形”也会高分。颜色只适合作为 Scale/ROI proposal，必须经过独立结构验证才能成为脚本点击目标。
- 运行中改变 zoom 时，只要此前已有一次可信命中，就不需要重新猜素材来源倍率：`newMatchedScale = oldMatchedScale × newRuntimeZoom / oldRuntimeZoom`，随后在邻近三档微调。viewport revision 在截图期间变化则丢弃旧帧并重试。
- “素材在 1.5 截取、运行在 1.0”首次没有历史命中时，内容估算应找到约为原素材 Scale 的 `2/3`；找到后缓存的是实测 Scale，而不是假设 PNG 自带 zoom 元数据。

因此下一阶段不是把 OpenCV 全屏盲扫直接接入生产，而是实现“颜色生成 Scale/位置候选 → 局部结构验真 → 可信命中后 Scale 迁移”。困难负样本门禁通过前，不把颜色 proposal 当作最终匹配。
