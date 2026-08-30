# Phase 8 — `.baoauto` v3 / Recorder / Legacy Cutover 执行计划

> 状态：Complete  
> 输入：Phase 2～7 Complete；旧格式明确不支持；用户已批准断代

## 断代原则

这一Phase是原子cutover，不提供1.x/当前formatVersion 2兼容层、migration、deprecated API或双写。旧`.baoauto`导入直接返回`UNSUPPORTED_FORMAT`。删除动作只针对已审计的Automation旧系统，不触碰密码、userscript、Flash/Ruffle或其他产品域。

## v3包结构

```text
example.baoauto
├── manifest.json
├── workflow.json        # 可选，WorkflowDocumentV3
├── scripts/             # 可选，至少一个JS entry时存在
├── assets/
└── profiles/
```

manifest声明frontend entries、features、permissions和integrity；workflow与scripts可共存。profiles只保存参数/Surface选择，不保存grant。

## 批次

1. `P8-T01`：冻结v3 manifest/package schema、path/integrity/size limits和错误码。
2. `P8-T02`：实现v3 pack/unpack/preview/commit；拒绝旧formatVersion和未知危险entry。
3. `P8-T03`：实现frontend catalog：Blockly workflow与多个JS script共存，run时显式选择entry/profile。
4. `P8-T04`：实现Recorder event model → Action × CoordinateLocator/Context IR；不输出旧Step。
5. `P8-T05`：切换Automation workspace/store/IPC/preload/UI到v3 document/package。
6. `P8-T06`：激活Blockly 2.0 editor与JS editor/run入口；删除旧draft key读写。
7. `P8-T07`：删除旧Workflow schema/types/runtime/Driver facade/page-game模型/旧blocks/assistant兼容入口；页面悬浮助手作为v3原生frontend保留。
8. `P8-T08`：删除`LEGACY-P2/P3/P5`适配器、migration/deprecated code和旧`.baoauto`测试fixtures。
9. `P8-T09`：全仓dead-code/旧术语/switch搜索，更新probe/smoke/release校验。
10. `P8-T10`：全量/Electron验证、package round-trip、Recorder replay和最终架构审计。

## 删除门禁

- v3 schema、pack/unpack、frontend run和Recorder测试先通过，再删除旧实现。
- 删除前用`rg`固定精确文件/符号清单；不使用宽泛递归删除。
- 删除后以下搜索必须为零（文档审计引用除外）：旧Step union、`click-image/click-text/click-coordinate`、旧`page/game`动作字段、`LEGACY-P*`源码marker、旧Blockly `bao_*`定义和旧formatVersion 2 parser。

## 验收

- 新包可同时含workflow、scripts、assets、profiles。
- Recorder只输出v3 IR。
- 旧`.baoauto`明确拒绝，不迁移。
- 产品运行路径不再实例化旧Runtime/Driver或读取旧Blockly XML。
- Legacy inventory全部关闭，源码搜索无死代码。
- Pixel OCR仍不在本Phase范围。

## 完成记录（2026-08-30）

- P8-T01～T03：v3 manifest、pack/unpack、integrity、limits、repository、frontend catalog完成。
- P8-T04：Recorder pointer events直接编译为Action × CoordinateLocator/Context IR。
- P8-T05～T06：IPC/preload/workbench/sidebar切到v3；Blockly 2.0与JavaScript可共存并显式选择frontend/profile运行。
- P8-T07～T08：旧schema/types/Runtime/Driver/service/package/blocks、assistant旧适配层及全部LEGACY adapter已删除；助手重接v3/Core。
- P8-T09：旧Step、镜像Action、page/game动作字段和format v2 parser源码搜索清零；专用`GM_baoAutomation` grant仅保留给固定v3助手。
- P8-T10：typecheck、Vitest、lint、production build和JavaScript sandbox Electron smoke通过。
