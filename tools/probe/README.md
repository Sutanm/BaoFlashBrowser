# AI 开发协助工具包 — 探针原型库

针对 BaoFlashBrowser 的**精准探针工具包**。设计目标:AI 或开发者**不必重复测试**来决定"在哪里加探针、实现哪些功能"——找到对应原型,复制 `_template.cjs` 二次开发即可。探针执行有硬超时护栏,永不挂满默认超时;日志**只读追加,不清理、不截断**。

## 快速开始

```bash
npm run probe          # 纯 Node 快检(秒级):构建新鲜度/脚本/配置/git/日志
npm run probe:deep     # Electron 深层:主进程模块健康 + 运行时健康(BrowserView)
node tools/probe/host.cjs --only 00,03   # 指定探针(支持前缀)
node tools/probe/host.cjs --json         # JSON 输出(喂 AI)
SMOKE_TIMEOUT=200 npm run probe:deep     # 提高宿主 watchdog(默认 90s)
```

## 探针清单

| id | 探针 | 宿主 | 回答的问题 |
|---|---|---|---|
| `00-build` | 构建产物新鲜度 | 纯 Node | 产物是否过期?该跑哪个 build?(源码 mtime vs 产物) |
| `01-userscripts` | 已安装脚本 | 纯 Node | userData 里装了哪些脚本、启停状态、版本 |
| `02-config` | 配置快照 | 纯 Node | flashVersion / lowEndMode / downloadEngine 等 |
| `03-git` | git 状态 | 纯 Node | 分支、未提交文件、最近提交 |
| `04-logs` | 日志尾部 | 纯 Node | 日志路径、尾部 N 行、error/warn 计数(**不清理日志**) |
| `10-main-process` | 主进程模块健康 | Electron | userscript manager 能否初始化、与磁盘存储是否同步 |
| `11-views` | 运行时健康 | Electron | 真实 BrowserView:主框架/iframe 脚本执行、命令去重、命令生效 |
| `67-qax-flash-host` | 高版本内核 PPAPI Flash | 纯 Node | 奇安信 102 内核的 Flash 是否原生 PPAPI、插件路径能否换成自带 DLL、杀插件后 JS 是否存活(需 `BAO_QAX_EXE`,否则跳过) |

## 架构

```
host.cjs / host-electron.cjs     宿主原型:发现探针 → 逐探针执行 → 汇总输出
lib/context.cjs                  上下文:项目根、userData、日志定位、mtime 工具
lib/timeout.cjs                  超时原语:withTimeout / waitFor 轮询 / 进程级 watchdog
lib/reporter.cjs                 输出:文本表 / --json;部分失败不中断,退出码=失败数
probes/_template.cjs             新探针模板(复制即二次开发)
probes/<NN>-<name>.cjs           探针实例(00-09 纯 Node,10-19 Electron)
```

## 二次开发:新增一个探针

1. **复制** `probes/_template.cjs` → `probes/12-my-check.cjs`;
2. 填四个字段 + `run(ctx)`:
   ```js
   module.exports = {
     id: '12-my-check',        // 唯一,前缀 12 表示第 12 号探针
     name: 'my check',         // 表格显示名
     needsElectron: false,     // true 则放 host-electron.cjs 里跑
     timeoutMs: undefined,     // 可选:探针级预算
     async run(ctx) {
       // ctx = { root, userData, logFile, readJsonSafe, latestMtime, exists }
       //   needsElectron 探针额外有 ctx.electron = { app, BrowserWindow, BrowserView, ipcMain }
       return { ok: true, summary: '一行摘要', detail: { ...任意 JSON } };
     },
   };
   ```
3. 不需要改宿主——两个宿主自动发现 `probes/*.cjs`(跳过 `_template.cjs`),按 `needsElectron` 分流;
4. 运行验证:`npm run probe -- --only 12`。

## 规则(硬性)

