# Automation 2.0 OpenCV 视觉链路审计

> 审计日期：2026-08-31
> 代码基线：`0e3d677`
> 范围：图片素材、图片组、BrowserView 捕获、OpenCV Worker、Locator/Action、Blockly、JavaScript API、页面助手、测试中心、坐标转换、缓存与跨平台发布。
> 本批次只审计，不修改生产代码。Pixel OCR 不在本次范围内。

## 1. 结论摘要

当前图片识别不是“截图落盘后再交给 OpenCV”。BrowserView 的画面来自 Chromium `capturePage`，但取得 `NativeImage` 后，场景和模板都以 BGRA 内存位图传入 OpenCV Worker；进程内使用固定 `SharedArrayBuffer`，没有 PNG/BMP 场景落盘。

OpenCV 基础匹配器、BrowserView 基础截图和坐标变换目前没有发现整体失效：相关 46 个单元测试通过；Windows Electron 最小化视觉闭环准确命中，像素误差为 0；强制 1.25 设备缩放下，三种窗口尺寸的整帧和区域截图均能还原到约 1 个逻辑像素内。

当前最主要的问题位于 OpenCV 上下游的产品语义，而不是“OpenCV 不如其他库”这一单点：

1. 助手、离线测试中心和 Blockly Runtime 使用的默认缩放集合不同。同一素材在助手能命中，并不能保证实际积木运行能命中。
2. 助手游戏区域采用“整帧归一化后限制 ROI”，Runtime 采用“先区域截图再归一化”。二者都合理，但不是同一输入栅格，缺少等价性门禁。
3. Core 声明支持 first/last/index/nearest 等目标选择策略，但图片识别每次只返回一个全局最强位置，图片 Locator 无法兑现多目标选择语义。
4. 图片组已经共享一次场景匹配，但只表示“多个模板中选最优模板”，不是“返回一组位置”。命名和 UI 必须避免误导。
5. 匹配器内部已有细粒度耗时、缓存和内存统计，作者工具只显示截图、匹配和总耗时，关键诊断信息被丢弃。
6. 现有测试验证了各零件，却没有验证四个用户入口在同一真实素材上的一致性；也没有 Windows/Linux 的真实视觉语料基准。

因此不建议现在先替换 OpenCV。下一批应先统一输入契约、默认参数、候选模型和基准，再决定 OpenCV.js、原生 OpenCV、ONNX 特征模型或混合方案是否值得替换。

## 2. 实际架构与调用链

```text
Blockly                 JavaScript                页面助手             测试中心
   │                        │                        │                    │
Workflow ImageLocator   bao.vision.find/exists   GM automation match   imported NativeImage
   │                        │                        │                    │
   └──────────── Automation Locator/Core ───────────┘                    │
                            │                                            │
                  BrowserViewAutomationCoreSession                       │
                            │                                            │
              BrowserViewCaptureService                 testAssetOnImage
                            │                            │
              capturePage → logical normalization       │
                            │                            │
                            └──── AutomationVisionService ┘
                                           │
                              OpenCvWorkerMatcher
                                           │
                         SharedArrayBuffer（BGRA 内存）
                                           │
                              vision-worker.cjs
                                           │
                   gray / alpha mask / multi-scale matchTemplate
                                           │
                              strongest ImageMatch
                                           │
                  AutomationFrameTransform → logical bounds
                                           │
                                  Action / API result
```

### 2.1 入口矩阵

| 入口 | 场景来源 | 默认 scales | threshold 行为 | 区域行为 | 最终 matcher |
|---|---|---:|---|---|---|
| Blockly Runtime | 当前 BrowserView | `[1]` | 达标才返回 | 先按区域捕获 | 同一 OpenCV Worker |
| JavaScript `bao.vision` | 当前 BrowserView | 未传时 `[1]` | 达标才返回 | 由 Locator region/context 决定 | 同一 OpenCV Worker |
| 页面助手 | 当前 BrowserView | `[0.75, 1, 1.25]` | 始终取最强候选，UI 再判阈值 | 游戏区域为整帧搜索 ROI | 同一 OpenCV Worker |
| 工作台测试中心 | 用户导入静态图片 | `[0.75, 1, 1.25]` | 始终取最强候选，UI 再判阈值 | 静态整图 | 同一 OpenCV Worker |
| 旧侧栏测试入口 | 当前 BrowserView | 调用方决定，默认 `[1]` | 运行阈值 | 直接捕获 | 同一 OpenCV Worker |

