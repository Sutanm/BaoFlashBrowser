# 浏览器 Agent 与自动化社区项目调研

2026-11-24 · 讨论记录。本文记录对 BaoFlashBrowser Next 有直接参考价值的社区项目、可借鉴机制、适用边界和许可证注意事项。本文不是依赖选型 ADR，也不表示项目已经采用其中任何实现。

## 1. 调研目标

BaoFlashBrowser Next 面临的问题不是单纯“让 AI 点击网页”，而是同时覆盖：

- 普通网页中的表单、表格、列表和多标签任务；
- 多层同源、跨源 iframe 与 OOPIF；
- Shadow DOM、老旧网页和非标准 DOM；
- Flash、Canvas、WebGL 等无法通过 DOM 读取的画面；
- 浏览器标签、窗口、设置和引擎等外壳能力；
- 一次性 Agent 操作与可长期、可重复运行的自动化工作流；
- 操作轨迹、测试步骤、断言、报告和失败恢复；
- 自编译 Electron / Chromium 142 与现有 WebContentsView 宿主。

调研重点因此是：跨 frame 页面建模、DOM 与视觉混合定位、统一坐标、稳定目标引用、工作流格式、自然语言测试以及 Agent 工具合同，而不是寻找一套直接替换现有浏览器宿主的框架。

## 2. 结论摘要

没有一个社区项目完整覆盖本项目的需求。最值得采用的是组合式路线：

| 课题 | 主要参考 |
| --- | --- |
| 多 frame 页面地图与统一坐标 | BrowserGym |
| 跨 iframe / Shadow DOM 定位与结果复用 | Stagehand、browser-use |
| Agent 工具合同、snapshot ref、结构/视觉双通道 | Playwright MCP |
| 视觉操作、自然语言断言和执行报告 | Midscene.js |
| 工作流 JSON、录制、回放和测试代码转换 | Chrome DevTools Recorder、Puppeteer Replay |
| 视觉工作流产品形态与长任务 | Skyvern（仅参考） |
| 用户指代、元素附件与人工纠错 | Cebian（仅参考） |

推荐的实现原则：

1. 不把第三方框架作为浏览器拥有者嵌入主链路；Bao 自己拥有 Electron、WebContents、标签、Session 和输入。
2. 研究并重实现社区中成熟的数据模型与算法。
3. Agent 只看到精简的 Page Map 和短目标 ID；frame、selector、坐标与代际由 Host 管理。
4. 普通网页优先结构化观察，Flash/Canvas 使用视觉，复杂游戏站默认允许 hybrid。
5. 第一次可由 AI 发现和修复，成功路径固化后由确定性运行时执行。

## 3. BrowserGym：页面地图和跨 frame 坐标

项目：<https://github.com/ServiceNow/BrowserGym>

许可证：Apache-2.0。

BrowserGym 是当前最贴近本项目 Page Map 问题的实现。它使用 CDP `DOMSnapshot.captureSnapshot` 获取 DOM、iframe 文档、Shadow DOM、布局矩形、paint order 和滚动信息，再构造 frame 树，将子 frame 的局部位置转换为顶层页面的统一坐标。

核心参考点：

- 为各 frame 中的元素建立 observation ID；
- 将 DOM、AX tree、截图、bbox 与 Set-of-Marks 关联；
- 递归计算父 iframe 位置和子文档滚动偏移；
- 把多文档布局摊平到统一页面坐标；
- 在提取前标记节点，提取后清理临时标记；
- 对 detached frame、受 sandbox 限制的 frame 和异常 embed 做降级。

对 Bao 的意义：

```text
frame 内局部坐标
  + 父 iframe 在父文档中的位置
  + 全部祖先 frame 的位置
  - 各层滚动偏移
  = 顶层内容视口坐标
```

建议借鉴其算法和数据结构，不直接引入 Python/Playwright 运行时。

相关上游：

