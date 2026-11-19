# 升级到 Chromium 142 可行性评估

> 评估日期：2026-11-19
> 基线：Chromium 140.0.7339.41 / Electron 38.0.0（tag `bao-v140-baseline`）
> 目标：Chromium 142.0.7444.52 / Electron 39.0.0

## 1. 版本对应

| Electron | Chromium | 状态 |
| --- | --- | --- |
| v38.0.0 | 140.0.7339.41 | ✅ 当前基线（已跑通 Flash） |
| **v39.0.0** | **142.0.7444.52** | 🎯 **升级目标** |
| v40.0.0 | 144.0.7559.60 | 后续 |
| v41.0.0 | 146.0.7680.65 | 后续 |

## 2. 关键前提：142 和 140 在 PPAPI 上**结构完全相同**

| 检查项 | Chromium 140 原树 | Chromium 142 |
| --- | --- | --- |
| `ppapi/c/ppb.h` | ❌ 无 | ❌ 无 |
| `content/renderer/pepper/` | ❌ 无 | ❌ 无 |
| `content/browser/renderer_host/pepper/` | ❌ 无 | ❌ 无 |
| `content/ppapi_plugin/` | ❌ 无 | ❌ 无 |
| `content/public/renderer/renderer_ppapi_host.h` | ❌ 无 | ❌ 无 |
| 含 `pepper` 的路径数 | 3 | 3 |

**结论**：Chromium 从 140 开始就没有 PPAPI 了（138 是最后一个）。
142 的移植工作量与 140 **同构** —— 都是"把 138 的 PPAPI 层搬过来 + 适配 API 漂移"。

## 3. 依赖 API 在 142 的可用性

我们移植的代码依赖这些底层 API：

| API | 142 状态 |
| --- | --- |
| `content/public/renderer/render_frame.h` | ✅ 在 |
| `content/public/browser/render_widget_host_view.h` | ✅ 在 |
| `content/public/browser/web_contents.h` | ✅ 在 |
| `content/renderer/render_frame_impl.cc` | ✅ 在 |
| `ppapi/proxy/ppapi_messages.h` | ❌ 需移植（同 140） |

**底层骨架都在**，只是 PPAPI 那一层需要重新搬。

## 4. 工作量估算

### 140.0.7339.41 → 142.0.7444.52 的改动规模

| 范围 | 提交数 |
| --- | --- |
| 全部 | **13,494** |
| `content/` | 602 |
| `third_party/blink/` | 1,176 |

### 需要移植的代码规模（与 140 相同）

| 部分 | 文件数 |
| --- | --- |
| `ppapi/` | 1,470 |
| `content/renderer/pepper/` | 147 |
| `content/browser/renderer_host/pepper/` | 61 |
| Flash 私有 PPAPI | ~51 |

### 工作量对比

| 迁移 | 提交跨度 | 结果 |
| --- | --- | --- |
| 138 → 140 | 已完成 | ✅ 跑通 |
| **140 → 142** | **13,494** | 待评估 |

两个跨度同量级（138→140 约 1.1 万提交），所以 **140→142 的工作量 ≈ 已完成的那次**。

## 5. 已知会踩的坑（140 上已经踩过的）

这些在 138→140 时都遇到过，142 大概率重复：

| 坑 | 140 上的解法 | 142 需重新确认 |
| --- | --- | --- |
| `gles2_external_framebuffer` DCHECK（fbo != 0） | `Destroy()` 里调 `external_default_framebuffer_->Destroy()` | 同名文件是否还在 |
| `CopyVideoFrameToSharedImage` 签名变化 | Flash 不走这条路，跳过 | 同理 |
| `bind_generates_resource_chromium` 能力位 | 传 `GetGLCapabilities()` 的实际值 | 同 |
| gin 不再自动注册 `NamedPropertyInterceptor` | 显式 override `GetNamedPropertyInterceptor()` | 同 |
| `RenderFrameImpl::pepper_routing_id_` 默认 -1 | 用 `params.routing_id` 初始化 | 同 |
| `prefetch_matches` 结构化绑定数量 | 加 `DO_FIELD(skip_orb)` | ORB 若被移除则不需要 |
| `ui::Clipboard` 读取异步化 | 回调式应答 | 可能再变 |
| `ClipboardSequenceNumberToken` 是 `base::TokenType` | 用 `ToString()` | 同 |

## 6. 风险评估

| 风险 | 等级 | 说明 |
| --- | --- | --- |
| API 漂移导致编译失败 | **中** | 13,494 提交，602 个动 content/ |
| 运行时行为变化（渲染/GPU） | **中** | 140 上踩过 `external_framebuffer`，142 可能有新的 |
| Flash DLL 兼容性 | **低** | Flash 29 是独立进程，与 Chromium 版本解耦 |
| Electron 39 的 API 变化 | **低** | 我们只用 `--register-pepper-plugins` + `webPreferences.plugins` |
| 无参考实现 | **中** | 140 有我们自己踩过的坑可复用，142 是新的 |

## 7. 建议的验证步骤（先探路，再决定投入）

### 步骤 0：准备（~30 分钟）

```bash
# 1. 拉取 142 的 Electron 39 源码树
# 2. 确认 gclient sync 可用（142 的 DEPS 与 140 不同）
```

### 步骤 1：裸编译 142（~2-4 小时）

先不移植 PPAPI，确认 **142 + Electron 39 能正常构建**。
如果这一步就失败，说明工具链/依赖有问题，先解决。

### 步骤 2：移植 PPAPI（~1-2 天）

按 138→140 的清单搬：
1. `ppapi/` 整目录（1470 文件）
2. `content/renderer/pepper/`（147）
3. `content/browser/renderer_host/pepper/`（61）
4. `content/ppapi_plugin/`（9）
5. 构建系统接线（`BUILD.gn`、`content_switches`、`prefs`）

### 步骤 3：编译并统计错误（关键决策点）

**这一步决定是否继续**：
- 错误 < 50 处 → 直接修
- 50~200 处 → 分批修，可控
- **> 200 处 → 重新评估（可能 142 的架构变化太大）**

### 步骤 4：跑基线回归

用 `bao-v140-baseline` 的验证清单逐一过：
- 2D / Stage3D / 输入 / Socket / 视频 / LSO / 全屏 / 剪贴板 / 菜单
- 4399 联网游戏端到端

## 8. 结论与建议

**可行性：高。** 142 与 140 在 PPAPI 上结构完全同构，底层 API 都在，
移植方法可 100% 复用。

**建议节奏**：
1. **先做步骤 1（裸编译 142）** —— 这是最便宜的探路，2-4 小时就能知道基础是否可行
2. 再决定是否投入步骤 2-3

**不建议**：直接跳到移植，因为 142 的 GPU/合成器可能有 140 没踩过的新坑。

**如果 142 通过**，可以顺势评估 144（Electron 40）—— 但收益递减，因为 Flash 侧没有新需求。

## 9. 与 140 基线的对应关系

| 项 | 140 基线 | 142 目标 |
| --- | --- | --- |
| tag | `bao-v140-baseline` | `bao-v142-baseline`（待建） |
| Release | https://github.com/Sutanm/chromium/releases/tag/bao-v140-baseline | — |
| 分支 | `bao/140-linux` | `bao/142-linux`（待建） |
| 验证清单 | docs §一~§三十九 | 复用 |
| `[ppexp]` 诊针 | 已常驻 | 直接复用 |
