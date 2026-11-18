# 往上推进版本可行性评估（138 → 140 / 142 / 144 / 150）

> 评估日期：2026-11-15（**最后一次状态更新：2026-11-17**）
> 评估对象：在已跑通 **Chromium 138（Electron 37）** 的基础上，继续往高版本推进是否可行、代价多大
> 方法：在本地完整 git 历史（tag 覆盖到 149）上做**删除面、依赖漂移、IPC 层演化、Blink 稳定性**四项实测
> 关联文档：[`2026-11-14-electron138-flash-port.md`](2026-11-14-electron138-flash-port.md)、[`2026-11-14-flash-port-ai-runbook.md`](2026-11-14-flash-port-ai-runbook.md)、[`2026-11-17-chromium140-ppapi-revival-ai-guide.md`](2026-11-17-chromium140-ppapi-revival-ai-guide.md)

> ⚠️ **阅读提示（2026-11-17）**：本文是**按时间追加的运行日志**，早期小节里"卡在××""未出帧"等结论已被后续小节覆盖。
> **当前状态以 §1.14.11 为准**；每一节若已过时，节首会标注 `> 状态：…`。编号里出现的 `1.14.7b / 1.14.8b` 是当时并行排查留下的分支编号。

---

## 0. 结论先行

| 目标版本 | 结论 | 主要依据 | 工作量估计 | 置信度 |
| --- | --- | --- | --- | --- |
| **138 / E37** | ✅ 已跑通（基线） | 实测出帧 | — | 已验证 |
| 139 / 无 Electron | ❌ 跳过 | `content/renderer/pepper` 在 139 已被删，比 138 更差 | — | 高 |
| **140 / E38** | ✅ **已跑通并出帧（2026-11-17 实测）** | 删除面大但核心 IPC 仍在；Flash 29 完整渲染 FlxInvaders | **实测 ~2.2 天/18–20 工时**（原估 2–4 周） | 已验证 |
| **142 / E39** | ⚠️ 可行，是"性价比天花板" | 再退 2 个头文件，IPC 核心仍完整 | **3–5 周** | 中 |
| **144 / E40** | ❌ **不建议（2026-11-15 实测修正）** | legacy IPC **消息系统整体移除**：`ipc_message_macros.h`/`ipc_message_utils.h`/`ipc_channel_handle.h`/`ipc_platform_file.h`/`ipc_sender.h` 全删，PPAPI 的 ~300 条消息失去编译基础 | **2–3 个月+** | 低 |
| 146 / 148 / 149 | ❌ 同 144，风险更高 | 同上 + 更多漂移（`content_plugin_info.h` 在 149 也被删） | 3 个月+ | 低 |
| **150 / E43** | ⚠️ 可行，但成本最高 | 远程实测：Blink 插件 API 与 `OverrideCreatePlugin` 仍在；需重下 150 源码 + 承担 144 档适配 | 10–14 周 | 中 |

**一句话（2026-11-17 实测修正）：140 已经跑通并出帧；142 是下一个合理目标；144+ 需要复活 legacy IPC 消息框架，不建议。**

---

## 1. 实测数据

### 1.1 删除面（各版本还剩多少 PPAPI 代码）

| 路径 | 138 | 139 | 140 | 145 | 149 |
| --- | --- | --- | --- | --- | --- |
| `ppapi/` | **1419** | 1419 | 0 | 0 | 0 |
| `content/renderer/pepper/` | **137** | **0** | 0 | 0 | 0 |
| `content/ppapi_plugin/` | 9 | 9 | 0 | 0 | 0 |
| `content/browser/` ppapi 相关 | 66 | 66 | 0 | 0 | 0 |
| `content/common/` pepper 相关 | 7 | 7 | 0 | 0 | 0 |
| **合计需 vendor** | **1638** | — | 1638（全部取自 138） | 同左 | 同左 |

> 关键点：**139 不是跳板**。它保留 `ppapi/`，但渲染进程的插件实例实现（`content/renderer/pepper/`，137 文件）已经删了，
> 所以做 139 仍然要从 138 vendor 渲染层，收益只有 +1 个里程碑——不划算。

### 1.2 依赖漂移面（138 的 `ppapi/` 依赖的 117 个外部头）

138 的 `ppapi/` 一共依赖 117 个外部头文件：`base` 76、`ipc` 19、`gpu` 12、`net` 4、`media` 3、`ui` 2、`mojo` 1。

| 目标 | 被删除的依赖头 | 有改动的依赖头 | 累计变更行数 |
| --- | --- | --- | --- |
| 140 | **5** | 55 | 1422 |
| 142 | 7 | 65 | — |
| 144 | **13** | 76 | — |
| 145 | 13 | 78 | 5368 |
| 149 | 15 | 85 | 7665 |

140 删除的 5 个都是边缘头（`ipc_logging.h`、`ipc_test_sink.h`、`ipc_sync_message_filter.h`、`message_filter.h`、`struct_constructor_macros.h`），
每个只被 1–4 个 ppapi 文件包含，属于**局部修补**级别。

### 1.3 144 的"陡坡"到底是什么（更正：不是删功能，是集中重构）

| 版本 | `ipc/` 文件数 | `ipc_message_utils.h` | `ipc_sender.h` | `ipc_platform_file.h` |
| --- | --- | --- | --- | --- |
| 138 | 131 | 有 | 有 | 有 |
| 140 | 111 | 有 | 有 | 有 |
| 142 | 93 | 有 | 有 | 有 |
| **144** | 75 | **无** | **无** | **无** |
| 145–149 | 75 | 无 | 无 | 无 |

"无"不等于"功能没了"。用 `git log --diff-filter=D` 追到三个提交，它们都是**重构/改名**，不是能力删除：

| 提交 | 实际动作 | 对 ppapi 的影响 |
| --- | --- | --- |
| `Rename several ipc_* files used by param_traits*` | `ipc_message_utils.h` 拆成 `ipc/param_traits.h`、`param_traits_macros.h`、`param_traits_read/write_macros.h`、`param_traits_utils.h`；`ipc_platform_file.h` 一并并入/改名 | 7 个文件改 include（`ParamTraits` 模板仍在 `param_traits.h`） |
| `Remove class IPC::Sender` | `Send()` 并入 `IPC::Channel` / `IPC::ChannelProxy` | 8 个文件 + `Dispatcher` 的继承结构调整 |
| `Remove IPC::PlatformFileForTransit` | 句柄传递改用 `base::File` / `base::FileDescriptor` 体系 | **51 处、约 17 个文件**（文件/音频/序列化句柄），最重的一项 |

为什么偏偏集中在 141–144？因为 **PPAPI 是最后一个大规模 legacy IPC 使用者**：
140 把 ppapi 整层删掉之后，141–144 就能把这套基础设施"现代化"——先拆 param traits 头，再删 `Sender`，最后删 `PlatformFileForTransit`。

所以对我们是"工程陡坡"：**39 个 ppapi 文件要跟改名/改类型**，但通信模型本身没变，不需要 Mojo 重写。

### 1.4 利好：Blink 插件 API 一直没动（含 150 / 156 远程实测）

| 文件 / 接口 | 138 → 140 | 138 → 149 | **150.0.7871.46** | **156.0.8078.48** |
| --- | --- | --- | --- | --- |
| `third_party/blink/public/web/web_plugin.h` | 11 行 | 11 行 | **存在**（API 基本一致） | **存在**（新增少量虚函数） |
| `third_party/blink/public/web/web_plugin_container.h` | 无变化 | 无变化 | — | — |
| `third_party/blink/public/web/web_plugin_params.h` | 无变化 | 无变化 | — | — |
| `ContentRendererClient::OverrideCreatePlugin` | 存在 | 存在 | **存在** | **存在** |
| `ContentRendererClient::OverrideFlashEmbedWithHTML` | 存在 | 存在 | **存在** | **存在** |
| `content/public/common/content_plugin_info.h` | 存在（+33 行） | 已删除 | **删除**（需 vendor） | 删除 |
| `content/public/browser/browser_ppapi_host.h` | 已删除 | 删除 | 删除 | 删除 |
| `ipc/ipc_message.h` + `ipc/param_traits.h` | 存在 | 存在 | **存在** | 存在 |
| `content/renderer/pepper/` | 137 文件 | 0 | **0**（需 vendor） | 0 |

验证方式（可复现）：

```powershell
# 远程确认某版本是否还有插件挂载点
curl -s "https://api.github.com/repos/chromium/chromium/contents/third_party/blink/public/web/web_plugin.h?ref=150.0.7871.46"
curl -s "https://api.github.com/repos/chromium/chromium/contents/content/renderer/pepper?ref=150.0.7871.46"   # 404 = 已删
curl -s https://raw.githubusercontent.com/chromium/chromium/156.0.8078.48/content/public/renderer/content_renderer_client.h | findstr OverrideCreatePlugin
```

**结论：从 138 一直到 156，Blink 侧的"插件挂载点"都还在**（`WebPlugin` 虚表 + `OverrideCreatePlugin` 钩子）。
无论做 140、144 还是 150+，**都不需要重写 Blink**——这是整个评估里最重要的利好。

### 1.7 关键发现（2026-11-15，144 spike D3 实测）：legacy IPC **消息系统**在 144 整体移除

在 144 上编译 `ppapi/proxy:ipc` 时，PPAPI 的 `ppapi_messages.h`（约 300 条 `IPC_MESSAGE_CONTROL*` 定义）直接失去编译基础。逐项核对：

| 头文件 | 140 | 142 | 144 |
| --- | --- | --- | --- |
| `ipc/ipc_message_macros.h`（消息类生成宏） | ✅ | ✅ | **❌** |
| `ipc/ipc_message_utils.h`（ParamTraits/WriteParam） | ✅ | ✅ | **❌** |
| `ipc/ipc_channel_handle.h`（`IPC::ChannelHandle`） | ✅ | **❌** | ❌ |
| `ipc/ipc_platform_file.h`（`IPC::PlatformFileForTransit`） | ✅ | ✅ | **❌** |
| `ipc/ipc_sender.h`（`IPC::Sender`） | ✅ | ✅ | **❌** |
| `ipc/ipc_message.h`（`IPC::Message` 本体） | ✅ | ✅ | ✅（只剩 pickle + routing 头） |

