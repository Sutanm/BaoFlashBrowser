# 08 · 异常退出、诊断与内存监控

## 1 范围

该模块判断上次进程是否异常退出、导出脱敏诊断，并在内存中保留短期进程内存趋势。标签恢复数据由渲染层的会话持久化服务负责；主进程 `session-recovery.ts` 本身只维护 clean/abnormal 标志，不保存完整标签快照。

## 2 当前结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/session-recovery.ts` | electron-store 中的运行/干净退出标记 |
| `src/main/utils/session-recovery-state.ts` | `beginSession` / `finishSession` 纯状态转换 |
| `src/renderer/services/tab-session.ts` | 标签会话快照与恢复候选 |
| `src/main/modules/diagnostics.ts` | 应用、平台、Flash/Ruffle、资源、下载、内存和脱敏日志报告 |
| `src/main/modules/memory-monitor.ts` | 每 2 秒采样，最多保留 300 个趋势点和各进程类型峰值 |
| `src/main/ipc/diagnostics.ipc.ts` | 打开本地 SWF、导出诊断 JSON |
| `tools/probe/` | 构建、配置、git、日志与 BrowserView 的只读开发探针 |

## 3 异常退出与标签恢复

启动时 `initializeSessionRecovery()` 把上次 `running` 状态解释为异常退出，并立即记录本次运行。正常退出调用 `markCleanShutdown()`；主渲染进程连续崩溃等路径可先调用 `preventCleanShutdownMark()`，避免错误标记为正常。

UI 只有在 `getSessionRecoveryStatus().abnormalExit` 为真时才提供恢复。恢复候选来自 renderer 的 `tab-session.ts`，不是主进程模块虚构的 `SessionSnapshot` 文件。用户处理恢复提示后调用 `resolveSessionRecovery()` 清除本次提示状态。

## 4 诊断与隐私

`diagnostics:export` 让用户选择 JSON 保存位置，以 `0600` 模式写入 `createDiagnosticReport()` 的结果。报告包括版本、平台、资源存在性、下载和内存状态，并通过 `diagnostic-redaction.ts` 与 URL 隐私工具避免输出查询串、令牌和密码。

`file:open-swf` 只接受用户选择的 `.swf`，返回 file URL 给标签系统打开。

## 5 内存监控

`startMemoryMonitor()` 每 2 秒读取 `app.getAppMetrics()`，保留最近 300 个样本并记录各进程类型工作集/私有内存峰值；它不写 CSV、不主动终止进程，也不实现阈值告警。

## 6 测试与雷区

- Vitest 覆盖异常退出状态、标签会话合并、诊断脱敏、来源信息和内存数据形状。
- `npm run probe` 只读构建、配置、git 与日志；`probe:deep` 检查运行时 BrowserView。
- 不把密码、cookie、查询串或截图内容加入诊断。
- 正常关闭不能留下恢复提示；异常路径不能提前写 clean 标志。
