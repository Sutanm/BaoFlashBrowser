# 文档地图与单一事实源

2026-11-24 · 收敛说明。本文只回答三件事：**哪份算数、冲突在哪、新文档怎么加**。

**当前项目状态：M0 已通过，M1 已验收，M2 实施中但尚未整体验收，M3 尚未立项。**

## 1. 四类文档

| 类别 | 位置 | 性质 | 修改规则 |
| --- | --- | --- | --- |
| **现行合同** | [`agent-automation-architecture.md`](agent-automation-architecture.md)、[`2026-11-22-bfb-next-architecture.md`](discussions/2026-11-22-bfb-next-architecture.md) 未被替代部分 | Agent/自动化专项 SSOT + 浏览器工程合同 | 专项文档优先；改动须同步本页 |
| **现行记录** | [`kernel/`](kernel/README.md)、[`kickoff/`](kickoff/README.md) | 已裁决的详细条款与验收记录 | 追加式；结论回填 |
| **过程存档** | 同一份 11-21 讨论稿的其余部分、[技术栈讨论](discussions/2026-11-21-bfb-next-tech-stack.md)、[架构审计](discussions/2026-11-22-bfb-next-architecture-audit.md)、[Agent 架构审计与裁决](discussions/2026-11-25-agent-architecture-audit.md) | 决策过程与依据；审计记录可标注「已裁决并回填」 | 只读；以标注的权威文档为准 |
| **依据 / 证据** | [`specs/`](specs)、[`reports/`](reports)、[`evidence/`](evidence)、[`design/`](design)、[`blog/`](blog) | 技术评估与实测输出 | 只增不改；修正写新报告或追加修正节 |

## 2. 单一事实源（SSOT）

