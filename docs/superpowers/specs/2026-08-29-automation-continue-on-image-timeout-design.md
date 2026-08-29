# 自动化遇错继续（仅超时未识别）设计

- 日期：2026-08-29
- 状态：已批准（设计评审通过，待写实现计划）
- 目标作者：自动化运行时 / 工作台

## 背景与问题

当前任何一步抛错（例如 `wait-text` 超时抛出 `timed out waiting for text: 钓鱼`）都会向上传播，
导致整个脚本立即中止（`runtime.ts` 的 `execute()` 只在显式 `end`/`break` 信号处捕获）。

用户希望：
1. 某一步"超时未识别"时脚本不要全部停止，而是接着往下走。
2. 在循环体里出错时，放弃本轮剩余步骤，直接继续下一个循环。
3. 目前用户只遇到过"超时未识别"这一种错误，其它错误尚未遇到。

## 范围界定

只把**「超时未识别」**（某个 `wait-*` 步骤到达其 deadline）当作可续行的**软错误**。

其余错误仍然中止运行，保持现有行为：
- 导航失败（`navigate` / `reload`）
- tab 被切走 / 目标 `WebContents` 销毁（`assertCurrent`）
- 自动化被取消（`signal.aborted`）
- 坐标非法、区域不相交等结构错误
- OpenCV 匹配器 / worker 崩溃

> 理由：当前用户只遇到超时错误；把真正致命的错误也静默续行会让脚本在故障时无限空转、难以诊断。

## 数据模型

### `src/shared/automation/types.ts`

`AutomationWorkflow` 增加可选字段：

```ts
errorPolicy?: 'continue' | 'fail-fast';
```

语义：
- `continue`（默认）：超时未识别 → 记录 warning → 按恢复语义继续。
- `fail-fast`：保持现状，超时即整体中止。

### `src/shared/automation/schema.ts`

`automationWorkflowSchema` 增加：

```ts
errorPolicy: z.enum(['continue', 'fail-fast']).optional(),
```

## 软错误标记（`src/main/modules/automation/runtime.ts`）

新增内部信号类：

```ts
class SoftTimeoutError extends Error {}
```

将以下四处抛错由普通 `Error` 改为抛 `SoftTimeoutError`：
- `waitForImage` → `timed out waiting for image: <asset>`
- `waitForText` → `timed out waiting for text: <text>`
- `waitForImageState`（`state === 'hidden'`）→ `timed out waiting for image to disappear: <asset>`
- `waitForTextState`（`state === 'hidden'`）→ 对应超时抛错

`waitForConditionResult` 返回 `false` 的路径（`wait-condition` / `wait-condition-branch`）保持**不抛错**，
由既有分支逻辑（`success` / `timeout` / `waitForCondition` 抛 combined-condition 超时）决定；
`wait-condition` 超时抛错属于"超时未识别"，也应改为 `SoftTimeoutError`。

## 恢复语义（`runtime.ts` `execute()`）

新增第二个内部信号：

```ts
class IterationAbortSignal extends Error {}
```

### `sequence`（序列）

`sequence` 的 `for` 循环遍历每个子步骤，为每个子步骤的 `execute` 包一层 try/catch：

```ts
for (const child of step.steps) {
  try {
    await this.execute(child, signal, depth + 1);
  } catch (error) {
    if (error instanceof SoftTimeoutError) {
      if (this.errorPolicy === 'fail-fast') throw error;
      if (loopDepth > 0) {
        // 在循环体内：放弃本轮剩余步骤，转交给循环继续下一轮
        throw new IterationAbortSignal();
      }
      // 顶层序列：记录 warning，continue 到下一个兄弟步骤
      this.reportStepError(child, error);
      continue;
    }
    throw error;
  }
}
```

### 循环（`repeat` / `forever` / `repeat-until-*`）

每个循环的 body 包 try/catch，仅捕获 `IterationAbortSignal` → `continue` 下一轮：

