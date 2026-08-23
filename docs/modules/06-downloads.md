# 06 · 下载系统

## 1 范围

下载系统同时支持 Chromium `will-download` 和可选 aria2。主进程维护实时任务并将记录持久化；渲染层下载面板订阅进度和状态。

## 2 当前结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/download.ts` | 下载目录、Chromium handler、aria2 进程/RPC、暂停/恢复/取消 |
| `src/main/modules/download-state.ts` | electron-store 持久化、重启归一化、终态记录裁剪 |
| `src/main/modules/aria2-locator.ts` | 随包与系统 aria2 候选定位、Linux 动态库目录 |
| `src/main/modules/aria2-rpc.ts` | aria2 JSON-RPC 客户端 |
| `src/main/utils/download-path.ts` | 文件名清洗和目录边界检查 |
| `src/main/utils/download-record.ts` | 下载记录合并、重启状态和保留策略 |
| `src/main/ipc/download.ipc.ts` | 下载列表、目录、记录与控制 IPC |
| `src/renderer/hooks/useDownloadListener.ts` | 进度事件接入 Zustand/Dexie UI 数据 |

## 3 核心行为

- `setupDownloadHandlers(sess)` 必须对实际使用的 session 注册；标签使用 `persist:`，不能只配置 `defaultSession`。
- `download:start` 只接受 `http/https`，危险扩展名会被额外检查。Chromium 下载通过 `will-download` 统一报告进度。
- aria2 可用时可承担任务；找不到二进制、Linux 缺少 `libaria2.so.0` 或 RPC 失败时回退 Chromium。
- 活跃记录每秒节流持久化，完成/取消/中断立即写入；最多保留 1000 条终态记录。应用重启后原 `progressing/paused` 记录归一为 `interrupted`。

## 4 接口

- 查询：`download:aria2-status`、`get-dir`、`list`。
- 配置/记录：`set-dir`、`sync-records`、`remove-record`、`clear-finished`、`delete-file`。
- 控制：`download:start/cancel/pause/resume/open/openDir`。

文件删除与打开操作必须验证保存路径位于下载目录内；删除危险文件或目录外路径会被拒绝。

## 5 平台与验证

- Windows x64/ia32 分别携带匹配架构的 aria2；发布校验检查 PE 架构。
- Linux 随包 aria2 依赖系统 `libaria2.so.0`，否则尝试系统 aria2 再降级。
- Vitest 覆盖路径、记录合并/裁剪、aria2 定位和下载策略；发布校验覆盖二进制与架构。

## 6 雷区

1. Electron 11 同一 session 的监听器注册要避免互相覆盖。
2. 不把响应体整体读入内存；进度事件需节流。
3. 不能声称 Chromium 下载完整支持断点续传；暂停/恢复能力受 Electron 和服务器行为限制。
