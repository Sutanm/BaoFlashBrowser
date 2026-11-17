# Chromium 87 自编译：修复窗口快速拉伸时的黑边（resize gutter）

- 状态：**已降级为后备路线**（2026-11-12）。用户实证 Chromium 102（Electron 19）与 132（360 极速版）仍可加载 PPAPI Flash——"87 是最后支持 Flash 的版本"这一前提被证伪。主路线改为升级 Electron（见 §9）；本方案仅在升级路线全部受阻时启用。
- 目标版本：Electron 11.5.0 / **Chromium 87.0.4280.141**（`DEPS` 的 `chromium_version`，已核实）
- 关联现象：无边框窗口快速放大时，右侧/底部出现纯黑条，宽度约等于单次尺寸跳变幅度

## 1. 根因（已用 87 源码核实，不是推测）

黑边不是"内容还没画完"，而是 **swapchain 被 `ResizeBuffers` 作废后仍被当作内容呈现**。
链路三步，全部在 `ui/gl/`：

### 1.1 `DirectCompositionSurfaceWin::Resize`

`ui/gl/direct_composition_surface_win.cc`：

```cpp
if (!SetWindowPos(window_, nullptr, 0, 0, size.width(), size.height(),
                  SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOCOPYBITS |
                      SWP_NOOWNERZORDER | SWP_NOZORDER))
  return false;
return root_surface_->Resize(size, scale_factor, color_space, has_alpha);
```

`SWP_NOCOPYBITS` 明确**禁止系统保留旧客户区内容**。

### 1.2 `DirectCompositionChildSurfaceWin::Resize`

`ui/gl/direct_composition_child_surface_win.cc`：

```cpp
// This will release indirect references to swap chain (|real_surface_|) by
// binding |default_surface_| as the default framebuffer.
if (!ReleaseDrawTexture(true /* will_discard */))
  return false;
...
if (swap_chain_ && resize_only) {
  HRESULT hr = swap_chain_->ResizeBuffers(2 /* BufferCount */, size.width(),
                                          size.height(), format, flags);
  if (SUCCEEDED(hr)) return true;
}
```

两件事同时发生：当前帧被 `will_discard` **丢弃且不 `Present1`**；`ResizeBuffers` 按 DXGI 语义让 back buffer 内容失效。

### 1.3 `DCLayerTree::CommitAndClearPendingOverlays`

`ui/gl/dc_layer_tree.cc`：只有 **swapchain 句柄变化** 才重新 `SetContent`：

```cpp
if (root_surface->swap_chain() != root_swap_chain_ || ...) {
  root_surface_visual_->SetContent(...);
  needs_rebuild_visual_tree_ = true;
}
```

而 `ResizeBuffers` 复用同一个 swapchain 对象，句柄不变 → 不重新 `SetContent`，但 visual 的尺寸隐含跟随 swapchain 立刻变成**新尺寸**。**整个函数没有任何 `SetBounds` / `SetTransform` / `SetOffset`**，visual 尺寸完全由 swapchain 决定。

所以 resize 后、renderer 重排完成前，被呈现的是"新尺寸的、内容作废的 buffer"。DWM 把 buffer 里未定义区域显示为黑 → 黑条宽度 ≈ 该次 resize 的 delta。

### 1.4 为什么不能 backport Electron 39 的补丁

Electron 39 的两个 patch 改的是：

- `components/viz/service/display/direct_renderer.cc`（`DrawFrame` 里清 viewport 外区域）
- `components/viz/service/display_embedder/skia_output_device_dcomp.cc`（设置 `clear_drawn_areas_outside_viewport` capability）
- `components/viz/service/display/output_surface.h`（新增该 capability 字段）

**87 里这三样都不存在**：`output_surface.h` 的 `Capabilities` 没有该字段（已逐字段核对），`display_embedder/` 目录下没有 `skia_output_device_dcomp.cc`（Windows 的 DComp 呈现在 `ui/gl/`）。所以 39 的修复是另一代架构的另一条路径，**只能重写，不能套用**。