- CDP DOMSnapshot：<https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/>
- BrowserGym observation：<https://github.com/ServiceNow/BrowserGym/blob/main/browsergym/core/src/browsergym/core/observation.py>

## 4. Stagehand：跨 frame locator 与观察结果复用

项目：<https://github.com/browserbase/stagehand>

许可证：MIT。

Stagehand 已实现跨 iframe 与 Shadow DOM 的 locator。其 locator 可以用 `>>` 表达 frame 跳转，例如：

```text
iframe#checkout >> button.submit
```

值得借鉴的不是 XPath 本身，而是“可序列化 frame 路径 + 目标描述”的定位模型。Stagehand 还支持先 `observe()` 得到动作，再将动作交给 `act()`，后续缓存和复用已解析结果，减少模型调用。

核心参考点：

- iframe 与 closed shadow root 穿透；
- 跨 frame locator 的分段解析；
- observe 和 act 分离；
- 第一次 AI 解析，后续复用确定性动作；
- 动作结果携带 selector、方法、参数和描述；
- iframe 错误有独立错误类型；
- 跨源 OOPIF 使用 CDP auto-attach 管理。

社区现状也说明跨源 iframe 是持续维护的难点。Stagehand 4.3 曾出现 `act()` 修改 auto-attach 后导致后加载跨源 iframe 丢失的问题，4.4 又修复已加载和嵌套跨源 iframe 的接管。这意味着 Bao 必须把 OOPIF 生命周期当作正式子系统，而不能假设 Playwright/CDP 会自然处理完整。

建议的数据形态：

```ts
interface FrameLocatorRecipe {
  hops: Array<{
    urlPattern?: string
    ownerSelector?: string
    indexHint?: number
    visualAnchor?: string
  }>
  target: {
    role?: string
    name?: string
    selector?: string
    visualAnchor?: string
  }
}
```

相关资料：

- Locator：<https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/reference/locator.mdx>
- Act：<https://github.com/browserbase/stagehand/blob/main/packages/docs/v3/references/act.mdx>
- 4.4 跨源 iframe 修复：<https://www.stagehand.dev/blog/changelog-stagehand-4-4>

## 5. browser-use：组合观察和 frame 成本控制

项目：<https://github.com/browser-use/browser-use>

browser-use 的 DOM 服务组合 DOM tree、Accessibility tree、截图、Shadow DOM、cross-origin iframe、paint order 和坐标信息。它还显式设置：

- `max_iframes`；
- `max_iframe_depth`；
- `cross_origin_iframes`；
- `paint_order_filtering`；
- 最小跨源 iframe 尺寸；
- observation-local DOM index。

最值得借鉴的是成本治理：Page Map 不能无限递归所有广告、统计和隐藏 iframe。Host 应根据面积、可见性、交互密度、frame 深度、任务相关性和资源预算裁剪。

建议规则：

1. 面积过小且无交互证据的 frame 默认忽略；
2. 设定最大 frame 数和最大深度；
3. 优先保留可见、可交互、包含表单或大 surface 的 frame；
4. observation 中的短 ID 默认只在当前代际有效；
5. 页面变化后重新观察，不隐式复用旧索引；
6. 对已知游戏站允许配方提升目标 frame 的优先级。

源码参考：<https://github.com/browser-use/browser-use/blob/main/browser_use/dom/service.py>

## 6. Playwright MCP：Agent 工具合同和双通道

项目：<https://github.com/microsoft/playwright-mcp>

许可证：Apache-2.0。

Playwright MCP 默认向 Agent 提供 Accessibility snapshot，元素使用短 ref；动作工具接受 snapshot 中的 ref，而不是让模型编写 selector。Snapshot 还能附加 `[box=x,y,width,height]`，把结构化元素与 CSS 视口坐标连接起来。

视觉模式额外提供：

- screenshot；
- coordinate mouse move/click；
- drag；
- mouse down/up；
- wheel。

官方建议普通网页使用 snapshot ref，Canvas/WebGL、地图、图片编辑器和无 ARIA 控件使用视觉坐标。这验证了本项目的结构化、视觉、hybrid 三模式方向。

