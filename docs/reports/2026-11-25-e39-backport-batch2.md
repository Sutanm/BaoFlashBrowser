# 内核增量：E39 回拣批次 2（#53031）

2026-11-25 · 对应 [E39 回拣实施计划](../kernel/2026-11-25-e39-backport-plan.md)。
批次 1 见 [2026-11-25-e39-backport-batch1.md](2026-11-25-e39-backport-batch1.md)。

## 1. 批次内容

| 补丁 | 上游 | 提交 | 改动 | 结论 |
| --- | --- | --- | --- | --- |
| [`0006-53031-detached-view-bounds.patch`](../kernel/0006-53031-detached-view-bounds.patch) | #53031 `96f3996` | `5faf91f967` | `InspectableWebContentsView` 增加 `SetContentsViewBounds()`：视图不在 Widget 里时把尺寸直接 `Resize` 给 WebContents（+20 行） | **采用并装配** |
| — | #55955 `46980d7` | — | 换宿主时重定向 `NativeWindowRelay` | **暂不采用**：缺陷真实存在，但 E39 里没有任何消费者出现在我们的路径上（详见 [batch2 复查](../evidence/probes/2026-11-25-upstream-electron-probe/batch2-detached-bounds.md)） |

## 2. 改前/改后（真实运行时，`innerWidth × innerHeight`）

| 场景 | 改前 `7925BA9E` | 改后 `1C1DE6B1` |
| --- | --- | --- |
| 从未 attach → `setBounds(400×300)` → load | `[0,0]` | **`[400,300]`** |
| attach 后 `setBounds(400×300 → 500×400)` | `[400,300] → [500,400]` | 相同（无回归） |
| `removeChildView` 后 `setBounds(520×420)` | `[500,400]`（stale） | `[500,400]`（**已知缺口**） |
| 叠加层顺序：`setBounds(360×240)` 早于 `addChildView` | 附着前 `[0,0]` → 附着后 `[360,240]` | 附着前 **`[360,240]`** |

第三条没修好的原因：E39 上视图脱离窗口后 `setBounds` 不再触发 `Layout()`，而上游修复挂在 `Layout()` 里。产品不依赖该顺序（tearoff 是 detach → 立刻 attach → 再 layout），因此接受这个缺口。

## 3. 构建与账目

| 项 | 值 |
| --- | --- |
| 内核树分支 | `bao/e39-batch2`（基于 `bao/e39-batch1`）：`5faf91f967` |
| 构建 | 增量：10 步（含 4 个 TU 重编）→ 后续微调 2 步 |
| 产物 | `out\Rel\electron.exe` SHA-256 `1C1DE6B17283C15E9F817D29890AB7462C60129F73F0B91E09D8CBCBFD6C62B1` |
| 运行时 | 已装配；上一版（batch1）整体备份到 `.runtime/win-x64-before-e39-batch2` |
| 新 tag | `bao-v142-265-ppapi-sandbox+win-ppapi-process-sandbox+e39-batch2` |
| manifest | exe 哈希、`kernel.tag`、`kernel.patch`、`patches`（新增 0006）、`electronCommits`（新增 `5faf91f967`）、`fallbackTag` → batch1 tag |

## 4. 验证

| 项 | 结果 |
| --- | --- |
| `npm run runtime:check` | ✅ 内核与插件匹配（新 tag） |
| 探针 A–D | A/D 修复，B 无回归，C 已知缺口 |
| `node scripts/test.cjs smoke --serial`（已装配运行时） | ✅ **56 用例 / 50 通过 / 0 失败 / 6 跳过**，179.8 s |
| 原生 Flash | ✅ 本次不再跳过（manifest 哈希匹配）：PPAPI 注册、JS 桥、插件内键盘回环均通过 |

**已知 flake（与本次补丁无关）**：`engine-rules.test.cjs` 在整套串行里出现过一次 32 s 超时
（`panel 叠加层未显示预期控件：记住当前引擎`）；同一构建单跑 3/3 通过、整套复跑也通过。

## 5. 装配过程的一个坑（值得记住）

`Move-Item .runtime\win-x64 <备份>` 被 `resources/default_app.asar` 的占用挡住（该文件被
`node_modules/electron` 的启动器副本映射），结果只搬走 469/470 个文件，留下半个目录，`runtime:prepare`
又因为"目标目录已存在"而拒绝执行。

处置：
1. 从 `win-x64-batch2-test` 把缺的那一个 asar 补进备份，备份恢复成完整 470 文件；
2. 手工执行与 `prepare-runtime.cjs` 等价的装配（staging → 覆盖到现有目录，保留被占用的同名 asar，内容相同）；
3. 残留的 `win-x64-patched-51200`、锁定的 asar 需在无 Electron 进程时再手工清理。

**下次的稳妥做法**：装配前确认没有 Electron 进程、并先试 `Move-Item`；或直接把备份做成
`robocopy /MIR` 到新目录，而不是依赖目录改名。

## 6. 下一步

| 项 | 说明 |
| --- | --- |
| 几何组 | #51252 / #50706 / #51503 / #51562 共享一套 E39 缺失的 inset 基础设施，需先做归属调查 |
| API 类 | `clone()` / `setBackgroundBlur` / `focusOnNavigation`，每条"内核 + 应用 + 用例"原子提交 |
| #55955 | 等 webview / OSR / 下载 / 独立 DevTools 真正落地时再评估 |

## 7. 回退

```powershell
Move-Item .runtime\win-x64 .runtime\win-x64-batch2-tmp
Move-Item .runtime\win-x64-before-e39-batch2 .runtime\win-x64   # batch1 内核（7925BA9E）
# manifest 把 exe 哈希改回 7925BA9E…、kernel.tag 改回 …+e39-batch1
```