## 2. 修改设计

落点只有一个文件：`ui/gl/direct_composition_child_surface_win.cc`。不动 viz、不动 `dc_layer_tree`、不动 Electron 的 `shell/`。

### 2.1 主方案（阶段 1）：resize 时把旧帧快照回填 + 边缘像素延伸

思路：在内容被作废之前把当前 back buffer 抓成一张纹理，`ResizeBuffers` 之后把它贴回左上角，新增的右/下区域用**最右一列 / 最底一行像素**填充。

```cpp
bool DirectCompositionChildSurfaceWin::Resize(size, scale_factor, color_space, has_alpha) {
  if (size_ == size && has_alpha_ == has_alpha && color_space_ == color_space)
    return true;

  const gfx::Size old_size = size_;
  // (1) 新增：作废之前快照当前 back buffer
  const bool snapshot_ok = SnapshotCurrentFrame(old_size);

  if (!ReleaseDrawTexture(true)) return false;
  ...
  if (swap_chain_ && resize_only) {
    hr = swap_chain_->ResizeBuffers(2, size.width(), size.height(), format, flags);
    if (SUCCEEDED(hr)) {
      // (2) 新增：回填
      if (snapshot_ok) FillNewAreaAfterResize(old_size, size);
      return true;
    }
  }
  ...
}
```

`SnapshotCurrentFrame`：`swap_chain_->GetBuffer(0)` → `CopyResource` 到持久的 `ID3D11Texture2D snapshot_texture_`（`D3D11_USAGE_DEFAULT`，按 old_size 分配，尺寸不变时复用）。

`FillNewAreaAfterResize`：对新的 buffer 0 做纯 D3D11 `CopySubresourceRegion`，不发生 CPU 读回：

1. 快照整块 → 新 buffer `(0,0,old_w,old_h)`
2. 右侧新增区：取快照最右 1px 列，先用**指数复制**（1→2→4→…）铺到 `old_w` 之后，最后裁到 `new_w`
3. 底部新增区：同理用最底 1 行
4. 右下角：用 `(old_w-1, old_h-1)` 那一个像素铺满（或重复 2、3 的交叉填充）

指数复制让 200px 的新增宽度只需约 8 次 `CopySubresourceRegion`，不是 200 次。

效果：resize 瞬间画面是"旧内容 + 边缘色延伸"，浅色 UI 上几乎不可见，且**保留原生拖动循环、双击边缘最大化、贴边吸附**——因为完全没有接管窗口 resize，只改呈现内容。

### 2.2 阶段 2（可选，仅在阶段 1 观感不够时）：真拉伸

把步骤 1 的 1:1 复制换成 GPU 缩放。两条实现路径：

- **复用 `DCLayerTree::InitializeVideoProcessor` 的 `video_processor_`**：把快照当输入纹理、swapchain buffer 当输出做 `VideoProcessorBlt`。基础设施已在仓库里，但要先查 `D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT` 对 BGRA 的支持，不支持则需 NV12 中转。
- **新增一个最小 D3D11 管线**（顶点着色器画全屏 quad + 线性采样）：更可控，代码量约 +80 行。

阶段 1 的"边缘延伸"与"真拉伸"在纯色/渐变 UI 上视觉等价（拉伸只是插值，延伸是复制）；差异只在照片、视频这类高频内容上表现为 1~2 帧的条纹拖影。

## 3. 构建环境（一次性）