实测证据（144 树内）：

```text
ipc/ipc_message_macros.h       False
ipc/ipc_message_utils.h        False
ipc/ipc_channel_handle.h       False
ipc/ipc_platform_file.h        False
ipc/ipc_sender.h               False
ipc/ipc_message.h              True    ← 只剩 class Message : public base::Pickle
```

且 144 全树（`ipc/`、`base/`、`mojo/public/`、`content/common/`）已经搜不到 `IPC_MESSAGE_CONTROL*` 宏的定义——Chromium 自己已不再使用这套消息系统。

**这意味着什么：**

- 140 / 142 上，PPAPI 的 IPC 是"改 include / 改类型"级别的适配；
- 144 上，PPAPI 的 IPC 需要**复活整套 legacy IPC 消息框架**（宏、消息类、`ChannelHandle`、`PlatformFileForTransit`、`Sender`），而它正是"因为 PPAPI 被删"才被拆掉的；
- 这不再是"工程陡坡"，而是"**再 vendor 一个子系统**"：时间从 6–10 周上调到 **2–3 个月**，且风险高（宏生成的消息类与 144 的 `IPC::Message` 语义要逐一核对）。

### 1.8 修正后的版本建议

| 目标 | 结论 |
| --- | --- |
| **140 / E38** | ✅ **推荐**：legacy IPC 完全保留，只需处理 5 个边缘头（`ipc_logging`/`test_sink`/`sync_message_filter`/`message_filter`/`struct_constructor_macros`） |
| **142 / E39** | ⚠️ 次选：仅 `ChannelHandle` 被删，可小范围 vendor 解决 |
| **144 / E40+** | ❌ **不建议**：legacy IPC 消息系统整体移除，需复活框架（2–3 个月+） |


### 1.5 Electron 版本映射（本地 electron 仓库实测）

| Electron | Chromium | Node |
| --- | --- | --- |
| v37.0.0 | **138.0.7204.35** | v22.16.0 |
| v38.0.0 | **140.0.7339.41** | v22.18.0 |
| v39.0.0 | **142.0.7444.52** | v22.20.0 |
| v40.0.0 | **144.0.7559.60** | v24.11.1 |
| v41.0.0 | 146.0.7680.65 | v24.14.0 |
| v42.0.0 | 148.0.7778.96 | v24.15.0 |
| v43.0.0 | **150.0.7871.46** | v24.17.0 |
| v44.0.0 | 152.0.7977.54 | v24.18.1 |
| v45.0.0 | 156.0.8078.48 | v24.22.0 |

> "150+" 就是 **Electron 43+**。本地 Chromium 缓存只到 149，做 150 需要重新下载源码（约 14 GB）。

### 1.6 138 的 ppapi 代码本身已经"现代化"

在 138 的 `ppapi/` 里统计已知的历史漂移写法：

| 模式 | 出现次数 |
| --- | --- |
| `base::Bind(` | 0 |
| `TimeDelta::From*` | 0 |
| `base::size(` | 0 |
| `SupportsWeakPtr` | 0 |
| `base::DictionaryValue` / `base::ListValue` | 0 |

也就是说：我们这次在 87→138 迁移里修的 14 类"老 API"，**在 138→140 不会重演**。
138→140 的漂移主要是**头文件拆分/改名 + 少量函数签名变化**，量级远小于 87→138。

---

## 2. 工作量拆解（以 140 为例）

### 2.1 vendor 清单（全部取自 138）

```
ppapi/                             1419 文件（c/cpp/proxy/host/shared_impl/thunk/utility）
content/renderer/pepper/            137 文件
content/ppapi_plugin/                 9 文件
content/browser/ ppapi 相关          66 文件
content/common/ pepper 相关           7 文件
content/public/common/content_plugin_info.h（140 仍在，晚版本需一并 vendor）
content/public/browser/browser_ppapi_host.h
```

### 2.2 必须重做的接线（GN / 构建开关）

| 位置 | 内容 |
| --- | --- |
| `ppapi/BUILD.gn` 及各子目录 | 目标定义整体恢复 |
| `ppapi/buildflags/buildflags.gni` | `enable_ppapi` 不再依赖 NACL（同 138） |
| `content/BUILD.gn` | 恢复 `ppapi_plugin`、`renderer/pepper` 目标与依赖 |
| `sandbox/policy/sandbox_type.cc` | 恢复 `--type=ppapi` 映射（Windows 返回 `kNoSandbox`） |
| `content/common/pepper_plugin_list.*` + switches | 插件列表 + `--register-pepper-plugins` / `--allow-command-line-plugins` |
| `content/renderer/render_frame_impl.cc` | 在 `CreatePlugin` 里恢复 `PepperWebPluginImpl` 分支 |
| `ppapi/shared_impl/ppapi_permissions.h` | `PERMISSION_FLASH` 位（140 起随 ppapi 一起 vendor） |

### 2.3 87 Flash 私有层

可直接复用 138 上已完成的移植（14 项漂移已修），只是要重新对 140 的 ppapi 版本编译一次。

### 2.4 时间估计

| 阶段 | 140 | 142 |
| --- | --- | --- |
| vendor + gn gen 通过 | 2–3 天 | 3–4 天 |
| `ppapi_proxy` 目标编译通过 | 3–5 天 | 4–6 天 |
| `content/renderer/pepper` + 插件进程编译通过 | 5–7 天 | 6–8 天 |
| 链接 + 跑通 `init OK` | 2–3 天 | 3–4 天 |
| 出帧 + 基本回归 | 2–3 天 | 3–4 天 |
| **合计** | **2–4 周** | **3–5 周** |

> 144+：在以上基础上再叠加 39 个文件的 IPC 层改名/改类型适配（见 §1.3），**6–10 周**，风险中等。

> **实测对照（2026-11-17）**：140 从 vendor 到"真实 SWF 出帧"实际用了 **约 2.2 天（累计 18–20 工时）**，
> 比表中 2–4 周的估算快一个数量级；原因是 §1.3 里担心的 IPC 阻塞点大多只需"补回 138 的接线"而非重写框架。
> 142 仍按 3–5 周保守估计（未实测）。

---

## 3. 风险清单

| 风险 | 影响版本 | 严重度 | 缓解 |
| --- | --- | --- | --- |
| legacy IPC 层集中重构（改名为主，非删除） | 144+ | **高** | 提前把 ppapi 侧 include/类型改成新名；`PlatformFileForTransit` 51 处逐点替换 |
| `content_plugin_info.h` 在 149 删除 | 148/149 | 中 | 一并 vendor（已在清单内） |
| `browser_ppapi_host.h` 在 140 删除 | 140+ | 中 | vendor + 重新接线 |
| mojo 化导致 `ppapi/proxy` 编译失败 | 145+ | 高 | 同上 |
| Windows 沙箱策略变动 | 140+ | 低 | 沿用 138 的 `kNoSandbox` 方案 |
| 每个大版本都要重做一次 | 全部 | **高** | 建立"vendor patch 集 + 升级 runbook" |
| 150+ 无本地源码 | 150+ | 低（可下载） | 重新拉 GCS 缓存 |

---

## 4. 决策建议

### 4.1 如果目标是"可交付产品"

**留在 138（或 132）**。理由：

1. 138 已验证出帧；
2. 140+ 的收益只有"新 2–10 个里程碑 + 安全补丁"，代价是 2–5 周一次性投入 + **每个版本都要重做**；
3. 新网站兼容性问题用 **Ruffle 兜底**（单内核内双引擎）比 vendor PPAPI 便宜一个数量级。

### 4.2 如果目标是"研究/最高可行版本"

**推荐路线：140 已完成（2026-11-17 出帧）→ 先把 2D 体验与功能债补齐，再评估 142。**

- 140 是最便宜的"跨过删除线"验证点：能证明"vendor 1638 文件 + 修 5 个 IPC 头"这条路走得通；
- 142 是**性价比天花板**（IPC 核心仍在，只多退 2 个头文件）；
- 144 起是**工程陡坡**（约 39 个文件适配 + 51 处句柄类型替换），要 6–10 周；除非有明确商业理由，否则建议停在 142。

### 4.3 不建议

- **139**：渲染层已删，等于从 138 vendor，收益 1 个里程碑；
- **150+**：技术上可行（150 与 156 的 Blink 插件 API 均已远程实测仍在），代价是重新下载源码 + 144 那一档适配 + 再多 1–3 个里程碑漂移；适合作为"长期分支"而不是一次性验证。

---

## 5. 建议的 spike 方案（若要执行）

**目标**：用 2 周时间盒验证 140（E38）能否跑通，**只要求"能编 + 能出帧"**，不追求功能完整。

| 天 | 里程碑 | 判据 |
| --- | --- | --- |
| D1–D2 | 切到 140 源码 + 从 138 vendor 1638 文件 + 补 GN | `gn gen out/Testing` 成功 |
| D3–D5 | `ppapi_proxy` 目标编译通过 | 无编译错误 |
| D6–D8 | `content/renderer/pepper` + 插件进程编译通过 | 无编译错误 |
| D9–D10 | 链接 `electron.exe` | 生成可执行文件 |
| D11–D12 | 跑测试页 | trace 出现 `init OK` |
| D13–D14 | 出帧验证 | 截图出现 SWF 画面 |

**止损**：D7 结束时 `ppapi_proxy` 仍编不过 → 停止，写结论。

**复用**：138 的 87 Flash 私有层移植成果、构建脚本文档（runbook §7/§8）、测试页与 trace 埋点。

---

## 6. 数据附录（复现命令）

