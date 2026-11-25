# 内核增量：E39 回拣批次 3（#49959 `webContents.clone()`）+ 应用侧集成

2026-11-25 · 对应 [E39 回拣实施计划](../kernel/2026-11-25-e39-backport-plan.md)。
前两批见 [batch1](2026-11-25-e39-backport-batch1.md) · [batch2](2026-11-25-e39-backport-batch2.md)。

## 1. 这一批做了什么

| 层 | 改动 |
| --- | --- |
| 内核 | 移植 `webContents.clone()`（44 行）：`web_contents()->Clone()` → 复制 `WebContentsPreferences` → `CreateAndTake` → `HandleNewRenderFrame`。提交 `c244a99d9c`，产物 `2FD3B40A…`（[0007](../kernel/0007-49959-webcontents-clone.patch)） |
| 应用 | **接入后又撤销**：`duplicateViaClone()` 全链路试过，因"preload 不跟随 clone"对所有页面标签都不成立，见 §3.5。当前保留的是新增用例 `tab-duplicate-ruffle.test.cjs`（守住回退路径） |
| 装配 | 运行时 → `…+e39-batch3`；旧内核 exe 备份在 `.runtime/win-x64-before-e39-batch3`（`1C1DE6B1…`） |

## 2. 为什么值得做

`duplicateTab()` 原来是"同 URL 新开一个标签"：**丢前进/后退历史**，且**必然多一个渲染进程**（70–110 MB）。改走 clone 后：

| 指标 | 旧路径（同 URL 新标签） | clone |
| --- | --- | --- |
| 渲染进程 | +1 | **+0**（复用源标签的进程） |
| 导航历史 | 丢失 | **保留**（实测 `entries` 相等、`canGoBack = true`） |

## 3. 两条限制（实测得出，已写进代码注释）

### ① clone 出来的是"没有活动页面的壳"

文档原话 *will not contain any open web pages*。接管后 `executeJavaScript` **直接超时**，必须 `reload()` 一次才有内容。代码里已经在 `duplicateViaClone()` 末尾做了这件事。

### ② **PPAPI（原生 Flash）标签不能用 clone** —— 这是本批最重要的发现

| 场景 | 结果 |
| --- | --- |
| 源标签（Flash） | `state=loaded bridge`、`PercentLoaded=100`、插件进程 1 个 |
| **clone 出的标签** | `state=timeout bridge-unavailable`、`PercentLoaded is not a function` —— `<embed>` 退化成普通元素 |
| 对照：同 URL 的**独立进程**新视图 | ✅ `loaded bridge`、100 |
| 对照：两个 Flash 标签各自独立进程 | ✅ 两个都 100，共用一个插件进程 |

结论：**同一渲染进程里的第二个 PPAPI 实例无法实例化**（插件在 `navigator.plugins` 里可见，但 `CreatePlugin()` 失败）。因此代码里的守卫是：

```ts
if (tab.engine === 'ppapi' && plugins) return   // 回退旧路径
```

另有一层特性检测：`typeof contents.clone !== 'function'` 时同样回退，所以**未打 0007 的内核上行为与今天完全一致**。

## 4. 验证

| 项 | 结果 |
| --- | --- |
| 用例 `tab-duplicate-ruffle.test.cjs`（回退路径） | ✅ 副本 pid ≠ 源 pid、两个标签的 Ruffle 播放器画布都存在、运行时版本一致 |

| 整套冒烟（已装配运行时） | ✅ **57 用例 / 51 通过 / 0 失败 / 6 跳过**，177.9 s；原生 PPAPI 用例实际执行并通过 |
| 旧路径回归 | ✅ `tab-ops`（PPAPI 标签复制）与 `tab-duplicate-ruffle`（Ruffle 标签复制）都走 URL 新标签，通过 |

## 3.5 应用侧接入为什么被撤销（追加验证）

克隆体在**两类标签上都不可用**：

| 标签类型 | 依赖 | clone 后的表现 |
| --- | --- | --- |
| Ruffle | 页面 preload（`preload/page.js` 注入 `window.RufflePlayer`） | **`window.RufflePlayer` 为 undefined、`<embed>` 不被替换**（preload 没跑） |
| PPAPI（原生 Flash） | 渲染进程里的插件实例 | `<embed>` 退化成普通元素（同进程第二个 PPAPI 实例无法实例化，见 §3.5 之前的一节） |

**关键对照**：在**官方 Electron 44** 上用最小 preload（`contextBridge.exposeInMainWorld('__probePreload', …)`）复跑同样的克隆流程，结果同样是 `clone preload = missing`。
→ **"clone 不跟随 preload"是上游固有局限，不是我们移植的问题。**

本产品的每个页面标签必然落在两类之一（Ruffle 需要 preload；PPAPI 需要插件），因此 clone 在本产品的标签模型里**没有适用场景**。处置：

- **应用侧已完全撤销**：`duplicateTab()` 回到"同 URL 新标签"（`git diff app/src/main/browser-window.ts` 为空）；`electron-clone.d.ts` 删除；clone 用例删除。
- **内核补丁保留**（0007，44 行、纯增量、无行为改变），状态标记为"已验证但当前无消费者"。等上游让 preload 跟随 clone、或我们把 Ruffle 注入改成不依赖 preload（例如主进程 `executeJavaScript` 注入）时再接入。
- **新增用例** `tab-duplicate-ruffle.test.cjs` 改为守住**回退路径**的合同：复制 Ruffle 标签后副本是独立渲染进程、两个实例都能初始化播放器（源标签在复制后仍存活）。

## 5. 已知边界

| 项 | 说明 |
| --- | --- |
| 同进程连带崩溃 | 副本与源共享渲染进程，一个标签渲染进程崩溃会同时带走另一个（SiteInstance 共享的固有语义）。 |
| 跨源导航会分家 | 副本导航到别的站点时拿新进程，属正常行为。 |
| Flash 标签 | 一律走旧路径（多一个进程，换来插件可用）。 |
| Ruffle 标签 | **不走 clone**（preload 不跟随），改由 `tab-duplicate-ruffle.test.cjs` 守住回退路径：独立进程 + 两个实例都初始化播放器。 |

## 6. 回退

```powershell
Copy-Item .runtime\win-x64-before-e39-batch3\electron.exe .runtime\win-x64\electron.exe -Force
# manifest：exe 哈希改回 1C1DE6B1…、kernel.tag 改回 …+e39-batch2、去掉 0007
# 应用侧：duplicateViaClone() 直接 return（或删掉该分支），回到同 URL 新标签
```


## 7. 过程复盘（写给下一次）

1. **先说清"能不能用"再动手集成**：clone 的三个坑（要 reload、PPAPI 不可用、preload 不跟随）都是集成过程中才暴露的。正确顺序应是：先用**产品同款 preload**做一次最小验证，再改业务代码。
2. **上游行为要当对照**：Ruffle 那次失败，如果没有官方 E44 的 `clone preload = missing` 对照，很容易误判成"我们移植漏了 push startup data"，从而去改内核——方向完全错。
3. **用例要测"合同"而不是"实现"**：最初的 clone 用例只断言"同 pid + 保历史"，于是**在功能已经坏掉的情况下仍然通过**（Ruffle 没注入）；补上"播放器画布存在"才暴露问题。
