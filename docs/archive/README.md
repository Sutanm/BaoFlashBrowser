# 文档归档（docs/archive）

> 本目录保存**已完成使命的历史文档**，不随版本维护。文件内容保持归档时的原样，
> 其中的路径、命令、测试数量、待办状态都可能已经过期。
>
> 查询当前事实请回到 [`../README.md`](../README.md)；需要追决策过程时再看这里。

## 为什么归档

2026-11-04 对 1.1.2 做了一次全量文档复核。发现的问题不是"文件太旧"，而是**语义失真**：
文档停在 2026-09-09 的基线，而 9 月下旬到 11 月初有三批功能（查看门禁、全局代理、
原生助手、全平台内置 OCR 等）没有进入现行文档；同时多份"当前规范"互相矛盾。
处理方式是：**旧版整份留档，现行文档按源码重写**，不做"在旧文上打补丁"。

## 目录结构

| 路径 | 内容 | 为什么不维护 |
| --- | --- | --- |
| `superpowers/specs/` | 24 份带日期的设计规格（SDD 工作产物） | 记录"当时打算怎么做"，不承诺与实现一致 |
| `superpowers/plans/` | 18 份实施计划与任务流水线 | 同上；任务状态早已推进 |
| `automation-v2/` | Automation 2.0 切换期的 ADR（0001–0010）、phases、架构审计、benchmark、验证日志 | 切换已完成；旧 `Step/Runtime/Driver` 与包格式 v1/v2 已删除 |
| `legacy/` | 早期手册与整改记录：`architecture-manual.md`、`lessons-learned.md`、`repair-and-improvement-plan.md`、`高优先级处理事项.md`、`userscript-platform-plan.md`、`userscript-runtime-demo-results.md`、`documentation-status.md`、`automation-blockly-beginner-guide.md` | 描述的是 1.0.x/1.x 时代（Jotai、webpack、`session.ts`、旧 Blockly 工作台）与当前结构不符 |
| `legacy/demos/` | 5 份版式草稿 HTML（侧边栏、布局、UI 重设计、自动化工作台、悬浮控件） | 设计过程稿，不是事实源 |
| `legacy/blog.md`、`legacy/blog-technical.md` | 1.0.1 发布文章 | 与 1.1.2 无关 |
| `releases/1.1.1-regression-baseline.md` | 1.1.1 的实际回归结果 | 被 [`../FINAL_REGRESSION.md`](../FINAL_REGRESSION.md) 的 1.1.2 基线取代 |
| `modules-v1/` | 被重写的模块文档旧版（00、01、02、03、04、05、06、07、08、09） | 每份的现行版本在 `docs/modules/` 同名位置 |

## 现行版本在哪

| 旧文档 | 现行文档 |
| --- | --- |
| `modules-v1/*.md` | [`docs/modules/`](../modules/00-overview.md) 同名文件 |
| `legacy/architecture-manual.md` | [`docs/architecture-overview.md`](../architecture-overview.md) |
| `legacy/automation-blockly-beginner-guide.md` | [`docs/automation-blockly-beginner-guide.md`](../automation-blockly-beginner-guide.md)（1.1.2 重写版） |
| `releases/1.1.1-regression-baseline.md` | [`docs/FINAL_REGRESSION.md`](../FINAL_REGRESSION.md) |
| `legacy/userscript-platform-plan.md` | [`docs/modules/04-userscripts.md`](../modules/04-userscripts.md) + [`docs/userscript-developer-guide.md`](../userscript-developer-guide.md) |
| `legacy/lessons-learned.md` | 雷区已分散到各模块文档的「雷区」章节与 `AGENTS.md` |
| `superpowers/specs/*screenshot*` | [`docs/modules/07-screenshots.md`](../modules/07-screenshots.md) |
| `automation-v2/*`（行为规则） | [`docs/modules/03-automation.md`](../modules/03-automation.md) |

## 使用约定

1. **不要**从归档文档里复制命令或路径到当前环境；它们可能指向已删除的文件。
2. 归档文档之间的相对链接大多已失效（目录层级改变），属预期。
3. 引用归档文档时必须标明"历史"属性，例如
   `docs/archive/superpowers/specs/2026-09-22-view-gate-design.md`（历史规格）。
4. 新增归档时按"来源目录"归入对应子目录，并在本页登记；不要新建平行目录。
5. 归档**不删除**：`git mv` 保留历史，便于追溯当时的判断依据。
