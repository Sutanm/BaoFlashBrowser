# clone() 验证与移植（#49959）

2026-11-25 · 探针：[probe-clone-attach.js](probe-clone-attach.js)（E44 探索）、[probe-clone-e39.js](probe-clone-e39.js)（E39 最终验证）。

## 0. 结论

| 项 | 结果 |
| --- | --- |
| Chromium 142 有 `WebContents::Clone()` | ✅ 有（`WebContentsImpl::Clone()`，同 SiteInstance + 继承 opener） |
| E39 能否显示克隆体 | ✅ 能：`new WebContentsView({ webContents: clone })`（该构造选项 39.8.10 已存在） |
| 是否零新进程 | ✅ 是：接管后渲染进程数不变 |
| 是否保历史 | ✅ 是：`navigationHistory` 条目复制，`canGoBack = true` |
| 是否需要额外一步 | ⚠️ **必须 `reload()`（或导航）才有活动页面** |
| 内核移植量 | 44 行（`electron_api_web_contents.{cc,h}` + 文档），**不需要动 Chromium** |

## 1. 可用配方（已实测）

```js
const clone = sourceContents.clone()                       // 同 SiteInstance，冻结的页面壳
const view = new WebContentsView({ webContents: clone })   // 接管（E39 已支持该选项）
win.contentView.addChildView(view)
view.setBounds({ x: 0, y: 0, width: 300, height: 200 })
clone.reload()                                             // 关键一步：让它真正出页面
```

## 2. 实测记录

### 官方 Electron 44.11.6（Chromium 152）

| 步骤 | 结果 |
| --- | --- |
| `clone()` | `id=3 pid=12980`，与源同进程；`entries=2`；出现在 `getAllWebContents()` |
| 用 `webPreferences.webContents` 塞进视图 | ❌ **无效**：静默新建了一个 WebContents（`id=4`）——参数形状写错，正确是顶层 `webContents` |
| `new WebContentsView({ webContents: clone })` | ✅ 接管成功（`view.webContents === clone`） |
| 接管后 `executeJavaScript` | ⏱ **超时**（clone 不含活动页面） |
| `clone.reload()` 后 | ✅ `executeJavaScript` 返回 `["two",300,200]`，`canGoBack=true`，`pid` 不变 |
| 渲染进程数 | 接管前后都是 2；普通新视图 → 3（+1 进程） |

### 自编译 E39（39.8.10 + 本批补丁，`2FD3B40A`）

```
source id=2 pid=21680 entries=2 renderers=[11492,21680]
adopted id=3 pid=21680           renderers=[11492,21680]
js before reload -> timeout
reload() -> url=...two pid=21680 entries=2
js after reload -> ["two",300,200]   canGoBack=true
fresh   id=4 pid=31204           renderers=[11492,21680,31204]
```

**与 E44 行为完全一致**，说明移植没有引入语义差异。

## 3. 移植内容（`docs/kernel/0007-49959-webcontents-clone.patch`）

| 文件 | 改动 |
| --- | --- |
| `shell/browser/api/electron_api_web_contents.h` | 声明 `v8::Local<v8::Value> Clone(v8::Isolate*)` |
| `.cc` | 实现：`web_contents()->Clone()` → 复制 `WebContentsPreferences` → `CreateAndTake(..., type_)` → `HandleNewRenderFrame(MainFrame())` |
| `.cc` | `FillObjectTemplate` 注册 `.SetMethod("clone", ...)` |
| `docs/api/web-contents.md` | 上游文档段落 |

E39 适配点：上游用 `gin::ConvertToV8(isolate, wrapper)`，E39 的 `gin_helper::Handle` 提供 `ToV8()`，改用 `wrapper.ToV8()`。

## 3.5 Flash 与 clone：不能用于 PPAPI 标签（已实测）

| 场景 | 结果 |
| --- | --- |
| 源标签（flash.html，PPAPI） | `state=loaded bridge`、`PercentLoaded=100`、插件进程 1 个 |
| **clone 出的标签** | `state=timeout bridge-unavailable`、`PercentLoaded is not a function`（`<embed>` 退化成普通元素） |
| 对照：同 URL 的独立进程新视图 | ✅ `loaded bridge`、100 |
| 对照：两个 Flash 标签各自独立进程 | ✅ 两个都 100，共用一个插件进程 |

`navigator.plugins` 在克隆体里仍能看到 `Shockwave Flash`，但 `CreatePlugin()` 失败 —— 同一渲染进程里的第二个 PPAPI 实例无法实例化。
**结论**：`duplicateTab()` 对 PPAPI 标签必须回退旧路径（见 `duplicateViaClone()` 的守卫）。

## 3.6 preload 不跟随 clone（上游同样如此）

| 环境 | 源标签 | clone 出的标签 |
| --- | --- | --- |
| 官方 Electron 44.11.6，最小 preload（`contextBridge.exposeInMainWorld('__probePreload')`） | `preload=true` | **`preload=missing`** |
| 本项目（Ruffle 的 `preload/page.js`） | `window.RufflePlayer.version = "0.1.0"`、播放器画布存在 | **`window.RufflePlayer` 为 undefined、`<embed>` 未被替换** |

结论：克隆体拿不到页面 preload，**上游亦然**——属于 Electron 的行为，不是移植缺陷。
对本品的影响：Ruffle 标签与 PPAPI 标签都不可 clone，故 clone 在页面标签上没有适用场景（详见 [batch3 记录](../../reports/2026-11-25-e39-backport-batch3.md) §3.5）。

## 4. 风险与待验证

| 项 | 说明 |
| --- | --- |
| **同进程连带崩溃** | 克隆体与源共享渲染进程；一个标签的渲染进程崩溃会同时带走另一个。产品上要接受这个语义（Chrome 的 tab duplication 也是同 SiteInstance）。 |
| **跨源会分家** | 克隆体导航到别的站点时会拿新进程（正常行为）。 |
| **Flash 不可用（已验证）** | 复制 PPAPI 标签后克隆体的 `<embed>` 无法实例化（见 §3.5）。应用侧已做守卫：PPAPI 引擎标签回退旧路径。 |
| 类型声明 | `app/node_modules/electron/electron.d.ts` 里没有 `clone()`；应用侧要用需在源码加环境声明（不要去改 node_modules）。 |

## 5. 应用侧集成计划（下一步，尚未做）

1. **新增类型声明**：`app/src/shared/` 加 `declare module 'electron' { interface WebContents { clone(): WebContents } }`（或局部 `as`）。
2. **`duplicateTab()` 改造**：`clone` → 建 `WebContentsView({ webContents })` → 绑事件 → `reload()` → `select()`。注意 `Tab.binding` 代际、`registerPageView()`、`tab.discarded` 语义都要按现有合同走。
3. **用例**：复制后 `canGoBack` 为真（历史保留）、渲染进程数不增加、复制 Flash 标签后两个标签都能出帧。
4. 集成完再决定是否装配进运行时——按"内核 + 应用 + 用例原子提交"的原则，本批**暂不装配**。