| 项 | 要求 | 说明 |
|---|---|---|
| OS | Windows 10 x64 | 已在用 |
| VS | **Visual Studio 2019**（16.11.x），含 C++ 桌面工作负载 | VS2022 不行，Chromium 87 的 toolchain 只认 2019；需设 `vs2019_install` |
| Windows SDK | **10.0.19041** + Debugging Tools for Windows | 需设 `WINDOWSSDKDIR`；symstore 只在出完整发行版时才要 |
| Python | **2.7.18**（供 gclient/depot_tools）+ **3.8**（Electron 的 hook 用 `python3`） | 2.7 必须放在 PATH 中 depot_tools 之前 |
| pywin32 | 已装（`pip install pywin32`） | 构建脚本需要 |
| depot_tools | **必须 pin 到 2020 年附近的提交** | 今天的版本不认 5 年前的 DEPS |
| Git | `git config --system core.longpaths true` | Electron 的 node 依赖路径极长 |
| 磁盘 | **≥150GB 空闲**（源码 ~25GB + `out/Release` ~60~80GB） | NVMe 强烈建议 |
| 内存 | ≥16GB（链接 `electron.exe` 峰值） | 12GB 以下会 OOM |

参考：Electron v11.5.0 的 `docs/development/build-instructions-windows.md`（Python 2.7.10+ 的要求即出自此）。

## 4. 源码与补丁管理

```bash
mkdir electron-gn && cd electron-gn
gclient config --name "src/electron" --unmanaged https://github.com/electron/electron
gclient sync --with_branch_heads --with_tags
cd src/electron && git checkout v11.5.0
```

补丁走 Electron 自己的机制（`DEPS` 的 `patch_chromium` hook 就是调 `script/apply_all_patches.py patches/config.json`）：

1. 在 `src/electron/patches/chromium/` 放 `bfb_fix_resize_gutter.patch`
2. 文件名加入 `src/electron/patches/chromium/.patches`
3. 重新跑 `python3 src/electron/script/apply_all_patches.py src/electron/patches/config.json`

不要直接改 `src/components/...` 而不留 patch —— `gclient sync` 会覆盖，且产物不可重复。

> 待实测：`apply_all_patches.py` 内部用 `git am`，patch 需 mail 格式（含 `From`/`Subject` 头）。若只想快速验证，可先直接改源码编一次，验证通过后再整理成 patch。

## 5. 编译与产物替换

```bash
cd src
gn gen out/Release --args="import(\"//electron/build/args/release.gn\")"
ninja -C out/Release electron
```

**编译前必查的头号项**：PPAPI/Flash 支持必须在 args 里打开，否则白编。

```bash
gn args out/Release --list=enable_plugins --list=enable_ppapi
```

若不包含（或为 false），在 `args.gn` 里显式加 `enable_plugins = true` / `enable_ppapi = true` 后重跑 `gn gen`。这条不通过就不要继续编译。

产物替换：把 `out/Release/` 里的 `electron.exe`、`*.dll`、`*.pak`、`icudtl.dat`、`snapshot_blob.bin`、`v8_context_snapshot.bin`、`locales/` 覆盖到 `node_modules/electron/dist/`，**保留 `dist/resources/default_app.asar`**（那是 npm 包自带的，自编译产物里没有）。版本必须整体替换，不能只换 exe（snapshot 与 exe 绑定）。

## 6. 验证计划

| # | 检查点 | 判定 |
|---|---|---|
| V0 | `gn args --list` 确认 `enable_plugins`/`enable_ppapi` | 通过才继续 |
| V1 | 空编译（不改代码）能出 `electron.exe` 并能启动本仓库 | 工具链验收，失败即停止 |
| V2 | 用 V1 产物跑 `npm start`，Flash 站点（4399/7k7k）可加载 SWF | 编译参数正确 |
| V3 | 打补丁重编，快速甩动拉伸，录制 60fps 视频逐帧看 | 黑条消失；阶变处为边缘色延伸 |
| V4 | 回归：最大化/还原、多显示器 150% DPI、全屏、自动化截图、密码填充 | 无新缺陷 |
| V5 | `npm run probe` + `npm test -- --run` | 应用层不回归 |

V3 建议用 240fps 或逐帧截图（`npm run probe` 里的截图能力 / OBS）确认，肉眼在快速甩动时会漏判。

