# 测试基础设施优化设计

- 日期：2026-09-01
- 状态：已批准（设计评审通过，待写实现计划）
- 目标作者：测试工程 / 构建管线
- 相关测量：611 项 Vitest 全量墙钟 6.5s；import 累计 37.7s、transform 19.0s；三大重型文件占大头（vision-worker 5.1s、OCR sidecar 2.3s/2.1s）；typecheck 12.3s、lint 9.3s

## 背景与问题

现有测试规模已突破 600 项，且仍在增长。全量运行的成本结构不健康：

1. **所有测试一把梭**：104 个 Vitest 文件混在同一个 `vitest run` 里，OpenCV WASM 初始化（vision-worker 5.1s）、PaddleOCR sidecar 进程（2.3s/2.1s）与纯逻辑测试（绝大多数 <300ms）共用同一命令，日常开发被重型测试拖累。
2. **Playwright 装而不用**：`playwright ^1.62.1` 在 devDependencies 中、`test:e2e` 脚本已存在，但**没有任何 config、没有一条 spec**。项目最缺的端到端 UI 流程验证（标签操作、收藏、引擎切换、自动化工作台）全靠人工回归（见 `FINAL_REGRESSION.md` 的人工验证记录）。
3. **无覆盖率门槛**：`vitest run` 不产出 coverage，无法量化"新代码有没有被测试覆盖"，规范只能靠自觉。

## 范围界定

本次只做**测试基础设施**改造，明确不动：

- 不修改任何 `src/` 业务代码（含 OpenCV/视觉模块，当前处于修改阶段，一律绕开）。
- 不改变现有 611 项测试的**断言内容**与**测试语义**；只调整它们被哪个 project/命令运行。
- 不引入新测试框架；只激活已安装的 Playwright 与 Vitest 原生能力。
- Electron smoke（`tests/electron/*.cjs`）保持现状，不在本次范围（其运行机制是独立 Electron 进程，与 Playwright e2e 互补而非替代）。

## 现状（探索确认）

- `node_modules/playwright` 为 1.62.1 单包结构，自带 `test.js`/`test.mjs`/`test.d.ts` 入口，`playwright/test` 即 test runner，**无需**额外安装 `@playwright/test`。
- `require('playwright')._electron` 可用（typeof object），可驱动项目锁定的 Electron 11.5.0（`.cache/electron/win32-x64-11.5.0/electron.exe` 已存在，`electron` npm 版本 11.5.0）。
- `dist/main.js`、`dist/preload.js`、`dist/renderer/index.html` 均存在，e2e 可直接加载现有构建产物。
- Playwright 浏览器已下载（`%LOCALAPPDATA%\ms-playwright` 含 chromium-1228/1234 等）。
- Vitest 4.1.10 原生支持 `test.projects`（workspace 式多项目配置），每个 project 可独立配置 `include`/`exclude`、`environment`、`poolOptions`、`testTimeout`。
- `@vitest/coverage-v8` **未安装**（`node_modules/@vitest/` 下无 coverage 包），覆盖率需要新增 devDependency。
- 测试命名已有规范雏形：`.integration.test.ts` 后缀（`automation-paddle-sidecar-runtime.integration.test.ts`）、`describe.skipIf` 条件跳过（Paddle 可用性检测）。

## 方案概览

三层优化，全部通过配置文件 + 新增测试文件实现：

### 1. Vitest projects 分层（治本，解决全量拖累）

用 `vitest.config.ts` 的 `test.projects`（或独立 `vitest.workspace.ts`）拆成两个 project：

```text
project: unit          → tests/**/*.test.ts + tests/**/*.test.tsx（排除重型）
project: integration   → *.integration.test.ts + vision-worker + OCR sidecar
```

- 重型判定规则（白名单式，稳定可预期）：
  - `tests/automation-vision-worker.test.ts`（OpenCV WASM）
  - `tests/automation-bao1-ocr-sidecar.test.ts`（Paddle sidecar）
  - `tests/automation-paddle-sidecar-runtime.integration.test.ts`（Paddle 集成）
- `npm test` 默认只跑 unit project（预期墙钟 <2.5s）。
- `npm run test:integration` 显式跑重型（CI 单独 job，不再阻塞日常）。
- 两个 project 均可被 `--project unit` / `--project integration` 单独选择。

### 2. Playwright e2e 激活（补最大空白）