这张表说明“测试能识别，实际运行不能识别”在当前设计下是可重现的合法结果，而不是偶发现象。例如素材只在 0.75 倍匹配超过阈值时，助手和测试中心会成功，Blockly 默认只测试 1 倍并失败。

### 2.2 图片组语义

图片组由 `@bao-image-group:` 字符串编码，Blockly 编译时展开为 `asset + alternatives`。Worker 的 `findMany` 会：

- 一次装载当前场景；
- 对组内每个模板和每个 scale 执行模板匹配；
- 返回所有模板/scale 中分数最高的一个结果；
- 在结果中带回实际命中的 asset。

它已经避免“图片组每张图分别截图”的浪费。但是图片组是“替代模板集合”，不是“多个命中位置集合”。

## 3. 捕获与内存传输审计

### 3.1 场景路径

1. `BrowserViewCaptureService` 根据逻辑视口或逻辑区域计算期望捕获尺寸。
2. 调用 `incrementCapturerCount(logicalCaptureSize)`，请求 Chromium compositor 以稳定逻辑尺寸捕获。
3. 调用 `capturePage(displayRegion)` 获取 `NativeImage`。
4. 如果实际尺寸仍与逻辑尺寸不同，使用 `NativeImage.resize({ quality: 'best' })` 归一化。
5. 调用 `toBitmap()` 得到 BGRA。
6. `OpenCvWorkerMatcher` 将 metadata、场景 BGRA 和未缓存模板 BGRA 拷贝到 64 MiB `SharedArrayBuffer`。
7. Worker 直接从共享内存构造 OpenCV Mat。

结论：当前仍然是“截图识别”，因为 Chromium 没有暴露 Flash/Canvas 的内部显存或对象内存；但截图之后不是文件协议，而是内存位图协议。

### 3.2 拷贝次数

典型冷请求至少包含：

- compositor → `NativeImage`；
- `NativeImage.toBitmap()` → Node Buffer；
- Buffer → `SharedArrayBuffer`；
- OpenCV `matFromArray` → WASM heap；
- BGRA → grayscale Mat。

热请求可复用：

- 主进程模板 LRU：默认 64 个 asset；
- Worker 模板 LRU：默认 32 项、64 MiB；
- scale 后的灰度模板和 alpha mask；
- 相同 `frameId` 的场景灰度 Mat；
- 同一 `withFreshFrame` 操作内相同 capture key 的帧。

当前传输已明显优于图片落盘方案，但仍有两次大块内存拷贝和一次灰度转换。是否改原生 OpenCV，应以这些阶段的实际 p50/p95 数据决定。

### 3.3 固定内存预算

共享区固定为 64 MiB，请求总大小包含 metadata、场景和本次未命中缓存的模板。普通 1280×720 BGRA 约 3.5 MiB，不构成压力；但导入接口只限制单个文件压缩字节不超过 16 MiB，没有限制解码后的像素尺寸。超大图片、多个大模板或图片组仍可能超过 64 MiB并直接失败。

目前没有：

- 解码像素上限；
- 按尺寸预估并给普通用户的友好提示；
- 分块/流式传输；
- 超预算请求的降采样策略。

## 4. OpenCV 算法审计

### 4.1 当前策略

Worker 将场景和模板转换为灰度，并根据模板特征选择算法：

| 条件 | 算法 | 分数转换 |
|---|---|---|
| 自动/强制 alpha mask | `TM_CCORR_NORMED` | `maxVal` |
| 无 mask 且模板标准差 `< 4` | `TM_SQDIFF_NORMED` | `1 - minVal` |
| 普通模板 | `TM_CCOEFF_NORMED` | `maxVal` |

alpha 自动策略会检测透明像素，并以接近不透明的像素生成 mask；极薄/柔边素材会退回较低 alpha 阈值，避免 mask 为空。

scale=1 会优先执行。如果 1 倍结果达到 `max(0.98, threshold)`，可提前结束；否则继续测试其他 scale。每个模板/scale 只通过一次 `minMaxLoc` 取单个最高点。

### 4.2 算法限制

