# 自动化积木识别目标统一化

## 背景与目标

当前自动化积木在图片识别与文字识别（OCR）上存在结构性割裂：

- **图片**有专属积木：`wait-image` / `wait-image-state` / `if-image` / `repeat-until-image` / `key-hold-until-image` / `click-image` / `move-to-image` / `drag-image` / `position-compare`（目标为图片）。
- **文字**只有少量专属积木：`wait-text-state` / `click-text` / 条件 `condition_text`。若想在"重复直到/如果/按住直到"里用文字，只能绕通用版 `-condition` + 嵌套 `condition_text`，且鼠标/流程类不全。
- 用户期望"只要图片有的能力，文字也要有"，且允许破坏性重构（项目用户少，无历史包袱）。

目标：**把"识别目标"抽象为流程与动作积木中的一等概念**——同一块积木可通过一个切换下拉选择"图片 / 文字（/ 坐标）"。消除图片/文字两套并行积木，积木数量减半，且未来扩展识别源（如颜色定位）只需扩展"目标"字段。

## 核心抽象

### 识别目标（RecognitionTarget）

把图片条件与文字条件统一为"识别目标"，作为所有识图步骤的共享输入：

```ts
export type RecognitionTarget =
  | ImageCondition      // type: 'image-visible'
  | TextCondition;      // type: 'text-visible'
```

（`ImageCondition`/`TextCondition` 保持一致。识别目标本身只关心"检测什么"，不含"出现/消失"状态——状态是 wait 等动作的属性。）

### 指针目标（PointerTarget）

点击/移动/拖拽/位置比较的目标，在图片/坐标基础上扩展文字：

```ts
export type PositionCompareTarget =
  | { kind: 'coordinate'; coordinate: AutomationCoordinate }
  | { kind: 'image'; asset: string; alternatives?: string[]; threshold?: number; region?: AutomationRegion; scales?: number[]; mask?: AutomationImageMask; offset?: { x: number; y: number } }
  | { kind: 'text'; text: string; match?: AutomationTextMatchMode; minScore?: number; region?: AutomationRegion; offset?: { x: number; y: number } };

export type AutomationPointerTarget =
  | { kind: 'coordinate'; coordinate: AutomationCoordinate }
  | { kind: 'image'; condition: ImageCondition }
  | { kind: 'text'; condition: TextCondition };
```

## 步骤类型统一（破坏性变更）

### 流程类：识别目标化

| 旧步骤（多对多） | 新步骤（合并后） |
|------------------|------------------|
| `wait-image` / `wait-text-state` | `wait-target`（`target: RecognitionTarget`, `state: 'visible'\|'hidden'`, `timeoutMs?`, `minCycleMs?`） |
| `if-image` / `if-condition`（仅文字） | `if-target`（`target: RecognitionTarget`, `negate?`, `then`, `else?`） |
| `repeat-until-image` / `repeat-until-condition`（仅文字） | `repeat-until-target`（`target: RecognitionTarget`, `until: 'visible'\|'hidden'`, `maxIterations`, `delayMs?`, `body`） |
| `key-hold-until-image` | `key-hold-until-target`（`key`, `modifiers?`, `target: RecognitionTarget`, `until: 'visible'\|'hidden'`, `timeoutMs?`, `minCycleMs?`） |

注：`wait-image`（无状态、只等出现）与 `wait-image-state`（含 hidden）合并进 `wait-target`，其 `state` 默认 `visible`。文字侧的 `wait-text-state` 也并入。

### 动作/指针类：目标三选一

| 旧 | 新 |
|----|----|
| `click-image` / `click-coordinate` / `click-text` | `click`（`target: PointerTarget`, `button?`, `clickCount?`, `offset?`, `verifyBeforeClick?`, `maxMovementPx?`, `timeoutMs?`, `minCycleMs?`） |
| `move-to-image` / `move-to-coordinate` | `move-to`（`target: PointerTarget`, `offset?`, `timeoutMs?`, `minCycleMs?`） |
| `drag-image` / `drag` | `drag`（`source: PointerTarget`, `target: PointerTarget`, `timeoutMs?`, `minCycleMs?`, `button?`, `durationMs?`） |
| `position-compare` | 不变结构，`targetA/B` 为 `PositionCompareTarget`（含 text） |

### 保留的条件层（已统一，不改）

`automationConditionSchema` 里 `all` / `any` / `not` 已经能混用 `image-visible` 与 `text-visible`。`if-condition`/`wait-condition`/`repeat-until-condition` 通用条件版继续保留（支持组合逻辑）。**`position-relation` 条件也自然获得文字目标**（其 `targetA/B` 用扩展后的 `PositionCompareTarget`）。

