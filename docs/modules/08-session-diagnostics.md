# 08 · 异常退出、诊断与内存监控

> 状态：按 **1.1.2（2026-11-02）** 源码核对，取代
> `docs/archive/modules-v1/08-session-diagnostics.md`。

## 1 范围与目标

该模块判断上次进程是否异常退出、导出脱敏诊断、在内存中保留短期进程内存趋势。
标签恢复数据由渲染层的会话持久化服务负责；主进程 `session-recovery.ts` 只维护
clean/abnormal 标志，不保存完整标签快照。

## 2 静态结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/session-recovery.ts` | electron-store `session-recovery` 中的运行/干净退出标记 |
| `src/main/utils/session-recovery-state.ts` | `beginSession` / `finishSession` 纯状态转换 |
| `src/renderer/services/tab-session.ts` | 标签会话快照与恢复候选 |
| `src/main/modules/diagnostics.ts` | 应用、运行时、设置、Flash/Ruffle、资源、内存与脱敏日志报告 |
| `src/main/modules/memory-monitor.ts` | 每 2 秒采样，最多 300 点，按进程类型记录峰值 |
| `src/main/ipc/diagnostics.ipc.ts` | 打开本地 SWF、导出诊断 JSON |
| `tools/probe/` | 构建、配置、git、日志与 BrowserView 的只读开发探针 |

## 3 异常退出与标签恢复

`session-recovery` 只持久化三个字段：`{ running, startedAt, cleanShutdownAt }`。

- 启动时 `initializeSessionRecovery()` 把上次 `running===true` 解释为异常退出，随后立即
  写入本次运行标记；结果缓存在内存（`recoveryRequired`）。
- 正常退出调用 `markCleanShutdown()`；若此前调用过 `preventCleanShutdownMark()`
  （例如主渲染进程连续崩溃超过阈值），本次不会再写 clean 标记——标记的是**本进程**，
  不修改历史记录。
- UI 只有在 `getSessionRecoveryStatus().abnormalExit` 为真时才提供恢复。
- 恢复候选来自渲染层 `tab-session.ts`，不是主进程虚构的快照文件。
- 用户处理完恢复提示后调用 `resolveSessionRecovery()`，只清内存态，不回写 store。

## 4 诊断报告与隐私

`diagnostics:export` 让用户选择保存位置，以 **`0600`** 模式写入
`createDiagnosticReport()` 的结果（formatVersion 3）。

报告字段：

| 分组 | 内容 |
| --- | --- |
| `provenance` | 构建来源与 shortId |
| `app` | 版本、是否打包、平台、架构 |
| `runtime` | Electron / Chrome / Node 版本、OS release、总内存 |
| `settings` | flashVersion、flashPluginChannel、lowEndMode、downloadEngine、是否自定义下载目录 |
| `flash` | 请求/生效通道、source、广告版本、physicalVersion、可用性、experimental/untested、fallbackReason |
| `ruffle` | 版本、字节数、SHA-256 |
| `resources` | PPAPI、Ruffle JS、CJK 字体、aria2、mouse-hook 的存在性/大小/SHA-256 |
| `memory` | 当前进程、按类型峰值、趋势、标签关联 |
| `logs` | 最近 **256 KiB** 日志，截取最后 500 行并脱敏 |

脱敏范围包括 home、userData、用户目录等私有路径；密码、cookie、查询串、令牌不得出现。

`file:open-swf` 只接受用户选择的 `.swf`，返回 `file://` URL 给标签系统打开；扩展名
不符直接返回 null。

## 5 内存监控

- `startMemoryMonitor()` 立即采样一次，之后每 **2 秒**读 `app.getAppMetrics()`。
- 最多保留 **300** 个趋势点；每点含采样时间、系统可用内存、按进程类型的 count /
  workingSet / private / cpu 汇总。
- 按类型记录峰值（workingSet、private）。
- `getMemoryDiagnostics()` 会**再取一次样**后返回当前进程、峰值、趋势、按标签关联的
  pid/engine/host，以及系统可用内存。
- 不写 CSV、不主动终止进程、没有阈值告警；`timer.unref()`，不阻止退出。

## 6 测试与雷区

- Vitest：异常退出状态机、标签会话合并、诊断脱敏、来源信息、内存数据形状。
- `npm run probe` 只读构建/配置/git/日志；`probe:deep` 检查运行时 BrowserView。
- **正常关闭不能留下恢复提示；异常路径不能提前写 clean 标记。**
- 不把密码、cookie、查询串或截图内容加入诊断。
- `preventCleanShutdownMark()` 只影响当前进程的退出标记，不会被持久化，也不应被用来
  "伪造"异常退出。
- 报告里的 `physicalVersion` 由 `flash-version.ts` 从插件二进制内嵌 token 解析（见 02），
  正常应等于实测版本（Win64 `29.0.0.171` 等）。为 null 只说明文件读不到，报告消费者
  不要据此判定"未安装"——可用性看同一分组的 `available` 字段。
