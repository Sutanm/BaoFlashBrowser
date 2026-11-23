# 文档地图与单一事实源

2026-11-23 · 收敛说明。本文只回答三件事：**哪份算数、冲突在哪、新文档怎么加**。它不修改任何已定结论，冲突一律登记而不擅自裁决。

## 1. 四类文档

| 类别 | 位置 | 性质 | 修改规则 |
| --- | --- | --- | --- |
| **现行合同** | [`2026-11-22-bfb-next-architecture.md`](discussions/2026-11-22-bfb-next-architecture.md) | 产品边界与工程合同 | 改动须在提交信息注明，并同步本页冲突登记 |
| **现行记录** | [`2026-11-21-bfb-next-architecture.md`](discussions/2026-11-21-bfb-next-architecture.md) §F、[`kernel/`](kernel/README.md)、[`kickoff/`](kickoff/README.md) | 已裁决的详细条款 | 追加式；结论回填 |
| **过程存档** | 同一份 11-21 讨论稿的其余部分、[技术栈讨论](discussions/2026-11-21-bfb-next-tech-stack.md)、[架构审计](discussions/2026-11-22-bfb-next-architecture-audit.md) | 决策过程与依据 | 只读；以标注的权威文档为准 |
| **依据 / 证据** | [`specs/`](specs)、[`reports/`](reports)、[`evidence/`](evidence)、[`design/`](design)、[`blog/`](blog) | 技术评估与实测输出 | 只增不改；修正写新报告或追加修正节 |

## 2. 单一事实源（SSOT）

