# Phase 5 — Automation Runtime 2.0 执行计划

> 状态：Complete  
> 输入：Phase 4 Complete、Core Design §18、ADR-005/008/010

## 目标边界

实现受限Workflow IR与解释器：`sequence / if / loop / break / continue / wait / action / query / let / set / with`。Runtime只解释控制节点；Action、Query、Locator通过registry dispatch。Blockly不是完整语言，本阶段不加入try/catch、class、closure、函数、递归、复杂对象或高级数组API。

## 批次

1. `P5-T01`：冻结Value、Expression、Workflow IR产品类型和验证器；编译期检查node ID、变量、类型、loop lexical scope和预算上限。
2. `P5-T02`：实现有界Expression evaluator；仅支持白名单unary/binary/project，禁止隐式对象访问和宿主值泄漏。
3. `P5-T03`：实现Runtime control interpreter；内部control signal承载break/continue，不把它们暴露为Error。
4. `P5-T04`：接入ActionRegistry、QueryRegistry和ExecutionContext；Runtime不得switch Action/Locator kind。
5. `P5-T05`：实现wait duration/query、deadline、poll和cancel/yield语义。
6. `P5-T06`：实现RunHandle、typed events、状态机、bounded history与RunResult。
7. `P5-T07`：实现Host hard budgets：nesting、nodes、iterations、wall clock、bindings、strings、yield和log ring。
8. `P5-T08`：实现cancel/shutdown资源屏障和并发所有权测试。
9. `P5-T09`：增加旧Workflow→IR单向兼容入口，登记Legacy；不改变旧schema/Blockly，不把适配字段写入Core。
10. `P5-T10`：全量验证、switch/依赖搜索、文档收口。

## 验收

- Runtime control interpreter只穷举IR control node。
- 新增Locator或Action executor不修改control interpreter。
- break/continue非法位置在运行前拒绝。
- while/repeat每轮检查cancel和budget，并按policy让出事件循环。
- cancel完成意味着timer、capture lease、CDP lease、recognizer请求和event stream均已收口。
- 旧Runtime保持可运行，直到Phase 8断代；新IR不继承旧34种Step镜像模型。

## 完成记录

- 产品类型与旧`AutomationStep`完全分离；validator覆盖ID、类型、binding、loop scope、surface/region与静态预算。
- Expression evaluator仅开放白名单运算/投影，具有operation/string budget。
- Runtime解释10类控制节点；Action/Query走冻结registry，不判断Action/Locator kind。
- repeat/while、break/continue、duration/query wait、Context lease、yield/cancel均有测试。
- RunHandle具备typed state/node/diagnostic event、bounded history和资源关闭屏障。
- `LEGACY-P5-001`仅单向翻译可表示的旧Workflow，不写入Core格式；不可表示Step明确失败，旧Runtime继续承担1.x执行。
- 完整验证：99 files / 634 tests；typecheck、lint和production build通过。
