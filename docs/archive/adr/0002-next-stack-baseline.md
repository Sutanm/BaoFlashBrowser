# ADR 0002：BaoFlashBrowser Next 技术栈评估（提案）

> **已归档（2026-11-23）**：本文是 2026-11-15 的提案快照，**不再是现行依据**。
> 其中两处已被实测推翻：
> - §2 内核基线推荐的 **E37 / Chromium 138** → 实际定为 **Electron 39（v39.8.10）/
>   Chromium 142.0.7444.265**（142 上原生 PPAPI 已出帧）；
> - §3 的 UI 框架「待定」 → 定为 **Vue 3 + Pinia**。
>
> 权威版与后续更新在 **`next` 分支**的同名文件（`main` 的 [`../../adr/0002-next-stack-baseline.md`](../../adr/0002-next-stack-baseline.md)
> 只保留指路）。版本线口径见 [`../../version-lines.md`](../../version-lines.md)。
> 正文保持 2026-11-15 原样，只修正了指向 0001 的相对链接。

- 状态：**提案 / 待决策**（2026-11-15）
- 关联：[`0001-next-branch-strategy.md`](../../adr/0001-next-branch-strategy.md)
- 原则：**全部重新评估**；87 的实现只作为需求与踩坑参考，不作为架构约束。

---

## 1. 评估维度

| 维度 | 权重 | 说明 |
| --- | --- | --- |
| Flash 能力 | ★★★★★ | 原生 PPAPI 可用性是 Next 存在的前提 |
| 内核可持续性 | ★★★★ | 能否从当前基线平滑上探 1–2 个版本 |
| 应用层迁移成本 | ★★★★ | 从空白开始，越简单越好 |
| 安全与更新 | ★★★ | 内核版本、ASAR 完整性、签名/更新通道 |
| 生态与工具链 | ★★★ | 构建、打包、调试、测试的成熟度 |
| 团队熟悉度 | ★★★ | 现有 React/TS/Electron 经验可复用性 |

---

## 2. 内核基线（关键决策）

### 候选

| 选项 | Chromium | 原生 PPAPI | 上探空间 | 内核工作 | 结论 |
| --- | --- | --- | --- | --- | --- |
| A. E37 / 138 | 138 | ✅ 已验证出帧 | 可上探 E39 | 0（已完成） | **推荐基线** |
| B. E39 / 142 | 142 | ❌ 需 vendor | 天花板 | +2–4 周（`ChannelHandle` 等） | 可选二期 |
| C. E38 / 140 | 140 | ❌ 需 vendor | 可到 E39 | +1–2 周 | 跳过（相对 E37 无净收益） |
| D. E40 / 144+ | 144+ | ❌ 需 vendor + IPC 复活 | — | 2–3 个月+ | 排除（实测阻断） |

### 建议

- **Next 以 E37 / 138 为基线**：唯一"原生 PPAPI + 已验证"的版本，且 E37 之后 Flash 支持都要靠 vendor；
- 在架构上预留**内核版本抽象层**（进程内插件宿主、插件注册、渲染接入点隔离），让未来切 E39 只需替换"内核适配层"而不是全量重写；
- E39 作为"二期可选"：若 Next 需要 ASAR 完整性/更新 Web 特性，再投入 2–4 周。

---

## 3. 应用栈选型（全部重新决定）

