# M2 增量：后台标签休眠（含 M3 预留）

2026-11-24 · 对应[架构 §3 标签](../discussions/2026-11-22-bfb-next-architecture.md#3-外壳标签与隔离)。
代码：`app/src/main/browser-window.ts`（`discardTab` / `revive` / `sweepDiscard` / `setKeepAwake`）、
设置项 `tab.discard`、标签右键菜单、`app/tests/smoke/tab-discard.test.cjs`。

## 1. 决定与实测

| 决策 | 选择 | 依据（实测） |
| --- | --- | --- |
| 丢弃手段 | 销毁 `WebContentsView`（保留标签元数据） | 冻结/降优先级不释放内存（0～+0.21 MiB）；销毁视图每标签回收 **≈111 MB** |
| 收益 | 6 标签 1161 MB → 休眠 5 个后 **619 MB** | 同机、同源、2000 段文本页面 |
| 代价 | 切回重新加载 **120 ms** + 网络 | 与 Chrome 丢弃语义一致（丢滚动/历史/表单） |
| 默认策略 | `tab.discard = auto`，TTL 10 分钟 | 挂机用户可在设置里整机关闭 |
| 标签级豁免 | 右键「保持活跃」(`keepAwake`) | 挂机/游戏标签单独豁免，复制标签继承 |
| 既有守卫 | 当前标签 / 内部页 / 置顶 / 有声 / 非 http(s) / 已崩溃 | 避免误伤 |

## 2. 实现要点

- `Tab.view` 改为可选；休眠时记录 `lastUrl`/`lastTitle`，`describe()` 用缓存字段投影（`discarded: true`）；
- `select()` 先 `revive()`；`reload` / `navigate` / `set-engine` 遇到休眠标签同样先唤醒；
- 扫描器 30 秒一次，窗口关闭时清理；切换活动标签时重置后台计时；
- 已加守卫的其余入口：`close` / `mute` / `pin` / `duplicate` / `tearoff` / DevTools / 内部页广播 /
  `ownsContents` / `internalSender` / `swapView`。

## 3. 验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ |
| `npx vitest run` | ✅ 100/100 |
| `node scripts/test.cjs smoke` | ✅ 20 个文件、30 通过 + 6 跳过、0 失败 |

`tab-discard.test.cjs` 三条：① 超时休眠 → 切回恢复标题/地址；② `never` 档不休眠；
③ `keepAwake` 标记期间不休眠、取消后恢复休眠。

## 4. M3 预留（本次**故意不做**，留空位）

| 预留项 | 空位在哪 | 收尾时要做什么 |
| --- | --- | --- |
| **TTL 可调** | `DISCARD_TTL_MS`（读 `BAO_DISCARD_TTL_MS`，仅测试用）；设置页「性能」卡片 | 新增设置项 `tab.discardTtl`（5/10/30 分钟），`sweepDiscard()` 改读设置；补设置校验与单测 |
| **自动判定挂机** | `sweepDiscard()` 的守卫链（目前只有显式 `keepAwake` / 有声） | 用「长时间无交互 + 持续音频输出/定时器活跃」做启发式，或提供「跟随系统空闲」档；需要防误判（例如仅后台且有音频 → 不睡） |
| **唤醒后恢复现场** | `revive()` 目前只按 `lastUrl` 重新加载 | 可选：休眠前存 `navigationHistory` 与滚动位置，唤醒后 `restore()` + 滚动复位（代价是休眠记录变大） |
| **休眠视觉** | 标签栏已有 `sleeping`（标题淡化）与 `awake-mark` | 目前无图标级提示；若要更明显可加「月亮/暂停」图标并补无障碍名称 |

以上四项都**不阻塞**当前功能；M3 动它们时不需要改协议或存储结构（`discarded`/`keepAwake` 已在快照里）。