- **只读**:探针不得写 userData/配置/产物/应用状态。深层探针 `initUserscriptManager()` 只读不保存。
- **日志**:只读追加。禁止删除、清空、截断日志文件——完整日志留给后续调试。
- **超时**:所有等待必须走 `lib/timeout.cjs`(waitFor/withTimeout);宿主还有进程级 watchdog
  (默认 90s,`SMOKE_TIMEOUT` 覆盖),任何探针都无法挂满 5 分钟。
- **永不中断他人**:探针失败只计失败数,不影响其他探针执行。
- **喂 AI**:`--json` 输出结构化结果;日志探针输出完整文件路径,AI 可按需全量读取。

## 选型速查(遇到问题用哪个)

| 症状 | 先跑 |
|---|---|
| "冒烟测的是旧代码/行为不对" | `00-build` → 看 stale 项,跑对应 build 命令 |
| "脚本没生效/装没装" | `01-userscripts`(快)+ `10-main-process`(深) |
| "页面挂了/渲染卡死" | `04-logs`(错误计数)+ `11-views`(运行时健康) |
| "启动配置不对" | `02-config` |
| "改到一半忘了改了什么" | `03-git` |
| "验证新站点/新场景" | 复制 `11-views`,改 fixture 页与断言 |

## 与现有测试的关系

- 工具包**不替代** `tests/electron/*` 冒烟;`11-views` 是 menu-command-dedupe 冒烟的
  "探针化"原型,供复制扩展。
- `lib/timeout.cjs` 的超时原语可被现有冒烟直接 require 使用(可选加固,未强制接入)。
- 不触碰 `src/main/modules/diagnostics.ts`(平台诊断导出,属产品功能)。

## Windows x64 双内核原型

在可交互的桌面运行。探针会打开测试窗口，移动鼠标并点击本地测试 SWF。
运行期间不要操作鼠标。两个运行时各用独立的临时配置目录。

```powershell
npm install --prefix .cache/electron/dual-kernel --no-save --no-package-lock electron@45.2.3 koffi@3.3.7
node -p "require('./.cache/electron/dual-kernel/node_modules/electron')"
npm run probe:automation-flash
$env:BAO_PROBE_DUAL_KERNEL = '1'
npm run probe:deep -- --only 62 --json
```

额外运行时只装在忽略跟踪的缓存目录。现有 Electron 11.5 继续运行 Flash。
控制通道使用一次性的本机 Windows 命名管道，因为这台机器上的
Electron 11.5 启动时关闭了继承的 stdin。结果和测试 SWF 截图写到
`release/dual-kernel-*`。结果中的 `offscreen` 单独记录离屏位图与
`sendInputEvent` 的观察结果，探针退出码以原生嵌入路径为准。

## Windows x64 CEF 对照

