# BaoFlashBrowser Next 应用

M1 在此目录下使用单应用包。开工范围和验收要求见[新版架构 §6](../docs/discussions/2026-11-22-bfb-next-architecture.md#6-交付顺序和验收)及[架构审计 · 当前开工判定](../docs/discussions/2026-11-22-bfb-next-architecture-audit.md#当前开工判定)。

| 目录 | 职责 |
| --- | --- |
| `src/main/` | Electron 主进程，负责窗口、标签及 WebContentsView 生命周期、导航、会话权限、PPAPI 注册和 IPC 校验。 |
| `src/main/browser-window.ts` | 每个窗口的标签、选中关系、绑定代际与命令处理；崩溃后重建 WebContents。 |
| `src/main/sessions.ts` | 外壳与页面两条会话边界，权限检查与权限请求一律拒绝。 |
| `src/main/plugins.ts` | 自编译内核的 PPAPI 插件注册（`--allow-command-line-plugins` + `--register-pepper-plugins`）。 |
| `src/preload/` | 受信任外壳的预加载入口，向 Vue 外壳暴露经批准的异步命令和状态接口。 |
| `src/renderer/` | Vue 3 + Pinia 外壳，负责地址栏、标签交互和窗口状态展示；瞬态交互留在组件内。 |
| `src/shared/` | 跨进程共享的 IPC 类型、稳定错误码和数据结构，保持独立于 Electron 与 Vue。 |
| `tests/smoke/` | 使用实际自编译运行时和独立测试 profile 验证外壳、标签、PPAPI 与窗口隔离。 |
| `tests/smoke/fixtures/` | 可重复使用的本地 HTML 与自编 AS3 样本，来源与哈希见该目录 README。 |

阶段验收记录归档到 [docs/kickoff](../docs/kickoff/README.md)。

## 本地启动

使用 Node.js 22.12+ 或 24.x。在本目录执行以下 PowerShell 命令，按本机路径调整自编译产物目录。

```powershell
npm ci
npm run runtime:prepare -- 'D:\electron-build-142\dist'
$env:ELECTRON_EXEC_PATH = (Resolve-Path '.runtime/win-x64/electron.exe').Path
npm run dev
```

`npm ci` 安装锁定的依赖，并从同版本的 Electron 包获取默认启动器。准备命令在 `.runtime/win-x64` 组装独立开发副本，使用自编译 EXE 和运行时文件，保留原目录的探针应用。每个新 PowerShell 会话需重新设置 `ELECTRON_EXEC_PATH`。

环境里若存在 `ELECTRON_RUN_AS_NODE=1`（本机曾用于其它探针），Electron 会以 Node 模式启动、主进程拿不到 `app`。冒烟脚本会自行清除该变量；手工 `npm run dev` 前请先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`。

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 检查 TypeScript 和 Vue 类型。 |
| `npm run build` | 检查类型并编译主进程、预加载和渲染层。 |
| `npm start` | 使用自编译 Electron 启动已编译的应用。 |
| `npm run smoke` | 用临时测试 profile 验证无边框外壳、标签栏交互、快捷键、引擎切换与站点规则、视图尺寸、Node 隔离、内核版本和本地 PPAPI 样本（8 个用例）。 |
| `npm run smoke:packaged` | 核对最近一次 `pack:win` 生成的验证包能启动真实内核、加载 PPAPI 样本并带上 Ruffle 运行时。 |
| `npm run pack:win` | 每次在 `dist/win-preview-*/win-unpacked` 生成独立的 Win x64 验证包，并输出可执行文件路径。 |

## 当前增量范围

已实测（`bao-v142-265-ppapi-sandbox`，Electron 39.8.10 / Chromium 142.0.7444.265）：

- 无边框两行外壳、Windows 原生窗口控件、Fluent 2 token 与深浅色跟随；默认应用菜单已移除。
- **启动只有一个标签页**；多标签由「新建标签页」按钮、双击标签栏或 `Ctrl+T` 创建。
- 标签栏交互：点击/键盘切换、中键关闭、关闭按钮按需显示、拖动排序、拖出窗口（tearoff）、`Ctrl+W` 关闭、`Ctrl+Shift+T` 撤销关闭。
- 撤销关闭用 E39 导航栈（`getAllEntries()/restore()`）恢复，保留前进/后退历史；无可撤销项时返回稳定错误码 `nothing-to-undo`。
- 标签级快捷键在主进程 `before-input-event` 处理，因此页面（含 Flash）获得焦点时仍然生效。
- **双引擎**：每标签一个引擎（原生 PPAPI / Ruffle）。站点规则决定初始引擎，手动切换会新建 WebContents 并恢复导航栈；切换后可「记住此站点」写入规则。Ruffle 使用 `vendor/ruffle` 的固定版本资源（0.8.0），由页面 preload 注入主世界并 polyfill `<embed>`。
- 页面会话关闭 Node、开启 context isolation 与 sandbox，权限检查与请求一律拒绝；外壳 IPC 校验发送者、帧与文档来源，失败返回稳定错误码。
- 本地 PPAPI 样本：`navigator.plugins` 含 `Shockwave Flash`、独立 `Pepper Plugin` 进程、SWF 装载完成（`PercentLoaded = 100`）与 `SetVariable/GetVariable` 变量桥往返。
- 窗口销毁与重建：旧窗口的 WebContents 全部释放、旧事件不污染新窗口、标签业务 ID 跨窗口唯一；渲染进程崩溃后重建 WebContents 恢复页面。

## 已知约束与待验证项

- **内核要求**：原生 PPAPI 需要 `bao-v142-265-ppapi-sandbox`（提交 `9de35f61aea60`）或更新。此前为了让插件实例化曾关闭页面视图的渲染进程沙箱；根因是渲染进程里的插件路径复核，已由[内核补丁](../docs/kernel/README.md)修复，外壳与页面视图现在都保持 `sandbox: true`。
- **Ruffle 的能力边界**：`ExternalInterface` 只覆盖部分 API，PPAPI 样本里的 `PercentLoaded`/`SetVariable` 往返在 Ruffle 引擎下不保证可用；验收断言只看运行时注入与 polyfill 接管。
- **站点规则存储**：当前是 `userData/engine-rules.json`（临时方案），M2 引入业务库后迁到 SQLite。
- **标签合同尚未覆盖**：会话恢复、未加载占位、标签固定、复制、静音、分组与搜索、标签右键菜单。`detachTab/adoptTab` 与 `undo-close` 是这些交互的同一入口。
- **跨窗口移交的未验证面**：失焦、全屏退出、音频继续播放、Flash 内存态在真实站点下的表现；已实测的是同一 WebContents 复用带来的页面运行时状态与导航历史保留。
- **快捷键当前只有 `Ctrl+T/W/Tab/Shift+T`**：`Ctrl+Shift+I` 等 DevTools 入口随默认菜单移除而不可用，按 §4「原生 DevTools 优先」在后续增量接入。
- **引擎相关未验证**：引擎切换失败回退（`restore()` 抛错）没有构造用例；真实站点（4399 等）在两种引擎下的对照未复测；UA、插件版本通告、`mms.cfg`、SWFObject 等站点兼容项按审计 §C7 另行验证。
- 后台出帧（#52844/#54311/#54090）与真实站点复测按架构 §2 与外壳开发并行推进，当前未开始。
- 独立复建内核与发布依赖校验仍未完成，验证包只用于受控范围。
