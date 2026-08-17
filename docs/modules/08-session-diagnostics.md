# 08 · 会话恢复、诊断与内存监控

## 1 范围与目标

- **会话恢复**：崩溃/异常退出后恢复上次打开的标签、窗口状态与设置；
- **诊断**：向渲染层/开发者输出环境、日志、崩溃数据的可观测通道；
- **内存监控**：纯观测采样（**无阈值告警**），记录后台数据供人工/外部分析。

**边界**：内存监控不主动杀进程（只记录）。

## 2 静态结构

| 文件 | 职责 |
|---|---|
| `src/main/modules/session-recovery.ts` | clean/abnormal 退出标志、恢复会话数据序列化/反序列化 |
| `src/main/modules/session-recovery-session.ts` | `app.on('session-end')` 钩子保存恢复快照（JSON/文件） |
| `src/main/modules/diagnostics.ts` | 导出环境/版本/GPU/JSON 结构化诊断 |
| `src/main/modules/memory-monitor.ts` | 周期采样进程/会话内存（`getAppMetrics`），追加写入日志文件 |
| `src/main/ipc/diagnostics.ipc.ts` | 渲染层取诊断/日志接口 |
| `src/renderer/.../DiagnosticsPanel` | 渲染层诊断面板 |

## 3 核心流程

### 3.1 退出与恢复

```
app 'before-quit' / 'session-end'
  ├─ markCleanShutdown()：写 clean 标志 + 恢复快照（打开标签列表 + 活动索引 + 窗口边界）
  └─ 异常退出（渲染进程崩溃后未 clean）→ 下次启动 restoreSession() 读取快照
```

- 快照格式：`{ version, tabs:[], activeTabId, bounds, settingsSubset }`；
- 崩溃路径：`render-process-gone` → reporter 记崩溃 + 触发 `markUnclean`（见 01 §3.1）；
- 恢复时逐项重建标签，贴上 `{restored:true}` 让 UI 高亮“已恢复”。

### 3.2 诊断

- `about:diagnostics`（渲染层页）：环境（OS/node/electron）、GPU、session 分区、版本号校验（package+index.ts 一致性）、日志目录打开。
- IPC：`diagnostics:get` 返回结构化；日志 tail 经 `file` IPC 白名单只读。

### 3.3 内存监控（观测）

```
setInterval(60s) → process.getProcessMemoryInfo/getAppMetrics
  ├─ 每个附加渲染进程 { pid, workingSetSize, created } → append CSV/行日志
  ├─ 含 persist: 会话的磁盘增长采样
  └─ 无阈值、无介入（V1.1 定位：数据底座）
```

实现注意：采样要在后台，不阻塞主线程；日志路径 userData/logs。

## 4 数据模型与接口

- `SessionSnapshot`：`{ version, createdAt, tabs: Array<{url,title,isRuffle,rude?}>, activeTabId, bounds }`。
- `DiagnosticsInfo`：`{ versions, platform, gpu, partitions, spellCheckDisabled,… }`。
- IPC：`session:restore / session:snapshot`、`diagnostics:get / diagnostics:logs`、`memory:sampling` 开关。

## 5 安全边界与不变量

- 恢复快照只含 URL/标题等非敏感字段（不含密码保险库、cookies）。
- 日志文件权限默认用户级；诊断面板不渲染密码 store 明文（见 05 约束）。
- 只追加不清理日志（供审计），上限由 OS 或外部轮转。

## 6 兼容性

- WIn/Linux 崩溃场景差异：GPU 相关崩溃走诊断 GPU flags（WSLg 三开关）。
- session-end 与 before-quit 在 Linux 上触发时机不同，恢复由 createWindows 后 restore 保证一致。

## 7 测试策略

- Vitest：`session-snapshot.test.ts`（序列化/反序列化、字段校验、损坏快照容错）、`diagnostics` 输出结构断言、`index.ts` 版本与 package.json 一致性单测。
- Electron smoke：`tests/electron/session-recovery-smoke.cjs`（kill -9 模拟异常退出 → 重启恢复）。
- 探针：`04-logs.cjs`、`02-config`（诊断面板数据）、`00-build`.

## 8 雷区与注意事项

1. 快照写入必须**在退出路径尽量同步**，`session-end` 是可用的最后险襟；不要依赖 async fs 在退出后完成。
2. `markCleanShutdown` 只能由正常退出调用；渲染层 3 次崩溃自动 reload 后 `preventCleanShutdownMark()` 介入。
3. 恢复标签时同样受 webRequest/初始化时序约束（02/01 的 sendSync 预注册）。
4. 内存采样不引入阈值告警的逻辑分支，避免“以为会杀进程”。

## 9 演进建议

- 给内存采样加小时级聚合摘要 + 阈值**观测性**告警（仅通知不介入），为后续自动悬挂策略（01）供数据。