```powershell
# 各版本 PPAPI 代码量
foreach ($t in '138.0.7204.35','140.0.7339.41','149.0.7827.95') {
  $all = git -C src ls-tree -r --name-only $t
  '{0} ppapi={1} renderer/pepper={2}' -f $t,
    ($all | Where-Object { $_ -match '^ppapi/' }).Count,
    ($all | Where-Object { $_ -match '^content/renderer/pepper/' }).Count
}

# 138 ppapi 的外部依赖
git -C src grep -h -o '#include "[^"]*"' 138.0.7204.35 -- ppapi |
  ForEach-Object { if ($_ -match '#include "([^"]+)"') { $matches[1] } } |
  Where-Object { $_ -match '^(base|content|ipc|mojo|gpu|media|ui|net|third_party/blink)/' } |
  Sort-Object -Unique

# IPC 层演化
foreach ($t in '138.0.7204.35','140.0.7339.41','142.0.7444.52','144.0.7559.60','149.0.7827.95') {
  $n = (git -C src ls-tree -r --name-only $t | Where-Object { $_ -match '^ipc/' }).Count
  $ok = git -C src cat-file -e "$t`:ipc/ipc_message_utils.h" 2>$null; $has = ($LASTEXITCODE -eq 0)
  '{0} ipc文件数={1} message_utils={2}' -f $t, $n, $has
}

# Electron → Chromium
foreach ($e in 'v37.0.0','v38.0.0','v39.0.0','v40.0.0','v43.0.0') {
  $d = (git -C src/electron show "$e`:DEPS") -join "`n"
  $m = [regex]::Match($d, "'chromium_version':\s*'([^']+)'")
  '{0} -> {1}' -f $e, $m.Groups[1].Value
}
```

### 1.9 140 实测结果（2026-11-15 17:17）：`ppapi/proxy:proxy` 编译通过 ✅

在 140 树（Chromium 140.0.7339.41 / Electron v38）上完成 vendor 后，`ppapi_proxy.lib` 成功产出。

| 项 | 140 的实际情况 | 需要做的事 |
| --- | --- | --- |
| `IPC_MESSAGE_CONTROL*` 宏 | ✅ 保留 | 无 |
| `IPC_MESSAGE_ROUTED*` 宏 | ❌ 已删（PPAPI 全是 routed 消息） | 从 138 补回约 15 KB 宏定义到 `ipc_message_macros.h` |
| `IPC::MessageFilter` + `ChannelProxy` 过滤链 | ❌ 已删（`TryFilters()` 退化为 `return false`） | 恢复 `message_filter.{h,cc}` + 给 `ChannelProxy` 补 `AddFilter/RemoveFilter` 管道 |
| `IPC::SyncChannel::CreateSyncMessageFilter` | ❌ 已删 | 用 `sync_context()->shutdown_event()` 恢复 |
| `ipc_logging.h` / `ipc_test_sink.h` / `ipc_sync_message_filter.h` / `struct_constructor_macros.h` | ❌ 已删 | 从 138 取回（编译期只剩头文件需求） |
| `NOTIMPLEMENTED` | 移到 `base/notimplemented.h` | ppapi 几个文件补 include |
| unsafe-buffers 检查 | 140 起默认开启 | ppapi 源文件加 `#pragma allow_unsafe_buffers` / `allow_unsafe_libc_calls` |
| `media::SignedInt16SampleTypeTraits` | 需显式 include | 补 `media/base/audio_sample_types.h` |

**结论**：140 的缺口是"过滤器层 + routed 宏"，属**可恢复的局部删除**；144 是"整套消息框架 + traits 改名 + 句柄类型统一"的**系统性删除**。这印证最终的版本梯队：**140 可行（约 1 周），142 次之（天花板），144+ 不建议**。
### 1.10 140 阶段 1 实测（2026-11-15 20:05）：插件数据结构恢复完成 ✅

140 不仅删了 PPAPI 代码，还**剔除了数据结构里的 pepper 字段**。阶段 1 已按"加法式恢复"补齐，并验证编译通过。

| 结构 | 140 原状 | 恢复内容 | 验证 |
| --- | --- | --- | --- |
| `content::WebPluginInfo` | 只剩 `PLUGIN_TYPE_BROWSER_*` | 补回 `PLUGIN_TYPE_PEPPER_IN_PROCESS` / `PLUGIN_TYPE_PEPPER_OUT_OF_PROCESS`、`pepper_permissions`、`is_pepper_plugin()` | ✅ `webplugininfo.obj` |
| `content::ContentPluginInfo` | 无 pepper 字段 | 补回 `is_out_of_process`、`permissions`，并让 `ToWebPluginInfo()` 正确映射类型与权限 | ✅ `content_plugin_info.obj` |
| `content_switches` | 删除全部 pepper 开关 | 补回 `kPpapiInProcess` / `kPpapiPluginProcess` / `kPpapiPluginLauncher` / `kPpapiStartupDialog` / `kPpapiSubpixelRenderingSetting` / `kPpapiAntialiasedTextEnabled` / `kRegisterPepperPlugins`（值取自 138） | ✅ `pepper_plugin_list.obj` |
| `content/common` 的 pepper 文件 | 文件在 140 被删 | 从 138 vendor（`pepper_file_util`、`pepper_plugin_list`、`pepper_renderer_instance_data`、`pepper_plugin.mojom`） | ✅ 三个对象全部编译通过 |

**关键结论**：140 的缺口是"**代码 + 少量数据字段**"，可以加法式恢复；这与 144 的"整套 IPC 消息框架删除"不是一个量级。

下一步（阶段 2）：`content/renderer/pepper` 的 137 个文件编译适配。
### 1.11 140 阶段 2 进展（2026-11-15 20:50）：渲染层错误已收敛为 15 个文件

阶段 2（`content/renderer/pepper` 的 137 个文件）分两批推进，当前错误面已清晰。

**已完成（两批）**

| 修复 | 说明 |
| --- | --- |
| `pepper_plugin.mojom` 纳入构建 | 加入 `content/common` 的 `mojo_bindings` 源 |
| `browser_font_resource_trusted.{h,cc}` | 从 138 vendor，并加入 `content/child` 源 |
| `ContentPluginInfo::EntryPoints` + `internal_entry_points` | 从 140 的"纯浏览器插件"结构补回 PPAPI 入口点（`get_interface` / `initialize_module` / `shutdown_module`） |
| `content/renderer/sad_plugin.{h,cc}` | 从 138 vendor |
| `pepper_plugin_list` / `pepper_file_util` / `pepper_renderer_instance_data` | 从 138 vendor 并编译通过 |
| media 采样 traits、`NOTIMPLEMENTED` | 补 include |

**剩余错误（15 个文件，均为 140 删除的"pepper 钩子/API"）**

| 类别 | 具体缺失 | 涉及 |
| --- | --- | --- |
| `RenderFrameImpl` 的 pepper 钩子 | `PepperInstanceCreated/Deleted`、`PepperFocusChanged`、`PepperTextInputTypeChanged`、`PepperSelectionChanged`、`PepperCaretPositionChanged`、`PepperCancelComposition`、`GetPepperHost` | 7 处 |
| `RenderFrame` 路由 ID | `GetRoutingID()`、`RenderFrameImpl::FromRoutingID()` | 6 个文件 |
| `ContentRendererClient` | `IsExternalPepperPlugin()` | 1 处 |
| `viz::TransferableResource` | `MakeSoftwareSharedImage()` 删除、`MakeGpu()` 私有化 | `pepper_graphics_2d_host.cc` |
| `RenderThread::Send` | 已删除 | `pepper_in_process_router.cc` |
| Blink `WebPepperSocket` | 头与实现整体删除 | `pepper_websocket_host.{h,cc}` |
| `ui/gfx/gpu_memory_buffer.h` | 头被移动/删除 | `pepper_media_stream_video_track_host.cc` |
| 视频接口参数 | 某处 7 参数 → 6 参数 | video capture / encoder |

**结论**：错误已从"缺文件/缺结构"收敛为"缺钩子"——**每一类都是 138 有、140 删掉的具体 API**，恢复方式明确。预计阶段 2 还需 **6–10 小时**（钩子恢复 + graphics2d 资源适配 + websocket 桩）。
### 1.12 140 阶段 2 完成（2026-11-15 21:31）：渲染层 pepper 全部编译通过 ✅

`content/renderer/pepper` 的 **32 个目标对象全部生成**（含 `pepper_plugin_instance_impl`、`pepper_webplugin_impl`、`pepper_graphics_2d_host`、`pepper_websocket_host`）。

**本轮（阶段 2）修复清单**

| 类别 | 修复内容 |
| --- | --- |
| mojom | `pepper_plugin.mojom` 纳入 `content/common` 的 `mojo_bindings` |
| 缺失源文件 | 从 138 vendor：`browser_font_resource_trusted.{h,cc}`、`sad_plugin.{h,cc}`、`pepper_plugin_list`、`pepper_file_util`、`pepper_renderer_instance_data` |
| 插件结构 | `ContentPluginInfo::EntryPoints` + `internal_entry_points`；`WebPluginInfo` 的 pepper 类型/权限；`content_switches` 的 7 个 pepper 开关 |
| RenderFrame 钩子 | 恢复 `GetRoutingID()`（基类虚函数 + 实现 + 路由表）、`FromRoutingId()`、`GetPepperHost()`、`PepperInstanceCreated/Deleted`、`PepperFocusChanged`、`PepperTextInputTypeChanged`、`PepperSelectionChanged`、`PepperCaretPositionChanged`、`PepperCancelComposition`（降级为 no-op） |
| 客户端钩子 | `ContentRendererClient::IsExternalPepperPlugin()`（默认 false，定义在新文件 `pepper_client_compat.cc`） |
| viz 资源 | `TransferableResource::MakeSoftwareSharedImage/MakeGpu` → 统一改用 140 的 `Make(shared_image, source, sync_token)` |
| IPC 发送 | `RenderThread::Get()->Send()` → `RenderThreadImpl::current()->GetChannel()->Send()`；`PepperBrowserConnection` 改走 `render_frame()->GetRoutingID()` |
| Blink | 从 138 取回 `web_pepper_socket{,_client}.h`，新增 `web_pepper_socket_stub.cc` 桩（WebSocket 降级为连接失败） |
| media API | `VideoFrame::WrapExternalData/YuvData` 改为 `base::span` + `TimeDelta` 参数；补 `audio_sample_types.h` |
| 安全告警 | content/renderer/pepper 的 72 个 .cc 加 `allow_unsafe_buffers` |

