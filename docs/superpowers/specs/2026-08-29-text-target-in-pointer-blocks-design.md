# 文字（OCR）目标统一进现有指针积木

## 背景与目标

自动化积木目前分两类识别能力：
- **图片识别**：用模板匹配（`findImage`），遍布 `click-image`、`move-to-image`、`drag-image`、`position-compare`、`position-relation` 等积木。
- **文字识别（OCR）**：用 PaddleOCR（`findText`），但只暴露了 `wait-text-state` / `click-text` 两个独立积木。

用户希望把 OCR 文字能力**统一进现有指针积木**，让同一块积木的目标可选"图片 / 坐标 / 文字"三种，一套积木三用，UI 统一，避免重复开一套 OCR 积木。

### 现状（探索确认）

- **组合条件层已经统一**：`AutomationCondition` 联合类型（types.ts:71）含 `image-visible` 与 `text-visible`，`if-condition` / `wait-condition` / `repeat-until-condition` / `and` / `or` / `not` 已能混用图片+文字。此层**无需改动**。
- **指针/目标层未统一**：两个 target 类型都只判别 `coordinate | image`：
  - `PositionCompareTarget`（types.ts:57-59）→ 用于 `position-compare` 步 + `position-relation` 条件。
  - `AutomationPointerTarget`（types.ts:312-314）→ 用于 `drag` 步。
- **运行时已天然支持**：`TextMatch = ImageMatch & { text }`（runtime.ts:65），结构与 `ImageMatch` 完全一致；`driver.click` / `moveTo` / `drag` 均接受 `ImageMatch`。缺的只是 target 类型的判别与 `findText` 解析路径。

### 关键既有模式

Blockly 侧已有三种**目标切换扩展**：`CLICK_TARGET_EXTENSION`（行 112）、`DRAG_TARGET_EXTENSION`（行 128）、`POSITION_COMPARE_EXTENSION`（行 148）。它们通过字段值判别（`ASSET === COORDINATE_TARGET`、`A_TYPE === 'image'` 等）显示/隐藏对应行。本次复用同一模式，把判别从"图片↔坐标"扩展到"图片↔坐标↔文字"。

## 方案：三选一下拉目标

块内部署一个三选下拉（图片 / 坐标 / 文字）：
- 选**图片** → 显示素材下拉 + 识别字段（阈值/多尺度/掩码/区域）。
- 选**坐标** → 显示 0-10000 相对坐标输入。
- 选**文字** → 显示文字输入 + 匹配方式（包含/完全一致）+ 最低置信度。

一次改动覆盖全部指针积木：`click-image`、`move-to-image`、`drag-image`、`position-compare`（其 `position-relation` 条件同样受益）。

## 架构与改动点

### 1. shared 类型层（`src/shared/automation/types.ts` + `schema.ts`）

`PositionCompareTarget` 增加 text 变体：
```ts
export type PositionCompareTarget =
  | { kind: 'coordinate'; coordinate: AutomationCoordinate }
  | { kind: 'image'; asset: string; alternatives?: string[]; threshold?: number; region?: AutomationRegion; scales?: number[]; mask?: AutomationImageMask; offset?: { x: number; y: number } }
  | { kind: 'text'; text: string; match?: AutomationTextMatchMode; minScore?: number; region?: AutomationRegion; offset?: { x: number; y: number } };
```

`AutomationPointerTarget` 增加 text 变体：
```ts
export type AutomationPointerTarget =
  | { kind: 'coordinate'; coordinate: AutomationCoordinate }
  | { kind: 'image'; condition: ImageCondition }
  | { kind: 'text'; condition: TextCondition };
```

`schema.ts`：`positionCompareTargetSchema`（行 66）与 `automationPointerTargetSchema` 各加 `z.discriminatedUnion('kind', [...])` 的 text 分支。`click-coordinate` / `move-to-coordinate` / `drag` 等步的 schema 因复用 target schema 自动受益。

### 2. 运行时（`runtime.ts` + `browserview-driver.ts`）

**`resolveTargetPoint`（browserview-driver.ts:466-482）** 加 text 分支：
```ts
if (target.kind === 'text') {
  const match = await this.findText({ text: target.text, match: target.match ?? 'contains', minScore: target.minScore ?? 0.5, region: target.region }, signal);
  if (!match) throw new Error(`text not found for position comparison: ${target.text}`);
  return this.toCssPoint(match, target.offset ?? { x: 0, y: 0 });
}
```
注：`resolveTargetPoint` 目前在 driver（已处理 image/coordinate）。text 分支走 `findText`，返回的 `TextMatch` 经 `toCssPoint` 转逻辑点——与 image 路径一致（text 是 ImageMatch 超集）。

