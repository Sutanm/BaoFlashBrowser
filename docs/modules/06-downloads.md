# 06 · 下载系统

## 1 范围与目标

管理浏览器下载：默认下载器 + 可选外部下载工具（aria2）桥接，覆盖任务生命周期、进度上报、路径安全。

**边界**：只负责主进程侧调度与持久化任务表；界面在 renderer 的下载面板。

## 2 静态结构

| 文件 | 职责 |
|---|---|
| `src/main/modules/download-manager.ts` | 下载任务注册、进度收集、路径校验、事件分发 |
| `src/main/modules/download-aria2.ts` | aria2 桥接（RPC-lite）与普通 fallback 下载器 |
| `src/main/modules/download-path.ts` | 路径解析/安全（`isPathWithinDirectory`、文件名清洗、`{d}` 等占位符） |
| `src/main/ipc/dl.ipc.ts` | 下载 IPC：开始、暂停/继续、取消、改路径、打开目录、列表 |
| `src/renderer/services/` | `useDownloadListener` / 下载面板组件（进度条、暂停恢复） |

## 3 核心流程

### 3.1 任务生命周期

```
renderer 触发 dl:start({url, filename?, path?, savePath?})
  ├─ download-path.resolve 规范化目标目录（防越权/占位符）
  ├─ 通道选择：aria2 可用→ RPC；否则内置下载器（net.createWriteStream 流）
  ├─ 进度事件 download:progress({id, received, total, speed}) → renderer 面板
  └─ 完成/失败/取消 → download:finished / download:error（zod 事件）
```

- 多任务并发：任务表 `Map<id, TaskState>`；暂停=中止底层流/aria2 pause，恢复=续传（支持 Range 时）。
- 悬停进度窗口期去重（避免高频 event 挤满 IPC）。

### 3.2 路径安全

- 目标目录必须存在且位于允许区（`downloadPath` 配置 + 用户选择的绝对目录）；
- 文件名清洗非法字符、保留扩展名；
- 占位符 `{d}`（日期）逐段 resolve，杜绝 `..`。

### 3.3 外部工具桥（aria2）

配置开启时以 aria2 优先：`get global option dir` → 提交任务 `download` RPC，进度轮询（1s），`pause`/`unpause`/`remove` 透传；aria2 未安装/失败自动降级内置下载器并通知。

## 4 数据模型与接口

- `DownloadRecord`（持久化 `electron-store` 或 IndexedDB 双写）：
  `{ id, url, filename, savePath, status: queued|active|paused|done|error|removed, received, total, startedAt, completedAt, source:'window'|'external', mime? }`
- IPC（zod）：`dl:start / dl:pause / dl:resume / dl:cancel / dl:open / dl:list / dl:path`；事件 `download:progress/finished/error/added`。

## 5 安全边界与不变量

- 任意 url 需 `http/https://` 校验；file: 直下需用户确认路径。
- 写路径必须通过 `download-path` 安全解析（拒绝 `..`、空名、系统目录）。
- 大文件不整载进内存：钉住可续传；暂停不丢已落盘。
- 下载任务表与应用用户数据目录隔离（路径属 userData/downloads）。

## 6 兼容性

- 默认用 Electron 11 `session.on('will-download')` 之于 persist: session（SWF/游戏内资源下载走同管线）；aria2 仅桌面安装。
- 下载使用注意磁盘编码：文件名用系统 locale 转义（Windows ANSI 边界）。

## 7 测试策略

- Vitest：`download-path.resolve`（占位符、越权、非法字符）单测；`aria2` RPC 请求咒语单测（mock）。
- Electron smoke：`tests/electron/download-smoke.cjs`（本地 http 服务丢文件，验证进度/完成/暂停）。
- 探针：`03-scripts` 看下载快捷键绑定是否影响正常功能。

## 8 雷区与注意事项

1. progress 高频事件要在主进程做稀释（至少 500ms 节流），否则 IPC 通道被下载洪峰击穿。
2. 会话分区：`initSession` 后要在 persist: 上注册 `will-download`，别漏 default 会话。
3. 暂停后 resume 若无 `Accept-Ranges` 支持，必须重启流并允许丢进度。
4. 打开目录用 `shell.openPath`（目录不存在先建后开）。

## 9 演进建议

- aria2 手柄页加“速度限流/代理”配置项（当前仅 dir 直写）。
- 断点续传在 aria2 和内置下载器行为不一致（内置依赖服务端 Range），可统一失败回退策略。