| 层 | 87 现状 | Next 候选 | 建议 | 理由/待办 |
| --- | --- | --- | --- | --- |
| 语言 | TypeScript | TypeScript | ✅ 沿用 | 生态成熟，团队熟悉 |
| UI 框架 | React 18 | React 19 / 或 Vue / Svelte | **待定** | React 19 与 87 线生态一致；若追求更小包体可评估 Svelte |
| 构建（主进程） | esbuild | esbuild / tsup / rspack | ✅ esbuild（主进程）+ 视需要加 tsup 做类型产物 | 简单、快 |
| 构建（渲染层） | Vite | Vite 6/7 | ✅ 沿用 | 与 React 生态匹配 |
| 状态管理 | Zustand + Dexie | Zustand + Dexie / SQLite | **待定** | 87 用 IndexedDB 镜像曾出过一致性问题；Next 可考虑主进程权威 + SQLite |
| 进程模型 | BrowserView（已弃用） | **WebContentsView** | ✅ **必须** | E30 起 BrowserView 不再推荐；Next 直接按新模型设计 |
| IPC | ipcMain/ipcRenderer + zod | 同上 / 或 mojo 风格通道 | ✅ zod 校验保留 | 87 的"sendSync 造成渲染层卡死"教训要吸收 |
| 预加载/隔离 | contextIsolation + preload | 同上，默认更严（sandbox: true） | ✅ 收紧 | 87 因 Flash 需要 `sandbox:false`，Next 只在 Flash 视图放开 |
| Flash 引擎 | PPAPI + Ruffle | 原生 PPAPI（E37）+ Ruffle 回退 | ✅ 双引擎但都跑在新栈 | 与 87 的差异：不再需要 87 的 polyfill/私有 scheme |
| 用户脚本 | 自研 GM API | 重新设计（GM4 兼容？） | **待定** | 先定义需求，再定 API 面 |
| 密码库 | 自研 + DPAPI | 重新评估（OS 凭据/DPAPI/Argon2） | **待定** | 87 的"失败路径不得销毁密钥"教训写进设计 |
| 下载 | aria2 + Chromium | 同上 / 原生 Chromium 下载 | **待定** | 取决于是否需要多线程/限速 |
| 扩展 | 不支持（仅用户脚本） | 是否支持 MV3 扩展？ | **待定** | 影响架构复杂度，先定为非目标 |
| 打包 | electron-builder | electron-builder / Electron Forge | ✅ electron-builder（E37+ 需新版） | 需验证 E37+ 与 ASAR 完整性 |
| 更新 | 仅提示 | 是否做自动更新（Squirrel/electron-updater） | **待定** | 87 明确"只提示不自动装"，Next 可重新决定 |
| 测试 | Vitest + Playwright + 自研 probe | 同上 + 进程级 smoke | ✅ 沿用思路 | probe 机制值得保留（重写） |

---

## 4. 从 87 继承的"教训"（只继承结论，不继承代码）

1. **Chromium 87 的 polyfill/私有 scheme 方案不要带过来**：新内核已支持标准能力，87 的 workaround 会变成技术债；
2. **主进程是权威**：87 曾因渲染层 IndexedDB 镜像 + 实时查询形成回环，Next 只做单向数据流；
3. **Flash 视图与普通视图分离**：87 因 Flash 需要关闭 sandbox，Next 用"按视图类型配置"的方式隔离；
4. **密钥失败路径不可销毁数据**：写进 Next 的密码库设计约束；
5. **调试探针机制**（probe）值得重建：比一次性脚本更可维护。

---

## 5. 首批要回答的问题（阻塞脚手架）

| # | 问题 | 影响 |
| --- | --- | --- |
| Q1 | Next 内核基线确认 E37/138？ | 决定构建产物与内核仓库 |
| Q2 | Next 首发功能集：Flash + 标签 + 下载（最小） / 还是要带用户脚本+密码库？ | 决定模块划分与工期 |
| Q3 | UI 框架：React（沿用经验）还是尝试更轻的方案？ | 决定渲染层脚手架 |
| Q4 | 是否需要支持 MV3 扩展？ | 架构级决策 |
| Q5 | Next 是否要自动更新通道？ | 发布流程与签名 |
| Q6 | Next 的代码放在 `next` 分支根目录（与 87 共存）还是独立 worktree/仓库？ | 仓库结构 |

---

## 6. 建议的实施顺序（待 Q1–Q6 确认后细化）

1. 仓库与分支：`next` 分支 + 独立 worktree，空的 `app/` 脚手架；
2. 内核适配层：封装"启动带 PPAPI 的 Electron、注册 Flash 插件、创建 Flash 视图（WebContentsView）"三件事；
3. 最小产品：标签管理 + 地址栏 + Flash 视图渲染 + 测试页跑通；
4. 按需加模块：下载 → 用户脚本 → 密码库 → 截图/自动化；
5. 打包与更新：electron-builder 新版本 + 签名；ASAR 完整性（若上 E39）。