1. **颜色信息完全丢失。** 相同亮度、不同颜色的 UI 可能产生高分误识别。
2. **分数不可完全横向标定。** mask、低方差和普通模板使用三种方法，UI 都称为“相似度”；相同 0.90 并不代表完全相同的误报概率。
3. **只保留一个峰值。** 无法做多个实例、NMS、按空间选择或候选解释。
4. **模板匹配对非均匀缩放、旋转、抗锯齿和字体重绘敏感。** 目前仅有有限离散 scale。
5. **小模板容易受背景影响。** 尤其是纯色、低方差和裁剪边界带入背景时。
6. **没有素材质量检查。** 取材后没有提示透明边缘、背景占比、尺寸过小、方差过低或建议阈值。

因此，OpenCV 并非完全不可用；它适合像素风、固定 UI 和稳定比例的游戏自动化，但需要在产品层补足参数一致性、候选诊断和素材质量反馈。

## 5. 坐标与区域链路

### 5.1 Runtime 区域识别

```text
Persisted Region / current Surface
  → resolveLocatorCaptureRegion（viewport logical ROI）
  → logicalRegionToDisplayCapture（当前窗口显示 ROI）
  → capturePage(display ROI)
  → normalize to logical ROI size
  → OpenCV returns ROI-local bitmap coordinates
  → AutomationFrameTransform adds captured logical origin
  → viewport/surface logical target
  → current display coordinates
```

这里明确不允许 matcher 把 `deviceOrigin` 直接加到区域局部像素上，否则会混合逻辑单位与 bitmap 单位。对应单元测试已覆盖 DPR 区域和 source-region origin。

### 5.2 页面助手游戏区域识别

助手采用：

```text
selected display region
  → map to logical region
  → capture normalized full frame
  → pass logical region as OpenCV ROI
  → crop the same full frame for preview
```

该路径是为了让整屏和游戏区域使用同一模板像素比例，避免“先裁区域”时不同捕获实现返回不同密度。但它和 Runtime 的输入路径并不相同。

### 5.3 已验证与未验证

已验证：

- DPR 区域匹配坐标转换；
- 直接捕获区域时返回区域局部匹配；
- 固定 device scale 1.25 下多种窗口尺寸的整帧/区域几何；
- 最小化 BrowserView 截图、匹配、坐标转换、CDP 点击闭环。

未验证：

- 同一真实素材在助手整屏与助手游戏区域的 score/位置等价；
- 同一真实素材在助手与 Runtime 的 score/位置等价；
- 同一素材在最大化、窗口化、最小化恢复后的 score 稳定性；
- PPAPI Flash、Ruffle、Canvas、iframe/container 各自的真实匹配语料；
- Windows 与 Linux/WSLg 的栅格和分数容差。

## 6. Core 语义缺口

### 6.1 图片 Locator 与 SelectionPolicy 不匹配

Core 的 `TargetRef.selection` 支持：

- best；
- first；
- last；
- index；
- nearest。

但 `BrowserViewAutomationCoreSession.locateImage` 只将 Worker 的一个结果包装成长度为 1 的候选数组。因此图片目标上的 first/last/best 都等价，index 大于 0 必然越界，nearest 没有选择空间。

这不是单纯实现遗漏，而是候选模型没有闭合。后续必须二选一：

1. Vision 返回多位置候选并做 NMS，完整支持 SelectionPolicy；或
2. 在图片 Locator API/文档中禁止图片使用无法兑现的选择策略。

推荐第一种，因为游戏界面中“多个相同按钮/物品，选择最近或第 N 个”是合理需求。

### 6.2 操作级帧复用没有覆盖普通 Action

Capture Service 已实现 `withFreshFrame`，作者工具也使用它复用预览与识别帧。普通 Action 执行没有统一包裹该作用域：

- click/move 的单 Locator 通常只捕获一次；
- drag 的 from/to 会顺序解析，若二者都是视觉 Locator，会捕获两帧；
- JavaScript 同时发起多个 vision Promise 时，matcher 明确拒绝第二个并发请求；
- wait 循环每轮新截图是正确的，但一轮内的组合 Locator 尚无明确帧一致性契约。

应把“一个动作/一次组合查询观察同一帧”写成 Core 规则，而不是只由作者工具偶然实现。

## 7. 性能与可观测性

### 7.1 Worker 已产生但未充分暴露的数据

`ImageMatch` 已可携带：

