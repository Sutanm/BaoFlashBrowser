# 启动期「外壳渲染线程被阻塞 331 ms」的性质修正与两处改动

2026-11-26 · 起因：开发态启动时 `[heartbeat] 外壳渲染线程被阻塞约 331 ms` 反复出现，且「预热了飞窗
第一次打开仍会卡一下」。代码：`app/src/main/heartbeat.ts`、`app/src/shared/heartbeat.ts`、
`app/src/preload/index.ts`、`app/src/main/browser-window.ts`、`app/tests/unit/heartbeat.test.ts`。
口径修正同步写进 `app/README.md` 的「观测量」「窗口出现时机」两条。

## 1. 结论

| 项 | 修正前（11-25 口径） | 本次实测后的口径 |
| --- | --- | --- |
| 331 ms 是什么 | 外壳渲染线程被同步长任务占住 | **新渲染进程的冷启动**：进程启动 + 解析 + 首帧，期间**没有**超过 54 ms 的单任务 |
| 为什么总在启动时报 | 未区分冷启动与运行期 | 心跳从窗口创建就发（`startHeartbeat()` 在 `await loadURL()` **之前**），首批 ping 只能排在启动任务后面 |
| RTT 的含义 | 直接等于被阻塞时长 | 运行期成立；冷启动期它测的是「渲染进程还没起来」；另外**主进程自己卡住也会抬高它** |
| 窗口何时出现 | `loadURL` 解析后立刻 `show()` | `ready-to-show`（画过首帧）之后才 `show()`，兜底 1500 ms |
| 预热是否拖慢首帧 | 未知 | 不是主因：预热文档 39 ms 就 `did-finish-load`，且实测落在首帧之后；热开飞窗 12–27 ms |

## 2. 证据

**① preload 探针（记录 ping 到达与回执发出的真实时刻）**

```
[probe] ping seq=1 arrival=…443 readyState=interactive now=277   ← 文档已经 interactive，ping 才被处理
[probe] pong seq=1 sent=…444                                     ← 回执只用了 1 ms
[probe] ping seq=2 arrival=…444                                  ← 两跳同一毫秒到达：它们在队列里排了 277 ms
```

回执立刻发出 ⇒ RTT 不是"渲染线程在干活"，而是"消息排到队尾才被处理"。

**② Chromium `contentTracing.startRecording` 启动 tracing（3 s，解析 `ThreadControllerImpl::RunTask`）**

| 线程 | 最长单任务 | 明细 |
| --- | --- | --- |
| 外壳渲染线程 | **54.2 ms** | `NotifyScriptLoaded` 54.2 · `FinishedParsing` 37.3 · `UpdateStyleAndLayout` 34.0 · `layout` 33.9 · `v8.evaluateModule` 16.3 |
| 主进程 | 18.7 ms | 无长阻塞 |
| GPU 进程 | — | 首帧前后有 98–209 ms 的忙碌桶（D3D11 设备/首帧提交） |

外壳渲染线程**第一个任务出现在 tracing 起点后 221 ms**：在那之前进程还没起来，谈不上"被占住"。

**③ 空白页基线（同一内核、可见窗口）**：首窗首帧 216–330 ms（冷启动那一次 952 ms）。
也就是说启动期那 200–350 ms 里有一大块与我们的代码无关。

**④ 预热与热开**

| 动作 | 实测 |
| --- | --- |
| 外壳 `loadURL` 解析 → 预热浮层 `did-start-loading` | 451 ms（首帧之前）；浮层 `did-finish-load` 490 ms ⇒ **预热文档约 39 ms** |
| 点击齿轮（已预热）→ 卡片有布局盒 | **12 ms**（另一轮 17–18 ms） |
| 点击齿轮 → 首帧提交 | **23–27 ms**，无长任务 |

**⑤ 窗口出现时机（这是"一起动就卡一下"的真实来源）**

| | show 时刻 | 首帧（FCP） | 空窗口 |
| --- | --- | --- | --- |
| 改前 | 430 ms | 664–780 ms | **200–300 ms**，期间点齿轮开飞窗只能排在启动任务后面 |
| 改后 | 与首帧同帧（差 −56…−54 ms） | 同上 | ≈0；窗口一出现就是完整一帧，第一次点击时渲染线程已空闲（17–18 ms 出布局盒） |

## 3. 改动

