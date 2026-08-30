# Phase 2 — Coordinate / Surface 实现计划

> 状态：Complete  
> 日期：2026-08-30  
> 输入：Approved Core Design、ADR-002/003/004/010  
> 范围：Viewport、Surface、Point、Region、Transform、CoordinateResolver、Frame geometry

## 1. 边界

Phase 2允许修改Core geometry和BrowserView coordinate adapter，并以临时adapter接回Automation 1.x。禁止：

- 修改Blockly UI、block schema或toolbox；
- 引入Locator/Action 2.0执行器；
- 重写Runtime 2.0；
- 切换OCR provider；
- 改变`.baoauto`持久格式；
- 删除旧Workflow或page/game（Phase 8执行）。

## 2. 批次

### P2-T01：纯Geometry / Space / Transform

目标文件：

- `src/shared/automation/core/geometry.ts`
- `tests/automation-core-geometry.test.ts`

实现finite number、IDs/generation、SpaceRef、Point/Vector/Region/Size、ratio→logical、半开Region、affine apply/invert/compose、舍入边界。全部纯函数。

### P2-T02：SurfaceSpec / ResolvedSurface

目标文件：

- `src/shared/automation/core/surface.ts`
- `tests/automation-core-surface.test.ts`

实现SurfaceSpec types、depth/cycle/ratio region validation、ResolvedSurface generation验证、region Surface composition。

### P2-T03：CoordinateResolver

目标文件：

- `src/shared/automation/core/coordinate-resolver.ts`
- `tests/automation-coordinate-resolver.test.ts`

实现Viewport/Surface Space内ratio/logical解析、Surface↔Viewport、任意同target Space转换、generation stale拒绝。

### P2-T04：BrowserView coordinate adapter

目标文件：

- `src/main/modules/automation/browserview-coordinate-adapter.ts`
- 相应单元测试

把Viewport logical映射到live BrowserView display；Point保留小数，Capture Region outward rounding/clamp。模块不包含Vision/OCR/Input副作用。

### P2-T05：Frame geometry

目标文件：

- `src/shared/automation/core/frame-geometry.ts`
- 相应单元测试

实现frame identity、bitmap↔captured Space transform、generation assertion、match center/region投影。Phase 4再加入像素lease与CaptureService。

### P2-T06：Automation 1.x临时adapter

旧Driver导出的coordinate helpers委托新Core；保留旧`0..10000`、page/game外部行为和测试。不得改动Blockly。登记`LEGACY-P2-001/002`。

### P2-T07：验证与关闭

- `npm run typecheck`
- `npm run lint`
- `npm test -- --run`
- 必要的现有Automation Electron coordinate/viewport smoke；若运行前必须刷新专用bundle，先执行对应build script。
- 全仓搜索新Core不得导入Electron/renderer/Blockly/旧Runtime。
- 更新traceability、verification log、risk和legacy inventory。

## 3. 验收矩阵

| 维度 | 样例 |
|---|---|
| ratio Point | 0、0.5、1映射到logical可点击范围 |
| ratio Region | full/edge/subregion使用完整extent和半开边界 |
| invalid number | NaN、Infinity、negative size、zero region拒绝 |
| transform | identity、translate、scale、nested compose、inverse round-trip |
| generation | target/viewport/surface任一变化拒绝旧geometry |
| Surface | viewport、element、region、named、nested、cycle/depth |
| BrowserView | nonuniform scale、outward capture rounding、clamp |
| Frame | full frame、ROI、DPR、stale、match center |
| Legacy parity | 0..10000 point、search region、game surface offset保持现有结果 |

## 4. 回滚边界

新Core文件是新增模块。旧系统接入仅通过小型adapter调用；若某接入批次失败，可回退adapter调用而不删除已验证的纯Core。禁止用双写状态或第二套page/game模型“临时修复”。

## 5. 完成条件

- 上层新Core没有page/game类型。
- Point/Region不能脱离Space。
- Surface与Frame使用generation验证。
- Match→Point不需要全局lastFrame（新Frame geometry路径）；旧Driver临时合同登记待Phase 4/8删除。
- 所有新增和既有测试通过。