- `templateLoadMs`；
- `workerReadyMs`；
- `sharedCopyMs`；
- `sceneMatMs`；
- `grayMs`；
- `resizeMs`；
- `matchTemplateMs`；
- scale cache hit/miss；
- scene bytes / transferred bytes；
- WASM heap；
- template cache entries/bytes；
- tested scales；
- mask/lowVariance/stdDev。

页面助手最后只展示 capture、match、total；工作台测试中心展示得更少。结果是用户看到“慢”，但无法区分：

- 首次加载 WASM；
- Worker 空闲唤醒；
- 截图；
- 位图拷贝；
- 模板首次解码；
- 灰度转换；
- 多 scale resize；
- 真正的 `matchTemplate`。

开发诊断应完整保存这些阶段；普通用户界面只显示总耗时，并在明显异常时给出“首次预热/素材过大/尝试了多个缩放”等可理解说明。

### 7.2 计时精度

多个阶段使用 `Date.now()`。快速阶段出现 0ms 是计时分辨率导致，不代表没有执行。性能基准和诊断应使用单调高精度时钟；用户 UI 可继续四舍五入为整数毫秒。

### 7.3 并发与排队

一个 matcher 只接受一个进行中的请求，第二个请求直接报错 `OpenCV matcher accepts one request at a time`。作者工具在 Service 层有串行 queue，因此通常不会触发；Runtime/JS API 没有同样的视觉调度器，脚本作者使用 `Promise.all` 并发调用 `bao.vision` 时可能失败。

Core 应拥有显式的 Vision scheduler：串行执行、支持取消、可以合并同帧请求，并定义最大队列与过载错误。

## 8. 跨平台结论

OpenCV 图像匹配使用 `@techstark/opencv-js` WASM 和 Node worker_threads；Windows/Linux 运行同一 JavaScript/WASM 算法，不涉及为每个平台编译 OpenCV native ABI。发布配置会将 `vision-worker.cjs` 和 `@techstark/opencv-js` 从 asar 解包，Worker 才能从真实文件系统加载。

跨平台差异主要来自：

- Electron 11/Chromium compositor 的截图尺寸与像素；
- 系统 device scale；
- GPU/WSLg 渲染；
- PPAPI Flash 版本与渲染；
- 字体和浏览器控件绘制；
- Ruffle/Canvas 的抗锯齿与缩放。

因此“算法相同”不等于“分数相同”。当前只有 Windows 的视觉与 viewport Electron 探针证据；Linux OCR 已验证不代表 Linux OpenCV 视觉链路已经通过。

## 9. 问题分级

| 级别 | 问题 | 影响 |
|---|---|---|
| P0 | 助手/测试中心默认多 scale，Blockly Runtime 默认单 scale | 普通用户调试成功但运行失败，直接破坏信任 |
| P0 | 缺少四入口同图等价性门禁 | 回归可在测试全绿时进入产品 |
| P1 | 图片识别只返回单个位置，Core 却公开多目标 SelectionPolicy | API 语义不成立，无法稳定扩展 |
| P1 | 助手 ROI 与 Runtime ROI 输入栅格策略不同 | 整屏、区域、实际运行可能分数不同 |
| P1 | Runtime/JS 无统一 Vision scheduler | 并发脚本可能直接失败 |
| P1 | 细粒度性能统计未进入诊断 | 无法判断慢在截图、拷贝、预热还是匹配 |
| P1 | 没有真实素材 benchmark corpus | 无法比较 OpenCV.js、原生 OpenCV 或其他算法 |
| P2 | 三种匹配方法共用一个“相似度”阈值 | 不同素材阈值含义不一致 |
| P2 | 灰度匹配不区分颜色 | 可能误识别同亮度不同颜色控件 |
| P2 | 单文件只限制压缩字节，不限制解码像素 | 可超出共享内存/WASM 预算 |
| P2 | 普通 Action 未统一帧作用域 | drag/组合定位可能观察不同画面 |
| P2 | 毫秒计时使用 `Date.now()` | 快速阶段显示 0ms，误导诊断 |
| P3 | Worker 最长 50ms 定时唤醒兜底 | 冷空闲请求可能有额外尾延迟 |

## 10. 建议的后续批次

### V1：先统一产品契约，不替换算法

