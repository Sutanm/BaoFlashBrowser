# 几何组 inset 归属调查（150% DPI 实机）

2026-11-25 · 起因：几何组 4 条补丁（#51252 / #50706 / #51503 / #51562）都问"E39 到底缺什么"，需要先把 non-client inset 的账算清。
探针：[probe-inset.js](probe-inset.js)（几何账）、[probe-resize-band.js](probe-resize-band.js)（缩放带）。

## 0. 结论

| 补丁 | 判定 | 依据 |
| --- | --- | --- |
| #51287（全屏残留 inset / 白边） | ❌ **不存在该缺陷** | 全屏 `size = content = 1707×1067 = 屏幕`，inset `0×0` |
| #51562（约束后缩水） | ❌ **不在产品路径** | 有边框窗口 inset `15×64`，无边框仅 `1×1`；产品只用无边框 |
| #51252（setResizable 后 bounds 不稳） | ❌ 同类，低价值 | 实测只是 ±1 px 漂移，且无边框重新应用 bounds 后 inset 反而变 `0×0` |
| **#50706 + #51503（无边框缩放带）** | ✅ 真差异，但**已用 4 行的 DPI 修正（0008）覆盖主因** | E39 原为约 **3 物理像素**；修复后约 **8**（E44 为 5–7 外加窗口外命中带）。#50706 本体的"外部命中带"仍因依赖边界重构而暂缓 |

## 1. 几何账（150% 缩放，屏幕 1707×1067，工作区 1707×1019）

| 状态 | size | content | inset | 偏移 |
| --- | --- | --- | --- | --- |
| 有边框 400×300 | 401×301 | 386×237 | **15×64** | (7,56) |
| 有边框 + setMinimumSize | 401×301 | 386×237 | 15×64 | (7,56) |
| 有边框 + 重新应用 bounds | 402×302 | 387×238 | 15×64 | (8,56) |
| 无边框 400×300 | 401×301 | 400×300 | **1×1** | (0,0) |
| 无边框 + setMinimumSize | 401×301 | 400×300 | 1×1 | (0,0) |
| 无边框 + 重新应用 bounds | 402×302 | **402×302** | **0×0** | (0,0) |
| 无边框 最大化 | 1722×1034 | 1707×1019 | 15×15 | (8,8)，content 恰等于工作区 |
| 无边框 全屏 | 1707×1067 | 1707×1067 | **0×0** | (0,0)，与屏幕完全一致 |

要点：

1. **有边框窗口的 inset 是 15×64**（标题栏 56 + 边框），这正是 `GetRestoredFrameBorderInsets()` 要喂给约束换算的量；产品是无边框，用不上。
2. **无边框窗口只有 1×1**（`WS_THICKFRAME` 的 1 px 边框），重新应用 bounds 后连这 1 px 也没了 —— 无害的 1 px 跳变。
3. **全屏 inset 为 0** → #51287 描述的"白边"在 E39 上无从复现，不是移植难度问题，是没有缺陷。

## 2. 缩放带 A/B（同一台机器、同一 DPI）

沿窗口四边/四角向内取样，发 `WM_NCHITTEST`（屏幕坐标，物理像素）：

| 距边距离 | E39（Chromium 142） | E44（Chromium 152） |
| --- | --- | --- |
| 1 px | `HTLEFT` / `HTRIGHT` / `HTTOP` / `HTBOTTOM` | 同 |
| 3 px | 同上 | 同上 |
| **5 px** | **`HTCLIENT`（抓不到）** | `HTLEFT` / `HTRIGHT` / `HTBOTTOM`（top 已 `HTCLIENT`） |
| 8 px 以上 | `HTCLIENT` | `HTCLIENT` |
| 角 1 px | `HTTOPLEFT` 等四角 | 同 |
| **角 5 px** | **`HTCLIENT`** | **`HTTOPLEFT` 等四角** |
| 角 10 px | `HTCLIENT` | `HTCLIENT` |

窗口矩形本身也不同：同样请求 400×300，**E39 得到 402×302、E44 得到 415×310** —— 后者把"窗口外的命中带"也算进了窗口矩形（`kResizeOutsideBorderThickness`），这正是 #50706「external resize hit targets」带来的。

**解读**：E39 的可抓区约 3 物理像素（≈2 DIP），在 150% DPI 的笔记本上用鼠标抓边非常难；E44 是 5–7 物理像素并向外扩。这是核心交互（拖边缘缩放无边框窗口）的真实手感差异，且我们的主窗口就是无边框可缩放。

## 2.5 批次 4 实测：缩放带靠"按 DPI 换算"就够了

`kResizeInsideBoundsSize` 一直按 **DIP** 定义（5），但命中点在**高 DPI 下按设备像素**到达。

| 构建 | 边缘可抓区（物理像素） |
| --- | --- |
| 改前（常量 5，无换算） | 约 3–4 |
| 实验：常量 10、不换算 | 约 9–10（证明"带宽 ≈ 常量物理像素"） |
| 改后（5 DIP × 1.5，四舍五入） | 约 8 |
| 官方 Electron 44（Chromium 152）参考 | 5–7，外加窗口外的命中带（同请求 400×300 → 窗口矩形 415×310） |

三档真实缩放的新旧对照：

| 显示缩放 | 旧内核（无 0008，`5BB2274F`） | 新内核（含 0008，`0A7C92A9`） | 5 DIP 应有带宽 |
| --- | --- | --- | --- |
| 100% | 4 px | **4 px** | 5 px（取整/边界差 1） |
| 150% | 4 px | **7 px** | 7.5 px |
| 200% | 4 px | **9 px** | 10 px |

四个方向（左/右/上/下）在每个缩放比下读数一致；100% 与 200% 各复测一次，结果稳定。

结论：**#50706 的"外部命中带"需要整套边界重构；而"抓不住"的主因是缩放丢失，4 行就能修**。已落 [0008](../../kernel/0008-frameless-resize-band-dpi.patch) 并装配（记录见 [batch4](../../reports/2026-11-25-e39-backport-batch4.md)）。

## 3. #50706 的移植可行性（已试跑）

`git apply --reject` 结果：**7 个文件里 4 个直接应用成功**（`native_window_views.h`、`electron_desktop_window_tree_host_win.cc/.h`、`win_frame_view.cc` 的 hunk 1），3 处需要人工：

| 未应用 | 说明 |
| --- | --- |
| `native_window_views.cc`（整文件） | 命中带计算的主体，E39 的 `GetRestoredFrameBorderInsets` 不存在，要换成本地计算 |
| `win_frame_view.cc` hunk 2 | `WinFrameView::GetMinimumSize()` 一类新增方法，E39 无对应 |
| `win_frame_view.h` hunk 1 | 成员/方法声明 |

结论：**可以做，但不是"改几行"**——需要自己实现一个"inset + 命中带"的本地版本，再按上游语义接进 `NonClientHitTest` 链路。建议作为批次 3 单独排期，验收判据就是本文件的缩放带表（边缘/角在 5 px 处应能命中，向外扩的命中带生效）。

## 4. 复跑

```powershell
# 几何账
electron.exe <本目录>              # package.json main = probe-inset.js
# 缩放带（脚本内含 PowerShell 侧 WM_NCHITTEST 取样逻辑见交付记录）
electron.exe <本目录>              # main = probe-resize-band.js，再用 U32 SendMessage 取样
```

两次取样都要在**同一 DPI、同一屏幕**下做，否则数字不可比（本机为 150%）。