**已知降级**：`PPB_WebSocket` 不可用（桩）、`PepperCancelComposition` 无操作。这两项不影响 Flash 渲染主路径。

**下一步（阶段 3）**：`content/browser` 的 pepper 宿主（66 文件）+ `content/ppapi_plugin`（9 文件）+ 链接 `electron.exe`。
### 1.13 140 阶段 3 进展（2026-11-15 22:45）：浏览器侧 pepper 与插件进程全部编译通过 ✅

`content/browser` 的 pepper 宿主（28 个对象）与 `content/ppapi_plugin`（4 个对象）**全部编译通过**，已进入 `electron` 全量构建。

**本轮修复清单**

| 类别 | 修复内容 |
| --- | --- |
| ContentBrowserClient | 补 `DidCreatePpapiPlugin`、`AllowPepperSocketAPI`、`IsPluginAllowedToCallRequestOSFileHandle`、`IsPluginAllowedToUseDevChannelAPIs`、`GetExternalBrowserPpapiHost`（默认实现放 `pepper_browser_client_compat.cc`，注意必须位于 `public:` 段） |
| 进程类型 | `PROCESS_TYPE_PPAPI_PLUGIN` → 140 的 `PROCESS_TYPE_PPAPI_PLUGIN_DEPRECATED` |
| ChildProcessHost | 恢复 `Send()`（走内部 `channel_`）、在 `ChildProcessHostImpl::OnMessageReceived` 转发给 delegate、`OnChannelConnected` 通知 delegate |
| 消息过滤器 | 从 138 取回 `browser_message_filter.{h,cc}` 并加入 `content/public/browser` 构建 |
| PpapiPluginProcessHost | `Send` 走 `process_->GetHost()->Send()`；去掉 `AddFilter`（140 无过滤器），改为在 `OnMessageReceived` 中先交给 `BrowserPpapiHostImpl::message_filter()`；`Create` 去掉 `IpcMode` |
| PluginServiceImpl | 恢复 `OpenChannelToPpapiPlugin` / `FindOrStartPpapiPluginProcess` / `FindPpapiPluginProcess` / `CountPpapiPluginProcessesForProfile`（复用 140 已有的 `plugins_`、`filter_`、`max_ppapi_processes_per_profile_`） |
| RenderFrameHostImpl | vendor `render_frame_host_impl_ppapi_support.{h,cc}`（138，250 行），补 `GetPpapiSupport()` 与成员（注意成员必须在 `WeakPtrFactory` 之前） |
| ppapi_plugin 进程 | `PpapiThread` 继承 `IPC::Sender`，`Send` 改走 `channel()->Send()`；`OnControlMessageReceived` → `OnMessageReceived`；`ppapi_plugin_main` 去掉 140 已删的 startup tracing 调用 |
| 网络过滤器 | `ResolveHostClient::OnComplete` 适配 140 签名（`AddressList` 非 optional + `vector<HostResolverEndpointResult>`），断连回调改 lambda |
| 其他 | `ReceivedBadMessage` 改传 `render_process_id_`；pepper 媒体会话走 `RenderFrameHostImplPpapiSupport` |

**当前状态**：`ninja -C out/Testing electron` 进行中（1788/10494），已无编译错误，等待链接结果。

**下一步**：处理链接期未定义符号（预计集中在被删除的 pepper 外围符号），然后跑测试页出帧。
### 1.14 140 端到端联调（2026-11-16 起）：构建成功 → **已出帧（见 §1.14.10 / §1.14.11）**

**里程碑：`electron.exe`（Chromium 140 / Electron 38）构建成功并可运行。**

| 阶段 | 状态 |
| --- | --- |
| `ninja electron` 全量构建 | ✅ **成功**（305 MB，`--version` = v38.0.0） |
| 插件注册（浏览器侧） | ✅ `plugins_` 含 Shockwave Flash（oop=1） |
| 插件列表下发渲染进程 | ✅ 渲染进程收到 3 项（含 `application/x-shockwave-flash`） |
| Blink → `RenderFrameImpl::CreatePlugin` | ✅ 触发，`mime=application/x-shockwave-flash` |
| 渲染侧解析插件信息 | ✅ `PepperPluginRegistry::GetInfoForMimeType` 命中 |
| 创建插件模块 | ❌ **挂起**（`PluginModule::Create` 不返回，无崩溃日志） |

**本轮定位并修复的关键问题（都是"140 删掉了、138 有"的接线）**

| 问题 | 修复 |
| --- | --- |
| 140 的 `RenderFrameImpl::CreatePlugin` 只调用 `OverrideCreatePlugin`，无 pepper 分支 | 补 pepper 分支：按 MIME 从 `PepperPluginRegistry` 解析 `ContentPluginInfo` → `PluginModule::Create` → `PepperWebPluginImpl` |
| `ContentPluginInfo::ToWebPluginInfo()` 的类型被后一行覆盖成 `PLUGIN_TYPE_BROWSER_PLUGIN` | 修正为"internal → BROWSER_INTERNAL，否则 → PEPPER_OUT_OF_PROCESS/IN_PROCESS"，避免误走进程内路径触发 `InitializeModule` DCHECK |
| `PepperPluginRegistry::Initialize()` 把 Electron 的 PDF 内部插件当 pepper 模块预加载（entry points 为空） | 跳过无 `initialize_module` 的内部插件 |
| `--register-pepper-plugins` 未传递给渲染进程（140 只传了 `--allow-command-line-plugins`） | 在 `PropagateBrowserCommandLineToRenderer` 中补回该开关 |
| `RenderProcessHostImpl` 无 `pepper_renderer_connection` | 补成员/访问器/构造，并在 `OnMessageReceived` 首段路由 |
| `ContentBrowserClient`/`ContentRendererClient` 缺 pepper 钩子 | 补齐 5 个（实现集中在新文件 `pepper_*_compat.cc`） |
| `ContentPluginInfo::EntryPoints`、`WebPluginInfo` pepper 字段、7 个 pepper switch | 全部补回 |
| blink `WebFont` 被删 | 从 138 vendor `web_font.{h,cc}` 并适配 140 API（`PlainTextPainter` 无 offset/selection，自己用 `TextRun::SubRun` 实现） |

**当前卡点**：`PluginModule::Create` 内部挂起（无崩溃、无返回）。下一步需在下列位置加日志定位死锁：
`PepperRendererConnection::OnOpenChannelToPepperPlugin` → `PluginServiceImpl::OpenChannelToPpapiPlugin` → `PpapiPluginProcessHost::OpenChannelToPlugin`（注意 UI/IO 线程切换），以及插件进程 `ppapi_plugin_main`/`PpapiThread` 的初始化握手。
#### 1.14.1 本轮（21:30–23:00）进展：全链路打通，卡点收敛到"插件进程启动即崩溃"

**修复的 3 处接线（都在"138 有、140 删了"之列）**

| 位置 | 问题 | 修复 |
| --- | --- | --- |
| `render_frame_host_impl_interface_binders.cc` | 帧的关联接口注册表里没有 `mojom::PepperHost` | 在 `SetUpMojoConnection()` 中注册，委托 `GetPpapiSupport().Bind()` |
| `RenderFrameImpl::Initialize` | **从未创建 `PepperBrowserConnection`**（138 在此 new） | 补 `new PepperBrowserConnection(this)`（→ `module conn=0` 变成有效对象） |
| `RenderFrameImpl::GetPepperHost` | 仅判断 `pending_associated_interface_provider_remote_` 为空就放弃（该 pending 在首次使用后已被消费） | 改为"pending 与已建 provider 都没有才放弃"，绑定成功后 `bound=1` |

**当前链路（日志实测，全部通过）**

```
CreatePlugin mime=application/x-shockwave-flash
registry info=yes
module Create enter path=...pepflashplayer64_34_0_0_380.dll
module info=<ptr> oop=1
module conn=<ptr>
PepperBrowserConnection::GetHost frame=<ptr>
GetPepperHost after bound=1
module host=<ptr>
[browser] support OpenChannelToPepperPlugin
[browser] conn OpenChannelToPepperPlugin
[browser] service OpenChannelToPpapiPlugin
[browser] Ppapi sandbox on Windows is not supported.
[browser] ppapi plugin process crashed.
[browser] PpapiPluginProcessHost~PpapiPluginProcessHost()
renderer  module=no registered=1
```

**结论**：渲染→浏览器→插件进程的 mojo 通道与宿主对象已全部就位；**ppapi 插件进程在启动后立即崩溃**，且崩溃发生在日志初始化之前（`chrome.log` 中没有任何该进程的行）。下一个定位点是 `content/ppapi_plugin/ppapi_plugin_main.cc` / `ppapi_thread.cc` 的启动路径，以及 `PpapiPluginProcessHost::Init` 对子进程命令行/句柄的组装。
#### 1.14.2 本轮（09:00–11:15）进展：插件进程已能启动并进入 `PpapiPluginMain`

**本轮定位到的根因（都是 140 把 ppapi 进程类型从各处的 switch 里删掉导致的）**

| 位置 | 现象 | 修复 |
| --- | --- | --- |
| `content/app/content_main.cc` `IsSubprocess()` | `--type=ppapi` 不被当作子进程 | 加入 `kPpapiPluginProcess` |
| `content/app/content_main_runner_impl.cc` | 进程类型→main 函数映射表里没有 ppapi（两张表） | 补 `PpapiPluginMain` 条目 + extern 声明 |
| `sandbox/policy/sandbox_type.cc` `SandboxTypeFromCommandLine()` | 140 删掉了"未知类型"的兜底，对 `--type=ppapi` 直接 `NOTREACHED()` → 子进程 `STATUS_BREAKPOINT (0x80000003)` | Windows 上在 `PpapiPluginProcessHost::Init` 给子进程追加 `--no-sandbox` |