**`resolvePointerTarget`（runtime.ts:507-511）** 加 text 分支：
```ts
if (target.kind === 'text') {
  const match = await this.waitForText({ ...target.condition, type: 'wait-text-state', state: 'visible', timeoutMs, minCycleMs }, signal);
  return { kind: 'match', match };
}
```
（`AutomationDriverPointerTarget`，runtime.ts:161，若未含 text 需扩展为其携带 `{ kind: 'match', match }`，与 image 一致，天然可用。）

**`drag` 的 source/target 解析**：`resolvePointerTarget` 统一处理，加 text 分支后 `drag` 可拖到文字。

**driver 端**：`driver.click` / `moveTo` / `drag`、`dragTargets`（browserview-driver.ts:556-564）已接受 `ImageMatch`/指针目标，`TextMatch` 是超集，**无需改动**。`dragTargets` 的 resolve 函数（行 560-562）已按 `kind === 'coordinate'` / else（match）判别，text 走 match 分支可复用。

### 3. Blockly（`AutomationBlocklyEditor.tsx` + `automation-block-schema.ts`）

三个扩展函数把判别扩展到 text：

- `CLICK_TARGET_EXTENSION`（行 112-126）：`ASSET` 可能的第三值 `TEXT_TARGET`。当选中文字时隐藏 COORDINATE/THRESHOLD/MORE，显示 TEXT 输入 + 匹配 + 置信度。
- `DRAG_TARGET_EXTENSION`（行 128-146）：`SOURCE_ASSET` / `TARGET_ASSET` 同样支持 text。
- `POSITION_COMPARE_EXTENSION`（行 148-166）：`A_TYPE` / `B_TYPE` 加 `'text'`；顺带 `position-compare` 的 `A/B_COORDINATE`、`A/B_ASSET` 对应的 `A/B_TEXT` 行切换。

新增常量：`TEXT_TARGET = '__bao_text__'`（对应 `COORDINATE_TARGET = '__bao_coordinate__'`）。

目标下拉选项：`clickTargetField`（行 201-205）、`drag` 的 source/target、`positionCompareTarget` 的 `A_TYPE`/`B_TYPE` 下拉都加入第三项"文字"。选文字时显示 `TEXT` field_input（复用现有文字积木的 `field_input` 模式，如 `wait-text-state` 行 226）。编译/解码函数（`requiredImageTarget`、`imageTarget`、`pointerTarget`、`positionCompareTarget`、`createStep`）各加 text 分支。

### 4. i18n（`zh-CN` / `en`）

新增积木内目标下拉项的文案：
- 图片 / 坐标 / 文字 三选标签
- 文字目标的"匹配方式"（包含文字/完全一致）、"最低置信度" 等，复用现有 `textCondition` / `waitTextState` 相关文案。

## 改动面汇总

| 层 | 文件 | 改动 |
|----|------|------|
| 类型 | `shared/automation/types.ts` | 两个 target 类型加 text 变体 |
| Schema | `shared/automation/schema.ts` | 两个 target schema 加 text 分支 |
| 运行时 | `runtime.ts` | `resolvePointerTarget` 加 text |
| 运行时 | `browserview-driver.ts` | `resolveTargetPoint` 加 text |
| Blockly | `AutomationBlocklyEditor.tsx` | 3 个扩展函数 + 目标下拉 + 编译/解码加 text |
| Blockly | `automation-block-schema.ts` | 相应 block 定义加 text 字段 |
| i18n | `zh-CN`/`en` | 目标三选、文字匹配文案 |
| 测试 | `tests/automation-runtime.test.ts` 等 | 补 text target 的解析/位置比较用例 |

## 关键设计决策

1. **一套积木三用，不另开 OCR 积木**。复用已有 `TextMatch` + `click`/`moveTo`/`drag` 通路，运行时改动最小。
2. **文字目标从 `pointer-target` 层接入**，与图片目标同构，`position-compare`/`position-relation` 因此获得文字比较能力。
3. **Blockly 交互沿用现有 asset↔coordinate 切换模式**，一致性最高，用户无需学新交互。

## 测试策略

- 运行时：`resolveTargetPoint` 对 text 目标返回正确逻辑点；`click-text`/`drag` 的 text target 解析。
- `position-relation` / `position-compare` 用 text target 做垂直对齐/重合判定的单元测试。
- Blockly：编译一个含 text 目标的 click/position-compare 块，解码回正确 workflow。
- 回归：现有 image/coordinate 目标行为不变。

## 开放问题（需在实现时敲定）

1. `click-image` 语义不变（仍是"先 wait 再 click"）；`click` 加 text 目标后，是否复用 `click-text` 的 `waitForText` 时间语义？——建议：`click` 目标为 text 时等价于 `click-text`，复用其 `waitForText` 逻辑。
2. `key-hold-until-image` 是否也纳入 text？——暂不纳入，保持范围收敛（它按"按住直到图片出现"语义，加 text 属额外边缘场景）。