Bao 需要在其 ref 模型上增加生命周期：

```ts
interface TargetRef {
  tabId: number
  bindingId: number
  navigationId: number
  observationId: number
  targetId: string
}
```

相关资料：

- 工具清单：<https://github.com/microsoft/playwright-mcp/blob/main/README.md>
- Vision Mode：<https://github.com/microsoft/playwright.dev/blob/main/mcp/vision-mode.mdx>

不建议将 Playwright MCP 作为产品内部 Agent Host。它拥有自己的 Playwright 浏览器抽象，适合作为工具 schema、snapshot 格式和视觉 fallback 的参考。

## 7. Midscene.js：视觉测试、自然语言断言和报告

项目：<https://github.com/web-infra-dev/midscene>

许可证：MIT。

Midscene 以视觉 GUI Agent 为核心，支持自然语言动作、等待、断言和结构化查询。它面向 Canvas、图标、自定义控件、跨源 iframe 与测试场景，并生成包含截图、定位结果、AI 决策、动作和断言的 HTML 报告。

值得借鉴的高层合同：

```text
act
waitFor
assert
query
```

适用于以下 Bao 场景：

- “填写测试平台表格并写出测试步骤”；
- 对 Flash/Canvas 的可见结果做断言；
- 自动保存每一步的证据；
- 将操作轨迹转成人类可读测试说明；
- 在结构化通道置信度不足时使用视觉定位。

不建议让 Midscene 的视觉模型循环接管整个 Bao Host。应参考其报告、断言、视觉定位和 YAML 用例表达，将执行权保留在 Bao Automation Host。

## 8. Chrome DevTools Recorder 与 Puppeteer Replay：Workflow IR

项目：

- Chrome Recorder：<https://developer.chrome.com/docs/devtools/recorder/overview>
- Puppeteer Replay：<https://github.com/puppeteer/replay>

Puppeteer Replay 许可证：Apache-2.0。

Chrome Recorder 已定义可编辑、可导入和可导出的 JSON User Flow，并支持：

- 录制与回放；
- 断点、暂停和逐步执行；
- timeout、condition 和 assertion；
- 导出 Puppeteer、Cypress、WebdriverIO、Nightwatch 等格式；
- 通过扩展增加转换格式。

Bao Workflow v1 不应从空白发明。建议研究 User Flow schema，保留其动作、目标、timeout、assertion 和 target 概念，再增加 Bao 特有步骤：

```text
surface.detect
surface.bind
vision.wait
vision.findTemplate
vision.findColors
engine.switch
agent.escalate
browser.tabs.*
```

不直接采用 Puppeteer Runner，因为 Bao 要在已有 WebContents 中执行，并受自己的权限、代际、资源闸和任务生命周期控制。

## 9. Skyvern：视觉工作流产品形态

项目：<https://github.com/Skyvern-AI/Skyvern>

许可证：AGPL-3.0。

Skyvern 值得研究：

- 长任务 UI；
- 工作流节点；
- planner/actor 分离；
- 视觉定位；
- 任务历史；
- 失败恢复；
- 无预置 XPath 的跨站点工作流。

但它偏云端、多进程和服务端编排，且核心仓库为 AGPL-3.0。Bao 在许可证未明确前只应参考产品形态和公开思想，不复制或派生源码。

## 10. Cebian：用户指代和人工纠错

本地参考项目：`D:\java_workspace\Cebian-master`

许可证：AGPL-3.0-only。

Cebian 提供元素拾取器：向页面注入 Shadow DOM 覆盖层，通过 `elementFromPoint()` 找到底层元素，返回 selector、DOM path、attributes、text、rect、tabId 和 frameId，并作为 `<selected-element>` 附件发送给 AI。它还能让用户逐层进入 iframe。

对 Bao 的价值：

- 用户“指着一个东西问”；
- AI 识别低置信度时请求用户确认；
- 用户纠正目标；
- 创建视觉监控区域；
- 首次适配奇怪游戏站；
- 失效配方的人工修复。

