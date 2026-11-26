# `--renderer-process-limit` 在 Electron 39 上不合并 WebContents（2026-11-26）

探针：`probe-renderer-limit.js`（同一脚本跑两次，只差一个开关）。

## 原始输出

| 跑法 | 渲染进程数 | 4 个视图的 pid | 总进程 |
| --- | --- | --- | --- |
| 默认 | **4** | 32904 / 29344 / 9476 / 34688 | 7 |
| `--renderer-process-limit=2` | **4** | 34540 / 33728 / 33552 / 31392 | 7 |

## 结论

1. **`--renderer-process-limit=N` 不能用来合并标签进程。** 四个视图（其中两个同站
   `probe://a.local`）在开关下仍然各占一个渲染进程。源码侧这个开关确实会被消费
   （`content/browser/browser_main_loop.cc` → `RenderProcessHost::SetMaxRendererProcessCount`），
   但 Electron 给每个 `WebContentsView` 建**独立 BrowsingInstance**，进程分配走的是
   "新 SiteInstance 直接建进程"那条路，`IsProcessLimitReached()` 根本没被问到。
2. 因此 B6 的"零代码路径"是**死路**。真要合并，只能在 `ContentBrowserClient` 层动手：
   - `ShouldUseProcessPerSite(profile, site_url)` — 同站固定进一个进程（站点粒度）；
   - `ShouldTryToUseExistingProcessHost(profile, url)` — 允许复用现成进程，但**选哪个是随机的**
     （`GetExistingProcessHost()` 从合适的候选里随机挑），表达不了"按引擎分池"。
   两者都需要内核补丁（约 30–60 行），而且要先解决"同引擎分组"的选择逻辑。
3. 与另一份实验（`app/tests/smoke/flash.test.cjs` 的"同页两个 `<embed>`"）合起来看：
   **能力上允许合并 Flash 标签**（两个实例共用一个 Pepper 进程），**工具上不允许**（没有受支持的
   开关）。所以 B6 的下一步是"写补丁 + 定分组规则"，不是"跑开关"。