1. 定义 `VisionMatchOptions` 的唯一默认值，Blockly、JS、助手、测试中心全部从同一处读取。
2. 明确素材是在固定逻辑像素下制作，默认只匹配 1 倍；或统一启用受控多 scale。不能入口各自决定。
3. 让助手提供“按实际 Runtime 参数测试”，诊断模式可额外测试 scale，但必须明确标注。
4. 把整帧搜索 ROI 与直接捕获 ROI 的选择收口到 Capture/Vision policy，所有前端只传 Region。
5. 增加图片解码尺寸、总像素、共享预算校验和普通用户提示。

### V2：重建候选结果

1. Worker 返回 `VisionCandidate[]`，而不是一个 `ImageMatch | null`。
2. 每个模板/scale 提取多个局部峰值并执行 NMS。
3. 结果保留 asset、score、scale、algorithm、mask、bounds。
4. Core 的 best/first/last/index/nearest 在统一候选集上工作。
5. 作者工具始终展示最强候选；低于阈值用黄色框，达标用绿色框。

### V3：统一调度、帧与诊断

1. Vision scheduler 串行化 Worker 请求并支持取消。
2. 一次 Action/组合 Locator 共享同一 FrameSnapshot。
3. 同一帧的多模板、多区域查询尽可能合并。
4. 开发诊断记录全部阶段耗时、cache hit、场景/模板字节和算法分支。
5. 使用高精度单调时钟。

### V4：建立真实基准后再选技术

基准语料至少包含：

- 像素风小图、普通网页 UI、透明 sprite、低方差按钮、同亮度不同颜色；
- 整屏与游戏区域；
- 1.0/0.75/1.25 比例；
- 最大化、窗口化、最小化恢复；
- Canvas、Ruffle、PPAPI；
- 单图、图片组、多实例；
- Windows 与 Linux/WSLg。

记录：命中率、误报率、位置误差、score 漂移、冷启动、热 p50/p95、内存、发布体积。

只有 V1-V4 完成后，才比较：

- 当前 OpenCV.js Worker；
- 原生 OpenCV sidecar/addon；
- 更小的自研模板匹配内核；
- ONNX 特征/检测模型；
- OpenCV 快速路径 + 特征模型回退的混合方案。

## 11. 验收门禁建议

### 11.1 一致性

- 同一场景、素材和参数：助手、测试中心和 Runtime 返回同一 asset/scale。
- 整帧与 ROI：位置误差不超过 1 个逻辑像素；score 差值目标不超过 0.02。
- 最大化/窗口化：位置误差不超过 1 个逻辑像素；score 差值目标不超过 0.03。
- 同一入口的绿色/黄色判断只由统一阈值策略决定。

上述 score 容差必须先用真实 corpus 校准；如果个别渲染引擎无法达到，应按引擎记录明确例外，不能静默放宽全局阈值。

### 11.2 功能

- 单图：返回最强候选，低于阈值仍可在作者工具显示。
- 图片组：一次场景捕获，返回实际命中的 asset。
- 多实例：返回经过 NMS 的候选列表，selection 全部可用。
- Region：完整包含、部分越界、比模板小、surface 嵌套均有测试。
- 并发：多个 JS vision Promise 被调度，不出现 busy/reject。

### 11.3 性能

- 分开记录冷 Worker、暖 Worker、暖模板、暖场景。
- p95 不包含 UI 收缩动画，只测 capture → result 的真实链路。
- 明确场景分辨率、模板数量、模板尺寸和 scale 数量，禁止只报一个无上下文的“匹配耗时”。

## 12. 本次证据

### 12.1 自动测试

执行：

```text
npm test -- --run tests/automation-vision-worker.test.ts tests/automation-capability-services.test.ts tests/automation-browserview-capture-service.test.ts tests/automation-browserview-coordinate-adapter.test.ts tests/automation-frame-geometry.test.ts tests/automation-blockly-v2.test.ts tests/automation-workbench-v3.test.tsx
```

结果：7 个测试文件、46 个测试全部通过。

### 12.2 Windows Electron 视觉闭环

执行 `npm run probe:automation-visual`：

- Electron/BrowserView 最小化捕获成功；
- OpenCV 版本 `4.12.0-release.1`；
- 场景 1350×840，模板 282×123；
- score 0.9880；
- matchTemplate 闭环记录 135ms；
- 识别坐标与期望坐标误差 0×0；
- CDP 点击命中且 debugger 已 detach。