**验证结果（文件标记法逐阶段确认）**

| 阶段 | 结果 |
| --- | --- |
| `ContentMainRunnerImpl::Initialize()` 入口 | ✅ |
| `BasicStartupComplete` / `ContentClientInitializer::Set` / `PreSandboxStartup` | ✅ |
| `sandbox::policy::Sandbox::Initialize` | ❌ 之前在此崩溃 → 加 `--no-sandbox` 后 ✅ |
| **`PpapiPluginMain` 入口** | ✅ **已进入**（`ppapi-main.txt` 标记确认） |

**新暴露的两个问题（下一轮处理）**

1. `FATAL: content/browser/browser_child_process_host_impl.cc:115 NOTREACHED hit.`
   `GetCoordinatorClientProcessType()` 的 switch 只处理 RENDERER/UTILITY/GPU，`PROCESS_TYPE_PPAPI_PLUGIN` 落到 `default: NOTREACHED()` → 浏览器进程 FATAL。138 里该处有 ppapi 分支（映射到 `PLUGIN`）。需补。
2. `FATAL: blink/.../font_cache_skia.cc:211 DCHECK failed: font_platform_data.`
   插件/渲染进程创建字体时 last‑resort 字体取不到（`kCourierNew` 回退也失败）。怀疑 ppapi 进程没有初始化字体环境（138 的 `PpapiPluginMain` 里有 DWrite 字体代理 / `SkFontMgr` 相关初始化），需对照 138 补齐。

**结论**：插件进程已从"启动即崩溃"推进到"正常进入自己的 main 函数"。剩余问题从"进程起不来"变成"两个具体的 CHECK/DCHECK"。
#### 1.14.3 本轮（11:20 前）进展：进程类型修复完成，5 个进程全部存活，卡在插件进程初始化握手

**本轮修复**

| 位置 | 问题 | 修复 |
| --- | --- | --- |
| `content/common/process_type.cc` | `GetProcessTypeNameInEnglish()` 缺 ppapi 分支（140 改成 `_DEPRECATED` 后缀并删了 case） | 补 `PROCESS_TYPE_PPAPI_PLUGIN_DEPRECATED` / `_BROKER_DEPRECATED` → "Pepper Plugin"/"Pepper Plugin Broker" |
| `content/browser/browser_child_process_host_impl.cc` | `GetCoordinatorClientProcessType()` 对 ppapi 落到 `default: NOTREACHED()` → **浏览器进程 FATAL** | 补两个 ppapi case → `memory_instrumentation::mojom::ProcessType::PLUGIN` |

**当前状态（实测）**

- 5 个进程全部存活：`browser / gpu-process / utility / renderer / **ppapi**`
- 渲染侧日志：`GetPepperHost after bound=1` → `module host=<ptr>` → 浏览器 `support/conn/service OpenChannelToPpapiPlugin` → `ppapi launched pid=<n>`
- 插件进程侧：**只打印 power_monitor 启动行**，没有任何 `PpapiThread` / `LoadPlugin` 活动
- 结果：应用挂起（渲染进程阻塞在同步 `OpenChannelToPepperPlugin`，等插件进程完成初始化握手），无崩溃、无 FATAL

**下一个定位点**：浏览器 → 插件进程的 `PpapiMsg_LoadPlugin`（`PpapiPluginProcessHost::RequestPluginChannel` 里的 `Send()`）是否真的送达。怀疑点是我们恢复的 `BrowserChildProcessHostImpl::Send()` 在 140 的 mojo 化通道上并未真正投递（140 已把子进程 IPC 换成 mojo，legacy `Send()` 可能只是空转）。需要：
1. 在 `PpapiPluginProcessHost::RequestPluginChannel` 和 `Send()` 里加日志确认投递；
2. 在插件进程 `PpapiThread::OnChannelConnected` / `OnMessageReceived` 加日志确认接收；
3. 若 legacy 通道确实不通，改为用 140 的 mojo `ChildProcess` 接口发送 `PpapiMsg_LoadPlugin` 对应的消息。
#### 1.14.4 本轮（11:26–12:05）进展：插件↔浏览器通道握手打通，卡在插件进程后续初始化

**本轮修复（3 处，全部是"140 不再通知/不再传递"的接线）**

| 位置 | 问题 | 修复 |
| --- | --- | --- |
| `BrowserChildProcessHostImpl::OnChannelConnected()` | 140 只置标志，不再通知 delegate → 插件宿主永远收不到"通道已连接"，`PpapiMsg_LoadPlugin` 和挂起的 channel 请求都不会发出 | 补 `delegate_->OnChannelConnected(peer_pid)` |
| `PepperRendererConnection::OpenChannelToPpapiPluginCallback::GetPpapiChannelInfo()` | 我们不再以 legacy `BrowserMessageFilter` 运行，`PeerHandle()` 恒为 null → `renderer_pid=0` → 插件侧 `DCHECK(base::kNullProcessId != renderer_pid)` 崩溃 | 回退到 `RenderProcessHost::FromID(...)->GetProcess().Handle()` |
| `PpapiPluginProcessHost::Init()`（上一轮已加） | Windows 上 ppapi 沙箱子进程启动即 `NOTREACHED` | 子进程命令追加 `--no-sandbox` |

**实测链路（日志，全部通过）**

```
[browser] CreateChannel send=1
[plugin]  ChildThreadImpl::Init legacy=1 / mojo invitation valid=1
[plugin]  ppapi_thread OnChannelConnected peer=<browser pid>
[plugin]  OnCreateChannel renderer_pid=23152 child_id=4
[plugin]  SetupChannel enter / InitPluginWithChannel result=1
[plugin]  sending ChannelCreated valid=1 → sent ChannelCreated
[browser] ppapi crashed code=-1073740791 (0xC0000409 STATUS_STACK_BUFFER_OVERRUN / __fastfail)
```

**当前卡点**：插件进程在成功把通道句柄回传给浏览器之后（约 200 ms）以 `0xC0000409` 崩溃。此时浏览器刚发出 `PpapiMsg_LoadPlugin`，插件要真正加载 Flash DLL 并处理后续消息；崩溃点最可能在：
- `PpapiThread::OnMsgLoadPlugin` → `base::LoadNativeLibrary` 载入 Flash DLL 的路径（140 的 `NativeLibrary` 接口有改动），或
- `ppapi::proxy::PluginDispatcher` 在 mojo 管道上处理首批消息时的断言/`__fastfail`。

**下一轮定位**：在 `PpapiThread::OnMsgLoadPlugin`、`PluginModule`/`LoadNativeLibrary` 调用处、`PluginDispatcher::InitPluginWithChannel` 之后的首次 `OnMessageReceived` 加日志/文件标记，区分是"DLL 加载失败"还是"首批消息处理崩溃"。
#### 1.14.5 本轮（12:06–13:30）进展：插件进程完整启动并加载 Flash DLL，卡在"浏览器收不到插件的回包"

**已确认的完整链路（插件侧全部正常）**

```
[browser] CreateChannel send=1
[plugin]  OnChannelConnected peer=<browser pid>
[plugin]  OnLoadPlugin enter path=...pepflashplayer64_34_0_0_380.dll
[plugin]  library loaded valid=1
[plugin]  entry points get_interface=1 init_module=1
[plugin]  initialize_module returned -2      ← Flash 的 PPP_InitializeModule 返回 PP_ERROR_FAILED
[plugin]  OnCreateChannel renderer_pid=<pid> child_id=4
[plugin]  SetupChannel enter → InitPluginWithChannel result=1
[plugin]  sent ChannelCreated
[browser] （无任何 host OnMessageReceived / OnRendererPluginChannelCreated 日志）
[plugin]  约 30 秒后 ppapi crashed code=0xC0000409
renderer  module=no registered=1
```

**本轮修复**

| 位置 | 问题 | 修复 |
| --- | --- | --- |
| `PpapiThread::OnLoadPlugin` | 浏览器重复发 `PpapiMsg_LoadPlugin` 时，Flash 二次 `initialize_module` 直接崩溃（0xC0000409） | 增加"已加载则忽略"的保护 |
| `PpapiPluginProcessHost::OnChannelConnected` | 同一连接事件可能被通知两次 | 增加 `load_plugin_sent_` 去重 |
| `BrowserChildProcessHostImpl::OnMessageReceived` | 140 不再实现该 override，导致 `ChildProcessHostImpl` 把子进程消息交给基类（返回 false）后**被丢弃** | 补 override：转发给 `delegate_->OnMessageReceived` |

**当前卡点（两个，均已定位到具体环节）**

1. **Flash 初始化返回 -2**：接口探测日志显示 Flash 依次取得 `PPB_Core/PPB_Audio/PPB_BrowserFont_Trusted/...`（全部 `perm=1`、`iface_null=0`），唯一缺失的是 `PPB_Flash_Clipboard;4.0/5.0/5.1`（138 的 `interface_list.cc` 同样没有，待确认 138 上是否也返回 -2）。
2. **浏览器收不到插件的 `PpapiHostMsg_ChannelCreated`**：`ipc_channel_mojo` 已编入（obj 存在），但 `ChildProcessHostImpl::OnMessageReceived` 从未被调用 → 浏览器侧 legacy IPC 通道没有把插件发来的消息派发上来。这是"`module=no`"和插件 30 秒后被杀的直接原因。

**下一轮定位**：检查 `ipc/ipc_channel_mojo.cc` 在 140 里的消息派发路径（`ChannelMojo::CreateClientFactory`/`CreateServer` 的 listener 是否被真正挂上、`ChannelMojo::Start` 是否被调用），必要时给浏览器侧通道加"收到的字节/消息"日志。
#### 1.14.6 本轮（14:10–17:20）重大突破：Flash 的 `PPP_InitializeModule` 已返回 0（初始化成功）