- 新建 `playwright.config.ts`：
  - 用 `_electron.launch` 驱动项目自身 Electron 11（`electron` 可执行文件 + `dist/main.js`），而非独立 Chromium。
  - 关键：**Electron 11 的 BrowserView 内容无法被 Playwright 的 DOM API 访问**（BrowserView 是原生视图，不在页 DOM 树中）。因此 e2e 的断言面是**浏览器外壳 UI**（React 渲染层：标签栏、地址栏、侧边栏、面板），不承诺操作 BrowserView 内部页面。
  - 每个测试前执行 `npm run build` 或直接依赖现有 `dist/`；CI 中在 build 之后运行。
- 新建 `tests/e2e/` 目录，首批 3-4 条高价值流程：
  1. **外壳冒烟**：应用启动 → 窗口出现 → 标签栏可见 → 新标签页渲染（`about:newtab` 的 React 内容可见）。
  2. **标签管理**：新建标签 → 数量增加 → 关闭标签 → 数量恢复。
  3. **收藏夹**：新标签页中收藏当前地址 → 侧边栏收藏面板出现该条目。
  4. **自动化工作台可达性**：通过 `about:automation` 打开工作台 → 脚本库/积木区渲染。
- 这些场景正是 `FINAL_REGRESSION.md` 里目前依赖人工回归的部分。

### 3. 覆盖率门槛（让规范可度量）

- 新增 devDependency `@vitest/coverage-v8`。
- 在 unit project 上启用 coverage，`npm run test:coverage` 输出报告。
- 阈值先设**宽松起步**（如 lines 60 / functions 60），随测试补充逐步上调；**不设硬性 CI 门禁**（避免覆盖率与"改业务代码"耦合，本次不动 src/）。
- coverage 排除 `src/main/modules/automation/vision-worker.cjs` 等当前修改中/难测文件，避免噪声。

## 关键决策记录

| 决策点 | 结论 |
|--------|------|
| 分层方式 | Vitest `test.projects`（单配置文件内多 project），不新建 workspace 文件 |
| 重型测试判定 | 白名单式三个文件，不用 glob 黑名单（防止新重型文件悄悄漏进 unit） |
| `npm test` 语义 | 改为只跑 unit project；integration 用 `test:integration` 显式 |
| e2e 驱动方式 | `_electron.launch` 驱动项目自带 Electron 11，非独立 Chromium |
| e2e 断言面 | 仅浏览器外壳 React UI，不承诺 BrowserView 内部（Electron 11 限制） |
| e2e 首批场景 | 外壳冒烟 / 标签管理 / 收藏夹 / 自动化工作台可达性 |
| 覆盖率包 | `@vitest/coverage-v8`（新增 devDependency，唯一新增依赖） |
| 覆盖率门槛 | 宽松起步（lines/functions 60），不加 CI 硬门禁，排除 vision-worker.cjs |
| 业务代码 | 全部不改；OpenCV/视觉模块一律绕开 |
| Electron smoke | 保持现状，与 Playwright e2e 互补 |

## 风险

- **BrowserView 不可断言**：Electron 11 的 BrowserView 内容对 Playwright DOM API 不可见。缓解：e2e 明确限定断言面为外壳 UI；BrowserView 内部行为继续由现有 Electron smoke（CDP/Ruffle）覆盖。若未来发现外壳 UI 也无法稳定驱动（如无边框窗口、隐藏 preload），对应场景降级为人工回归并记录。
- **覆盖率起步噪声**：现有 611 项测试主要覆盖逻辑层，renderer 组件覆盖率天然偏低，起步阈值可能触发红。缓解：阈值宽松 + coverage 排除清单 + 不加 CI 门禁。
- **Playwright 与 Electron 11 兼容**：Playwright 1.62 驱动 Electron 11 的 CDP 协议版本可能偏新。缓解：首批 e2e 用 `_electron.launch` 实测验证；失败则回退到"仅启动冒烟"（断言窗口创建）并记录。

## 测试

- 分层后的 `npm test`：unit project 全绿且墙钟 <2.5s（对比基线 6.5s）。
- `npm run test:integration`：三个重型文件全绿（语义不变）。
- `npm run test:e2e`：首批 4 条 e2e 通过（Windows 本地；CI 先行只在 ubuntu 启用，避免 Windows runner 兼容性风险）。
- 回归：`npm run check` 全程通过（i18n + typecheck + lint + 分层后的 test + build）。

## 实施顺序（写入 plan）

1. Task 1：Vitest projects 分层（配置 + 脚本，验证 unit <2.5s）
2. Task 2：Playwright e2e 激活（config + 首批 4 条，验证通过）
3. Task 3：覆盖率（装 coverage-v8 + 报告脚本 + 排除清单）