注意：该 smoke 仍是早期直接 OpenCV 闭环，不完全等同于生产 Worker 管线，因此只能证明基础能力，不能替代四入口等价性测试。

### 12.3 Windows viewport 几何

执行 `npm run probe:automation-viewport`，强制 device scale 1.25：

- 1200×720、800×600、660×500 三种窗口均通过；
- 整帧和区域截图都找到目标；
- 还原逻辑坐标误差约 1 像素内；
- 显示坐标点击命中；
- debugger 已 detach。

### 12.4 作者链路

执行 `npm run probe:automation-authoring`：

- 真实 BrowserView 捕获通过；
- surface 探测与 CDP lease 恢复通过；
- surface 相对坐标在 BrowserView resize 后仍生效；
- authoring 和 workflow 均释放 BrowserView lease。

该 smoke 当前没有真实图片匹配断言，因此不能证明助手、测试台和 Runtime 的视觉输入等价。

## 13. 最终判断

当前 OpenCV 方案仍可作为 Automation 2.0 的默认图像定位基线，不应因为近期 UI/区域回归直接废弃。优先级最高的不是换库，而是：

```text
统一输入与默认参数
  → 建立多候选语义
  → 建立同帧调度与完整诊断
  → 建立真实跨平台 benchmark
  → 再决定是否替换或增加新视觉后端
```

Pixel OCR 是另一条专门处理像素字形的 Recognizer，不应承担普通图片定位，也不应在上述视觉契约稳定前与 OpenCV 重构混在同一批次。

## 14. V1 实施记录（2026-08-31）

本审计提出的 V1 已完成第一批落地：

- 新增共享视觉策略，唯一默认值为 threshold `0.90`、scales `[0.75, 1, 1.25]`、mask `auto`；
- Blockly、JavaScript/Core、页面助手、工作台测试中心和旧侧栏测试入口改为复用该策略；
- 页面助手不再把多 scale 参数硬编码进 userscript，由 main IPC 应用共享默认值；
- 图片 Runtime 改为捕获统一逻辑整帧，再将当前 Surface、Context Region 或 Locator Region 作为 OpenCV ROI；
- 图片作者预览与 Runtime 使用相同的整帧+ROI输入契约；
- OCR 保持直接区域捕获，不受本次图片识别策略调整影响；
- 新增契约测试，验证 Runtime 在逻辑区域识别时仍向 matcher 提供 1280×720 整帧，并传入逻辑 ROI 和共享 scales/mask；
- 新增静态入口门禁，避免助手、工作台和 Blockly 再次各自持有视觉默认值。

本批次没有实现多候选/NMS、Vision scheduler、解码像素预算和跨平台真实语料 benchmark；它们仍按 V2-V4 推进。

V1 回归结果：

- TypeScript main/renderer/preload 类型检查通过；
- 103 个 Vitest 文件、579 项测试全部通过；
- ESLint 0 error，34 个既有 warning；
- production build 通过，并刷新自动化助手 updateHash；
- Windows 最小化视觉闭环通过，坐标误差 0×0；
- Windows 1.25 device scale 的三种窗口尺寸与区域映射通过；
- authoring、Surface 探测、CDP lease 恢复及窗口 resize 后相对坐标通过。
- Ruffle iframe 助手的图片识别、OCR、取材、坐标、Surface 和拖拽 smoke 全部通过；同时补齐 warm IPC mock，并将固定 80ms 等待改为结果条件等待，避免收缩动画造成假失败。

## 15. V2 实施记录（2026-08-31）

V2 已将图片识别从单个全局最优点扩展为有界多候选，同时保留单结果兼容入口：

- `AutomationVisionMatcher` 新增单图和图片组的候选列表接口，旧 `find/findMany` 继续返回最强候选；
- OpenCV Worker 对阈值以上的响应图执行 3×3 局部峰值提取，并用确定性的左上优先规则合并平台区域；
- 不同模板和不同缩放档产生的候选统一按置信度执行 IoU 0.35 的 NMS，避免同一目标重复出现；
- 候选数硬上限为 100，Worker 内部峰值池也有界，避免低阈值在大画面上制造无界内存；
- 返回列表最终按画面顺序排列：从上到下，同一行从左到右；
- Core 的 `best` 按最高置信度选择，`first/last/index` 按画面顺序选择，`nearest` 按逻辑坐标距离选择；
- 默认动作、`exists/wait` 和作者工具只请求 1 个候选，继续使用原有 `minMaxLoc` 快路径；只有显式使用非 `best` 选择策略时才请求多候选；
- 图片组在同一次场景匹配请求中返回各素材的候选，并在跨素材 NMS 后保留实际命中的 asset；
- 作者工具仍只展示一个最强候选，普通 Blockly 不增加多候选配置项。

