# 09 · 构建、发布与测试管线

## 1 范围与目标

规范从源码到制品再到发布验证的整条链：

- **构建**：`npm run build`（css-fixer → esbuild main → Vite renderer）；`npm run dev`（并发 watch）；i18n 代码生成；
- **发布**：`prepare-release` → 版本 bump → `electron-builder` 打 NSIS/便携包 → `verify-asr` 清单核对；
- **测试**：Vitest 单测、Electron smoke（每类都有值门）、探针（只读不清理）。
- **质量门**：lint / typecheck / test / build 全绿才可发布。

**边界**：Electron 版本永不升级（02 的兼容前提）；`release/tests` 独立产物不在主 build 输出内。

## 2 静态结构

| 路径 | 职责 |
|---|---|
| `package.json` scripts（`build`/`dev`/`i18n`/`lint`/`typecheck`/`test`/`check`/`probe`/`test:*`） | 命令总入口 |
| `build/` / `build/verify-release.cjs`、`build/prepare-release.cjs` | 发布准备与核对 |
| `electron-builder.config.cjs` | 安装器配置（NSIS + portable） |
| `scripts/build-css-fixer.mjs`、esbuild 配置（`build/*`） | 内置脚本与主进程打包 |
| `vite.config.ts` | renderer 打包；`esbuild-plugin-copy` 拷 `dist/lib/ruffle` |
| `tests/electron/build-*.mjs` | smoke 专属构件（`release/tests/`） |
| `tests/electron/*.cjs` | 各 Electron smoke 测试 |
| `.github/workflows/*.yml` | 发布矩阵（Win x64 arm64 等） |
| `tools/probe/` | 探针框架（`host.cjs`/`host-electron.cjs`、协议、`_template.cjs`） |

## 3 核心流程

### 3.1 构建

```
npm run dev      # concurrently: esbuild watch main + vite renderer（无自动重启）
npm run build    #  build:css-fixer → esbuild main（platform:node, CJS） → vite build
npm start        # i18n generate → esbuild main → vite build → electron .
npm run i18n     # typesafe-i18n codegen（改字符串后先跑）
```

关键点：
- `src/shared/automation/plugin/*` 等带 wasm/deps 的文件用 esbuild `loader`/`copy` 处理；
- `dist/lib/ruffle` 由 vite 插件复制（含 license）。

### 3.2 发布

```
prepare-release（版本 bump + changelog）→  git tag → GH workflow
  ├─ electron-builder NSIS + portable（首次运行升级迁移）
  └─ verify-release：核对 asar 内存在以下清单——
     MANIFEST= package.json, dist/main/index.js, dist/preload/index.js,
     dist/renderer/index.html+JS/CSS, dist/webview-preloads/...,
     dist/lib/ruffle/ruffle.js …自动化工作台页面 chunk
```

已知缺口：**`AutomationPage-*.js` chunk 未列入 verifyAsar 清单**（见 03 §9）；发布流程需人工复核该 chunk 存在。

### 3.3 smoke 专属构件

`tests/electron/build-*.mjs` 独立产出：
- `release/tests/userscripts-admin-module.cjs`
- `release/tests/userscript-runtime-preload.cjs`
- `release/tests/session-compatibility-smoke.cjs`

**改源码后必须先跑对应 build 脚本再跑 smoke，否则测 STALE 代码。**

### 3.4 smoke 通用守则

独立 Electron smoke（`tests/electron/*.cjs`）必须：
- 注册全部 preload 通道 mock（`userscript:get-config`、`report`、`menu-register` 等 IPC `.on`）；
- `app.setPath('userData', …/bao-flash-browser)`（否则读 `%APPDATA%\Electron`）；
- 设置 `BAO_USERSCRIPT_PRELOAD_PATH` 指向 `release/tests/userscript-runtime-preload.cjs`（`__dirname`=release/tests）。

## 4 数据模型与接口

- `release/tests` 是 smoke 产物的固定命名空间；`release/electron-builder-*` 为安装制品输出。
- 探针协议：`{ id, name, needsElectron, timeoutMs, run(ctx) }`；`SMOKE_TIMEOUT` 环境变量挂 timeout。
- GH 发布矩阵：`windows-latest`（x64/arm64）+ 未打 tag 的 PR 校验构建；产物用 `.nupkg`+NSIS。

## 5 安全边界与不变量

- 发布产物校验 asar 清单白名单，缺 chunk 应 fail；当前 Automation chunk 属已知例外需人工补。
- smoke 产物是测试专用，**不进安装包**。
- 探针只读：永不清理日志、永不写用户数据。
- electron-builder 不签自定义版本（未签名时发布须人工 Tag）。

## 6 兼容性

- Win：NSIS 安装器 + 便携 zip；升级保留 userData。
- Linux 构建仅 smoke 层面（`--no-sandbox`），官方发布以 Win 矩阵为准。
- i18n：baseLocale zh-CN、en 引用；改字符串必须 `npm run i18n` 再 build。

## 7 验证矩阵

- `npm run check`：i18n → typecheck → lint → vitest → build（**全绿门**）。
- `npm test -- --run`：Vitest 套件。
- `test:compat` / `test:electron` / `test:ruffle` / `test:userscripts(_admin)` / `test:css-fixer` / `test:automation`：各自对应模块 smoke。
- `probe` / `probe:deep`：构建新鲜度（00-build）、脚本、配置、git、日志、视图健康、CDP 运行时。

## 8 雷区与注意事项

1. `npm run build` 不重建 `release/tests`。改 `userscripts/` 源码/`bundled-scripts` 后必须重跑对应 `build-*.mjs`/`build:css-fixer`，否则 smoke 用旧 bundle。
2. `release/tests` 产物路径敏感于 `__dirname`。
3. esbuild main 用 `platform:node,cjs`；不要引入 `import.meta`（CJS）。
4. Vite chunk 用确定性命名时，verifyAsar 白名单要同步更新。
5. `.husky/` 未入 git（无生效 pre-commit）：如需 gate 建议在 GH PR 校验触发 `npm run check`。

## 9 演进建议

- 修复 verifyAsar 遗漏 `AutomationPage-*.js` 的缺口（把 Vite 产物清单与 asar 校验打通）。
- 引入发布前自动跑一遍 `test:automation` + `test:userscripts-admin`（当前依赖人工 Tag 触发）。
- 探针协议增加“会话恢复快照完整性”探针，衔接 08。