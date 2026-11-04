# 06 · 下载系统

> 状态：按 **1.1.2（2026-11-02）** 源码核对，取代 `docs/archive/modules-v1/06-downloads.md`。
> 行号会漂移，以语义为准。

## 1 范围与目标

下载同时支持 aria2 与 Chromium 两条引擎，默认 `aria2`（`config.ts` 的 `downloadEngine`
默认值），在实际不可用时回退 Chromium。主进程是下载记录的唯一权威源：实时进度由
`download:progress` 推送，持久化在 electron-store `download-state`，渲染层只消费。

**边界**：代理配置见 `docs/proxy-settings.md` 与 01，截图见 07。

## 2 静态结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/download.ts` | 引擎选择、aria2 进程与轮询、Chromium `will-download` 跟踪、暂停/恢复/取消 |
| `src/main/modules/download-state.ts` | electron-store 持久化、Map 缓存、重启归一化、终态裁剪 |
| `src/main/modules/download-proxy.ts` | 把 Chromium `resolveProxy` 的路由翻译成 aria2 选项 |
| `src/main/modules/aria2-locator.ts` | 随包候选、系统 PATH/`which` 候选、Linux 动态库目录 |
| `src/main/modules/aria2-rpc.ts` | JSON-RPC 客户端：随机 loopback 端口 + 随机 secret |
| `src/main/utils/download-path.ts` | 文件名清洗、重名避让、目录边界（含真实路径解析） |
| `src/main/utils/download-record.ts` | 记录合并、重启归一化、终态保留策略 |
| `src/main/utils/aria2-response.ts` | RPC 响应 schema（GID、状态字段） |
| `src/main/ipc/download.ipc.ts` | 下载 IPC；目录选择、打开文件夹、删除/打开校验 |
| `src/renderer/components/data/DatabaseHydrator.tsx` | 挂载时一次性 `download:list`，之后只靠事件 |
| `src/renderer/hooks/useDownloadListener.ts` | `download:progress` → Zustand + Toast |
| `src/renderer/components/panels/DownloadsPanel.tsx` | 引擎/就绪状态、任务列表、打开下载文件夹 |
| `src/renderer/components/panels/SaveDirectoryCard.tsx` | 「设置 → 下载与截图」的目录与引擎配置 |

## 3 核心行为

### 3.1 引擎选择与回退

1. `will-download` 在 **每个实际 session** 上注册（`defaultSession` 与 `persist:` 都要，
   标签使用 `persist:`）。
2. 若当前 URL 是 Chromium 重试队列里的任务，强制走 Chromium；否则读取
   `config.downloadEngine`（默认 `aria2`）。
3. `aria2` 且已就绪 → `preventDefault()`，解析代理后调 `aria2.addUri`；
   代理不支持或解析失败 → **当次回退 Chromium**，不会跳过代理直连。
4. `aria2` 未就绪 → 记 warn 并回退 Chromium。每条记录都带 `engine` 字段，
   面板按任务显示实际引擎。

### 3.2 aria2 启动链

候选顺序：随包二进制 → Linux `which aria2c` / Windows `PATH` 扫描。逐个尝试：
spawn → RPC 就绪（20 次 × 300ms）与进程早退竞速 → 成功则保留，失败则 `SIGKILL`
下一个；全部失败回退 Chromium 并广播 `aria2:status { ready:false }`。

spawn 参数关键项：`--no-conf=true`（禁用外部 `aria2.conf`）、`--allow-overwrite=false`、
`--auto-file-renaming=true`、`--continue=true`、`--max-concurrent-downloads=5`、
`--split=16`。进程环境会**删除** `http_proxy` / `https_proxy` / `ftp_proxy` / `all_proxy` /
`no_proxy`，避免继承的代理覆盖显式路由；Linux 随包候选额外补 `LD_LIBRARY_PATH`。

进程退出时，所有在途 aria2 任务置 `interrupted`、清空轮询定时器并广播未就绪。

### 3.3 进度、持久化与权威源

- aria2 轮询：进行中 500ms、暂停 1000ms；连续失败超过 5 次（`errorCount > 5`）→ `interrupted`。
- Chromium：`updated` 事件计算速度与进度，进度封顶 99.9；`done` 时 100 / 0。
- 持久化：终态（completed / cancelled / interrupted）立即落盘；进行中 1s 节流；
  终态最多保留 1000 条，进行中/暂停永不裁剪。
- 重启时 `progressing` / `paused` 一律归一为 `interrupted`（`normalizeRestartedDownload`）。

**2026-09-04 重构（commit `931a5c7`，不要再回退）**：渲染层曾用 Dexie 存 downloads
镜像，并由 `useLiveQuery` 回灌 store；每次写库会把进行中/暂停记录改写成 `interrupted`，
与 `download:progress` 形成 0.5–1s 反馈回路，导致"任务反复显示已中断、暂停失效"。
现状是主进程唯一权威：`DatabaseHydrator` 挂载时一次 `download:list`，用
`reconcileDownloadSnapshot` 合并"列表请求在途期间到达的事件"（按 `updatedAt` 取新，
快照中不存在的记录保留），之后只由事件驱动。`download:sync-records` IPC 与
`adoptDownloadRecords` 已随此次重构删除。

### 3.4 代理路由

