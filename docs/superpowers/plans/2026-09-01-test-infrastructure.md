# 测试基础设施优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成三层测试基础设施优化：Vitest projects 分层（unit/integration）、Playwright e2e 激活（首批 4 条）、覆盖率报告脚本。全部通过配置与新增测试文件实现，**不修改任何 `src/` 业务代码**（含 OpenCV/视觉模块）。

**Architecture:** 单 `vitest.config.ts` 内 `test.projects` 双 project（unit/integration）；`playwright.config.ts` 用 `_electron.launch` 驱动项目自带 Electron 11；`@vitest/coverage-v8` 提供 coverage。npm 脚本新增 `test:integration`、`test:coverage`、`test:e2e`（已有）。

**Tech Stack:** vitest 4.1.10、playwright 1.62.1（自带 test runner + `_electron`）、@vitest/coverage-v8（新增）、Electron 11.5.0（锁定，e2e 目标）。

## Global Constraints

- **绝不修改 `src/` 下任何业务代码**；OpenCV/视觉相关模块（`vision-worker*`、`vision-service*`、`game-surface-detector*` 等）完全绕开。
- Electron 11.5.0 / Chromium 87 锁定，永不升级；e2e 必须用项目自带 Electron（`.cache/electron/win32-x64-11.5.0/electron.exe`），不得下载独立浏览器驱动 Electron。
- 现有 611 项测试的**断言内容与语义不变**，只调整运行分组。
- `npm run build` 不重建 `release/tests/` 产物；本计划不触碰 userscript/session smoke 相关源码，无 smoke 重建要求。
- vitest 4 的 projects 配置语法：`defineConfig({ test: { projects: [...] } })` 或顶层 `test.projects`；每 project 需 `name`、`test.include`/`test.exclude`、`test.environment`（默认 node，tsx 用 jsdom）。
- Playwright 1.62 单包结构，`require('playwright/test')` 即 runner；`require('playwright')._electron` 启动 Electron。
- e2e 断言面**仅限浏览器外壳 React UI**；Electron 11 BrowserView 内容对 Playwright DOM 不可见，不得编写依赖 BrowserView 内部 DOM 的断言。
- 每个任务完成后独立 commit，commit message 遵循仓库现有风格（`feat(test): ...` / `chore(test): ...`）。
- 本地验证命令：`npm test -- --run`（分层后只跑 unit）、`npm run test:integration`、`npx vitest run --project unit`、`npx playwright test`（在 dist 构建后）。

---

### Task 1: Vitest projects 分层（unit / integration）

**Files:**
- Modify: `vitest.config.ts`（`test.projects` 双 project + alias/plugin 保持）
- Modify: `package.json`（`test` 脚本语义、新增 `test:integration`）

**Interfaces:**
- Produces: `npm test` 只跑 unit project；`npm run test:integration` 跑重型三文件；`npx vitest run --project <name>` 可单跑。

- [ ] **Step 1: 修改 `vitest.config.ts` 增加 projects**

在现有 `defineConfig` 的 `test` 对象内新增 `projects`：

```ts
test: {
  projects: [
    {
      name: 'unit',
      test: {
        include: ['tests/**/*.{test,spec}.{ts,tsx}'],
        exclude: [
          'tests/automation-vision-worker.test.ts',
          'tests/automation-bao1-ocr-sidecar.test.ts',
          'tests/automation-paddle-sidecar-runtime.integration.test.ts',
        ],
      },
    },
    {
      name: 'integration',
      test: {
        include: [
          'tests/automation-vision-worker.test.ts',
          'tests/automation-bao1-ocr-sidecar.test.ts',
          'tests/automation-paddle-sidecar-runtime.integration.test.ts',
        ],
      },
    },
  ],
},
```

保留现有 `resolve.alias` 与 `user-js-as-text` plugin（两 project 共享）。注意：现有 `include` 在顶层 `test` 中，改为移到各 project 内（或保留顶层 + project 覆盖，二选一，保持语义一致）。jsdom 环境的 tsx 测试（automation-panel-v3.test.tsx、settings-panel.test.tsx 等）需在 unit project 内确认环境——检查它们当前如何获得 jsdom（可能依赖顶层 environment 或文件内注释），保持原样。

- [ ] **Step 2: 更新 `package.json` 脚本**

```json
"test": "vitest run --project unit",
"test:integration": "vitest run --project integration",
"test:watch": "vitest",
```

说明：`--project` 在 vitest 4 可用；`test:watch` 保留交互式全量（不强制 project）。若 `npm test` 现有调用方（CI `npm run check`）依赖全量语义，需在 CI 中补充 `test:integration`——见 Task 4 备注（CI 改动是否纳入本计划：**纳入 Task 4，最小化改动**）。

- [ ] **Step 3: 验证 unit project 全绿且墙钟 <2.5s**

Run: `npm test`
Expected: 全部 unit 测试通过（611 - 三个重型文件的用例数），墙钟 <2.5s。记录精确数字。

- [ ] **Step 4: 验证 integration project 全绿**