| 主题 | 权威文档 | 状态 | 备注 |
| --- | --- | --- | --- |
| 产品边界与工程合同 | [11-22 提案 §1–§6](discussions/2026-11-22-bfb-next-architecture.md) | **现行** | §1 与 F9 冲突 → C1 |
| 交付顺序与阶段验收 | [11-22 提案 §6](discussions/2026-11-22-bfb-next-architecture.md#6-交付顺序和验收) + [`kickoff/`](kickoff/README.md) | **现行** | M0 已通过、M1 已验收；M2/M3 为占位 |
| Agent 架构 F0–F9 | [11-21 讨论稿 §F](discussions/2026-11-21-bfb-next-architecture.md) | **现行记录** | F8 待审计；F9 冻结至 M3 |
| 反需求与放权边界 | [11-23 边界文档](discussions/2026-11-23-bfb-next-agent-boundary.md) | 讨论记录（未审计） | 拟并入 **F10** |
| 内核版本与补丁 | [`kernel/README.md`](kernel/README.md) + §F7 | **现行** | 只登记已验证补丁 |
| 版本可行性 138 → 150 | [`specs/2026-11-15-forward-version-feasibility.md`](specs/2026-11-15-forward-version-feasibility.md) §1.7 | 依据 | 结论未变（144+ 阻断） |
| 技术栈 | [ADR-0002](adr/0002-next-stack-baseline.md) + [ADR-0003](adr/0003-kernel-baseline-e39-142.md) + 技术栈讨论稿 | **现行** | ADR-0002 §2 已由 ADR-0003 推翻 |
| 实测结果 | [`reports/`](reports) + [`evidence/`](evidence) | 证据 | 只增不改 |
| 文档规则 | 本文 | **现行** | — |

## 3. 冲突登记

冲突只登记、不在此页裁决；处置时机写在条目里。

| # | 冲突 | 当前口径 | 处置时机 |
| --- | --- | --- | --- |
| **C1** | 定位：提案 §1「从空白构建的 Flash 浏览器」 vs [F9](discussions/2026-11-21-bfb-next-architecture.md)「通用浏览器 + 自动化增强」 | **§1 有效**；F9 明示冻结至 M3 且不改 §1 | M3 立项（F9 第九节第 1 问） |
| **C2** | Agent 边界：提案 §5（独立 profile、只读观察、三项独立安全评审） vs §F 区（默认 shared profile、四层工具面、三级权限、五道资源闸） | **已处置（2026-11-23 分层）**：§5 = 对外承诺，§F = 实现合同；口径不一致时各自约束；§F 中【待审计】【冻结至 M3】不得对外表述 | 完成（提案 §5 末段 + F 区分层标注） |
| **C3** | SDK：F5「首个 adapter 走 OpenAI-compatible 协议、不绑 SDK」 vs [F8](discussions/2026-11-21-bfb-next-architecture.md) 候选 `ai` | F5 有效；F8 为待审计提案（建议并存对比） | F8 审计 |
| **C4** | 工具面层数：F0′ 四层 vs F9 第五层（浏览器/外壳层） | 四层有效；第五层为草案 | M3 |
| **C5** | 通用最小集：F9 第七节「P0 缺件」 vs 提案 §6 的 M2（已含书签/历史/会话/下载） | **已处置（2026-11-23）**：F9 第七节已加对齐说明；重叠项归提案 §6，本节只留差异项（标签组/搜索、设置页细化） | 完成 |
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
3. Agent 区编号从 **F10** 起；ADR 三位数递增。
4. 任何「推翻既有结论」的改动：新增文档 + 在旧文档头部标注，**不删旧文**。
5. 设计稿与截图进 `design/`、`evidence/`，Markdown 内用相对路径引用。

## 6. 文档层待办

- [x] **C2 分层**（2026-11-23）：提案 §5 末段 + F 区头部标注，确立「§5 = 对外承诺 / §F = 实现合同」。
- [x] **C5 对齐**（2026-11-23）：F9 第七节加与提案 §6 M2 的对齐说明，重叠项归 M2。
- [x] **C7 收口**（2026-11-23）：新增 [ADR-0003](adr/0003-kernel-baseline-e39-142.md)。
- [x] `kickoff/` M0/M2/M3 占位文件（2026-11-23）：已建三份占位，README 表改为带状态与链接；M2/M3 明确「验收前不得写已通过」。
- [x] 根 `README.md`「从这里开始」加一行指向本页（2026-11-23）。

**结论类未决项不在本页处理**，见第 3 节 C1（定位）、C3（SDK 绑定）、C4（工具面层数）——三者都等到 M3 或对应审计。

## 7. 文件索引

| 文件 | 用途 |
| --- | --- |
| [`discussions/2026-11-22-bfb-next-architecture.md`](discussions/2026-11-22-bfb-next-architecture.md) | **现行提案**：产品边界、内核与发布、外壳/标签/隔离、数据模块、自动化与 Agent、交付顺序 |
| [`discussions/2026-11-22-bfb-next-architecture-audit.md`](discussions/2026-11-22-bfb-next-architecture-audit.md) | 对 11-21 讨论稿 A–F 议题的审计判定 |
| [`discussions/2026-11-21-bfb-next-architecture.md`](discussions/2026-11-21-bfb-next-architecture.md) | 议题讨论与裁决存档；**§F0′–§F9 为 Agent 区现行记录** |
| [`discussions/2026-11-21-bfb-next-tech-stack.md`](discussions/2026-11-21-bfb-next-tech-stack.md) | 第一轮技术栈选型讨论（§7.5/§7.6 已定） |
| [`discussions/2026-11-23-bfb-next-agent-boundary.md`](discussions/2026-11-23-bfb-next-agent-boundary.md) | 反需求与放权边界（未审计，拟并入 F10） |
| [`adr/0001-next-branch-strategy.md`](adr/0001-next-branch-strategy.md) | 独立分支策略（已接受） |
| [`adr/0002-next-stack-baseline.md`](adr/0002-next-stack-baseline.md) | 技术栈基线（部分收口，§2 已被推翻） |
| [`adr/0003-kernel-baseline-e39-142.md`](adr/0003-kernel-baseline-e39-142.md) | 内核基线更正为 E39 / Chromium 142（推翻 ADR-0002 §2） |
| [`kernel/README.md`](kernel/README.md) | 已验证内核补丁登记（含构建标识与 SHA-256） |
| [`kickoff/README.md`](kickoff/README.md) · [`m1-browser-slice.md`](kickoff/m1-browser-slice.md) | 阶段归档索引与 M1 验收记录（M0 说明、M2/M3 占位） |
| [`specs/`](specs)（5 篇） | Flash 移植、AI 复现手册、版本可行性、模块影响评估 |
| [`reports/`](reports)（6 篇） | 140 实验、142 构建与运行、M1 增量、M2 设置页与存储 |
| [`evidence/`](evidence)（9 件） | 4399/摩尔庄园 双引擎对照图、crossdomain 调查、帧自检结果 |
| [`design/`](design)（HTML + renders） | 设置页与引擎面板设计稿 |
| [`blog/assets/`](blog/assets) | 对外文章配图 |

---

*本页是文档规则页，不是结论页。结论以第 2 节的权威文档为准；发现新的冲突或重复，追加到第 3 节。*