V2 新增回归覆盖：

- 同一模板在画面中出现三次，候选按稳定画面顺序返回；
- 等价缩放档产生的重叠框被 NMS 合并为一个；
- 图片组中的两个不同素材可在同一画面分别命中；
- Vision Service 先保留置信度最高的候选预算，再按画面顺序交给 Core；
- `best/first/last/index/nearest` 五种选择策略及单候选/多候选预算传播。

## 16. V3 实施记录（2026-08-31）

V3 已完成统一调度、Action 观察帧和高精度诊断：

- 新增按 matcher 实例共享的 FIFO Vision Scheduler；Runtime、JavaScript 和作者工具即使创建不同 `AutomationVisionService`，也会进入同一队列；
- 队列上限为 64，超过上限返回明确的 `QUEUE_FULL`，不再把底层 `worker shared channel is busy` 暴露给脚本作者；
- 排队中的请求可以立即取消并从队列移除；已经开始的请求继续使用原有 AbortSignal/Worker 重启取消路径；
- 每个 Action 自动建立独立 `observationScope`，Drag 的 from/to 和 FirstOf 内部候选共享该 scope；
- Capture Service 以 `scope + capture region` 为键缓存 Promise，不仅复用完成帧，也能合并同一作用域内同时发生的相同截图；
- 不同 Action 使用不同 scope；输入完成后下一 Action 必定重新截图，不会跨越 input freshness barrier；
- 图片定位统一捕获逻辑整帧，所以同一 Action 内不同图片 Locator 即使 ROI 不同，也能共享 FrameSnapshot；
- OCR 在捕获 key 相同（例如整帧 OCR）时可以共享；显式小区域 OCR 保持独立区域帧，避免为小区域强制运行整帧 OCR；
- Worker、模板加载、共享内存复制、截图和作者工具总耗时改用 `performance.now()` 单调高精度时钟；
- 候选增加 `algorithm`（`ccoeff`、`ccorr-mask`、`sqdiff`）、`queueWaitMs` 和 `queueDepthAtSubmit` 诊断字段；
- 助手对高精度耗时进行面向普通用户的格式化：小于 0.1ms 显示 `<0.1ms`，其余避免暴露冗长小数。

V3 回归覆盖包括：

- 两个 Service 共享同一 matcher 时严格串行，实际 OpenCV Worker 不再 busy/reject；
- 等待中的识别请求取消后不会进入 matcher；
- 同 scope 并发截图合并，不同 scope 仍保持隔离；
- Drag 的两个 Locator 使用同一观察 scope，而后续 Click 使用新 scope；
- 三种 OpenCV 分支均返回明确算法诊断。

本阶段没有实现跨 Action 的隐式“最近帧”缓存。该行为会越过输入/导航新鲜度屏障，与 ADR-007 冲突；未来若启用 `WithContext.frameReuse`，必须同时实现 maxAge、viewport generation 和输入失效规则，不能简单保存全局 last frame。

## 17. V4 基线实施记录（2026-08-31）

已新增可重复执行的图片 Locator benchmark：

- `npm run benchmark:vision` 生成 corpus、构建 runner 并输出逐样本 JSON；
- corpus 使用相同 BGRA 原始帧在 Windows 与 Linux 运行，避免平台 PNG 解码差异；
- 覆盖网页 UI、透明 sprite、低方差、多实例、ROI、1.25 像素缩放，以及可选真实游戏素材；
- Windows 10 轮与 WSL Linux 3 轮均为 8/9，通过/失败集合完全一致；
- 已确认 1.25 nearest-neighbor 像素图与当前 linear 模板缩放不一致：坐标正确，但 score 约 0.6067；
- 真实 1418×839、4 模板、3 scales 的负样本 warm p95 约为 Windows 393ms、WSL 430ms；
- 普通网页整图 warm p95 约为 68–71ms，恐龙真实 crop 约为 14ms；
- WSL 实测验证了 Node Worker + BGRA + OpenCV.js 管线，不冒充 Linux Electron BrowserView 完整验收。