`resolveDownloadProxy(sess, url)` 通过**真实 Chromium session** 解析路由（系统代理、
PAC、绕过规则都交给 Chromium），5 秒超时。`aria2ProxyOptions` 的规则：

- **只取路由结果的第一条**。跳过不支持的代理直接走 DIRECT 会静默绕过用户策略，
  因此 `aria2ProxyOptions` 返回 `null` 而不是降级。
- 只接受 `PROXY host:port` 与 `DIRECT`；SOCKS / HTTPS 代理返回 `null` → Chromium。
- 选项显式覆盖 `all-proxy` / `http-proxy` / `https-proxy` / `ftp-proxy`，并先置空
  `no-proxy` 以阻断继承的 aria2 配置；手动 HTTP 且未配置绕过时，再把 `no-proxy` 设为
  Chromium 的隐式回环列表
  （`localhost,.localhost,127.0.0.0/8,::1,169.254.0.0/16,fe80::/10`）。
- 每个新任务与重建的重试任务都会重新解析；aria2 内部的重定向不会逐跳重跑 PAC。

### 3.5 取消、暂停与恢复

引擎按记录里的 `engine` 分派（缺省时按 id 前缀 `a2_` / `cr_` 兜底）：

- aria2：`cancel` → `aria2.remove` 并置 `cancelled`；`pause` / `unpause` → 对应 RPC，
  失败返回 `false`；gid 丢失时用记录里的 URL 重建任务（重新解析代理）。
- Chromium：直接 `item.cancel/pause/resume`；item 已不在内存时，用记录 URL 重新入队
  `pendingChromiumRetries`，重试沿用原记录 id，且不会覆盖已存在的文件（走
  `availableSavePath` 生成 `name (1).ext`）。

### 3.6 路径与文件操作

- `sanitizeDownloadFilename`：剥离目录、控制字符、Windows 非法字符，处理
  `CON/PRN/AUX/NUL/COM1-9/LPT1-9` 保留名，超长按扩展名截断到 180。
- `availableSavePath`：同名文件存在时递增 `(n)`，不覆盖。
- `isPathWithinDirectory`：对**已存在的祖先**做 `realpath` 再拼接剩余段，防符号链接
  逃逸；Windows 比较时大小写不敏感。
- 删除要求路径在下载目录内且是普通文件；打开/打开所在目录还额外拒绝危险扩展名
  （`.exe .bat .cmd .ps1 .vbs .js .wsf .scr .com`）。

## 4 接口

| 通道 | 方式 | 说明 |
| --- | --- | --- |
| `download:start` | send | 仅 `http:` / `https:`；走 `defaultSession.downloadURL` |
| `download:cancel` | send | 按引擎取消 |
| `download:pause` / `download:resume` | invoke | 返回 `{ success: boolean }` |
| `download:list` | invoke | 返回全部记录（按 `updatedAt` 升序） |
| `download:aria2-status` / `download:get-dir` | invoke | 就绪状态与当前目录 |
| `download:set-dir` | invoke | 目录选择框；标题由渲染层传入以支持 i18n |
| `download:open-folder` | invoke | 创建并打开下载目录 |
| `download:remove-record` / `download:clear-finished` | invoke | 删记录 / 清终态 |
| `download:delete-file` | invoke | 目录内 + 普通文件校验 |
| `download:open` | send | 目录内 + 危险扩展名校验 |
| `download:openDir` | send | 目录内校验，打开父目录 |
| `download:progress`、`aria2:status` | 主 → 渲染 | 记录推送与引擎就绪 |

## 5 不变量与雷区

1. **下载记录只有一个权威源（主进程）**。不要再加 IndexedDB 镜像或用 `useLiveQuery`
   回灌实时状态；`reconcileDownloadSnapshot` 只用于启动一次性合并。
2. `setupDownloadHandlers` 必须覆盖 `defaultSession` 与 `persist:`；只配 default 会让
   标签页下载没有进度。
3. 代理不支持时要回退 Chromium，**不要**退化成 DIRECT。
4. 终态记录才立即落盘；进行中只节流写，否则高频进度会拖垮存储。
5. 不要声称 Chromium 下载完整支持断点续传；暂停/恢复受 Electron 与服务器行为限制。
6. 打开文件前必须同时过"目录边界 + 危险扩展名"；删除只需目录边界 + 普通文件。
7. aria2 stderr 只写 `electron-log` 且截断 200 字符，不转发到渲染层。

## 6 平台与验证

- Windows x64/ia32 各自携带匹配架构的 aria2；发布校验检查 PE 架构。
- Linux 随包 aria2 依赖系统 `libaria2.so.0`；缺失时再尝试系统 aria2，最后 Chromium。
- 单元：`npm test -- --run tests/download-path.test.ts tests/download-record.test.ts tests/download-proxy.test.ts tests/aria2-response.test.ts`。
- e2e：`npm run test:e2e -- tests/e2e/download-settings.spec.ts`（需先构建）。
- 探针：`npm run probe:deep -- --only 26-aria2-proxy`（实际代理路由）。
- 已知边界：`resumeDownload` 的重建路径使用 `session.defaultSession` 解析代理并发起
  重试，不保留原下载所属分区；跨 `persist:` 分区的恢复差异尚未单独验证。