## Blockly 交互

### 识别目标切换（流程类与动作类共用模式）

在相关块内放置一个**目标类型下拉**，选项 `图片 / 文字`（动作类另加 `坐标`）。依据所选显隐对应字段：

| 类型 | 显示字段 |
|------|---------|
| 图片 | 素材下拉（asset + image group）、阈值、多尺度、掩码、区域 |
| 文字 | 文字输入、匹配方式（包含/完全一致）、最低置信度、区域 |
| 坐标 | 0-10000 坐标输入（仅动作类） |

复用既有 "目标切换扩展" 模式（`CLICK_TARGET_EXTENSION` / `DRAG_TARGET_EXTENSION` / `POSITION_COMPARE_EXTENSION`），把 `asset ↔ coordinate` 判别扩展为 `asset ↔ coordinate ↔ text`（动作类）或 `asset ↔ text`（流程类）。

### 积木清单（合并后）

对应工具箱分类：
- 鼠标操作（catMouse）：`click`（图片/坐标/文字三选一）、`move-to`、`drag`、`click-region`、`scroll`
- 键盘与文字（catKeyboard）：`key-press`、`key-hold-until`（图片/文字二选一）、`text-input`（键入，非识别）
- 识别与等待（catRecognition）：`wait`（图片/文字二选一 + 出现/消失）、`vision-region`、`delay`
- 流程（catFlow）：`if`（图片/文字二选一）、`repeat-until`、`wait-condition`、`position-compare`，条件块 `condition_image`/`condition_text`/`condition_position`/`and`/`or`/`not`

## 命名约定

- 消除 `-image` / `-text` 后缀，事件/状态类统一为 `-target`（识别目标）。动作类统一为动作动词（click / move-to / drag）。
- 为可读性，块内下拉直接显示"图片 / 文字 / 坐标"，不暴露内部 kind。

## 改动面汇总

| 层 | 文件 | 改动 |
|----|------|------|
| 类型 | `shared/automation/types.ts` | 新增 RecognitionTarget、PointerTarget；合并步骤类型；重命名旧 type |
| Schema | `shared/automation/schema.ts` | 新步骤 schema、target schema 扩展 |
| 运行时 | `runtime.ts` / `browserview-driver.ts` | 新步骤类型分派、target 解析（findImage/findText） |
| Blockly | `AutomationBlocklyEditor.tsx` / `automation-block-schema.ts` | 块定义合并、目标切换扩展、编译/解码 |
| i18n | `zh-CN` / `en` | 块标签、目标下拉文案 |
| 迁移 | 迁移/兼容层 | 旧 workflow JSON（image-*/text-* step type）→ 新 target 化步骤的映射（可选，保留读取旧格式） |

## 关键设计决策

1. **一次重构到位的抽象**：识别目标与动作/流程解耦，未来加颜色定位只需扩展 RecogntionTarget，不复用整套积木。
2. **保留通用条件层**：`all/any/not` 与 `-condition` 通用版是"组合逻辑"能力，与"便捷目标块"互补，不冲突。
3. **Blockly 沿用既有目标切换扩展模式**：交互一致性最高，用户无需重学。
4. **迁移策略**：新增步骤类型后，提供读取旧格式 `image-*`/`text-*` step 的兼容解析（旧脚本不立即失效），用户在编辑器保存后升级为新格式。

## 测试策略

- 运行时：`wait-target`/`if-target`/`repeat-until-target`/`key-hold-until-target` 对图片目标与文字目标分派正确；`click`/`move-to`/`drag`/`position-compare` 的 text 目标解析与 `findText` 对接。
- `position-relation` 条件用文字目标做垂直/重合判定。
- 旧格式迁移：读取 `wait-image`/`wait-text-state` 等旧 step 映射到新步骤且行为一致。
- Blockly：编译含文字目标的 click/wait/repeat-until 块并解码回正确 workflow。
- 回归：现有图片、坐标、组合条件行为不变。

## 开放问题（实现时敲定）

1. `wait-target` 是否保留独立的"只等出现"便捷块（默认 visible），还是全部走 state 字段？——建议：保留一个默认 `visible` 的便捷形态，减少常用场景的字段数量。
2. 命名：`wait-target` vs `wait`；`if-target` vs `if`；需与既有 `wait-condition`/`if-condition` 区分。建议动作/等待用简洁名（`wait`/`click`），条件用 `-condition` 后缀区分。
3. 旧格式兼容保留多久（是否提供 V1→V2 迁移，或仅读取），避免破坏已发布脚本。