Run: `npm run test:integration`
Expected: 三个重型文件全部通过（vision-worker、bao1-ocr-sidecar、paddle-sidecar-runtime.integration）。

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts package.json
git commit -m "chore(test): vitest 分层 unit/integration，默认只跑 unit"
```

---

### Task 2: Playwright e2e 激活（config + 首批 4 条）

**Files:**
- Add: `playwright.config.ts`
- Add: `tests/e2e/app-shell.spec.ts`、`tests/e2e/tabs.spec.ts`、`tests/e2e/favorites.spec.ts`、`tests/e2e/automation-workbench.spec.ts`
- Modify: `package.json`（`test:e2e` 脚本确认/调整）

**Interfaces:**
- Produces: `npm run test:e2e` 可运行首批 4 条 e2e（需先构建 dist）。

- [ ] **Step 1: 新建 `playwright.config.ts`**

```ts
import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1, // Electron 单实例锁：必须串行
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
```

- [ ] **Step 2: 新建 e2e 公共驱动（`tests/e2e/_electron-app.ts`）**

封装 `_electron.launch`：指向项目 Electron 可执行文件 + `dist/main.js`。注意 Electron 11 的 `app.requestSingleInstanceLock` 与 `--no-sandbox`（Linux CI 需要）。提供 `launchApp()` / `closeApp(app)` 辅助。**不写进 spec 文件**（放共享 helper）。

关键实现要点：
```ts
import { _electron as electron } from 'playwright';
const electronPath = process.env.BAO_E2E_ELECTRON ?? require('electron'); // 指向 .cache 下 exe 或 npm electron
const app = await electron.launch({
  args: [path.join(__dirname, '..', '..', 'dist', 'main.js')],
  // Linux CI 需要 --no-sandbox；Windows 无需
});
const window = await app.firstWindow();
```

- [ ] **Step 3: 编写首批 4 条 e2e**

1. `app-shell.spec.ts`：启动 → `firstWindow()` 出现 → 标签栏/地址栏/侧边栏可见（外壳 UI 选择器，参考 TopBar/DrawerSidebar 的 class 名）。
2. `tabs.spec.ts`：记录标签数 → 触发新建（点击"+"或 Ctrl+T）→ 数量 +1 → 关闭 → 恢复。
3. `favorites.spec.ts`：在 newtab 页触发收藏 → 打开收藏面板 → 断言条目出现。
4. `automation-workbench.spec.ts`：`app.evaluate` 或地址栏导航到 `about:automation` → 断言工作台标题/脚本库渲染。

选择器来源：先读 `src/renderer/components/` 确认实际 class 名（如 `.topbar-tabbar`、`.drawer-*`、`#browserview-area` 等），写进 spec 时用真实类名；不得臆造。

- [ ] **Step 4: 构建 + 运行 e2e 验证**

Run: `npm run build`（确保 dist 新鲜）→ `npm run test:e2e`
Expected: 4 条 e2e 通过。若 Electron 11 与 Playwright 1.62 驱动不兼容（启动即失败），记录失败信息并在 spec 中回退方案（仅断言窗口出现），同时更新 spec 文档的风险段。

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts tests/e2e/ package.json
git commit -m "feat(test): 激活 Playwright e2e，覆盖外壳/标签/收藏/自动化工作台"
```

---

### Task 3: 覆盖率报告（@vitest/coverage-v8）

**Files:**
- Modify: `package.json`（新增 devDependency `@vitest/coverage-v8`、脚本 `test:coverage`）
- Modify: `vitest.config.ts`（unit project 启用 coverage + 排除清单）

**Interfaces:**
- Produces: `npm run test:coverage` 输出覆盖率报告（unit project 范围）。

- [ ] **Step 1: 安装依赖**

Run: `npm install -D @vitest/coverage-v8`
Expected: 安装成功，package.json devDependencies 新增条目。

- [ ] **Step 2: vitest.config.ts 启用 coverage（unit project）**

在 unit project 的 `test` 内新增：

```ts
coverage: {
  provider: 'v8',
  include: ['src/**/*.{ts,tsx}'],
  exclude: [
    'src/main/modules/automation/vision-worker.cjs',
    'src/renderer/i18n/**',
    'src/renderer/types/**',
    'src/shared/types/**',
    // 按需补充难测文件
  ],
  thresholds: { lines: 60, functions: 60, branches: 50, statements: 60 },
},
```

- [ ] **Step 3: 新增脚本**

```json
"test:coverage": "vitest run --project unit --coverage"
```

- [ ] **Step 4: 验证**

Run: `npm run test:coverage`
Expected: 报告生成（terminal 或 html），阈值宽松起步不强制红（若超时/报错调整阈值或排除清单）。

- [ ] **Step 5: Commit**

```bash
git add package.json vitest.config.ts
git commit -m "feat(test): 增加 v8 覆盖率报告与 unit 层门槛"
```

---

### Task 4: CI 最小化适配（可选但推荐）

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1:** 在 `npm run check` 之后补充 `npm run test:integration`（确保重型测试在 CI 仍被跑）；在 build 之后加 `npm run test:e2e`（Linux job，xvfb 环境）。

**Step 2:** 本地无法验证 CI，仅做语法级检查（yaml 缩进），并在 commit message 标注"CI 改动未经 runner 实测"。

**Step 3:** Commit：`chore(ci): check 后补充 integration 与 e2e`

---

## 验证汇总

- `npm test`（unit）：全绿，墙钟 <2.5s。
- `npm run test:integration`：三文件全绿。
- `npm run test:e2e`：首批 4 条通过（本地 Windows）。
- `npm run test:coverage`：报告产出，无硬性红。
- `npm run check`：i18n + typecheck + lint + unit test + build 全过。
- 确认 `git status`：无 `src/` 下文件被修改（仅 vitest.config.ts / playwright.config.ts / package.json / tests/e2e/ / CI）。
