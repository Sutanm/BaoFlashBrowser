# Automation 识图 Scale 修正实施计划

> 日期：2026-09-06
> 状态：主项目已实施并通过自动验收；待真实游戏手测
> 关联调研：`docs/superpowers/specs/2026-09-05-image-scale-notes.md`

## 目标

修复素材取材时页面缩放与运行时页面缩放不一致时的模板 Scale 预测，使窗口化、最大化及页面 zoom 改变后仍能按正确尺寸识别。

本批只修正 Scale 元数据和换算链，不修改颜色评分、OpenCV 分数、自动路由和融合判定。

正确公式：

```text
normalizedFrameSize = logicalSize / viewportScale
templateScale = runtimeLogicalSize / authoringLogicalSize
              × authoringViewportScale / runtimeViewportScale

viewportScale = displaySize / logicalSize = 1 / zoom
```

例：取材 zoom=1、运行 zoom=1.5、Surface logical 比为 1.25：

```text
templateScale = 1.25 × 1 / 0.667 = 1.875
```

## 范围约束

- Electron 11.5.0、BrowserView 和现有截图归一化方式保持不变。
- 不额外乘 DPR；DPR 已被捕获归一化链消化。
- 显式 `locator.scales` 始终优先，不被自动预测覆盖。
- 只有 `reference.kind === 'surface'` 且元数据完整时使用单一预测 Scale。
- 旧素材、外部导入素材和混合新旧图片组不猜测取材 zoom，继续走现有多尺度兜底。
- X/Y 校正后明显非等比时拒绝预测，不把非等比伸缩压成一个伪造 Scale。
- Scale 修复只负责尺寸对齐，不承诺消除树叶、状态栏等同色异形误报。

## 数据模型

扩展 `AutomationAssetMetadataV3.reference`，新增可选的取材视口变换：

```ts
type AutomationAssetReferenceV3 = {
  kind: 'viewport' | 'region' | 'surface';
  width: number;
  height: number;
  viewportTransform?: {
    scaleX: number;
    scaleY: number;
  };
};
```

约束：

- `width/height` 继续表示裁取目标前的逻辑捕获区域尺寸，保持既有语义。
- `scaleX/scaleY` 使用 `BrowserViewAutomationTargetHandle.getViewportTransform()` 的原始定义。
- 新字段可选，因此 `.baoauto` 仍使用 formatVersion 3，不做破坏性升级。
- 解析时仅接受有限正数；字段缺失表示 legacy/unknown，不默认成 1。
- 导出、导入和 clone 必须原样保留新字段。

## 任务总览

| Task | 内容 | 完成门禁 |
|---|---|---|
| 1 | 固化基线和纯函数契约 | 当前 REPRO 保持唯一预期红测；新增公式单测先红 |
| 2 | 扩展包元数据与兼容解析 | package v3 单测、typecheck 通过 |
| 3 | 在同一次取材租约中保存 viewport transform | service/capture 单测通过 |
| 4 | 实现双端 Scale 换算 | vision-policy 单测及现有 REPRO 转绿 |
| 5 | 接入 Runtime、助手和测试中心共享路径 | 三入口策略测试通过 |
| 6 | Electron 跨 zoom/窗口状态验收 | 真实帧 bbox、匹配位置和 Scale 全部通过 |
| 7 | 全量回归与文档收尾 | typecheck、unit、integration、build 通过 |

## Task 1：固化公式和优先级契约

**文件：**

- Modify: `tests/automation-vision-policy.test.ts`
- Add/Modify: `tests/automation-package-v3.test.ts`

步骤：