```ts
try {
  await this.execute(step.body, signal, depth + 1);
} catch (error) {
  if (error instanceof IterationAbortSignal) {
    // 本轮已放弃，继续下一个循环
    // repeat：for 循环自然进入 index+1
    // forever：while 自然进入下一轮
    // repeat-until：保持其 until/maxIterations 语义
    continue;
  }
  throw error;
}
```

重复逻辑仍遵守 `maxIterations` / `unboundedLoopDepth` 约束。

### 循环深度追踪

`execute()` 需要知道当前是否在循环体内。当前已有 `unboundedLoopDepth`
（只覆盖 `forever`），需要增加一个覆盖所有循环类型（`repeat` / `forever` / `repeat-until-image` / `repeat-until-condition`）
的计数 `loopDepth`，在进入 / 离开 body 时增减。

## 内部信号与错误处理优先级

捕获次序必须明确，避免错误被错误吞掉：

1. `AutomationEndSignal`（显式 `end` 积木）——最高优先，无论策略都终止并返回成功/失败。
2. `AutomationBreakSignal`（`break` 积木）——仍正常跳出循环。
3. `IterationAbortSignal`——仅由循环体捕获，用于放弃本轮。
4. `SoftTimeoutError`——由 `sequence` 的恢复分支捕获。
5. 其它错误——按既有路径传播（最终中止）。

注意：`repeat` / `forever` 等处已有捕获 `AutomationBreakSignal` 的分支，
需与新增的 `IterationAbortSignal` 捕获并存且顺序放其后（`break` 优先于 `continue`）。

## 事件与日志（`src/main/modules/automation/service.ts`）

- 运行时新增事件 `{ type: 'step-error'; step: AutomationStep; error: Error }`。
- `service.ts` 的 `handleRuntimeEvent` 新增分支：写一条 warning 关键日志，
  例如 `key: 'status.stepError'`, `params: { detail }`。
- 在最终状态（completed / cancelled）里累计"跳过 N 次"计数（可用 `executedSteps` 之外再加一个 `errorCount`）。

## UI / Blockly

- 脚本属性面板增加开关「识图/文本超时后继续」（默认开）。
- 导出 / 导入时携带 `errorPolicy` 字段（`formatVersion` 保持 2，字段可选，向后兼容）。

## 测试（Vitest + Electron smoke）

### Vitest 用例（`tests/` 下，遵循现有自动化测试结构）

1. **顶层序列超时续行**：workflow = `[wait-image(A) 超时, delay, end success]`，
   `errorPolicy: 'continue'` → 断言整体 completed，且 `wait-image` 的超时被记录为 warning，
   后续步骤被执行。
2. **循环体超时放弃本轮**：workflow = `repeat 3 { [wait-image(A) 超时, click(B)] }` →
   断言每次循环在超时后不再执行 `click(B)`，`repeat` 完成 3 轮。
3. **fail-fast 仍中止**：同用例 1，但 `errorPolicy: 'fail-fast'` → 断言整体 failed。
4. **break 优先于 continue**：循环体内先超时再 `break` → 断言正确跳出循环且不进入下一轮。

### Electron smoke

- 扩展或新增 `tests/electron/` smoke，用一个真实 fixture 验证：
  最小化窗口下超时续行 + 循环继续（非最小化时不影响）。

### `npm run check` 回归

运行 i18n + typecheck + lint + tests + 生产构建，确保 schema 变更不破坏现有包导入。

## 关键决策记录

| 决策点 | 结论 |
|--------|------|
| 默认策略 | `continue`（用户授权破坏重建） |
| 可续行错误范围 | 仅"超时未识别"，硬错误仍中止 |
| 顶层序列续行 | 跳过当前失败步骤，继续兄弟 |
| 循环体续行 | 放弃本轮剩余步骤，下一轮 |
| break 与 continue 冲突 | break 优先 |
| 致命错误 | 无论策略都中止（tab 缺失/取消/导航失败） |
| UI 默认 | 开关默认开 |
| 打包格式版本 | 保持 2，字段可选 |

## 风险

- 超时后继续点击后续步骤可能误点 `click-*`。已通过"循环放弃本轮"缓解；
  若需更保险，可将"超时后强制复核再点击"作为后续可选增强（本次不做）。