**根因**：Chromium 140 把整套 **Flash 私有 PPAPI 接口**从 ppapi 里删掉了；我们的 140 树因此缺失 51 个文件，Flash 请求 `PPB_Flash_Clipboard` / `PPB_Flash` 等接口全部落空，`PPP_InitializeModule` 返回 `PP_ERROR_FAILED (-2)`。

**从 138 vendor 的 51 个文件**（`ppapi/` 下）：
- `c/private/`：`ppb_flash.h`、`ppb_flash_clipboard.h`、`ppb_flash_file.h`、`ppb_flash_font_file.h`、`ppb_flash_fullscreen.h`、`ppb_flash_menu.h`、`ppb_flash_message_loop.h`、`ppb_flash_print.h`、`ppb_flash_drm.h`、`ppp_flash_browser_operations.h`
- `proxy/`：`flash_clipboard_resource`、`flash_drm_resource`、`flash_file_resource`、`flash_font_file_resource`、`flash_fullscreen_resource`、`flash_menu_resource`、`flash_resource`、`ppb_flash_message_loop_proxy`、`serialized_flash_menu`
- `shared_impl/`：`flash_clipboard_format_registry`、`ppb_flash_font_file_shared.h`、`ppp_flash_browser_operations_shared.h`
- `thunk/`：`interfaces_ppb_private_flash.h` + 10 个 `ppb_flash_*_thunk.cc` + 8 个 `ppb_flash_*_api.h`

**配套接线（同样是从 138 补回）**：
| 位置 | 补什么 |
| --- | --- |
| `ppapi/proxy/BUILD.gn` / `thunk/BUILD.gn` / `shared_impl/BUILD.gn` | 新增 20 个源文件条目 |
| `ppapi/shared_impl/singleton_resource_id.h` | `FLASH_CLIPBOARD/FLASH_FILE/FLASH_FULLSCREEN/FLASH_SINGLETON_ID` |
| `ppapi/thunk/resource_creation_api.h` + `ppapi/proxy/resource_creation_proxy.{h,cc}` | `CreateFlashDRM/FontFile/Menu/MessageLoop` |
| `ppapi/shared_impl/resource.h` | `FOR_ALL_PPAPI_RESOURCE_APIS` 增加 8 个 Flash API getter |
| `ppapi/shared_impl/api_id.h` | `API_ID_PPB_FLASH_MESSAGELOOP` |
| `ppapi/thunk/thunk.h` | include `interfaces_ppb_private_flash.h` |
| `ppapi/proxy/interface_list.cc/.h` | **换成 138 版本**（含 Flash 注册）|
| `ppapi/proxy/ppapi_messages.h`、`serialized_structs.*`、`ppapi_param_traits.*` | 换成 138 版本（含 Flash IPC 消息与序列化）|
| `ppapi/proxy/ppb_instance_proxy.cc`、`content/renderer/pepper/pepper_plugin_instance_impl.cc` | 补 Flash singleton 分支（`FlashResource` 等）|
| `content/renderer/pepper/pepper_in_process_resource_creation.{h,cc}` | 补 4 个 Flash 虚函数（返回 0）|

**实测（关键里程碑）**

```
[plugin] initialize_module returned 0        ← Flash 初始化成功
[renderer] module=yes registered=1           ← 插件模块创建成功
```

**新卡点（渲染进程，非插件）**

```
FATAL: components/viz/common/resources/transferable_resource.cc:42
       Check failed: shared_image.
```

即 pepper 插件实例在创建合成资源（`TransferableResource::Make`）时 `ClientSharedImage` 为空 —— 正是此前记录的两处降级（`SetDefaultFramebufferSharedImage` / `CopyVideoFrameToSharedImage` 相关的 mail→SharedImage 迁移）造成的。下一轮在 pepper 的图层创建处补一个合法的 `ClientSharedImage`（或先跳过图层创建验证逻辑通路）。
#### 1.14.7 本轮（18:25–20:30）：渲染进程 FATAL 修复，Flash 全链路跑通，剩"位图为白"

> **状态（2026-11-17 23:00）**：本节两个结论都已落地——
> ① `transferable_resource.cc:42` 的 FATAL 已修复（`Make` 前先保存 `resource_image`）；
> ② "位图为白"的**最终根因**是 `Graphics2D FlushAck` 缺失（见 §1.14.8b），不是本节推测的合成问题。

**修复（1 行语义，来自崩溃栈定位）**

`pepper_graphics_2d_host.cc` 的 GPU 分支在把 `shared_image` **move 进 release callback 之后**才调用 `Make(shared_image, ...)`，导致 `Make` 收到空指针：
```cpp
scoped_refptr<gpu::ClientSharedImage> resource_image = shared_image;   // 新增：先留一份（等价 138 的 mailbox）
*release_callback = ... std::move(shared_image);
*transferable_resource = viz::TransferableResource::Make(resource_image, ...);
```
→ `transferable_resource.cc:42 CHECK(shared_image)` 消失。

**现在的完整链路（全部实测通过）**

```
[browser] 注册 3 个插件 / PepperHost binder / OpenChannelToPpapiPlugin
[plugin]  initialize_module returned 0
[renderer] module=yes
[renderer] instance Create ok
[renderer] SendDidChangeView rect=550x420 visible=1
[renderer] 2d Init size=825x630
[renderer] 2d host msg: SetScale → ReplaceContents → Flush
[renderer] PrepareTransferableResource（bound_2d=1）→ 无崩溃
[进程]     Browser/GPU/Utility/Tab/**Pepper Plugin** 全部存活
```

**当前唯一剩余问题**

- `button.swf`（与 138 同一文件、同一哈希）本该显示**绿色方块**；140 上 `navigator` 侧截图全白。
- 在 `Flush` 后直接采样插件位图：`px(300,200)/px(400,250)/px(10,10)` **全为 0xFFFFFFFF（不透明白）** → **Flash 提供的位图本身是白的**，不是合成丢失。
- 即 Flash 完成了 init/实例/视图/Graphics2D/Flush 全流程，但绘制结果为空。

**下一轮方向（按优先级）**
1. 对比 138 同路径：138 在 `ReplaceContents` 后位图是绿色 → 说明 140 少给了 Flash 某种能力（候选：`PPB_Flash` 的打印/全屏/消息循环、`PPB_Graphics2D` 的 Flush ack 语义、`PPB_ImageData` 像素格式契约）。
2. 检查 `need_flush_ack_` / `ViewFlushedPaint` 链路是否把 ack 正确回给 Flash（Flash 可能等 ack 才绘制下一帧）。
3. 若需要，给插件侧加"首次绘制前的接口清单"日志（`PPB_GetInterface` 我们会记录 MISSING）。

**注意**：本轮为定位临时加了多处 `[ppdbg]` 探针（`ppapi/host/ppapi_host.cc`、`pepper_graphics_2d_host.cc`、`pepper_plugin_instance_impl.cc` 等），下轮定位完毕后统一清理。
#### 1.14.7b 白图判别（2026-11-17 20:30）：先分清「Flash 写了白」还是「采样的不是那块内存」

**现状**：`initialize_module=0` → 实例创建 → `DidChangeView 550x420 visible=1` → `2d Init 825x630`
→ `SetScale/ReplaceContents/Flush` → `PrepareTransferableResource(bound_2d=1)` 不崩，进程全活；
但 `button.swf`（与 138 同哈希）截图全白，Flush 后采样 `px(300,200)/(400,250)/(10,10)`
全为 `0xFFFFFFFF`。

**关键：这个观测有两种互斥解释，修法完全不同，必须先分开**

| 解释 | 含义 | 后果 |
|---|---|---|
| A. Flash 真的写了白 | 舞台 bgcolor（默认白）被清上，但 display list 没画 → **SWF 内容没进 Flash**（URLLoader/FileIO/参数链路） | 查加载链路 + Flash 自身日志 |
| B. 采样的不是 Flash 写的那块 | `ReplaceContents` 的 138↔140 双端缓冲协商断裂：host 换了新 buffer，或拿到的是未初始化 GPU 映射 | 查 `ppb_graphics_2d_impl`（138 plugin 侧）↔ `pepper_graphics_2d_host`（140 host 侧）的 handle 契约 |

**决定性实验（按顺序做，前两个各 10 分钟）**

| 编号 | 做法 | 判读 |
|---|---|---|
| E1 预填色 | host 分配 bitmap 后 `memset(0xFF00FF00)`（绿），走完 Flush 再采样 | **变白** → 解释 A（Flash 在写这块，且清成舞台白）；**保持绿 / 只局部变** → 解释 B |
| E2 Init 后采样 | `2d Init` 完成、Flush **之前**采样一次 | 若已是白 → 白色来自初始化（我方）而非 Flash 清屏，直接指向 B；若为 0/其它 → 白是 Flash 写的，指向 A |
| E3 138 基线 | 同一 SWF、同采样点，在 138 上记录 Init 前 / Init 后 / Flush 后三个像素快照 | 拿到 ground truth：138 上白色何时出现、绿色何时覆盖；140 与之差异即为断点 |

**A 线（内容没进 Flash）检查项**

1. 浏览器侧是否真的发出 `button.swf` 请求、响应码/字节数（`pepper_url_loader_host` 加 URL+status 日志）。
2. `mms.cfg` 开 `TraceOutputFileEnable=1`，取 `flashlog.txt` 看 SWF 加载/AS3 错误。
3. 页面参数（`<param>`/`flashvars`）是否送达：`PPB_Var`/`PPB_VarDictionary` 路径抽查。
4. 交互探针：鼠标移到按钮上是否有效果（有反应 = SWF 已加载，问题在绘制；无反应 = 未加载）。

**B 线（缓冲协商断裂）检查项**

