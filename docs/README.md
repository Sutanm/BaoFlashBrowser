# BaoFlashBrowser 文档索引

> 当前版本：**1.1.2**。全量复核日期：**2026-11-04**（按源码 + git 提交逐条核对）。
> 本文同时承担"文档索引"与"现行/历史边界"两个职责；原 `documentation-status.md` 已归档
> 到 [`archive/legacy/documentation-status.md`](archive/legacy/documentation-status.md)。

## 从哪里开始

1. 想了解整体结构 → [`architecture-overview.md`](architecture-overview.md)
2. 想找模块边界 → [`modules/00-overview.md`](modules/00-overview.md)
3. 只想跑起来 → 根目录 [`README.md`](../README.md) 的"源码运行"与
   [`PACKAGE.md`](PACKAGE.md)
4. 遇到具体故障 → 先看对应模块文档的「雷区」，再看「事故与诊断记录」

**优先级**：源码 > `package.json` / CI 工作流 > 模块文档 > 本索引。
文档与源码冲突时，以源码为准，并顺手修正文档。

## 架构与模块

| 主题 | 文档 | 说明 |
| --- | --- | --- |
| 架构总览 | [`architecture-overview.md`](architecture-overview.md) | 进程/目录分层、启动顺序、数据流、硬约束 |
| 模块总览 | [`modules/00-overview.md`](modules/00-overview.md) | 11 个模块的清单、共同原则、术语、主线演进 |
| 01 外壳与标签 | [`modules/01-browser-shell-tabs.md`](modules/01-browser-shell-tabs.md) | BrowserView 生命周期、视口、休眠、语言/主题挂载 |
| 02 Flash 与兼容 | [`modules/02-flash-engines-legacy-compat.md`](modules/02-flash-engines-legacy-compat.md) | PPAPI/Ruffle、特权 scheme、js-patch、GitHub 模块 |
| 03 视觉自动化 | [`modules/03-automation.md`](modules/03-automation.md) | Core/v3、Blockly、JS 沙箱、视觉与 OCR、页面助手 |
| 04 用户脚本 | [`modules/04-userscripts.md`](modules/04-userscripts.md) | run-at 调度、GM API、后台脚本、内置脚本 |
| 05 密码 | [`modules/05-password-vault.md`](modules/05-password-vault.md) | 捕获、保险库、密钥失败路径、查看门禁 |
| 06 下载 | [`modules/06-downloads.md`](modules/06-downloads.md) | aria2/Chromium、代理路由、权威源与持久化 |
| 07 截图 | [`modules/07-screenshots.md`](modules/07-screenshots.md) | 捕获决策、目录、调试 HTTP 口子 |
| 08 诊断 | [`modules/08-session-diagnostics.md`](modules/08-session-diagnostics.md) | 异常退出、诊断报告、内存监控 |
| 09 构建发布 | [`modules/09-build-release-test.md`](modules/09-build-release-test.md) | 命令、模块裁剪、OCR 打包、CI、测试分层 |
| 10 网络代理 | [`modules/10-network-proxy.md`](modules/10-network-proxy.md) | Electron 11 映射、连接检测、与下载/模块的关系 |
| 11 语言主题更新 | [`modules/11-i18n-theme-update.md`](modules/11-i18n-theme-update.md) | 双轨语言、nativeTheme、GitHub Release 检查 |

## 使用指南

| 主题 | 文档 |
| --- | --- |
| 自动化零基础 | [`automation-blockly-beginner-guide.md`](automation-blockly-beginner-guide.md) | 1.1.2 的 38 块积木、坐标、识别与第一个脚本 |
| 自动化使用 | [`automation-user-guide.md`](automation-user-guide.md) |
| `.baoauto` 脚本包请求规范 | [`baoauto-script-request-guide.md`](baoauto-script-request-guide.md) |
| 用户脚本使用 | [`userscript-user-guide.md`](userscript-user-guide.md) |
| 用户脚本开发 | [`userscript-developer-guide.md`](userscript-developer-guide.md) |
| 网络代理 | [`proxy-settings.md`](proxy-settings.md) |
| 实验平台边界 | [`experimental-platform-support.md`](experimental-platform-support.md) |

## 浏览器功能对照与规划

| 主题 | 文档 | 说明 |
| --- | --- | --- |
| Chrome 功能对照清单 | [`chrome-feature-parity.md`](chrome-feature-parity.md) | 1.1.2 现状、缺口、建议批次（含 1.1.3 候选）与待验证项 |
| 高版本内核 Flash 复核 | [`specs/2026-11-11-qax-chromium102-flash.md`](specs/2026-11-11-qax-chromium102-flash.md) | 奇安信 102 与 360 极速 X 132 的 PPAPI 实测、注册层恢复路径、单内核/外挂/双内核三条路线成本 |
| 138 单内核移植历程 | [`specs/2026-11-14-electron138-flash-port.md`](specs/2026-11-14-electron138-flash-port.md) | 自建 Electron 37 / Chromium 138 的完整历程：源码获取、四道注册门、Flash 加载实测、87→138 漂移修复、后续计划 |
| Flash 接入复现手册（AI 版） | [`specs/2026-11-14-flash-port-ai-runbook.md`](specs/2026-11-14-flash-port-ai-runbook.md) | 给另一个 AI/另一台机器的可执行 runbook：环境、源码、构建、四道注册门、87→138 移植补丁、错误字典、自检脚本 |
| 往上推进版本可行性 | [`specs/2026-11-15-forward-version-feasibility.md`](specs/2026-11-15-forward-version-feasibility.md) | 138→140/142/144/150 的实测评估：删除面、依赖漂移、legacy IPC 断崖、Blink 稳定性、工作量与决策建议（**§1.14.11 为 140 最终状态**） |
| **Chromium 140 复活手册（AI 版）** | [`specs/2026-11-17-chromium140-ppapi-revival-ai-guide.md`](specs/2026-11-17-chromium140-ppapi-revival-ai-guide.md) | 面向 AI 的 140 二次实现说明书：分阶段验收、逐文件清单、`Make` 顺序与 `FlushAck` 两个关键坑、25 条错误字典、验证 harness |
| Chromium 144 Spike 计划 | [`specs/2026-11-15-chromium144-spike-plan.md`](specs/2026-11-15-chromium144-spike-plan.md) | 15 个工作日、D10 止损的 144（Electron 40）移植执行计划：sccache 配置、vendor 清单、IPC 适配、逐日里程碑 |