| 主题 | 权威文档 | 状态 | 备注 |
| --- | --- | --- | --- |
| 产品定位、Agent 与自动化 | [Agent 与自动化架构](agent-automation-architecture.md) | **现行权威** | 覆盖旧 §1、§5、F0–F10 |
| 浏览器工程合同 | [11-22 提案](discussions/2026-11-22-bfb-next-architecture.md) | **部分现行** | §1、§5 及冲突的交付顺序已被专项文档替代 |
| 交付顺序与阶段验收 | [Agent/自动化架构 §18](agent-automation-architecture.md#18-交付顺序) + [`kickoff/`](kickoff/README.md) | **现行** | M0 已通过、M1 已验收、M2 实施中未验收、M3 未立项 |
| 旧 Agent 架构 F0–F10 | [11-21 讨论稿 §F](discussions/2026-11-21-bfb-next-architecture.md) | **已归档** | 仅作历史依据，不再实施 |
| 反需求与放权边界 | [11-23 边界文档](discussions/2026-11-23-bfb-next-agent-boundary.md) | **已吸收的讨论记录** | 有效原则已并入新 SSOT §15/§20 |
| 内核版本与补丁 | [`kernel/README.md`](kernel/README.md) + §F7 | **现行** | 只登记已验证补丁 |
| 版本可行性 138 → 150 | [`specs/2026-11-15-forward-version-feasibility.md`](specs/2026-11-15-forward-version-feasibility.md) §1.7 | 依据 | 结论未变（144+ 阻断） |
| 技术栈 | [ADR-0002](adr/0002-next-stack-baseline.md) + [ADR-0003](adr/0003-kernel-baseline-e39-142.md) + 技术栈讨论稿 | **现行** | ADR-0002 §2 已由 ADR-0003 推翻 |
| 实测结果 | [`reports/`](reports) + [`evidence/`](evidence) | 证据 | 只增不改 |
| 文档规则 | 本文 | **现行** | — |

## 3. 冲突登记

冲突只登记、不在此页裁决；处置时机写在条目里。

| # | 冲突 | 当前口径 | 处置时机 |
| --- | --- | --- | --- |
| **C1** | 定位：Flash 浏览器 vs 通用 Agent-native 浏览器 | **已处置（2026-11-24）**：通用 Agent-native 浏览器 + 自动化增强；Flash 为差异能力 | 新 SSOT §2 |
| **C2** | Agent 边界：旧 §5 vs 旧 §F | **已处置（2026-11-24）**：两者均被新 SSOT 替代 | 新 SSOT §13–§15 |
| **C3** | SDK：裸 OpenAI-compatible 协议 vs `ai` SDK | Adapter 边界已定，具体首个实现仍按依赖审计裁决 | 实现 A5 前审计 |
| **C4** | 工具面四层 vs 第五层 | **已处置（2026-11-24）**：改为 Browser/Shell、Page、Perception、Automation、Workflow 五层能力面 | 新 SSOT §4 |
| **C5** | 旧 F9 通用最小集 vs M2 范围 | **已处置（2026-11-24）**：旧 F9 已归档；M2 范围以 kickoff M2 记录为准，A1 作为浏览器底座纳入 M2 | 新 SSOT §18 + M2 记录 |
| **C6** | 编号：边界文档曾提「F9 反需求清单」，但 F9 已被定位提案占用 | 反需求清单顺延 **F10**（F9 尾注已写明） | 已在 F9 注明，无需再裁决 |
| **C7** | ADR-0002 §2 内核基线（E37/138）已被实测推翻为 E39/142 | **已处置（2026-11-23）**：新增 [ADR-0003](adr/0003-kernel-baseline-e39-142.md) 收口；ADR-0002 正文按「不改旧文」原则保留 | 完成 |

## 4. 状态词表

| 标记 | 含义 | 生效方式 |
| --- | --- | --- |
| 【已定】 | 已裁决，可据以实施 | 需新裁决才能改 |
| 【待审计】 | 提案已收、审计未过 | 审计后改 |
| 【冻结至 M3】 | 明确推迟 | M3 立项时处理 |
| 【待决】/【待定】 | 未裁决 | 进讨论 |
| 【事实】 | 有代码或实测依据 | 保留 |
| 【推断】 | AI 观点 | 需实测替换 |
| 【待核】 | 未核实 | 补证据 |

ADR 状态：**已接受** / **部分收口** / **提案**；被推翻时新增 ADR，不改旧正文。

## 5. 新增与编号规则

1. 新议题先进 `discussions/`，文件名用 `YYYY-MM-DD-` 前缀。
2. 裁决后回填权威文档；讨论稿只留过程，不再追加结论。
3. Agent/自动化新结论直接维护 [`agent-automation-architecture.md`](agent-automation-architecture.md)，不再向旧 F 区追加；ADR 三位数递增。
4. 任何「推翻既有结论」的改动：新增文档 + 在旧文档头部标注，**不删旧文**。
5. 设计稿与截图进 `design/`、`evidence/`，Markdown 内用相对路径引用。

## 6. 文档层待办

- [x] **Agent/自动化 SSOT 收敛**（2026-11-24）：新增专项权威文档，归档旧 §1/§5/F0–F10，并纠正“未实现能力已经就绪”的前提。
- [x] **C2 旧分层**（2026-11-23，已被 2026-11-24 新 SSOT 取代）：曾确立“§5 = 对外承诺 / §F = 实现合同”。
- [x] **C5 对齐**（2026-11-23）：F9 第七节加与提案 §6 M2 的对齐说明，重叠项归 M2。
- [x] **C7 收口**（2026-11-23）：新增 [ADR-0003](adr/0003-kernel-baseline-e39-142.md)。
- [x] **阶段体系同步**（2026-11-24）：M0–M3 保持唯一里程碑；M2 改为实施中，A0–A6 改为跨阶段工作流并映射到 M2/M3。
- [x] 根 `README.md`「从这里开始」加一行指向本页（2026-11-23）。

**结论类未决项不在本页处理。** 当前只剩 C3 的具体 Adapter 依赖选择，需在实现 A5 前完成依赖与许可审计。

## 7. 文件索引

| 文件 | 用途 |
| --- | --- |
| [`agent-automation-architecture.md`](agent-automation-architecture.md) | **现行权威**：产品定位、Agent、自动化、CDP、感知、身份、权限与交付顺序 |
| [`discussions/2026-11-22-bfb-next-architecture.md`](discussions/2026-11-22-bfb-next-architecture.md) | **部分现行**：内核与发布、外壳/标签/隔离、数据模块；§1/§5 已归档 |
| [`discussions/2026-11-22-bfb-next-architecture-audit.md`](discussions/2026-11-22-bfb-next-architecture-audit.md) | 对 11-21 讨论稿 A–F 议题的审计判定 |
| [`discussions/2026-11-21-bfb-next-architecture.md`](discussions/2026-11-21-bfb-next-architecture.md) | 议题讨论与裁决存档；§F0–§F10 已归档 |
| [`discussions/2026-11-24-agent-automation-design-clarification.md`](discussions/2026-11-24-agent-automation-design-clarification.md) | 新 Agent/自动化架构的讨论与设计依据 |
| [`discussions/2026-11-24-agent-browser-community-research.md`](discussions/2026-11-24-agent-browser-community-research.md) | 社区项目与 CDP/Page Map 参考调研 |
| [`discussions/2026-11-25-agent-architecture-audit.md`](discussions/2026-11-25-agent-architecture-audit.md) | 对 Agent/自动化 SSOT 的审计（**已裁决并回填**）：结果来源封装、短期/持久化目标、租约 holder、CDP 路由边界与 A1 合同测试；「Agent 不立项」分支关闭 |
| [`discussions/2026-11-24-new-tab-page-alignment.md`](discussions/2026-11-24-new-tab-page-alignment.md) | 新标签页对齐 Chromium：142 源码依据、差距清单、行为合同与 P0/P1 方案（**已交付**，见[报告](reports/2026-11-24-newtab-alignment.md)） |
| [`discussions/2026-11-21-bfb-next-tech-stack.md`](discussions/2026-11-21-bfb-next-tech-stack.md) | 第一轮技术栈选型讨论（§7.5/§7.6 已定） |
| [`discussions/2026-11-23-bfb-next-agent-boundary.md`](discussions/2026-11-23-bfb-next-agent-boundary.md) | 已吸收的反需求与放权边界历史记录；现行结论见新 SSOT §15/§20 |
| [`adr/0001-next-branch-strategy.md`](adr/0001-next-branch-strategy.md) | 独立分支策略（已接受） |
| [`adr/0002-next-stack-baseline.md`](adr/0002-next-stack-baseline.md) | 技术栈基线（部分收口，§2 已被推翻） |
| [`adr/0003-kernel-baseline-e39-142.md`](adr/0003-kernel-baseline-e39-142.md) | 内核基线更正为 E39 / Chromium 142（推翻 ADR-0002 §2） |
| [`kernel/README.md`](kernel/README.md) | 已验证内核补丁登记（含构建标识与 SHA-256） |
| [`kickoff/README.md`](kickoff/README.md) · [`m2-beta.md`](kickoff/m2-beta.md) | 阶段索引与当前 M2 实施/验收记录 |
| [`specs/`](specs)（5 篇） | Flash 移植、AI 复现手册、版本可行性、模块影响评估 |
| [`reports/`](reports)（16 篇） | 140 实验、142 构建与运行、M1 增量、M2 设置/叠加层/插件发现/标签休眠/新标签页/活动租约/会话恢复/新窗口形态等交付证据 |
| [`evidence/`](evidence)（9 件） | 4399/摩尔庄园 双引擎对照图、crossdomain 调查、帧自检结果 |
| [`design/`](design)（HTML + renders） | 设置页与引擎面板设计稿 |
| [`blog/assets/`](blog/assets) | 对外文章配图 |

---

*本页是文档规则页，不是结论页。结论以第 2 节的权威文档为准；发现新的冲突或重复，追加到第 3 节。*