- [ ] 保留现有 `1.25 → 1.875` REPRO，不先改期望迁就实现。
- [ ] 增加同 zoom：logical 比 1.25、双端 scaleX 相同，结果 1.25。
- [ ] 增加正向 zoom：取材 1、运行 1.5，校正为 `×1.5`。
- [ ] 增加反向 zoom：取材 1.5、运行 1，校正为 `×2/3`。
- [ ] 增加 X/Y 校正后非等比拒绝。
- [ ] 增加 legacy reference 缺 transform 时返回 `undefined`。
- [ ] 增加图片组中任一素材缺 transform 时不启用共享窄 Scale。
- [ ] 固化优先级：显式 scales > 可信 Surface 预测 > 已学习 Scale > 默认多尺度。

门禁：新增测试按预期为红，除此之外既有相关测试保持绿。

## Task 2：扩展 `.baoauto` 素材元数据

**文件：**

- Modify: `src/shared/automation/package-v3.ts`
- Modify: `src/main/modules/automation/package-v3.ts`
- Modify: `docs/automation-v2/automation-v2-core-interfaces.draft.ts`
- Modify: `tests/automation-package-v3.test.ts`

步骤：

- [ ] 为 reference 增加可选 `viewportTransform.scaleX/scaleY`。
- [ ] 补充 finite、正数和对象结构校验，禁止 NaN、Infinity、0、负数。
- [ ] 确认未知/缺失 transform 的旧包可正常导入。
- [ ] 确认新包导出再导入后 transform 不丢失。
- [ ] 不提升 formatVersion，不迁移、不重写用户旧包。

门禁：`npm run typecheck` 和 package v3 单测通过。

## Task 3：取材时原子记录 transform

**文件：**

- Modify: `src/main/modules/automation/browserview-core-session.ts`
- Modify: `src/main/modules/automation/service-v3.ts`
- Modify: `tests/automation-capability-services.test.ts`
- Modify: `tests/automation-vision-policy.test.ts`

关键要求：取材图像、逻辑区域和 viewport transform 必须来自同一个已稳定的 Automation lease/revision，不能先截图、窗口变化后再读取 transform。

步骤：

- [ ] 为作者会话增加“捕获预览 + 当前 transform/revision”的单次结果，避免 Service 读取私有 handle。
- [ ] 捕获前等待 viewport settle；捕获后若 revision 已变化则重试或返回 typed error。
- [ ] 扩展内存 capture token，保存 reference kind、捕获区域尺寸和取材 transform。
- [ ] `saveCapturedAsset` 仅在 `referenceKind:'surface'` 且区域存在时写入 Surface transform。
- [ ] viewport/普通 region 可以保留 transform 供诊断，但不得被 Surface Scale 预测器误用。
- [ ] 确认保存目标 crop 后，reference 仍指向裁取目标前的 Surface 捕获尺寸。

门禁：覆盖同 revision、revision 变化、Surface、viewport 和 region 五类测试；`npm run typecheck` 通过。

## Task 4：实现正确的 Surface Scale 换算

**文件：**

- Modify: `src/shared/automation/vision-policy.ts`
- Modify: `src/main/modules/automation/browserview-core-session.ts`
- Modify: `src/main/modules/automation/service-v3.ts`
- Modify: `tests/automation-vision-policy.test.ts`

建议接口：

```ts
type SurfaceImageScaleReference = {
  width: number;
  height: number;
  viewportTransform?: { scaleX: number; scaleY: number };
};

type RuntimeSurfaceScaleContext = {
  width: number;
  height: number;
  viewportTransform: { scaleX: number; scaleY: number };
};
```

算法：

```text
widthScale  = current.width  / reference.width
            × reference.scaleX / current.scaleX
heightScale = current.height / reference.height
            × reference.scaleY / current.scaleY
```

- [ ] 校验所有输入是有限正数。
- [ ] 对 widthScale/heightScale 做既有 3% 非等比检查。
- [ ] 通过时继续用几何平均值生成一个 isotropic Scale。
- [ ] 保留既有 `[0.25, 4]` 结果范围。
- [ ] 多素材必须全部有可信且相互一致的 Surface reference，否则返回 `undefined`。
- [ ] 把运行时 `getViewportTransform()` 传入预测器。
- [ ] 将现有 `1.25 → 1.875` REPRO 转绿。

