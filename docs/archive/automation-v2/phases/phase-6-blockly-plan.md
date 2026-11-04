# Phase 6 — Blockly 2.0 执行计划

> 状态：Complete  
> 输入：Phase 5 Complete、Workflow IR v3、Action × Locator合同

## 定位

Blockly是受限Workflow IR的可视化前端，服务简单自动化和非程序员用户。它不拥有Runtime、坐标、识别或输入语义，也不发展try/catch、函数、class、closure、复杂对象和高级数组API。

## 目标模型

```text
Action Block                  Locator value Block
点击 [目标]        ← value ← 图片 [asset]
移动 [目标]                  文字 [购买]
拖动 [from] 到 [to]          坐标 [x] [y]

Context Block
在 [游戏区域] 中
  ...
```

动作block不得保存`page/game`或Image/Text/Coordinate分支字段；Locator block负责自身参数。新增Locator只增加value block/codec，不复制Click/Move/Drag。

## 批次

1. `P6-T01`：定义Blockly 2.0 block taxonomy、连接类型与IR codec合同，固定block数量预算。
2. `P6-T02`：实现Locator value blocks：Coordinate/Image/Text；统一输出`BaoLocator`。
3. `P6-T03`：实现Click/Move/Drag Action blocks，只接受`BaoLocator`输入。
4. `P6-T04`：实现Viewport/Named Surface Context block和Region scope，不在动作上暴露page/game。
5. `P6-T05`：实现sequence/if/repeat/while/break/continue/wait与基础变量/表达式blocks。
6. `P6-T06`：实现Blockly workspace ↔ WorkflowDocumentV3双向codec；拒绝未知/断开的必填value block。
7. `P6-T07`：接入Automation页面的draft/save/run路径；v2草稿使用新key，不读取旧Blockly XML。
8. `P6-T08`：可访问性、中文/英文文案、toolbox分组和积木数量复核。
9. `P6-T09`：round-trip、golden workspace、Action × Locator扩展性和UI smoke测试。
10. `P6-T10`：全量验证与旧block引用清单；旧Blockly仅保留到Phase 8统一删除，不新增兼容字段。

## 验收

- Click/Move/Drag各只有一种Action block。
- Coordinate/Image/Text各只有一种Locator value block。
- Action block不含坐标系、图片、文字特有字段。
- Context继承由嵌套结构表达。
- Blockly 2.0 block数量明显少于旧43；核心首发目标不超过24。
- codec直接产生Workflow IR v3，不产生旧Step。
- 添加测试Locator不修改三个Action block定义和codec分支。

## 完成记录

- Blockly 2.0核心taxonomy为22 blocks：3 Locator、3 Action、2 Context、6 Control、8 Value/Variable/Query。
- Action value input统一检查`BaoLocator`；动作定义不包含图片/文字/坐标或page/game字段。
- `workspaceToWorkflowV3` / `workflowV3ToWorkspace`直接处理v3 IR，并拒绝断开的必填输入和不可无损显示的节点。
- Coordinate/Image/Text Locator使用可持久化geometry，不携带运行期Space/generation。
- 新`AutomationBlocklyV2Editor`使用独立`baoauto:v3:draft:*` key，绝不读取旧Blockly XML。
- 正式替换AutomationPage保存/运行入口与删除旧editor必须和Phase 8 `.baoauto` v3断代一起原子完成；此前不让新旧格式互相回写。
- 完整验证：100 files / 638 tests；typecheck、lint、production build通过。