1. `ReplaceContents` 载荷：138 plugin 侧发的 handle 类型/大小 vs 140 host 侧期望的类型/大小。
2. host 側 `ClientSharedImage::Map()` 返回值是否有效；创建的是 software SharedImage 还是被误走 GPU 路径（未初始化映射易读出 0xFF）。
3. 采样指针的来源与 plugin 绘制指针是否为同一块（打印两侧基址/长度）。

**已排除（记录以免重复）**

- 3D 降级（`Attach()/Detach()`）：日志 `bound_2d=1`，button.swf 走 2D。
- 像素格式 BGRA/RGBA 互换：绿色在两种排列下仍是绿色，不会全白。
- Flush ack（`ViewFlushedPaint`）：**低概率但不是零**——机制上只影响后续帧节奏；但若 A/B 两条
  都不成立，再回头看 Flash 是否在等首个 ack 才真正绘制（未验证，勿当结论）。

#### 1.14.8 本轮（20:35–21:35）：按 E1/E2/E3 实验定位"全白"，A 线基本排除

> **状态（2026-11-17 23:00）**：本节"白不是我方初始化写的、SWF 加载正常、输入正常、不用 3D"的结论仍然成立；
> 但"白图是个渲染能力问题"的推断**被 §1.14.8b 修正**——真正原因是 Flash 在等 `FlushAck`，只画了第一帧。

**实验与结论**

| 编号 | 做法 | 结果 | 判读 |
| --- | --- | --- | --- |
| **E2** | `Init` 后立即采样（Flush 之前） | `px(10,10)=0 px(center)=0` | 白**不是**我方初始化写的（初始为透明黑） |
| **E1** | `Init` 后把整块填绿（0xFF00FF00），Flush 后采样 | Flush 后 `px = 0xFFFFFFFF`（白） | 我们显示的不是"被填绿的那块"——`ReplaceContents` 换进了 Flash 的新 buffer |
| **E1'** | `ReplaceContents` 交换后立刻填绿，Flush 后采样 | 仍是绿（未被覆盖） | 交换后的 buffer 之后无人写（符合双缓冲）；**但取证前已被我覆盖，无法区分 A/B**（如实记录，避免误判） |
| **A 线检查** | `PepperURLLoaderHost` 的 open/response/finished | open→`bytes_total=1031`→`received=1031`（=SWF 实际大小） | **SWF 加载成功**，A 线（内容没进 Flash）基本排除 |
| 输入送达 | `PepperPluginInstanceImpl::HandleInputEvent` | 6 次事件（move/down/up） | 输入链路正常 |
| 3D 排查 | `PPB_Graphics3D_Impl::CreateRaw` / `DoSwapBuffers` | **0 次** | Flash 只用 2D，**3D 降级与本问题无关**（排除一个候选） |
| 换片验证 | 用 FlxInvaders.swf（68 KB 真游戏）替换 button.swf | 同样全白、digest 与 button 完全一致 | **系统性**：Flash 清了舞台但 display list 不出 |

**当前结论**：Flash 全流程（init/实例/视图/Graphics2D/SetScale/ReplaceContents/Flush/输入）都通了，SWF 也加载了，但画出来是均匀白。

**下一轮决定性实验（不破坏证据）**
1. 在 `OnHostMsgReplaceContents` **收到消息、swap 之前**打印：传入 buffer 的指针、`px(0,0)`、**非白像素计数**；同时在 `Init` 里记录初始 buffer 指针 + 写入魔数。
   - 若 传入 buffer == 初始 buffer → Flash 画的就是我们填过的那块 ⇒ **解释 A（Flash 写了白）**；
   - 若不同 → 需在 Flash 自建 buffer 上做同样的非白计数 ⇒ **解释 B（双端缓冲契约断裂）**。
2. 顺便打印 `PPB_ImageData` 双端映射的 `shm size/format`，确认是同一块共享内存。

**代码状态**：`pepper_graphics_2d_host.cc` 已恢复为"138 原始 + 仅 140 适配（Make/resource_image）"的干净版本（全部探针已移除）；其余文件仍有临时 `[ppdbg]` 探针（`pepper_plugin_instance_impl.cc`、`ppapi/host/ppapi_host.cc`、`pepper_url_loader_host.cc`、`ppb_graphics_3d_impl.cc`、`ppapi_plugin_process_host.cc`、`render_frame_impl.cc`），待定位完成后统一清理。
#### 1.14.8b 白图根因（2026-11-17 22:30，已定位）：`DidCommitAndDrawCompositorFrame` 被 140 删除

**根因链条**

```
140 删除 WebLocalFrameClient::DidCommitAndDrawCompositorFrame（138 有）
  → 我们 vendor 的 RenderFrameImpl 里那个 override 不再 override 任何东西（编译不报错！静默失效）
  → 138 里的 for (auto* plugin : active_pepper_instances_) plugin->ViewInitiatedPaint(); 永远不执行
  → PepperGraphics2DHost 不发 Graphics2D FlushAck
  → Flash 画完第一帧（清屏白）就停住等 ack，不再画后续内容
```

**实测吻合**：`RC=1`、`Flush=1`、`SendFlushAck=0`、三次 digest 完全相同（画面冻结在清屏白）。

**这一类失效的系统性风险（比本 bug 更值得处理）**

- 形态：vendor 138 的 `WebLocalFrameClient` 派生类里，凡 140 已删除的虚函数，`override` 关键字
  静默降级为"新方法"——**编译通过、链接通过、运行时不调用**。
- 排查命令（在 140 树内跑，逐个确认是否还有第二例）：
  ```bash
  # 1) 140 的 WebLocalFrameClient 全部虚函数名
  grep -oP 'virtual\s+[\w:<>&*\s]+?\b(\w+)\s*\(' third_party/blink/public/web/web_local_frame_client.h \
    | grep -oP '\w+(?=\s*\()' | sort -u > /tmp/140_virtuals.txt
  # 2) 我们 vendor 的 RenderFrameImpl 全部 override 方法
  grep -nP '\boverride\b' content/renderer/render_frame_impl.h | grep -oP '\w+(?=\s*\()' | sort -u > /tmp/ours.txt
  # 3) 差集 = 可能静默失效的钩子
  comm -23 /tmp/ours.txt /tmp/140_virtuals.txt
  ```
  同样要对 `WebFrameWidget`/`WebWidget`/`RenderFrameObserver` 派生类做一遍。

**修复方案（三选，按风险排序）**

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **B（先做）** | `PepperGraphics2DHost` 在 `need_flush_ack_` 时用 ~16ms 单次定时器发 FlushAck（松手前不重入） | ~10 行、不依赖 Blink、无死锁风险，先验证"内容能不能出来" | 与呈现不同步，可能多渲染几帧（CPU 略高） |
| **A（终态）** | Flush 后调 140 仍存在的 `WebFrameWidget::InsertVisualStateRequest(callback)` 或 `NotifyPresentationTime(callback)`（两者均在 `public/web/web_frame_widget.h` 中确认存在）→ 回调里 `ViewInitiatedPaint()` | 语义与 138 一致（帧真正提交/呈现后 ack），不会过度渲染 | 依赖"有新内容时必然产生一帧"，理论上存在不产生帧→死等的风险，需配兜底超时 |
| C（最忠实） | 在 Blink 侧重新加回帧级钩子（`WebFrameWidgetImpl` 提交通知 → `WebLocalFrameClient` 虚函数 → pepper 实例循环） | 完全复刻 138 语义 | 改 Blink 内部，~30–50 行，后续 rebase 多一处冲突 |

**建议顺序**：B 先验证画面（最快拿到"内容正确"的结论）→ 通过后在 A/C 里选一个做终态；
若 A 的兜底超时把风险压住，优先 A（不动 Blink）。

#### 1.14.9 里程碑：Chromium 140 上 Flash 已能真正渲染画面

> 说明：**根因链条见 §1.14.8b**；本节记录"修复后画面真的出来了"的验证数据与结论。

**根因（"全白"的最终解释）**

- 140 删除了 Blink 的 `WebLocalFrameClient::DidCommitAndDrawCompositorFrame`（138 有），于是 `RenderFrameImpl` 里那段"合成器提交后通知 pepper 实例"的代码也随之消失：
  ```cpp
  // 138: RenderFrameImpl::DidCommitAndDrawCompositorFrame()
  for (PepperPluginInstanceImpl* plugin : active_pepper_instances_)
    plugin->ViewInitiatedPaint();   // → PepperGraphics2DHost::ViewInitiatedPaint()
  ```
- 结果：`PepperGraphics2DHost::ViewInitiatedPaint()` 不再被调用 → 不发 `PpapiPluginMsg_Graphics2D_FlushAck` → **Flash 只画了第一帧（清屏为白）就停住**，等待 ack 才继续。这与实测完全吻合（`RC=1`、`Flush=1`、`SendFlushAck=0`、digest 三次完全相同）。

**验证**：把 ack 临时提前到 `PrepareTransferableResource()`（资源交给合成器时）发送后：
- 位图出现非白像素（`nonwhite=110137`，中心像素为绿色 0xFF00D38C 等）；
- 三次截图 digest 各不相同（`interactiveFrames` 1→3）；
- `button.swf` 截图出现 **粉色方块**（SWF 实际内容）；
- `FlxInvaders.swf`（68 KB 真实游戏）也能渲染出 Flash 自己的 UI 对话框（说明 AS3/渲染链路已工作）。

**当前状态**
- 完整链路：插件注册 → 进程启动 → `initialize_module=0` → 实例创建 → `DidChangeView` → Graphics2D → `SetScale/ReplaceContents/Flush` → 合成器出图 ✔
- ack 目前是**临时方案**（在 `PrepareTransferableResource` 里发），下一步应改为"合成器真正提交后发"：
  1. 首选：`RenderFrameImpl` 实现 `blink::WebViewObserver`，在 `DidCommitCompositorFrame()` 里遍历 `active_pepper_instances_` 调 `ViewInitiatedPaint()`；
  2. 或把 138 的 `DidCommitAndDrawCompositorFrame` 加回 `WebLocalFrameClient` 并恢复调用点（更贴近 138，但要改 blink public + core）。