详细方法、数据和技术结论见 `vision-benchmark-results.md`。当前决策是保留 OpenCV 基线，下一轮先比较像素 nearest 插值候选与负样本 scale 剪枝；不通过降低统一阈值掩盖失败，也不在没有同 corpus 对比时切换后端。

## 18. V5 模板放大插值决策（2026-08-31）

V5 没有直接凭单个像素样本修改默认值，而是先补充 1.25 倍线性重采样的 Web UI 对照，再用同一份 BGRA corpus 做 A/B：

- Windows linear 通过 9/10，nearest 通过 10/10；
- nearest 将像素图 score 从约 0.6067 提升到 1.0000；
- 平滑 Web UI score 没有下降，约从 0.92 到 0.93；
- 真实大图负样本最强 score 均约 0.32，没有扩大误报；
- Windows 两种方案的缩放样本耗时均约 5–7ms；
- WSL nearest 也通过 10/10，功能结果与 Windows 一致。

门禁通过后，产品默认模板放大从 `INTER_LINEAR` 切换为 `INTER_NEAREST`。缩小仍使用 `INTER_AREA`，不会同时执行两种插值；linear 仅作为内部 benchmark 对照保留。该设置不暴露给普通用户或脚本 API，因为它属于识别后端策略，而不是业务语义。

## 19. V6 Surface 参考尺寸与安全 scale 剪枝（2026-08-31）

V6 对真实四素材负样本增加逐 scale、逐素材诊断。三档分别约消耗112–133ms，四张素材分别约消耗89–95ms，说明简单重排无法解决约0.4秒的最坏路径。

包格式审计发现素材只有 PNG，没有取材上下文。为避免重现最大化/窗口化失效，V6 没有全局删除 `.75` 或 `1.25`，而是增加可选 `manifest.assetMetadata`：

- 助手在已绑定游戏 Surface 内取材，记录 `source: capture`、`reference.kind: surface` 和参考宽高；
- 页面、普通区域和外部导入素材不具备可信 Surface 标记；
- 覆盖导入素材时删除旧元数据，删除素材时同步删除元数据；
- 包加载严格验证路径、尺寸、枚举值以及元数据引用的素材是否存在；
- 旧 v3 包没有该字段时仍按原三档行为运行，不增加迁移层。

Core 只对“隐式 scales + 当前 Surface + 全图片可信元数据 + 等比缩放 + 图片组预测一致”的请求使用一个预测 scale。脚本作者显式设置 scales 时始终优先；任何不确定情况回退共享默认三档。

同一 1418×839、四素材、0.9 条件的负样本在 Windows 从约407ms降至127ms，在 WSL从约383ms降至131ms，降幅约66–69%，两种路径均无误报。benchmark 当前为11/11，通过集合包含像素图、平滑 UI、透明图、低方差、多实例、ROI、真实正负样本以及 Surface 单档对照。

## 20. V7 BrowserView 真实闭环（2026-08-31）

新增可人工打开的响应式 Canvas HTML fixture，并把它接入 `probe:automation-authoring`。验收不是单元测试拼装：它实际启动 Electron BrowserView、探测并绑定 Canvas Surface、从归一化 BGRA 帧取材、调整 BrowserView 尺寸、再次解析 Surface，再交给真实 OpenCV Worker 匹配。

Windows 150% DPI 首次运行揭示了测试夹具中的关键差异：`webContents.capturePage(rect)` 返回物理像素84×60，而 Automation Capture Service 对外提供逻辑帧56×40。若测试直接保存前者，却记录逻辑 Surface 尺寸，预测1.25后模板会错误变成105×75。验收已改为使用与助手一致的归一化逻辑帧，最终在 Canvas 从600×200变为750×250时得到：

- 图片组共享预测 scale `1.2500`；
- 目标框70×50，最强分数约98.39%；
- 旧素材无元数据路径继续使用默认三档并成功命中；
- Surface相对坐标在后续 BrowserView resize 后仍成功点击 Canvas。

因此 V6 优化已经通过项目真实 Electron 环境的 Windows HiDPI 端到端门禁。这里验证的是 Windows Electron 发布链；Linux目前仍是 WSL Node Worker/BGRA/OpenCV基准，不把它表述为Linux Electron GUI完整验收。