## 7. 风险与回退

| 风险 | 影响 | 处置 |
|---|---|---|
| 工具链拿不到（VS2019 EOL、SDK 归档失效） | 卡在 V1 | 前置到 V1 验收，失败即放弃此路线 |
| `enable_ppapi` 无法打开 | Flash 不可用 | 立刻回退，不再投入 |
| `resize_only` 分支未命中（alpha/colorspace 变化） | 补丁不生效 | 日志里加 UMA/`DLOG` 确认分支；alpha 变化时走 reset 路径为正常 |
| `GetBuffer(0)` 在 FLIP 模型下不可写 | 回填失败 | 退回 `IDCompositionSurface` 路径；先加断言与降级日志 |
| 自编译 exe 未签名 | SmartScreen 提示 | 用现有打包证书在 `electron-builder` 阶段签；或仅内部使用 |
| 阶段 2 缩放路径不稳 | 黑屏/闪烁 | 阶段 1 已可用，随时停 |

**回退路径**：整个内核路线是"换 `node_modules/electron/dist` 的文件"，回滚就是 `npm i` 复原官方包，不影响仓库代码。

## 8. 范围声明

**已核实（有源码依据）**：Electron 11.5.0 = Chromium 87.0.4280.141；87 的黑边三条链路的代码；87 不存在 39 patch 所依赖的字段与文件；`ui/gl` 下 DComp 相关文件清单；Electron 的构建参数入口与 patch 机制。

**待实测（不做假设）**：`enable_ppapi` 在默认 args 中是否已开；`apply_all_patches.py` 的 patch 格式要求；`GetBuffer(0)` 在该驱动/FLIP 模型下的可写性；指数复制填充的实际耗时；阶段 2 中 `video_processor_` 对 BGRA 的输入支持。

**成本**：首次全量编译 1.5~3 小时（16 核），之后每次改补丁 1~3 分钟增量编译。人工投入主要在 V1 的工具链排障，估算 0.5~1 天。

## 9. 新证据与替代路线（2026-11-12）

### 9.1 前提被证伪

用户实证：360 极速版（Chromium 132）与奇安信（Chromium 102）均可运行原生 Flash。
> **修订 2026-11-12**：初版写"已在 Electron 19 上打通 SWF 播放 / 只是缺注册层 / 零编译"，
> 不准确。Electron 19 原样跑 ppapi 子进程会 CFG 崩溃（`0xC0000409`），完整障碍链与
> 移植清单见 `docs/specs/2026-11-11-qax-chromium102-flash.md` §8~§13。修正后的事实：
> ① 任何 ≥102 的路线都必然自编译（19 需接口层补丁，34 需 `enable_plugins=true` 重编）；
> ② 注册通道 `--register-pepper-plugins` 在 102/132 上游仍在且实测有效；
> ③ 单内核 + 原生 Flash 的分支上限是 **Chromium 138**（Electron 45/140 已彻底删 PPAPI）。
> 87 不再是 Flash 的硬上限，但"零编译升级"不成立。

### 9.2 resize 机制在 102~132 已换代（源码核实）

- `OutputSurface::Capabilities` 在 **102 与 132 均已存在** `supports_viewporter`、
  `resize_based_on_root_surface`（87 全部没有）。
- 132 的 `direct_renderer.cc` 已有上游函数 `CalculateSizeForOutputSurface`：
  **surface 尺寸向上取整到 256px 倍数、1 秒内不收缩**（注释原文 "This allows backings
  to be more easily reused during a resize operation"）→ 快速拉伸时多数帧根本不触发
  `ResizeBuffers`，新露出的区域显示的是复用 buffer 里的旧内容而非未初始化黑。
  只有跨过 256px 对齐边界的瞬间才真正重建 buffer。
- 132 的 `SkiaOutputDeviceDComp` 构造函数已设
  `capabilities_.supports_viewporter = presenter_->SupportsViewporter()`（DComp 路径可用）。
