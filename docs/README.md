# BaoFlashBrowser 文档索引

> 当前产品版本：1.1.2。最近核对日期：2026-08-29。

本文用于区分“描述当前实现的文档”和“保留决策过程的历史记录”。遇到冲突时，以当前源码、`package.json`、CI 工作流和 `AGENTS.md` 为准。

## 当前文档

| 主题 | 文档 | 用途 |
| --- | --- | --- |
| 项目入口 | [`../README.md`](../README.md)、[`../README_EN.md`](../README_EN.md) | 功能、平台支持、源码运行与下载 |
| 发行说明 | [`../RELEASE_NOTES.md`](../RELEASE_NOTES.md) | 当前正式版内容、安装包大小与 SHA-256 |
| 自动化零基础入门 | [`automation-blockly-beginner-guide.md`](automation-blockly-beginner-guide.md) | 面向完全不会编程的用户，逐块解释全部积木、游戏画面特征串、两套坐标和示例 |
| 自动化使用 | [`automation-user-guide.md`](automation-user-guide.md) | 工作台、积木/JSON、素材、游戏画面定位、悬浮助手与脚本包 |
| 用户脚本使用 | [`userscript-user-guide.md`](userscript-user-guide.md) | 安装、管理和常见问题 |
| 用户脚本开发 | [`userscript-developer-guide.md`](userscript-developer-guide.md) | 运行时、GM API、安全边界与测试 |
| 模块设计 | [`modules/00-overview.md`](modules/00-overview.md) | 当前源码模块入口；各模块文档以此为目录 |
| 构建发布 | [`PACKAGE.md`](PACKAGE.md) | 平台构建、成品校验和发布门 |
| 回归基线 | [`FINAL_REGRESSION.md`](FINAL_REGRESSION.md) | 当前版本自动化与人工验证状态 |
| 实验平台 | [`experimental-platform-support.md`](experimental-platform-support.md) | 实验 Flash 与 macOS 的支持边界 |

## 历史与参考文档

以下文件保留设计过程、实施计划或特定版本的验证证据，不能替代当前源码说明：

- `superpowers/specs/`、`superpowers/plans/`：按日期冻结的设计与实施记录，其中的路径、依赖和待办状态可能已经变化。
- `userscript-platform-plan.md`、`userscript-runtime-demo-results.md`：用户脚本平台落地前后的阶段记录。
- `repair-and-improvement-plan.md`：2026-08-02 的分批改进计划。
- `architecture-manual.md`、`lessons-learned.md`：包含早期 Jotai、webpack、`session.ts` 等历史描述；查当前结构请优先使用 `modules/` 和源码。
- 仓库根目录 `blog.md`、`blog-technical.md`：对应 1.0.1 的发布文章，不是当前发行说明。
- `FINAL_REGRESSION.md` 是滚动的当前回归基线；需要保留旧版证据时应复制为带版本号的归档文件，而不是继续在旧标题下追加。

## 维护规则

1. 版本变化时同步检查 README、发行说明、打包手册、回归记录和模块总览。
2. 文档中的命令必须来自 `package.json`；CI 平台与触发条件必须来自 `.github/workflows/`。
3. `npm run build` 不会重建 `release/tests/` 冒烟构件；相关文档必须保留这一限制。
4. 历史设计不追改为当前实现，只在开头标明历史属性并从本索引分流。
5. 新增、移动源码后，检查模块文档中的文件路径和测试命令。