## 对外分享

| 主题 | 文档 | 说明 |
| --- | --- | --- |
| 博客：高版本 Flash 不是不可能 | [`blog/2026-11-14-high-version-flash-is-possible.md`](blog/2026-11-14-high-version-flash-is-possible.md) | 面向社区的技术分享：Chromium 138 上跑通原生 PPAPI Flash 的结论、路径、能力边界与成本 |
| 博客：138 → 140 再推两个大版本 | [`blog/2026-11-17-chromium140-flash-revival.md`](blog/2026-11-17-chromium140-flash-revival.md) | 纪念向分享：Chromium 140 / Electron 38 出帧实录、两个"一行级"坑、版本时间炸弹经验与成本 |
## 构建、发布与验证

| 主题 | 文档 |
| --- | --- |
| 构建与发布 | [`PACKAGE.md`](PACKAGE.md) |
| 1.1.2 回归基线 | [`FINAL_REGRESSION.md`](FINAL_REGRESSION.md)（2026-11-04 实跑结果） |
| 发行说明与制品 | 根目录 [`RELEASE_NOTES.md`](../RELEASE_NOTES.md)、`release/SHA256SUMS-1.1.2.txt` |
| OCR 引擎对比 | [`reports/2026-11-02-tesseract-x86-comparison.md`](reports/2026-11-02-tesseract-x86-comparison.md) |
| **138/140 出帧代码保存方案** | [eports/2026-11-17-port-preservation-plan.md](reports/2026-11-17-port-preservation-plan.md) | 本地快照（分支+提交）/ 补丁归档 / 远程 fork / 冷备四方案对比与执行细节，含已完成留痕清单 |
| **140 缺陷定性实验** | [eports/2026-11-18-140-experiments.md](reports/2026-11-18-140-experiments.md) | 用 [ppexp] 探针实测：LSO/存档确认不可用、PPB_Flash 单例消息全无宿主、视频其实能播、Flash 会创建 3D 上下文 |
| **142 空载编译打通** | [reports/2026-11-20-142-build-bringup.md](reports/2026-11-20-142-build-bringup.md) | Chromium 142 / Electron 39 本机从源码编出并启动成功；含 7 项环境缺口清单、断网依赖同步方案、142 与 140 的上游差异实测 |

## 事故与诊断记录

这些是**复盘类记录**，按项目约定单独成文，不并入模块文档：

| 时间 | 文档 | 内容 |
| --- | --- | --- |
| 2026-09-20 | [`password-vault-failure-2026-09-20.md`](password-vault-failure-2026-09-20.md) | DPAPI 探测超时导致 wrap key 被销毁 |
| 2026-09-22 | [`password-capture-diagnosis-2026-09-22.md`](password-capture-diagnosis-2026-09-22.md) | 7k7k 捕获失灵的三处缺陷 |
| 2026-10-28 | [`password-switch-and-automation-timing-2026-10-28.md`](password-switch-and-automation-timing-2026-10-28.md) | 换账号无捕获、最小化点击时序 |
| 2026-10-28 | [`stability-baseline-2026-10-28.md`](stability-baseline-2026-10-28.md) | 当时的稳定性基线快照 |
| 2026-11-02 | [`search-layout-diagnosis-2026-11-02.md`](search-layout-diagnosis-2026-11-02.md) | 新标签搜索焦点布局 |

## 历史归档

`docs/archive/` 保存已完成使命的文档，**不随版本维护**，不要从这里复制命令或路径。
完整说明见 [`archive/README.md`](archive/README.md)。

| 子目录 | 内容 |
| --- | --- |
| `superpowers/specs`、`superpowers/plans` | 42 份带日期的设计与实施快照 |
| `automation-v2/` | Automation 2.0 的 ADR、phases、审计与 benchmark |
| `legacy/` | 早期架构手册、经验记录、整改计划、旧博客、文档状态说明 |
| `modules-v1/` | 被重写的模块文档旧版 |
| `releases/1.1.1-regression-baseline.md` | 1.1.1 回归快照 |

## 维护规则

1. **版本变化时**至少复核：本文、`FINAL_REGRESSION.md`、`PACKAGE.md`、`RELEASE_NOTES.md`、
   `modules/00-overview.md`、[`chrome-feature-parity.md`](chrome-feature-parity.md)。
2. 文档中的命令必须来自 `package.json`；CI 平台与触发条件必须来自 `.github/workflows/`。
   不允许凭记忆写命令。
3. 现行文档**不固定写测试数量、文件数和本机耗时**，这类数据只写入带日期的验证记录
   （如 `FINAL_REGRESSION.md`）。
4. 历史文档不追改成当前实现；只更新"它属于历史"的说明，并保证归档索引能找到它。
5. 新增、移动源码后，检查模块文档中的路径与测试命令；路径失效比文字过时更危险。
6. 同一事实只留一个权威出处：模块文档讲实现，`AGENTS.md` 讲操作硬约束，
   `FINAL_REGRESSION.md` 讲某次实跑结果，三者不要互相抄。
