# E39（当前内核）缺陷复现：隐藏 WebContentsView 的拖动区

2026-11-25 · 对应上游修复 #51200（`c74de25b0170f67c772bbd845a7e8088edc203ab`）。
运行时：`app/.runtime/win-x64/electron.exe`（39.8.10 + PPAPI 沙箱补丁，**未打 #51200**）。

## 结论

**缺陷在当前运行时上存在，已实测复现。** 修复后的效果**尚未验证**（没有构建打过补丁的内核）。

## 方法

`drag-region-e39-repro.js`：建一个 `frame:false` 的窗口，窗口自身**没有**任何 `-webkit-app-region: drag`；
唯一拖动区来自一个子 `WebContentsView` 里的全屏拖动元素。然后按状态切换该视图可见性，
对窗口发 `WM_NCHITTEST`（屏幕坐标）看命中结果。

```powershell
# 关键调用（PowerShell + P/Invoke）
[U32]::SendMessage([IntPtr]$hwnd, 0x0084, [IntPtr]::Zero, $lParam)   # lParam = (screenY << 16) | (screenX & 0xFFFF)
```

判据：`HTCAPTION(2)` = 该点被当成标题栏（可拖动）＝缺陷；`HTCLIENT(1)`/`HTNOWHERE(0)` = 正常。

## 结果

| 状态 | `WM_NCHITTEST` | 含义 |
| --- | --- | --- |
| `baseline-no-view` | `1 HTCLIENT` | 基线：窗口自身没有拖动区 |
| `hidden` | **`2 HTCAPTION`** | **缺陷：不可见的视图仍在贡献拖动区** |
| `visible` | `2 HTCAPTION` | 正确行为（可见时就该能拖） |
| `hidden-again` | **`2 HTCAPTION`** | 缺陷复现 |
| `view-destroyed` | `1 HTCLIENT` | 命中测试跟随视图存在性 |

三个采样点（客户区 60,60 / 300,200 / 520,340）在 `hidden` 状态下全部返回 `2`。

## 解读

- 缺陷的判别条件**恰好就是"可见性"**：上游 #51200 的修复正是
  `if (!view() || !view()->GetVisible()) return HTNOWHERE;`，与实测的成因一一对应。
- 对应用的影响：飞窗（`shell-overlays.ts`）就是"隐藏的 WCV"，外壳顶部又是拖动区，
  因此隐藏飞窗覆盖的区域仍会把点击变成"拖动窗口"。
- **仍未证明**"打上补丁后不再拖动"。这需要：改 2 行 → `ninja -C out\Rel electron` →
  复跑本探针 → 断言 `hidden` 返回 `1`/`0`。

## 改后验证（2026-11-25 09:51 完成）

补丁：`docs/kernel/0003-51200-hidden-view-drag-regions.patch`（内核树分支 `bao/e39-51200`，提交 `a5693f61ab`，+7 行）。
E39 适配点：E39 的 `WebContentsView` 自身就是 `views::View`，所以守卫写 `GetVisible()`，不是上游的 `view()->GetVisible()`。

构建：`ninja -C out\Rel electron` 增量（1 个 CXX + 链接），**352 s**。
产物：`out\Rel\electron.exe` SHA-256 **`544E94FB…DE3F0351`**（改前 `5BB2274F…12667366`）。
验证运行时：`.runtime/win-x64-patched-51200`（其余文件硬链接到原 `.runtime/win-x64`，**原运行时未改动**）。

| 状态 | 改前 `5BB2274F` | 改后 `544E94FB` | 结论 |
| --- | --- | --- | --- |
| `baseline-no-view` | `1 HTCLIENT` | `1 HTCLIENT` | 不变（基线正确） |
| `hidden` | **`2 HTCAPTION`** | **`1 HTCLIENT`** | **缺陷消失** |
| `visible` | `2 HTCAPTION` | `2 HTCAPTION` | 不变（**可见时仍可拖动，无回归**） |
| `hidden-again` | **`2 HTCAPTION`** | **`1 HTCLIENT`** | 缺陷消失 |
| `view-destroyed` | `1 HTCLIENT` | `1 HTCLIENT` | 不变 |

应用冒烟（`ELECTRON_EXEC_PATH` 指向打补丁的 exe）：`node scripts/test.cjs smoke` →
**24 个文件、47 通过、0 失败**，60.2 s，含 `tabs` / `tearoff` / `tab-discard` / `quick-settings` / `titlebar` /
`session-restore` 等全部通过。

## 复跑

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'D:\java_workspace\BaoFlashBrowserNext\app\.runtime\win-x64\electron.exe'
$psi.Arguments = '"<本目录>"'   # 需同目录 package.json 指向 main.js
# 读 stdout 的 PROBE_HWND / STATE 行，对每个 STATE 发一次 WM_NCHITTEST
```

配套的比对脚本 `compare-e39-vs-upstream.js` 用来把上游补丁的"修复前代码块"在 E39 源码里精确查找
（本轮结果：`shell/` 下 71 个 hunk → 32 原样存在 / 22 有锚点但漂移 / 17 找不到）。
