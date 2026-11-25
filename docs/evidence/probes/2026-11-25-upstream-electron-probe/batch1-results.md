# 批次 1 的改前/改后探针结果（#51200 / #50688 / #51900 / #51562）

2026-11-25 · 探针 [batch1-scenarios-probe.js](batch1-scenarios-probe.js) + 驱动 [batch1-run-probes.ps1](batch1-run-probes.ps1)。

## 结论速览

| 补丁 | 缺陷在 E39 上是否复现 | 打补丁后 | 处置 |
| --- | --- | --- | --- |
| #51200 隐藏视图拖动区 | ✅ 复现（`HTCAPTION`） | ✅ 消失（`HTCLIENT`），可见时仍 `HTCAPTION` | **已落**（0003） |
| #50688 Wrappable 延迟析构 | ✅ 复现（`Invoke in DisallowJavascriptExecutionScope`，退出即崩） | ✅ 干净退出 0 | **已落**（0004） |
| #51900 render-process-gone 顺序 | ❌ 未复现（E39 上同步 reload/navigate 未崩） | — | **已落**（0005，硬化；只能证明无回归） |
| #51562 无边框约束后缩水 | ❌ 症状不符（E39 是**变大** 1–2 px） | — | **暂不落** |

## 场景数据

### wrappable-gc（#50688）

```
v8.setFlagsFromString('--stress-incremental-marking')
new WebContentsView() × 20（故意泄漏）→ app.quit()
```

| 构建 | 退出码 | stderr |
| --- | --- | --- |
| 改前 `5BB2274F` | `-2147483645`（0x80000003） | `# Fatal error in , line 0` / `# Invoke in DisallowJavascriptExecutionScope` |
| 改后 `1444ADAC` | `0` | — |

### crash-reload / crash-navigate（#51900 / #53924）

在 `render-process-gone` 处理函数里**同步** `reload()` 或 `loadURL()`，再 `forcefullyCrashRenderer()`。

| 构建 | crash-reload | crash-navigate |
| --- | --- | --- |
| 改前 `5BB2274F` | survived（exit 0） | survived |
| 改后 `1444ADAC` | survived | survived |

两种构建都没崩 → 该缺陷在 E39/Windows release 构建上**未复现**，所以"打补丁有改进"无法证明；只能证明补丁未引入回归（冒烟全绿）。

### resizable-bounds（#51562 / #51252）

请求 400×300 的无边框/有边框窗口，切换 `setResizable(false)` 后重新 `setBounds(getBounds())`：

| frame | initial | afterDisable | afterReapply | afterEnable |
| --- | --- | --- | --- | --- |
| true | 401×301 | 401×301 | **403×302** | 403×302 |
| false | 401×301 | 401×301 | **402×302** | 402×302 |

上游 #51562 的症状是"**缩小**"，E39 实测是"**变大 1–2 px**"，且初始尺寸就已经是 401×301（上游 spec 期望 400×300）。
说明 E39 的 non-client inset 记账与 E44 不同（正是 #50809/#51287 那一族），**照搬 #51562 有把 1 px 误差放大的风险**，暂不落。

## 构建与冒烟

| 项 | 值 |
| --- | --- |
| 分支 / 提交 | `bao/e39-batch1`：`a5693f61ab`(#51200) → `08dac9259e`(#50688) → `6be576032a`(#51900) |
| 增量构建 | 105 步（`wrappable_base.h` 被广泛包含），326 s |
| 产物 | `out\Rel\electron.exe` SHA-256 `1444ADACEF7B6EC276388DEB43232AAB2071E99B37B376F68C9CCD4215EE03CE`，232,040,960 B |
| 冒烟 | `node scripts/test.cjs smoke` → 24 文件 / 47 通过 / 0 失败，57.6 s |

## 复跑

```powershell
& .\batch1-run-probes.ps1 -Exe <electron.exe 绝对路径> -Label <标签>
# 或单场景： electron.exe <本目录> wrappable-gc
```
