# 内核增量：E39 回拣批次 4（无边框缩放带的 DPI 修正）

2026-11-25 · 对应 [E39 回拣实施计划](../kernel/2026-11-25-e39-backport-plan.md) 的几何组。
前序：[batch1](2026-11-25-e39-backport-batch1.md) · [batch2](2026-11-25-e39-backport-batch2.md) · [batch3](2026-11-25-e39-backport-batch3.md)。

## 1. 为什么不是 #50706

原计划是回拣 #50706「external resize hit targets」。读完补丁与 E39 源码后确认它是**一整套窗口几何重构**：

| #50706 依赖的符号 | E39 是否有 |
| --- | --- |
| `NativeWindowViews::GetRestoredFrameBorderInsets()` | ❌ 无 |
| `NativeWindowViews::LogicalToWidgetBounds()` / `WidgetToLogicalBounds()` | ❌ 无 |
| `native_window_view_->has_thick_frame()` | ❌ 无 |
| `WinFrameView::RestoredFrameBorderInsets()` | ❌ 无 |

同族的 #51503 又建立在这些之上（它改的是 #50706 引入的 `ResizingBorderHitTest` 与 `RestoredFrameBorderInsets`）。
也就是说：**要 #50706 就得先回拣 #50809/#51252 那一族的边界重构**，而它会把 `getBounds()` 的语义整体改一遍——我们的冒烟在 tearoff、弹窗、飞窗定位上都断言了几何，风险与收益不成比例。

## 2. 改成了什么（4 行 + 两个 include）

`shell/browser/ui/views/frameless_view.cc`：

```cpp
int FramelessView::ResizingBorderHitTest(const gfx::Point& point) {
  float scale = 1.0f;
  if (auto* window = frame_->GetNativeWindow()) {
    scale = display::Screen::Get()->GetDisplayNearestWindow(window).device_scale_factor();
  }
  const int inside_bounds =
      std::max(1, static_cast<int>(std::lround(kResizeInsideBoundsSize * scale)));
  return ResizingBorderHitTestImpl(point, gfx::Insets(inside_bounds));
}
```

`kResizeInsideBoundsSize` 一直是按 **DIP** 定义的（5），但命中测试拿到的点在**高 DPI 下按设备像素**到达，于是 150% 屏幕上实际只剩约 3 物理像素——这正是"鼠标抓不住窗口边缘"的原因。

## 3. 实测（150% DPI，`WM_NCHITTEST` 逐像素取样）

| 构建 | 边缘可抓区（物理像素） |
| --- | --- |
| 改前 `2FD3B40A`（常量 5，无换算） | 约 **3–4** |
| 实验：常量改 10、不换算 | 约 **9–10**（证明"带宽 ≈ 常量物理像素"） |
| **改后 `0A7C92A9`（5 DIP × 1.5）** | 约 **8** |
| 官方 Electron 44 参考（Chromium 152） | 5–7，**外加窗口外的命中带**（同请求 400×300 的窗口矩形是 415×310） |

### 三档缩放实测（真实系统缩放，新旧内核对照）

| 显示缩放 | 旧内核（无 0008，`5BB2274F`） | 新内核（含 0008，`0A7C92A9`） | 5 DIP 应有带宽 |
| --- | --- | --- | --- |
| 100% | 4 px | **4 px** | 5 px（取整/边界差 1） |
| 150% | 4 px | **7 px** | 7.5 px |
| 200% | 4 px | **9 px** | 10 px |

四个方向（左/右/上/下）在每个缩放比下读数一致；100% 与 200% 各复测一次，结果稳定。

**旧内核恒为 4 px**（不随 DPI 变化）＝ 缺陷本身；**新内核 4 / 7 / 9 px** 分别对应 5 DIP 在 100% / 150% / 200% 下的换算值。
**100% 下新旧完全相同**，即改动在无缩放时是恒等变换。

四条边表现一致（左/右/上/下都在同一档位切换），角部仍由 `kResizeAreaCornerSize = 16` 控制，未改动。

## 4. 验证与装配

| 项 | 结果 |
| --- | --- |
| 构建 | 增量 2 步（`frameless_view.obj` + 链接） |
| 产物 | `out\Rel\electron.exe` SHA-256 `0A7C92A9388D3A4F61E54FDBE273868BB5C66BFE4CBEE14CBADF1950D7B1DE3F` |
| 运行时 | 已装配，tag `…+e39-batch4`；上一版（batch3）exe 备份在 `.runtime/win-x64-before-e39-batch4` |
| `runtime:check` | ✅ |
| 冒烟 | **57 用例 / 51 通过 / 0 失败 / 6 跳过**，173.6 s |
| 补丁 | [`0008-frameless-resize-band-dpi.patch`](../kernel/0008-frameless-resize-band-dpi.patch)（提交 `353fb66eb0`） |

## 5. 已知边界

| 项 | 说明 |
| --- | --- |
| **没有窗口外命中带** | 那需要 #50706 的 `GetClientAreaInsets` 缩进 + 边界换算；现在只能"向内"扩大可抓区（8 px 已经够用，但光标必须落在窗口内）。 |
| 100% DPI 下无变化 | `scale = 1` → 仍 5 DIP，行为与今天一致（无回归面）。 |
| 页面顶部 8 px | 页面区域上沿 / 下沿 / 左右各 8 px 现在是缩放带，点击会变成拉窗口。这与 Chrome/Edge 的无边框一致，但**如果将来页面需要在边缘放可点击控件**，要记得这条。 |
| 最大/全屏 | `ResizingBorderHitTestImpl` 内部已经在最大化/全屏时禁用重叠手柄（`allow_overlapping_handles`），未受影响。 |

## 6. 回退

```powershell
Copy-Item .runtime\win-x64-before-e39-batch4\electron.exe .runtime\win-x64\electron.exe -Force
# manifest：exe 哈希改回 2FD3B40A…、kernel.tag 改回 …+e39-batch3、去掉 0008
```
