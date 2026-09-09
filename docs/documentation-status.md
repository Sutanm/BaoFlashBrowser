# 文档状态与维护边界

> 全仓复核日期：2026-09-09
>
> 复核范围：受 Git 跟踪的项目文档；按要求不审查或修改任何 `README*`。

本页用于区分“当前规范”和“历史证据”。源代码、`package.json` 与根目录
`AGENTS.md` 始终优先于文档中的示例、测试数量和阶段状态。

## 当前规范

下列文档按 1.1.2 源码维护，可以作为开发与使用入口：

- `docs/modules/00-overview.md` 至 `09-build-release-test.md`：按模块描述现行架构。
- `docs/automation-user-guide.md`：Automation 2.0、`.baoauto` v3 与 JS/TS frontend。
- `docs/PACKAGE.md`：构建、模块裁剪、OCR 与发布校验。
- `docs/userscript-user-guide.md`、`docs/userscript-developer-guide.md`：用户脚本能力与限制。
- `docs/experimental-platform-support.md`：实验 Flash/macOS 支持边界。
- `RELEASE_NOTES.md`：1.1.2 发布内容与制品记录。

`docs/architecture-manual.md` 是“历史演进 + 当前补章”的混合手册。第 11 节及之后的
用户脚本、截图和 Automation 2.0 补章按现行实现维护；较早章节保留项目演进背景，
若与模块文档冲突，以 `docs/modules/` 为准。

## 历史记录

以下目录或文件用于保存当时的决策、实验数据和实施顺序，不是当前 API 或待办清单：

- `docs/superpowers/specs/`、`docs/superpowers/plans/`：带日期的设计与实施快照。
- `docs/automation-v2/adr/`、`phases/`、架构审计和验证日志：Automation 2.0
  切换过程的证据；旧 `Step/Runtime/Driver`、`.baoauto` v1/v2 路径已删除。
- `docs/FINAL_REGRESSION.md`：1.1.1 发布时的回归快照。
- `docs/高优先级处理事项.md`、`docs/repair-and-improvement-plan.md`、
  `docs/userscript-platform-plan.md`、`docs/userscript-runtime-demo-results.md`、
  `docs/lessons-learned.md`：已完成整改或早期经验记录。
- benchmark、POC 与 research 文档：结论只对文中注明的语料、版本和机器成立。

历史正文中出现已删除的文件名、旧测试数量或当时计划使用的依赖版本，属于可追溯证据，
不应据此恢复旧架构。会被读者直接复制的命令仍应改为当前可运行命令，或明确标成历史命令。

## 2026-09-09 复核结果

- 已将自动化 M0–M5 文档中的废弃 probe 名称映射到现有脚本。
- 已校正 BrowserView、用户脚本主世界桥、页面助手截图行为、测试分层和 Scale 状态。
- 已将密码模块文档更新为 v2 无主密码模型；Windows DPAPI 已接入，Linux/macOS
  keyring 与查看门禁仍在计划中，`password:reveal` 当前拒绝未授权调用。
- 已去除现行回归说明中的易失测试数量，避免新增测试后文档立刻失真。
- 已把已完成或已被 Automation 2.0 取代的设计标记为“历史记录/已实现/已取代”。

## 维护规则

1. 新增或删除 npm 脚本时，同步检查文档中的 `npm run ...`。
2. 现行文档不固定写测试文件数、用例数和本机耗时；这些数据只写入带日期的验证记录。
3. 历史设计不重写成当前架构，只更新状态、失效命令和指向现行文档的说明。
4. 版本发布时至少复核 `docs/modules/`、`docs/PACKAGE.md`、用户指南、实验平台说明和
   `RELEASE_NOTES.md`。