- 已知环境问题（非移植缺陷）：`FlxInvaders.swf` 会弹 Flash 的 "当前版本不再受支持" EOL 提示；该提示需要系统级 `mms.cfg` 加 `EOLUninstallDisable=1`（需管理员权限，本会话无法写入 `%WINDIR%\SysWOW64\Macromed\Flash\mms.cfg`）；BaoFlashBrowser 产品侧本来就写 mms.cfg，所以这不是 140 移植的新问题。

**待清理探针**（定位期间临时添加）：`pepper_graphics_2d_host.cc`（Init/ReplaceContents/Flush/Prepare/ViewInitiatedPaint/SendFlushAck）、`pepper_plugin_instance_impl.cc`（Create/PrepareTransferableResource/SendDidChangeView/HandleInputEvent/ViewInitiatedPaint）、`ppapi/host/ppapi_host.cc`、`pepper_url_loader_host.cc`、`ppb_graphics_3d_impl.cc`、`ppapi_plugin_process_host.cc`、`render_frame_impl.cc`。
#### 1.14.10 端到端跑通：Chromium 140 + 原生 Flash 29 渲染真实游戏

> **状态（2026-11-17 23:00）**：本节结论有效且是本轮最高成果；唯一遗留是 `FlushAck` 目前为**临时方案**（在 `PrepareTransferableResource` 里发），
> 终态方案与三种候选（B / A / C）的评估见 §1.14.11。

**Flash 版本对比（同一 140 构建、同一测试）**

| 插件 | 结果 |
| --- | --- |
| `plugins\win64\pepflashplayer64.dll`（**29.0.0.171**，项目自带） | ✅ `initialize_module=0`，无崩溃，**FlxInvaders 完整渲染**（欢迎语/五色外星人阵列/护盾/飞船），`interactiveFrames=3` |
| `plugins\experimental\win64\pepflashplayer64_34_0_0_380.dll`（国内魔改版） | ⚠️ 能初始化、能出图，但弹 "当前版本不再受支持" EOL 提示（时间炸弹） |

**验证数据**

```
Flash 29 + button.swf : interactive=3, digests=6b11eb2f5636 / d5685c48c4bf / e3159d7b5f91
Flash 29 + FlxInvaders: interactive=3, digests=3098cac21a2e / 245eefe2a7d0 / b39f0c160827
                       → 截图：WELCOME TO FLX INVADERS + 完整游戏画面
（138 基线 button.swf: interactive=3，行为模式一致）
```

**结论**
1. **Chromium 140 上原生 PPAPI Flash 已完整工作**（初始化、实例、视图、2D 绘制、输入、逐帧刷新）；
2. 版本选择上应以 **29.0.0.171（项目自带稳定版）** 为主；34.0.0.380 魔改版带 EOL 时间炸弹，不适合作为默认；
3. 之前"全白"的根因已定位为 **`Graphics2D FlushAck` 缺失**（140 删了 `WebLocalFrameClient::DidCommitAndDrawCompositorFrame`），当前用"资源交付合成器时发 ack"的临时方案绕过。
#### 1.14.11 最终状态与待办（2026-11-17 23:00）

**结论：Chromium 140 + Electron v38 + 原生 PPAPI Flash 已端到端跑通并出帧。**

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| `out/Testing/electron.exe` 构建 | ✅ | `--version` = `v38.0.0`；Chromium `140.0.7339.41` |
| PPAPI 编入（`enable_ppapi=1`） | ✅ | `ppapi/buildflags/buildflags.h` = 1 |
| 插件进程启动 | ✅ | 进程列表出现 `--type=ppapi`，5 进程共存 |
| Flash 初始化 | ✅ | `initialize_module returned 0` |
| 实例/视图/2D 绘制/输入 | ✅ | `DidChangeView 550x420`、Graphics2D `825x630`、`HandleInputEvent` 6 次 |
| **真实游戏出帧** | ✅ | Flash 29.0.0.171 完整渲染 `FlxInvaders.swf`（`interactiveFrames=3`，三种 digest） |

**改动规模（`git status` 实测）**：新增 1662 文件（ppapi 1470 + content pepper 203 等）、修改 63 文件、未跟踪 59 文件（Flash 私有 PPAPI 51 + web_font 2 + compat 3 + NaCl stub 目录 3）。

**版本选择结论**

| 插件 | 结论 |
| --- | --- |
| `plugins\win64\pepflashplayer64.dll`（**29.0.0.171**） | ✅ 推荐默认；无 EOL 提示，游戏完整渲染 |
| `plugins\experimental\...\34_0_0_380.dll` | ⚠️ 能初始化/出图，但带 **EOL 时间炸弹**（"当前版本不再受支持"），不适合做默认 |

**遗留工作（按优先级）**

1. ~~**`FlushAck` 时机**~~：**已完成（2026-11-18，方案 A，见 §1.14.12）**。曾经的临时做法与三方案评估：
   - **A（推荐）**：`PepperPluginInstanceImpl` 用 `WebFrameWidget::InsertVisualStateRequest()`（140 有，语义=呈现后回调）→ 回调里 `ViewInitiatedPaint()`；需 `返回 false 立即 ack` + 100–250ms 兜底超时；不碰 Blink，覆盖 2D 与 3D。
   - **B（最省）**：16ms 单次定时器；与呈现无关，仅 pacing。
   - **C（最忠实 138）**：改 5 个文件恢复 `WidgetBase::DidCommitAndDrawCompositorFrame → WebFrameWidgetImpl → WebLocalFrameClient → RenderFrameImpl` 链路（约 20 行，其中 2 个是 blink core，rebase 有成本）。
2. **清理调试探针**（本轮为定位加的 `[ppdbg]` 日志）：`pepper_graphics_2d_host.cc`、`pepper_plugin_instance_impl.cc`、`ppapi/host/ppapi_host.cc`、`pepper_url_loader_host.cc`、`ppb_graphics_3d_impl.cc`、`ppapi_plugin_process_host.cc`、`render_frame_impl.cc`。
3. **已知功能债**（不影响 2D Flash 出帧）：
   - 3D：`ColorBuffer::Attach/Detach` 因 140 删除 `SetDefaultFramebufferSharedImage` 而降级为 no-op（Stage3D 内容不出图）；
   - 视频：`VideoDecoderShim` 的 `CopyVideoFrameToSharedImage` 因 140 改为收 `ClientSharedImage` 而跳过帧拷贝（Flash 视频黑屏）；
   - `PPB_WebSocket` 目前是桩；`PPB_BrowserFont_Trusted` 已改用 138 原生 `web_font.cc`（真实度量+绘制）。
4. **环境项**：系统级 `%WINDIR%\SysWOW64\Macromed\Flash\mms.cfg` 需加 `EOLUninstallDisable=1` 才能彻底压掉 Flash 34 的 EOL 提示（需管理员，产品安装期写）。

**16 个阶段、逐文件清单与 25 条错误字典**见 [`2026-11-17-chromium140-ppapi-revival-ai-guide.md`](2026-11-17-chromium140-ppapi-revival-ai-guide.md)。

#### 1.14.12 方案 A 落地（2026-11-18）：FlushAck 改为"帧呈现后"发送

**背景**：§1.14.9 的临时方案是在 `PrepareTransferableResource()`（资源交给合成器时）立刻发 `Graphics2D FlushAck`，
只能保证"能出帧"，节奏与真实呈现无关。本日按 §1.14.11 的 **A 方案**改成"呈现后发"。

**实现（3 个文件）**

| 文件 | 改动 |
| --- | --- |
| `content/renderer/pepper/pepper_graphics_2d_host.{h,cc}` | 新增 `RequestFlushAckAfterPresentation()`：用 `blink::WebFrameWidget::InsertVisualStateRequest()` 注册回调，回调在**下一帧被 display compositor 呈现之后**触发 → `SendFlushAck()`；无合成器则立即 ack；另加 **250ms 兜底定时器**（隐藏标签页 / 零尺寸不产生帧时不能卡死 Flash）。新增 `flush_ack_owed_` 状态保证"呈现回调"与"兜底定时器"只发一次 ack；`HasPendingFlush()` 把它算作待回包 |
| `content/browser/renderer_host/render_frame_host_impl_ppapi_support.cc` | `DidCreateOutOfProcessPepperInstance()` 里调一次 `RenderWidgetHostImpl::InsertVisualStateCallback()` |

**关键坑（不修则永远走不到呈现回调）**

`WidgetBase::InsertVisualStateRequest()` 依赖 `widget_compositor_`，而它**只在浏览器调用
`RenderWidgetHostImpl::InsertVisualStateCallback()` 时懒绑定**（`render_widget_host_impl.cc:2107`）。
绑定之前渲染进程侧一直返回 `false`，代码会静默退化到"立即 ack"（第一版实测：55 次全部落到
`no compositor` 分支）。所以必须在实例创建时由浏览器触发一次绑定。

**验证（Flash 29.0.0.171 / Chromium 140.0.7339.41）**

| 用例 | 结果 |
| --- | --- |
| FlxInvaders.swf | `interactiveFrames=3`，三帧 digest 各不相同；**等待呈现 56 次 / 兜底 0 次 / 无合成器 0 次**，ack 数 == 等待数（无重复 ack）；无 CHECK/FATAL |
| button.swf | `interactiveFrames=3`，digest 与"立即 ack"版本**完全一致**（`6b11eb2f5636 / d5685c48c4bf / e3159d7b5f91`），说明像素结果不变、只是节奏变化 |
| 探针清理 | 该文件里的临时 `[ppdbg]`（含 `Init` 时的调色预填）已全部移除 |

**提交**：`bao/140-verified` @ `a54a191522a6e`（"feat(pepper): 方案 A —— FlushAck 改为'帧呈现后'发送"）。