# 测试变慢的优化：构建缓存 + 按文件并行

2026-11-24 · 起因：全量冒烟 110 s，用例还在增加。

## 1. 先量清楚时间花在哪

| 项 | 数值 | 来源 |
| --- | --- | --- |
| 全量冒烟（串行，含构建） | **110.5 s** | `node scripts/test.cjs smoke --serial` |
| 其中 typecheck + electron-vite build | **6–7 s** | 每次调用都跑一遍 |
| 单次 Electron 启动 + 关闭 | **0.7–0.8 s + 0.1–0.2 s** | 3 次抽样：721/793/680 ms |
| 冒烟里应用实例总数 | ~35 个 | 18 个文件、部分文件多实例 |
| 最慢的单个用例 | 19 s（引擎面板切换 + 站点规则） | 串行日志 |

结论：**串行 + 每次重建**。用例本身大多 1–4 s，真正被浪费的是「一个文件一个进程串着跑」和「每次都重建」。

## 2. 改了什么

### 2.1 构建缓存（`scripts/build.cjs`）

`buildIfChanged()` 先算指纹（`src/`、`scripts/`、`tests/`、`package.json`、`electron.vite.config.ts`、`tsconfig.json` 的内容哈希），
指纹一致且 `out/` 存在就跳过 typecheck + build：

- `BAO_FORCE_BUILD=1` 强制重建；
- `BAO_SKIP_TYPECHECK=1` 只构建、不跑 vue-tsc。

省下 **6–7 s**/次。

### 2.2 按文件并行（`scripts/test.cjs` + `runPool`）

- 每个**文件**一个 node 进程（文件内仍串行，`--experimental-test-isolation=none --test-concurrency=1`）；
- **动态队列**：谁跑完谁领下一个文件，不按固定分组（分组会有长尾：之前 3 组里有一组 55 s、另两组 31 s）；
- **长文件优先**：`.cache/test-durations.json` 记录每个文件的耗时，下次按耗时倒序发车；
- 输出写文件，**只在失败时整段打印**，避免多进程 TAP 交错；
- 默认并发 **4**；`--jobs=N` 调整，`--serial` 回到单进程。

## 3. 实测（同一台机器，隐藏模式）

| 方式 | 用时 | 结果 |
| --- | --- | --- |
| `--serial`（含构建） | 110.5 s | 28 通过 + 6 跳过，0 失败 |
| `--jobs=2` | 57.8 s | 全绿 |
| `--jobs=3`（固定分组时代） | 46.2 s | 全绿 |
| `--jobs=4` | **35.3 s / 35.9 s** | 全绿（跑两次） |
| 默认（jobs=4 + 构建缓存命中） | **37.7 s 用例 + 构建缓存跳过** → 41.6 s（本次含重建） | 全绿 |

**约 2.7–2.9 倍**，且用例越多收益越大（并行度不变，串行时间线性增长）。

## 4. 现在的瓶颈

`engine.test.cjs` 在并发下要 30–34 s，已经盖住其他文件（第二慢的 14 s）。
它是**单个用例**里做了约 10 次「开面板→切引擎→等关闭」外加 3 次真实导航，属于内容本身，
不是等待超时。要继续压，只能：

1. **文件内复用应用实例**（4 个用例现在各启动一次，约 3 s）；需要处理用例间的状态隔离；
2. 把那个 19 s 的用例**拆成两个文件**，让并行度利用起来（拆开后两块可同时跑）；
3. 继续提高并发（`--jobs=6`）——收益递减：临界路径是那一个文件，多开只会让单文件更慢。

## 5. 未验证

- `--jobs>=5` 没跑（临界路径决定收益很小）。
- 只测了冒烟；`data`/`packaged` 走同一路径（`data` 单文件时 `jobs=1`，实测 11.1 s 含构建）。
- 并行下用例的偶发失败率：跑了 4 次 jobs=4 全绿，但样本小；若后续出现「并行才失败」，先怀疑窗口焦点/临时 profile 冲突。

## 6. 别人是怎么解决的（调研）

| 做法 | 来源 | 与我们的关系 |
| --- | --- | --- |
| **worker 级 / spec 级复用应用实例**：Playwright 只有 test 与 worker 两种 fixture 作用域，社区在推 spec 级——「worker 太粗（日志难查）、test 太细（每个用例重启应用太贵）」 | [playwright#33355 spec-scoped fixtures](https://github.com/microsoft/playwright/issues/33355) | 我们目前是 **file 级**（每个文件一个 node 进程、文件内可以共用实例，但我们仍每次 launchApp）。文件内复用是下一步 |
| **每个 worker 独立 userData / 独立端口**，本地默认串行、CI 上才开并行 | [dyad#3797 开启 e2e 并行](https://www.cubic.dev/pr/dyad-sh/dyad/pull/3797) | 我们每个 `launchApp()` 本来就建独立临时 profile，天然满足；`data`/`packaged` 这类共享状态的套件保持 `jobs=1` |
| **共享单例 → 只能 `workers: 1`**；要并行必须先把单例应用、数据库拆开 | [aionui: E2E 并行可行性](https://github.com/iofficeai/aionui/blob/1afdf95c187f24198ab502a3c86cb2ef40bc3c6f/tests/e2e/docs/parallel-feasibility.md) | 我们**没有**共享单例（每个文件独立进程），所以可以直接并行——这是我们能拿到 3 倍的原因 |
| **合并同类断言到同一次启动**：把共享同一 Electron fixture 的断言合并成一条 journey；作者明确说「单纯提高 worker 并发不会消除重复工作，还会重新引入焦点竞态」 | [apache/maka#2390](https://github.com/apache/maka/issues/2390) | 和我们对 `engine-rules` 的处理方向一致（先拆、再考虑合并）；也提醒了并行的代价——我们确实撞到一次 `tearoff` 焦点竞态 |
| **复用浏览器/应用实例，而不是每个用例重启**；启动参数用 `--disable-gpu`、`--no-sandbox`、`--disable-dev-shm-usage` | [Playwright 性能优化实践](https://www.volcengine.com/article/1804644) | 我们暂未加启动参数：`--disable-gpu` 会影响 Ruffle/Flash 的渲染路径，需要单独验证，收益也只有每次启动几百毫秒 |
| **延迟非核心初始化 + `ready-to-show`**，减少内核启动时间 | [Electron 启动优化](https://cloud.tencent.com.cn/developer/article/2757791) | 我们已经在用 `ready-to-show`；进一步可以把存储迁移、预热视图放到窗口显示之后（预热视图已经是延后 600 ms） |

一句话：**主流量法跟我们这两条一样（构建只做一次 + 并行分片），差别在「复用粒度」——业界推荐 spec 级复用，我们目前是「文件级进程 + 每个用例各自启动」。**

## 7. 下一步（按收益排序）

1. **文件内复用应用实例**（`before/after` 起一个 app，用例之间做状态重置）：每文件省 1–3 次启动，约 1–3 s；`startup`/`tabs` 这类会改动窗口状态的用例不适合，需逐个评估。
2. **`--disable-gpu` 等启动参数**先做 A/B（`flash`/`ruffle-*` 必须复测，渲染路径变了）。
3. CI 上按文件分片（`--shard`），本地保持 `jobs=4`。