门禁：`npx vitest run tests/automation-vision-policy.test.ts tests/automation-package-v3.test.ts` 全绿。

## Task 5：统一生产与作者工具路径

**文件：**

- Modify: `src/main/modules/automation/browserview-core-session.ts`
- Modify: `src/main/modules/automation/service-v3.ts`
- Modify: `tests/automation-vision-policy.test.ts`
- Modify: 必要的作者工具回归测试

步骤：

- [ ] Runtime `locateImage` 使用新 Surface Scale 预测。
- [ ] 助手和测试中心继续调用同一个 Core/vision-policy，不复制公式。
- [ ] 预测 Scale 命中时只跑该快路径。
- [ ] 预测 Scale 未命中时继续跑 `imageMatchFallbackScales`。
- [ ] legacy/外部素材直接使用默认多尺度，不显示“已按 Surface 精确校准”。
- [ ] 图片组只有在所有成员引用同一 Surface 语义且校正 Scale 接近时才共享快路径。
- [ ] learned Scale 的缓存 key 加入 viewport revision 或校正后的 Surface 上下文，避免最大化/zoom 后复用旧值。

门禁：Runtime、助手、测试中心的测试断言收到相同 scales；显式 scales 不受影响。

## Task 6：Electron 端到端验收

**文件：**

- Add: `tests/electron/automation-scale-reference-smoke.cjs`
- Modify: `package.json`，新增明确的 `probe:automation-scale-reference`
- Reuse: `tools/automation-probe/fixtures/scale-calib.html`

场景使用项目 BrowserView、相同 session、相同 capture normalization 和 Core session，不能用 BrowserWindow 简化替代。

矩阵：

| 取材 | 运行 | 预期 |
|---|---|---|
| zoom 1.0 | zoom 1.0 | Scale 1.0 |
| zoom 1.0 | zoom 1.5 | Scale 1.5 |
| zoom 1.5 | zoom 1.0 | Scale ≈0.667 |
| zoom 1.25 | zoom 1.5 | Scale 1.2 |
| 窗口化 | 最大化 | 按 Surface logical 比和双端 transform 共同计算 |
| 最大化 | 窗口化 | 反向换算仍命中 |

每项同时断言：

- 取材 transform 与运行 transform；
- 推导 Scale；
- 真目标帧 bbox 尺寸比；
- 匹配矩形与 ground truth 的 IoU；
- 页面坐标回填没有漂移；
- restore/maximize 后 viewport revision 已更新，没有使用旧缓存。

门禁：六组全部命中，Scale 相对误差建议 ≤2%，矩形 IoU ≥0.8；无 debugger 残留和窗口白屏。

## Task 7：回归、兼容和文档收尾

- [ ] `npm run typecheck`
- [ ] `npm test -- --run`
- [ ] `npm run test:integration`
- [ ] `npm run benchmark:vision:routing-poc`，记录但不把识别误报变化归功于 Scale。
- [ ] `npm run build`
- [ ] 运行 Task 6 的 Electron probe。
- [ ] 更新 `docs/superpowers/specs/2026-09-05-image-scale-notes.md`：红测转绿、实际公式、实测矩阵和边界。
- [ ] 更新 `docs/automation-v2/status.md`：只在 Electron 矩阵通过后把跨 zoom Scale 标记完成。

## 验收定义

只有同时满足以下条件才算完成：

1. 现有 REPRO 从 `[1.25]` 转为 `[1.875]`；
2. 新取材素材在双向 zoom 和窗口状态变化后仍命中正确位置；
3. 旧素材和外部 PNG 不崩溃、不错误套用 zoom=1，而是走兜底；
4. Runtime、助手和测试中心使用完全相同的 Scale；
5. 显式 scales、非等比拒绝及图片组行为没有回归；
6. 全量类型、单元、集成和构建门禁通过。

完成本计划后，再进入“颜色/OpenCV 候选并集 + 结构验证”实施批次。
