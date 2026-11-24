# M2 修订：新窗口请求的形态（新标签 vs 弹窗）

2026-11-24 · 基线提交 `52b157f`。代码：`app/src/main/browser-window.ts`
（`guardContents` 的 `setWindowOpenHandler`、新增 `openUrlInTab` 路径）、
`app/tests/smoke/link-target.test.cjs`（新增）、`app/tests/smoke/popup.test.cjs`（夹具改为显式 features）。

## 1. 问题

用户反馈：**在网页里点链接会弹出一个窗口，而不是在新标签里打开**。

代码证据（修订前）：`guardContents()` 的 `setWindowOpenHandler` 对**所有** `window.open`
一律返回 `action: 'allow'` 并创建一个 `frame: false` 的自绘弹窗。Chromium 把
`<a target="_blank">` 的点击同样走 `window.open` 路径（`disposition: 'foreground-tab'`），
于是最常见的一次"点链接"也变成了一个独立窗口。

这个取舍来自 M1：为了保住 `window.opener` 与 `window.open` 的返回值（Flash 大厅→游戏的交接通道），
明确"用真实子窗口承载而不是新标签"（`docs/kickoff/m1-browser-slice.md` §4 第 18 项）。
M1 没覆盖的是：**没有 features 的窗口请求本来就不是弹窗**。

## 2. 决定

按 Chrome 的语义重新划线：**由 `features` 决定形态**，而不是由"是否是新窗口请求"决定。

| 触发 | Chromium 侧的判据 | 本项目的处理 |
| --- | --- | --- |
| `<a target="_blank">` 点击、Ctrl/中键点击 | 无 features | **同窗口开新标签**并选中（新增 `openUrlInTab`） |
| `window.open(url)` / `window.open(url, '_blank')` | 无 features | 同上（新标签） |
| `window.open(url, name, 'width=…,height=…')` | 有 features | **真实子窗口**（保留 `window.opener`/返回值，沿用 M1 的同站限制） |
| 表单 `target=_blank` 的 POST | `details.postBody` 存在 | 真实子窗口（POST 体无法用 GET 重放） |
| `save-to-disk` / 非 http(s) | — | 拒绝（原有策略） |

补充说明：

- 新标签路径**不做同站限制**：标签是独立浏览上下文，没有 opener 关系（我们 deny 之后自建标签，
  opener 天然不存在），跨站链接开新标签是浏览器常态。同站限制只保留在**弹窗**路径上，
  因为它服务于"页面之间互相操纵"的场景（Flash 大厅→游戏）。
- 新标签的引擎按站点规则/默认值解析，不继承 opener 的引擎——与 `Ctrl+T` 新标签一致。
- 代价：`window.open(url)`（无 features）的调用方拿到的返回值为 `null`，`window.opener` 为空。
  这与 Chrome 的表现一致（Chrome 对无 features 的 `window.open` 也是开标签）；需要
  opener 的老站必须显式给 features（它们本来就这么写，否则早在 Chrome 里就坏了）。

## 3. 验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ |
| `node scripts/test.cjs smoke` | ✅ **24 文件 / 0 失败**（新增 `link-target.test.cjs`；`popup.test.cjs` 夹具改为显式 features） |

新增 `tests/smoke/link-target.test.cjs`（真实 Electron、单次启动覆盖三种形态）：

1. 点击 `<a target="_blank">` → 标签数 1→2、**原生窗口数不变**、新标签被选中；
2. 点击 `window.open('/plain-target', '_blank')`（无 features）→ 标签数 2→3、窗口数不变；
3. 点击 `window.open('/popup-target', '_blank', 'width=320,height=240')` → 原生窗口数 +1、
   标签数保持 3、弹窗仍有 `window.opener`。

`tests/smoke/popup.test.cjs` 的夹具从"无 features"改为 `'width=1024,height=768'`：
它测的是**弹窗**契约（同站放行、跨站与 `file:` 拒绝、策略递归、自绘 chrome、尺寸），
修订后这些断言仍然成立且更有指向性；跨站/`file:` 的负向断言也一并补上 features，
否则那条请求会被当成"开新标签"而不是"拒绝弹窗"，断言会变成假通过。

实现过程中还修掉一个测试侧的坑：点击会让新标签成为活动标签，此后
"`contentView` 里第一个非外壳视图"已经不是起点页；`clickOnce()` 因此**按 URL 定位视图**，
并给元素打 `data-clicked` 标记，避免 `executeJavaScript` 抖动重试时点两次。

## 4. 遗留

1. `window.open` 的 `frameName`（命名窗口）没有实现"复用同名标签/窗口"的语义，每次都是新建；
2. 中键点击与 Ctrl+点击走同一条路径（会开新标签），但"在后台打开"（`background-tab`）
   目前也按前台选中处理；
3. 表单 `target=_blank` 的 POST 仍由真实子窗口承载（尺寸为默认 1024×768，不带 features 时）。