需要 Visual Studio 2022 的 C++ 工具链、CMake 和上节的现代 Electron/Koffi。
从 [CEF 官方构建索引](https://cef-builds.spotifycdn.com/index.html) 下载并解压两个
Windows x64 minimal SDK。测试使用 CEF 87.1.14+ga29e9a3 和
CEF 156.0.27+ga10dae3。将下列 SDK 路径替换为实际目录。

```powershell
$cef87 = 'D:/path/to/cef87'
$cef156 = 'D:/path/to/cef156'
$fixture = 'tools/probe/fixtures/cef-compare'
cmake -S $fixture -B .cache/cef-compare/build87 -A x64 "-DCEF_ROOT=$cef87"
cmake -S $fixture -B .cache/cef-compare/build156 -A x64 "-DCEF_ROOT=$cef156" -DBAO_CEF_MODERN=ON
cmake --build .cache/cef-compare/build87 --config Release
cmake --build .cache/cef-compare/build156 --config Release
$env:BAO_CEF_PROBE_EXE = (Resolve-Path .cache/cef-compare/build87/bin/Release/bao_cef_probe.exe).Path
$env:BAO_CEF_MODERN_EXE = (Resolve-Path .cache/cef-compare/build156/bin/Release/bao_cef_probe.exe).Path
npm run probe:deep -- --only 63 --json
```

探针会短暂打开两个测试窗口。CEF 87 用 Bao 的 DLL 加载本地按钮 SWF，
在独立临时配置中分别请求位图和共享纹理。启用现代 CEF 对照时，两个宿主
依次接收实时发布到 Windows 共享内存的四个状态帧。鼠标序列由 worker
注入。两个宿主分别使用 Win32 GDI 和 Electron Canvas 绘制。
`release/cef-compare-*` 中保存 JSON 结果和 worker 的 BMP。
D3D11 输出单独报告。退出码以 CPU 位图和所选宿主的对照结果为准。

### 使用官方 cefclient 独立复核

从同一构建索引下载上述两个版本的 Windows x64 **client** 包，解压后在
可交互的桌面运行。此探针只采样测试窗口中心，不使用探针 63 的 worker 或回调。

```powershell
$env:BAO_CEFCLIENT_87 = 'D:/path/to/cef87-client/Release/cefclient.exe'
$env:BAO_CEFCLIENT_MODERN = 'D:/path/to/cef156-client/Release/cefclient.exe'
npm run probe:deep -- --only 64 --json
```

新版 client 是可选的共享纹理阳性对照。报告位于 `release/cefclient-osr-*`。
探针通过表示对照有效，旧版是否成功显示纹理另见 `texture87.animated`。

### 使用真实 Flash 游戏验证子进程

按上面的步骤重新构建 CEF 87 探针 worker。下载作者发布的
[FlxInvaders.swf](https://flixel.org/flxinvaders/FlxInvaders.swf)，放在本地缓存目录。
本次使用的 SWF 的 SHA-256 为
`562ddb1c28bc3ef838fd173ea232f3c2f4e3227e9eebe16965f83a32a1e1d95b`。

```powershell
$env:BAO_CEF_PROBE_EXE = (Resolve-Path .cache/cef-compare/build87/bin/Release/bao_cef_probe.exe).Path
$env:BAO_CEF_GAME_SWF = (Resolve-Path .cache/cef-compare/game/FlxInvaders.swf).Path
npm run probe:deep -- --only 65 --json
```

探针从现代 Electron 页面注入键鼠和合成 IME 事件，通过 stdio 送入 CEF，
并从共享内存接收 CEF 的 BGRA 帧。按钮延迟从输入注入计到 Canvas 绘制后
的确认，游戏统计在 640×480 的六秒区间内发布和绘制的帧数。方向键响应
按画面中的飞船位置验证。合成 IME 测试分别确认旧内核的 HTML 输入框和
原生 Flash 文本框提交了同一测试字符串。报告和截图在 `release/cef-live-*`。

帧传输默认由 CEF 写入共享内存后通过 stdout 通知外壳，帧像素仍走共享内存。
设 `BAO_CEF_FRAME_NOTIFY=0` 可对照轮询加绘制确认模式，设
`BAO_CEF_FRAME_POLL_ONLY=1` 可对照纯轮询模式。设
`BAO_CEF_FRAME_SAMPLE_MS=20000` 可将六秒采样延长到二十秒。
报告的 `game.stages` 记录读帧、IPC 往返和 Canvas 绘制的中位数及 P95。

### 测现有 BaoFlashBrowser 原生 PPAPI 的帧率

先运行 `npm run build`。复用上节的 FlxInvaders SWF 和已缓存的现代 Electron。
现代 Electron 运行采样探针，Playwright 启动项目自身的 Electron 11 和生产构建，
实际从地址栏打开游戏。两个进程使用隔离配置。

```powershell
$env:BAO_PROBE_NATIVE_FRAMES = '1'
$env:BAO_CEF_GAME_SWF = (Resolve-Path .cache/cef-compare/game/FlxInvaders.swf).Path
node -e "const {spawn}=require('child_process'); const e=require('./.cache/electron/dual-kernel/node_modules/electron'); spawn(e, ['tools/probe/host-electron.cjs','--only','66','--json'], {stdio:'inherit'}).on('exit', c=>{process.exitCode=c})"
```

探针先用有序号的动画校准桌面采样，再测 20 秒真实游戏画面。
随后重新打开同一个游戏，同时采样桌面和 BrowserView。报告、时间戳和游戏
区域的截图位于 `release/native-ppapi-*`。画面变化计数是采样估计。
