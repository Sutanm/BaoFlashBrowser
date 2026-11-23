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

> **换机器 / 新成员**：本项目用自编译内核，运行时不在仓库里。先看
> [`docs/kickoff/dev-environment.md`](../docs/kickoff/dev-environment.md)（快路径：把 `.runtime/win-x64`
> 从旧机器拷过来，约 30 分钟），并用 `npm run runtime:check` 校验来路。

```powershell
npm ci
npm run runtime:prepare -- 'D:\electron-build-142\dist'   # 或从旧机器拷贝 .runtime/win-x64
npm run runtime:check
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
| `npm run smoke` | 用临时测试 profile 跑 23 个用例：外壳/标签/快捷键/引擎与站点规则/输入回环/Ruffle 跨源/网络边界/弹窗/权限/主题/PPAPI 样本。无插件时 `flash` 与 `plugin-input` 两条会跳过并说明原因。 |
| `npm run runtime:check` | 校验 `.runtime/win-x64` 的内核与插件 SHA-256（按 `scripts/runtime-manifest.json`），失败时给出拷贝/重建两条恢复路径。 |
| `npm run runtime:export` / `:byop` | 导出运行时 zip（`internal` 含插件、`byop` 不含 Adobe 二进制）+ 包内 `RUNTIME-MANIFEST.json`，供其它机器搭建环境。 |
| `npm run runtime:import -- <zip>` | 校验逐文件 SHA-256 与内核 tag 后安装运行时；不一致直接拒绝。 |
| `npm run smoke:packaged` | 核对最近一次 `pack:win` 生成的验证包能启动真实内核、加载 PPAPI 样本并带上 Ruffle 运行时。 |
| `npm run pack:win` | 在固定的 `dist/win-preview/win-unpacked` 生成 Win x64 验证包（每次覆盖，并清理历史随机目录），产物自带 PPAPI 插件；结束时校验产物确实来自自编译内核。 |

## 当前增量范围

已实测（`bao-v142-265-ppapi-sandbox`，Electron 39.8.10 / Chromium 142.0.7444.265）：

- 无边框两行外壳、Windows 原生窗口控件、Fluent 2 token 与深浅色跟随；默认应用菜单已移除。
- **主题**：跟随系统明暗（`nativeTheme`），外壳与叠加层同时切换；暂无手动开关（等 M2 设置存储）。
- **启动只有一个标签页**；多标签由「新建标签页」按钮、双击标签栏或 `Ctrl+T` 创建。
- 标签栏交互：点击/键盘切换、中键关闭、关闭按钮按需显示、拖动排序、拖出窗口（tearoff）、右键菜单（重新加载/复制/固定/静音/关闭/撤销关闭）、`Ctrl+W` 关闭、`Ctrl+Shift+T` 撤销关闭。
- 撤销关闭用 E39 导航栈（`getAllEntries()/restore()`）恢复，保留前进/后退历史；无可撤销项时返回稳定错误码 `nothing-to-undo`。
- 标签级快捷键与 F11 / Esc 全屏都在主进程 `before-input-event` 处理，因此页面（含 Flash）获得焦点时仍然生效。
- **输入回环**：ASCII 与非 ASCII 字符进页面、IME 组合（`compositionstart/update/end` + 提交文本）、普通字母不被标签快捷键吃掉、地址栏与页面焦点互不串台、F11 全屏后视图跟随内容区、Esc 退出；自编 `keyprobe.swf` 证明键盘事件真的进了 **PPAPI 插件进程**。
- **双引擎**：每标签一个引擎（原生 PPAPI / Ruffle）。站点规则决定初始引擎，手动切换会新建 WebContents 并恢复导航栈；切换后可「记住此站点」写入规则。Ruffle 使用 `vendor/ruffle` 的固定版本资源（0.8.0），由页面 preload 注入主世界并 polyfill `<embed>`。工具栏用胶囊开关展示当前引擎（红=原生 Flash / 紫=Ruffle），`role="switch"` + `aria-checked`，标题里带引擎来源（默认 / 站点规则 / 手动切换）。
- **引擎网络 broker**：Ruffle 的 SWF/数据请求需要按站点 `crossdomain.xml` 放行跨源读。实现上**不碰页面 `window.fetch`**：注入前重写 wasm-bindgen 的 `__wbg_fetch_*` import，把 Ruffle 自己的 fetch 指向闭包内的私有传输（临时全局立即删除），因此普通网页脚本拿不到特权入口、页面 fetch 语义保持不变。主进程按目标站策略判定，来源取浏览器认证文档的完整 origin；重定向逐跳重新授权；Cookie 交给 `useSessionCookies`；`Referer` 用带随机令牌的私有标记还原（页面无法伪造）。
- **Ruffle 子帧支持**：Ruffle 视图开启 `nodeIntegrationInSubFrames`，preload 进每个子帧，跨源 iframe 里的客户端 SWF 也能被接管（淘米摩尔庄园的客户端挂在 iframe 里）。
- 页面会话关闭 Node、开启 context isolation 与 sandbox；**权限白名单**只放行 `fullscreen` / `pointerLock` 且要求 http(s) 来源，其余一律拒绝；**受控弹窗**只允许同站点 http(s) 弹窗（以新标签承载，引擎继承 opener），跨站与非 http(s) 拒绝；外壳 IPC 校验发送者、帧与文档来源，失败返回稳定错误码。
- 本地 PPAPI 样本：`navigator.plugins` 含 `Shockwave Flash`、独立 `Pepper Plugin` 进程、SWF 装载完成（`PercentLoaded = 100`）与 `SetVariable/GetVariable` 变量桥往返。
- 窗口销毁与重建：旧窗口的 WebContents 全部释放、旧事件不污染新窗口、标签业务 ID 跨窗口唯一；渲染进程崩溃后重建 WebContents 恢复页面。

## 已知约束与待验证项

- **内核要求**：原生 PPAPI 需要 `bao-v142-265-ppapi-sandbox`（提交 `9de35f61aea60`）或更新。此前为了让插件实例化曾关闭页面视图的渲染进程沙箱；根因是渲染进程里的插件路径复核，已由[内核补丁](../docs/kernel/README.md)修复，外壳与页面视图现在都保持 `sandbox: true`。
- **Ruffle 的能力边界**：`ExternalInterface` 只覆盖部分 API，PPAPI 样本里的 `PercentLoaded`/`SetVariable` 往返在 Ruffle 引擎下不保证可用；验收断言只看运行时注入与 polyfill 接管。
- **站点规则存储**：当前是 `userData/engine-rules.json`（临时方案），M2 引入业务库后迁到 SQLite。
- **标签合同尚未覆盖**：会话恢复、未加载占位、分组与搜索（固定/复制/静音/右键菜单已实现）。`detachTab/adoptTab` 与 `undo-close` 是这些交互的同一入口。
- **跨窗口移交的未验证面**：失焦、全屏退出、音频继续播放、Flash 内存态在真实站点下的表现；已实测的是同一 WebContents 复用带来的页面运行时状态与导航历史保留。
- **Ruffle 的键盘焦点**：Ruffle 0.8 需要用户**先点一次播放器**（它靠 `pointerdown` 把焦点交给内部容器），之后键盘事件才进 SWF；自动化要用 CDP 派发指针事件，`sendInputEvent({type:'mousedown'})` 不够。`ruffle-input.test.cjs` 已覆盖。
- **快捷键**：`Ctrl+T/W/Tab/Shift+T` 与 `Ctrl+Shift+I`（页面视图 DevTools）。标签分组、标签搜索、未加载占位仍未实现。
- **引擎相关未验证**：引擎切换失败回退（`restore()` 抛错）没有构造用例；真实站点（4399 等）在两种引擎下的对照未复测；UA、插件版本通告、`mms.cfg`、SWFObject 等站点兼容项按审计 §C7 另行验证。
- **输入相关未验证**：Ruffle 引擎下 `ruffle-embed` 画布的键盘焦点与游戏内输入未测（PPAPI 引擎下的插件内部输入已由 `plugin-input.test.cjs` 覆盖，样本见 `tests/smoke/fixtures/README.md`）。
- **下载默认拒绝**：页面与外壳会话的 `will-download` 一律 `preventDefault()`。M1 没有下载能力与落盘策略，没有明确策略前不静默写文件；下载的身份、分区、暂停/恢复按 §4 在 M2 立项。
- 后台出帧（#52844/#54311/#54090）与真实站点复测按架构 §2 与外壳开发并行推进，当前未开始。
- 独立复建内核与发布依赖校验仍未完成，验证包只用于受控范围。
### 打包产物的三条约定（2026-11-23 修正）

1. **开发不需要 `dist/`**：`dev` / `start` / `smoke` 都用 `.runtime/win-x64/electron.exe` + `out/`，`dist/` 只有 `pack:win` 与 `smoke:packaged` 用得到，随时可以整个删掉重打。
2. **必须带自编译内核**：未设置 `ELECTRON_EXEC_PATH` 时 electron-builder 会**静默下载官方 Electron**（产物 ~210MB，自编译运行时 ~232MB），官方内核没有 PPAPI 补丁，`smoke:packaged` 会报 `flash:timeout bridge-unavailable`。`pack-win.cjs` 现在兜底设置该变量，并在结束时断言产物大小与运行时接近，不符就失败。
3. **必须带 PPAPI 插件**：插件随内核 dist 目录进入 `win-unpacked/`（与 exe 同目录，`plugins.ts` 的第二候选路径），**不再复制到 `resources/`**——之前 extraResources 会让包里出现两份 30MB DLL。打包脚本会断言「包内有且只有一份插件」且哈希与来源一致。
4. **来源门禁**：`scripts/runtime-manifest.json` 记录内核 EXE、插件与 Ruffle 运行时的期望 SHA-256，`pack:win` 逐项校验，不匹配即失败。换内核/插件必须同步更新清单，并在提交信息里写明来源与 tag；临时放行用 `BAO_ALLOW_UNVERIFIED_RUNTIME=1`（会告警）。
5. **成品验证不允许默认跳过**：`smoke:packaged` 找不到产物会**失败**（`BAO_SKIP_PACKAGED=1` 才显式跳过）；`BAO_PACKAGED_ROOT` 可指向 CI 本次构建的产物目录。
6. **许可**：`NOTICE.md` 与 `licenses/`（Chromium 第三方许可 14.4 MB + Electron 许可）随包。Chromium 那份取自**官方 Electron 39.8.10 发行包**（同版本近似，见 `licenses/README.md`），最终应由内核构建生成。Flash 插件再分发授权未确认。
7. **签名与产物清单**：提供 `WIN_CSC_LINK` / `CSC_LINK`（+ `CSC_KEY_PASSWORD`）时打包会走 electron-builder 签名；无论是否签名，`pack:win` 都会在产物根写 `manifest.json`（组件哈希、许可文件、PE 签名块状态、内核 tag、发布门禁清单）。签名链校验仍需发布时用 signtool 另行验证。

### Flash 插件：BYOP（用户自备）

本项目**不随公开发布包分发 Adobe Flash Player**（其再分发受 Adobe 许可限制）。用户自行准备
`pepflashplayer64.dll` 并放到：

```text
<BaoFlashBrowser Next.exe 所在目录>\flash\pepflashplayer64.dll
```

放好后重启应用即可启用原生引擎；没检测到时所有标签自动回落到 Ruffle，引擎面板里的
「Flash」档会置灰并在悬停时给出上述路径。解析顺序：`BAO_FLASH_PLUGIN` → `<exe>\flash\` →
`<exe>\` → `<resources>\`。我们只负责加载用户提供的文件，**不提供来源与下载方式**。

两个打包 profile：

| 命令 | 产物 | 用途 |
| --- | --- | --- |
| `npm run pack:win` | internal：带插件 | 内部验证；**默认拒绝签名**（`BAO_ALLOW_SIGN_INTERNAL=1` 才放行），不得对外分发 |
| `npm run pack:win:public` | public：**不带** Adobe 二进制 | 可签名、可分发；用户按上面的 BYOP 方式自备插件 |