1. **冷启动与卡顿分开**：preload 在 `load` 后两次 rAF 发 `bao:heartbeat:ready`（`preload/index.ts`）；
   `HeartbeatMonitor` 加 `warmup`/`markReady()`，首帧之前的往返只记 `boot`（`console.info` 一行），
   不进样本、不计 `stalls`（`main/heartbeat.ts`）。8 s 兜底就绪，避免 preload 失效让观测永久停摆。
2. **RTT 归因**：主进程另测自身事件循环卡顿 `mainLag`（50 ms 采样），`heartbeatStats()` 一并返回，
   告警文案在主进程自身卡住时写明「RTT 含这一段」；`BAO_HEARTBEAT_TRACE` 现在逐跳落
   `sample rtt=… ready=… mainLag=…`，另有一次 `boot` 与运行期 `stall`。
3. **等首帧再 show**：`showWhenPainted()`，`ready-to-show` 已触发则直接 show，否则等它 + 1500 ms 兜底。
   **接管窗口例外**（`options.adopt`：拖出标签 / 跨窗移交通道的落点）仍然立刻 `show`——那条路径的
   用户动作是"把标签拖出来"，窗口必须跟手，晚 200–350 ms 反而像拖拽没反应。

验证：heartbeat 冒烟 3/3；`startup`、`quick-settings`（含投影边距点击转发）在隐藏与**前台**两种模式下通过；
全量 smoke 34 个文件 33 通过（`engine-rules` 在 4 并发下等标签超时，单跑 15.2 s 通过，判为并行负载 flake）；
单测新增 4 条覆盖冷启动样本与 `reset` 语义。

## 4. 修正：一条被撤回的推论

排查过程中我据一次 `app.getGPUFeatureStatus()` 读数（`gpu_compositing: disabled_software`）推断
「本机是软件光栅、所以首帧慢」。**该推论作废**：那次读数是在**还没创建任何窗口**的主进程里取的，
Chromium 在拿到 frame sink / display compositor 之前一律报软件回退。用真实应用（窗口可见、
含 `background` 冒烟模式）复测：`gpu_compositing / rasterization / 2d_canvas / webgl` 全为 `enabled`，
`glRenderer = ANGLE (NVIDIA RTX 4060 Laptop GPU, D3D11-32.0.16.2124)`，`displayType = ANGLE_D3D11`；
代码里也没有任何 `disableHardwareAcceleration` / `--disable-gpu` 开关。
本报告 §2 的所有数字都取自硬件合成下的运行，结论不受影响，只是"软件光栅"这个归因要去掉。

## 5. renderer 产物压缩（同日实施，结论：值得做，但不是启动优化）

electron-vite 给 renderer 的 `minify` 默认是 `false`，外壳首帧前要解析的是 266 KB 的 `theme-*.js`
加 58 KB 的 `index-*.js`。已在 `app/electron.vite.config.ts` 打开 `build.minify: 'esbuild'`
（只动 renderer：主进程/preload 的体积对启动没有影响，压了反而让主进程栈与 `BAO_*_TRACE` 更难读）。

| 文件 | 压前 | 压后 |
| --- | --- | --- |
| `theme-*.js`（Vue 运行时） | 266.2 KB | **108.6 KB** |
| `index-*.js`（外壳） | 57.9 KB | **25.4 KB** |
| `index-*.css` | 16.9 KB | **11.1 KB** |
| `settings-*.js`（设置页） | 36.1 KB | 18.8 KB |
| 外壳首屏三个文件合计 | ≈341 KB | **≈145 KB（−58%）** |

**它并没有让启动变快**：同一探针插在产物里、两种构建交替各跑 3 轮，`首个脚本执行 → DCL`
（= 模块解析 + 求值 + 挂载）压缩前 17–19 ms、压缩后 17–18 ms，差在噪声里；FCP 也无可分辨差别。
原因很直白——266 KB 对 V8 解析器不算什么，而启动期那 200–350 ms 本来就不是 JS 的账（见 §2 ②）。
之所以仍然保留：成品分发体积少一半，且不改任何行为（类名/自定义属性不动）。

验证：全量 smoke 34 个文件 113.1 s / 0 失败；前台 `startup` + `internal-page` 全绿。

## 6. 未做

- Chromium 冷启动本身（新渲染进程 + 首帧 ~200–350 ms）无法消除，只能像本次这样挪到窗口出现之前。
