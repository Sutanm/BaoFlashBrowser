# M2 增量 1：设置存储 + 主题开关

2026-11-23 · 对应[新版架构 §4 数据](../discussions/2026-11-22-bfb-next-architecture.md#4-数据和基础模块)、[§6 M2 退出标准](../discussions/2026-11-22-bfb-next-architecture.md#6-交付顺序和验收)，以及 [M1 §10 移交 M2](../kickoff/m1-browser-slice.md#10-移交-m2) 的第 1 项（设置存储 + SQLite 迁移）。

本增量只做**存储层与主题语义**：设置库（v1 表）、`engine-rules.json` 一次性迁移、主题设置项与 `nativeTheme` 的映射。设置界面（`bao://settings` 标签页 + 齿轮叠加层）在下一个增量，本增量用外壳命令 `set-setting` 驱动并验证。

## 1. 决定与依据

| 决策 | 选择 | 依据 |
| --- | --- | --- |
| SQLite 绑定 | **`node:sqlite`**（内建，SQLite 3.51.2） | 出厂内核实测可用；零依赖、零打包增量、`@types/node` 自带类型；代价（实验性 API）由锁定内核 + 启动自检 + 适配层兜住。对比数据见 §5 |
| 迁移节奏 | v1 → v4 递增（本增量只到 v1） | 每个增量都真跑一次迁移器，能拿到「旧库升级后数据还在」的证据，而不是等 M3 才首次验证 |
| 库文件 | `<userData>/db/browser.sqlite3`（WAL） | `userData` 根目录是 Chromium 的地盘（`History`/`Cookies`/`Partitions/`），`db/` 子目录避免撞名；测试用 `--user-data-dir` 天然隔离 |
| 主题映射 | `theme.mode` 1:1 → `nativeTheme.themeSource` | 不自己维护第二套亮/暗状态：解析后的 `shouldUseDarkColors` 是唯一真源，它同时驱动外壳 token、系统窗口按钮、起始页的 `light-dark()` 与站点看到的 `prefers-color-scheme` |
| 写入顺序 | **先落库，成功才应用** | 反过来的话，磁盘满/只读会变成「界面变了但重启后自己变回去」 |

## 2. 改了哪些文件

新增：

| 文件 | 作用 |
| --- | --- |
| `app/src/shared/settings.ts` | 设置模型：`theme.mode` / `engine.default` / `locale`，默认值、`sanitizeSetting()`（唯一校验点）、行 ↔ 对象转换 |
| `app/src/main/db/sqlite.ts` | SQLite 适配层：参数校验（拒绝 `Date`/`NaN`）、WAL + 显式 busy timeout、可嵌套事务（SAVEPOINT）、语句缓存、错误码归一 |
| `app/src/main/db/store.ts` | 库布局 + 迁移器（`PRAGMA user_version`，事务内完成 DDL 与 `engine-rules.json` 导入）+ 各表读写原语。**不 import electron** |
| `app/src/main/storage.ts` | 存储单例：打开/降级、设置与规则的内存快照、写入后应用 `nativeTheme.themeSource` |
| `app/tests/data/settings-store.test.cjs` | 存储合同集成用例（6 条，真进程 + 真库） |

修改：

| 文件 | 改动 |
| --- | --- |
| `app/src/main/engine-rules.ts` | 从 JSON 文件改为读 `storage` 的快照；`resolve/remember/forget` 签名不变 |
| `app/src/main/browser-window.ts` | 投影新增 `settings`；新增 `set-setting` 命令（仅外壳可用）；设置变化后 `refreshAllWindows()` 重绘标题栏与投影 |
| `app/src/main/index.ts` | `whenReady` 里先 `initStorage()`（迁移 + 应用主题）再建窗口；`will-quit` 关库 |
| `app/src/shared/browser.ts` | `BrowserState.settings`、`{type:'set-setting'}`、三个稳定失败码（`invalid-setting` / `settings-save-failed` / `storage-unavailable`） |
| `app/src/shared/engine.ts` | `resolveEngine(rules, host, fallback)`：默认引擎改由设置决定 |
| `app/tests/smoke/theme.test.cjs` | 新增「设置驱动主题」用例（含重启保留、标题栏按钮真实配色断言） |
| `app/tests/smoke/helpers.cjs` | 新增 `launchAppAt(profilePath)`：复用已有 profile 重启 |
| `app/package.json` | 新增 `npm run test:data` |

## 3. 实现要点（都是实测踩到的）

1. **`Date` 会被静默写成 NULL。** 文档说「不支持的类型抛异常」，但内核（Node 22.22.1）上 `Date`、`NaN`、`Infinity` 都是静默变 NULL。适配层在绑定前抛 `INVALID_PARAM`，并有明确的报错文案（`Date 请先转成 epoch 毫秒`）。这是选 `node:sqlite` 的主要代价，已被拦在写入口。
2. **`busy_timeout` 默认是 0。** 内核默认不等锁，实测多连接抢锁 0.19 ms 就失败；适配层用 `new DatabaseSync(path, { timeout: 2000 })` 显式设置，并有外部持锁用例守护。
3. **不支持嵌套 `BEGIN`。** 内核抛 `cannot start a transaction within a transaction`；适配层用 `db.isTransaction` 判定，内层改 `SAVEPOINT/RELEASE`，所以迁移里的「建表 + 导入」可以安全地嵌在事务里。
4. **`PRAGMA user_version` 是事务性的**，与 DDL 一起提交：迁移要么整步生效，要么整步回滚。
5. **迁移的幂等锚点是库里的标记，不是 JSON 文件是否存在。** 用例覆盖：导入后手工删掉规则行，重启不会因为归档文件还在而「复活」它。
6. **导入失败不吃数据**：JSON 解析失败时不写标记、不改名，下次启动重试；迁移成功才 `rename` 成 `engine-rules.json.migrated-1`（保留，不删除）。
7. **旧库升级才备份**：`previousVersion > 0` 时先 `sqlite.backup()` 快照到 `db/backups/`（新建库没有可丢的数据，不产生空备份）。
8. **启动自检**：打开后跑 `PRAGMA quick_check`，非 `ok` 就当打开失败（降级为默认设置 + 只读提示），而不是带着坏库继续写。
9. **降级不双写**：库打不开时以默认设置运行、写入返回 `storage-unavailable`，**绝不**回头写 JSON——否则下次启动会读到两套数据。

## 4. 实跑命令与结果

环境：`Windows 10/11`，内核 `app/.runtime/win-x64/electron.exe`（`bao-v142-265-ppapi-sandbox`），每个会话先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE` 并设置 `ELECTRON_EXEC_PATH`。

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 通过（`vue-tsc --noEmit` 无输出） |
| `npm run test:data` | ✅ **6/6 通过**，8.65 s（1.13 / 0.62 / 1.00 / 1.05 / 1.95 / 2.92 s） |
| `npm run smoke` | ✅ **24/24 通过**，41.03 s（新增「设置里的主题模式」1.04 s；其余 23 条无回归） |
| `npm run build` | ✅ 通过（`out/main/index.js` 63.45 → **78.27 kB**，preload/renderer 不变） |

`test:data` 的 6 条覆盖：

| # | 用例 | 覆盖的合同 |
| --- | --- | --- |
| 1 | 设置写入落库并跨重启保留 | 真库行断言 + `nativeTheme.themeSource` 1:1 + 重启后仍生效 |
| 2 | 非法设置值被拒绝且不改变状态 | 未知键 / 错值 / 缺值 → `invalid-setting`，库里不留行 |
| 3 | `engine-rules.json` 一次性迁移：入表、归档、幂等 | 坏值丢弃、归档文件保留、删行后不复活 |
| 4 | 库里的坏设置值不影响启动 | 回落到默认值，不崩 |
| 5 | 硬杀（SIGKILL）后写入仍完整 | WAL 恢复 + `integrity_check=ok` + 重启读到值 |
| 6 | 写库失败不应用新值 | 外部连接 `BEGIN EXCLUSIVE` → `settings-save-failed`，`nativeTheme` 不变、库无半截数据 |

`smoke` 新增用例断言的三处（不是恒真条件）：外壳 `document.documentElement.dataset.theme`、`setTitleBarOverlay` 的**真实调用参数**（该 API 没有 getter，用例记录并比较亮/暗两次调用的 `color`/`symbolColor` 不同）、`nativeTheme.themeSource`；再加同一 profile 重启后模式仍在。

## 5. 绑定选型的实测数据（本增量沿用的结论）

| 维度 | `node:sqlite` | `better-sqlite3` 13.2.0 |
| --- | --- | --- |
| SQLite | 3.51.2 | 3.54.1 |
| 1000 次 upsert 中位（E39 内核） | 21.6 ms（0.022 ms/次） | 19.8 ms（0.020 ms/次） |
| 依赖/打包 | 0 / 0 | 原生二进制 2 MB + `files` 4 条否定模式 + 门禁哈希 |
| 类型 | `@types/node` 自带 | 需 `@types/better-sqlite3` |
| `ENABLE_SESSION`（变更集） | 有 | **无** |
| 危险默认 | `Date`→NULL（已拦） | 读 >2^53 静默丢精度 |

## 6. 未验证 / 明确不承诺

1. **`SQLITE_FULL` 未直接构造**：写失败路径用「外部连接持写锁」验证（错误码 `SQLITE_BUSY`），`errcode 13 → SQLITE_FULL` 的映射没有真实触发过。
2. **迁移 v1 → v2 未做**：书签/历史/下载表还没加，迁移器的「旧库升级 + 快照备份」分支在真实旧库上只跑过 v0→v1。
3. **按类别清理未做**（M2 §6「存储与清理验证覆盖异常退出」只覆盖了写入侧的异常退出）。
4. **`utilityProcess` 未接**：当前主进程同步写（0.022 ms/次）；10 万行批量导入会堵主线程（实测 383 ms，期间 1 ms 定时器一次都没触发），触发条件与搬迁路径写在适配层注释里。
5. **打包产物里未跑**：`userData` 路径与打包无关，但成品内的 `quick_check`/迁移未在 `smoke:packaged` 里验证。
6. **多窗口并发未测**：`refreshAllWindows()` 的广播路径没有双窗口用例。
7. **设置界面未做**：本增量只有命令；`bao://settings` 页与齿轮叠加层在增量 2。

## 7. 下一步

增量 2：`bao://settings` 内部页（新 scheme + 内部会话 + 标签模型 `internal` 标记 + IPC 三元组校验）+ 齿轮快捷叠加层（同一 store 同步）。接入点清单与实测结论见本轮子代理报告，产品决策 P1–P4 已确认：重叠层底部「全部设置」/ 地址栏 / `Ctrl+,` 三入口、设置页内输入 http(s) 新开标签、每窗口一个设置标签、内部会话 `persist:bao-next-internal`。