- 结论：**102/132 上黑边大概率已大幅缓解**，39.2.6 的补丁只是把残余清干净（透明 + clip）。

### 9.3 新主路线：升级 Electron 19（后备：34）

> **修订（2026-11-12，读完 `docs/specs/2026-11-11-qax-chromium102-flash.md` 后）**：
> 本表初版写的「Flash 已实证打通 / 编译成本零」是错的——Electron 19 的 ppapi 子进程
> 原样跑会 CFG 崩溃（`0xC0000409`），需要源码改动（Flash 接口注册层 + CFG 登记）。
> 详见 qax 文档 §8~§13。修正后的结论：**任何 ≥102 的路线都必然伴随自编译**，
> 与 87 方案的差别只是「补丁面积小了一个数量级 + resize 黑边基础设施已就位」。

| 项 | 说明（修订后） |
|---|---|
| Flash | **非零编译**：Electron 19 需 ① 宿主侧 `SetProcessValidCallTargets` 登记 Flash 镜像（修 CFG 崩溃）；② 搬回 87 的 `ppapi/c/private/ppb_flash*` + thunk + `interfaces_ppb_private_flash.h` 七项接口面（§13.2 清单）；③ `ppapi-flash-args` 开关 + `GetCmdLine()` + thunk 返回空 StringVar（§13.3）。360（132）证明这套面在 132 上可编译，**目标内核可上探到 Chromium 138**（Electron 34 重编 + `enable_plugins=true`，源码改动可能为 0） |
| 黑边 | 102/132 的 256px 对齐 + buffer 复用预计大幅缓解；**待实测**（Electron 19 快速拉伸 + 360 对照） |
| BrowserView | Electron 19 仍在（Electron 33 起弃用，34+ 需迁 `WebContentsView`）——19 迁移面最小，34 多一层 BrowserView→WebContentsView 迁移 |
| safeStorage | Electron 15+ 提供，密码模块 A 档可简化：Windows DPAPI/Linux libsecret 均有官方后端，可删自研 keyring 封装 |
| 编译成本 | **不为零**：19 = 自编译 + 数十~数百行补丁；34 = 自编译 + `enable_plugins=true` 开关。均低于 87 方案（不用重写 resize 补丁、注册通道 `--register-pepper-plugins` 上游仍在） |
| 大工程 | DevToolbox 的 devtools-frontend 需重建到 102/132（`scripts/build-devtools-frontend.cjs` 唯一入口）；Chromium 87 特有的兼容垫片（`safe center`、`mask:` 前戳、DOM agent 节点失效自愈）可随升级清理 |

### 9.4 若升级后黑边仍不可接受

- 在 Electron 19/34 自编译上 backport 39 补丁，成本远低于 87：`skia_output_device_dcomp.cc`
  存在、capability 基础设施已有；注意 `resize_based_on_root_surface` 在 132 的
  `direct_renderer.cc` 中不被消费（主要为 Wayland 设计），单设该字段可能无效，
  需按 39 patch 1 的 `clear_drawn_areas_outside_viewport` 思路补 viewport 外清屏。
- 本文档 §1~§8（87 自编译）保留为最终后备。

### 9.5 待确认清单

1. Electron 19 上快速拉伸的黑边程度（决定是否需要 resize 补丁）。
2. 360（132）快速拉伸对照。
3. ~~Electron 19 打通 Flash 的具体注册机制~~ → 已解答：`--register-pepper-plugins`
   可用（102/132 实测），但需先修 CFG 崩溃与接口注册层，见 qax 文档 §8~§13。
4. ~~Electron 19 的 `ppapi-flash-path` / `webPreferences.plugins` 是否仍然有效~~ →
   已解答：`--ppapi-flash-path/--version` 在 102 已删；用 `--register-pepper-plugins`。
5. 本项目对 Chromium 87 行为的所有依赖点清单（垫片、CSS hack、DevToolbox）。