局限：

- iframe 需要用户逐层进入；
- frame 匹配主要依赖 URL 或顺序；
- rect 是子 frame 局部坐标；
- 没有 binding/navigation/transform 代际；
- 交互使用合成 DOM 事件，不能替代 PPAPI 所需的真实输入；
- 后台标签截图需要切到前台；
- 许可证不适合直接复制到尚未确定许可的 Bao。

结论：保留“人工指代/校准”思想，但不把元素拾取器作为普通 Agent 的主感知入口。

## 11. CDP 原生能力

社区项目最终都建立在浏览器原生能力上。Bao 拥有 Electron 主进程，更适合直接建立自己的 CDP Hub。

### 11.1 OOPIF 接管

`Target.setAutoAttach({ autoAttach: true, flatten: true })` 可以自动接管相关 iframe/worker target。对新 attached target 需要递归建立相同策略。

资料：<https://chromedevtools.github.io/devtools-protocol/tot/Target/>

### 11.2 DOM 与布局

`DOMSnapshot.captureSnapshot` 返回扁平 DOM、document 关系、layout bounds、client rect、scroll rect 和 paint order。

资料：<https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/>

### 11.3 Accessibility

`Accessibility.getFullAXTree({ frameId })` 可按 frame 获取 role、name、description 和状态。开启 Accessibility 域可能有性能影响，应按 session 管理。

资料：<https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/>

### 11.4 坐标反查

`DOM.getNodeForLocation` 根据坐标返回 backendNodeId 和 frameId，适合可信浮层的元素选择与视觉命中后的 DOM 反查。

资料：<https://chromedevtools.github.io/devtools-protocol/tot/DOM/>

## 12. 建议落地组合

```text
CDP Target auto-attach
        │
        ▼
     FrameGraph
        │
        ├── DOMSnapshot
        ├── AXTree per frame
        ├── layout / paint / visibility
        └── screenshot / surface detector
        │
        ▼
 PageMap + TargetRegistry + SurfaceRegistry
        │
        ├── Playwright-MCP 风格短 ref tools
        ├── Stagehand 风格可复用 locator recipe
        ├── Midscene 风格视觉 act/assert/report
        └── Recorder 风格 Workflow IR
```

Agent 不直接接触原始 CDP、完整 DOM、frame 坐标变换或绝对屏幕坐标。Automation Host 负责：

- schema 校验；
- target 代际；
- 统一坐标转换；
- 权限与审批；
- 资源预算；
- 真实输入；
- 动作轨迹；
- 失败证据；
- 确定性工作流执行。

## 13. 推荐研究顺序

1. BrowserGym 的 document/frame/bbox 扁平化；
2. Stagehand 4.x 的 cross-origin auto-attach 与 frame locator；
3. Playwright MCP snapshot ref、bbox 和 vision tools；
4. browser-use 的 frame 数量、深度和裁剪策略；
5. Chrome Recorder JSON schema 与 Puppeteer Replay 扩展点；
6. Midscene 的自然语言断言和执行报告；
7. Skyvern、Cebian 只作为产品与交互参考。

## 14. 许可证提醒

| 项目 | 许可证 | 当前建议 |
| --- | --- | --- |
| BrowserGym | Apache-2.0 | 可研究并在合规前提下复用 |
| Stagehand | MIT | 可研究并在合规前提下复用 |
| Playwright MCP | Apache-2.0 | 可参考工具合同与部分实现 |
| Midscene.js | MIT | 可参考视觉与报告能力 |
| Puppeteer Replay | Apache-2.0 | 可参考 schema、转换与 replay |
| Skyvern | AGPL-3.0 | 只参考，复制前必须单独评审 |
| Cebian | AGPL-3.0-only | 只参考，复制前必须单独评审 |

任何具体源码复用都要登记来源、版本、许可证和修改内容；“思想相似”不代替许可证审查。
