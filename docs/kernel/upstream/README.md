# 上游 Electron 补丁归档（E39 回拣候选）

本目录存放**上游 Electron 官方提交的原始 patch**，只作为移植参考，**不是我们要应用的补丁**。

- 来源：`electron/electron` 主线（经镜像 `gitee.com/mirrors/electron` 获取，2026-11-25）。
- 我们的基线：`v39.8.10`（Chromium 142.0.7444.265），内核树 `D:\electron-build-142\cr\src\electron`。
- **实测：18 条里 3 条可直接 `git apply` 到 v39.8.10**（#50688、#51900 整条；#51562 仅 spec 冲突，`--exclude=spec/*` 可应用），其余 15 条因 E39→E44 的 shell 代码漂移需要**手工移植**。移植后我们自己的补丁才登记为 `docs/kernel/000N-*.patch`。
- **归档规则：补丁文件必须是 LF**。本目录早期版本被 PowerShell 重定向写成了 CRLF，导致 `git apply` 上下文全部匹配失败，曾被误判为"18 条全冲突"。
- 应用条目见 [E39 回拣实施计划](../2026-11-25-e39-backport-plan.md)。

## 归档表

| 文件 | 上游 PR | 提交 | 日期 | 改动 | 域 | 动 Chromium patch 集 |
| --- | --- | --- | --- | --- | --- | --- |
| `upstream-51200-hidden-view-drag-regions.patch` | #51200 | `c74de25b0170f67c772bbd845a7e8088edc203ab` | 2026-04-22 | +2/−1 | shell | 否 |
| `upstream-51252-stable-bounds-setResizable.patch` | #51252 | `38cfc66c6f6c28a78dc1ccf47b4750ae5ac87bc2` | 2026-04-23 | +19/−6 | shell | 否 |
| `upstream-51287-fullscreen-insets-windows.patch` | #51287 | `ccaab437cc56866ba6a60b5b1e1139b800dbccc9` | 2026-04-26 | +19/−1 | shell | 否 |
| `upstream-50706-external-resize-hit-targets.patch` | #50706 | `4203d7688f604ad7bb86d0d1fdb9f35329ca7947` | 2026-04-09 | +79/−35 | shell | 否 |
| `upstream-51503-resize-band-scaling.patch` | #51503 | `efe652c7d9c06bc9d24a04298cc68a29f1fc0d0f` | 2026-05-07 | +27/−9 | shell | 否 |
| `upstream-51732-frameless-center-size.patch` | #51732 | `d4d8a180fa066f2d7fd1d9ec72dc95398e91624f` | 2026-06-08 | +49/−25 | shell | 否 |
| `upstream-51562-frameless-shrink-constraints.patch` | #51562 | `dea88371a82dda73207f1e22c05eb9f7f23265c9` | 2026-06-05 | +49/−57 | shell | 否 |
| `upstream-51900-render-process-gone-ordering.patch` | #51900 | `571d6e9d5194f82d2a16898aa9a62f6b8a4eeb6b` | 2026-06-08 | +33/−2 | shell | 否 |
| `upstream-53924-navigate-dead-renderer.patch` | #53924 | `57578d521a9ab4bc7df81ffd2114e92094477bd5` | 2026-09-15 | +118/−5 | shell | 否 |
| `upstream-50688-wrappable-deferred-destruction.patch` | #50688 | `3f8238b92c5f831025cf25718d4f5bb5faa4848d` | 2026-04-05 | +63/−3 | shell | 否 |
| `upstream-53031-detached-view-setBounds.patch` | #53031 | `96f3996d8d3ce6e2fcfb86326fc4b953b53936fb` | 2026-08-22 | +58/−3 | shell | 否 |
| `upstream-55955-native-window-relay-retarget.patch` | #55955 | `46980d7cb59add473650deabf13e0326ee2d2070` | 2026-11-20 | +130/−3 | shell | 否 |
| `upstream-54936-drag-regions-child-view.patch` | #54936 | `02b018c7661930d07e0f97ad29adceddc26af693` | 2026-10-15 | +114/−8 | shell | 否 |
| `upstream-52844-blank-wcv-throttling.patch` | #52844 | `50dd9631fa983333772dc89538460f4012f30095` | 2026-08-16 | +63/−2 | shell | 否 |
| `upstream-54311-hidden-reenable-render.patch` | #54311 | `2f22028fb3be78f945f60a0dfb9901b856a41258` | 2026-09-24 | +195/−17 | shell | **是**（`patches/chromium/allow_disabling_blink_scheduler_throttling_per_renderview.patch`） |
| `upstream-54090-hidden-window-nav-render.patch` | #54090 | `c3485835c263e32a108dbd84164d4eaef7c65266` | 2026-09-18 | +138/−36 | shell + spec | **是**（同上 + `disable_hidden.patch`） |
| `upstream-49959-webcontents-clone.patch` | #49959 | `76a03e10104f414803d7a8ac3951da9579721106` | 2026-04-22 | 新 API | shell | 否 |
| `upstream-51076-view-background-blur.patch` | #51076 | `a1d6918b59dc13c1e5d7d1c2849b8b67f46fab2c` | 2026-05-01 | 新 API | shell | 否 |

## 归档规则

1. 上游原文只读：**不要**把这里的文件直接当 `docs/kernel/000N-*.patch` 用。
2. 我们的移植版导出方式：改完内核树后 `git -C D:\electron-build-142\cr\src\electron diff > docs/kernel/000N-<pr>-<slug>.patch`，并在补丁头写明来源 PR/提交。
3. 上游再更新时用同一文件名覆盖，并在 [实施计划](../2026-11-25-e39-backport-plan.md) 的表格里改提交号。
