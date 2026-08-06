# D5:页面主世界桥(unsafeWindow 双向)设计

日期:2026-08-05
状态:已批准,实现中
范围:`tests/electron/userscripts/` demo 层,不触碰 `src/`

## 问题

ppapi 模式(`contextIsolation: true`)下 preload 运行在隔离世界,`bootstrap.ts` 中
`unsafeWindow: window` 指向的是**隔离世界的 window**,不是页面主世界。真实脚本
(mouse-gestures 的 `unsafeWindow.scrollTo/history`、switch-zh 的 `_unsafeWindow.tc2sc`、
mpiv 的 `unsafeWindow.YUI_config`)的页世界交互全部失效,这是它们停在 PARTIAL 的原因。

ruffle 模式(`contextIsolation: false`)共享页世界,`unsafeWindow = window` 即为主世界,
不受影响。

## 架构:双世界消息桥

```
页面主世界                          隔离世界(preload)
─────────────────                 ─────────────────
window.__bfBridge ←─postMessage─→  unsafeWindow Proxy
(注入脚本,文档最早执行)  (__bf:1)  (sandbox 注入参数)
```

- 主世界桥在 document-start 注册(早于任何页面脚本),无状态,只响应
  `event.source === window` 且带 `__bf: 1` 标记的消息。
- 隔离世界的 `unsafeWindow` 是 Proxy:所有读写/调用转发为消息,由桥在主世界
  同步执行后回发 `result`。`seq` 从随机起点递增,页面无法预知配对回复。
- 桥的 dispatch 是同步的,`postMessage` 同窗口保序 → 调用顺序严格保持。
- 握手:隔离世界发 `handshake`,桥回 `{ ready: true }`;500ms 无响应 → 降级为
  隔离世界 window(现状行为,如无桥的页面)。

## unsafeWindow 语义(档 1)

| 操作 | 行为 |
|---|---|
| `set` | 转发到主世界真实写入(switch-zh `_unsafeWindow.tc2sc = simplized` 可用) |
| `call` | 保序转发,结果回传后进入缓存(mouse-gestures 全部动作可用) |
| `get` | 缓存命中返回缓存值;未命中返回**路径 Wrapper**(truthy,可继续链式访问) |
| 函数参数 | 不能结构化克隆 → 字符串化(`__bfFn`)传主世界,桥端 `Function` 还原(CSP 页失败则忽略,记录边界) |
| 同步读复杂值 | 不支持(返回 wrapper 而非真值)——档 2 候选,先记录边界 |

非目标:页面→脚本反向回调(Tampermonkey 式)、读缓存同步化。

## 注入路径

- demo 主路径:本地 server `/page-world`、`/real` 页 head 内联 `PAGE_BRIDGE_SOURCE`。
- 真实路径预演:CDP `Page.addScriptToEvaluateOnNewDocument`(主世界,无 worldName)
  在导航前 attach→注册→立即 detach(注册持久,detach 不破坏页面 onload,与
  AGENTS.md debugger landmine 验证一致)。

## 安全与清理

- 桥不暴露 Node/Electron;消息仅接受 `event.source === window` + `seq` 配对。
- 现有 generation/acceptReport 机制不参与(桥无状态);导航后旧 Proxy 消息因
  seq 不匹配被忽略;页面卸载桥随文档销毁。
- smoke 继续断言主世界 `Object.prototype` 无污染、隔离世界无 Node 泄漏。

## 测试计划(smoke,双模式)

| 检查 | 断言 |
|---|---|
| set 到达主世界 | 主世界 `window.__demoSet === 'via-bridge'` |
| call 保序 | `__pageLog` = `['from-userscript','seq-0'..'seq-4']` |
| 函数 set | `typeof window.__demoFn === 'function'` 且调用返回正确 |
| wrapper 链 | ppapi:`typeof cfg === 'object'` 且 api 为 'missing'(同步限制记录);ruffle:读到 'secret-key' |
| 桥注册 | 主世界 `typeof window.__bfBridge === 'object'` |
| 降级(仅 ppapi) | 无桥的 `/strict-csp` 页 set 不到主世界 |
| CDP 注入预演 | `__bfBridge` 存在、注入标记存在、页面 load 事件正常触发 |
| 真实脚本 | switch-zh 期望升 **PASS**(主世界 `tc2sc/sc2tc` 函数可见);mouse-gestures 记录桥启用 |

## 移植提示(写入 demo-results)

- 桥源码字符串随 `src/webview-preload/userscripts/` 走;真实站点注入用 CDP
  addScriptToEvaluateOnNewDocument(导航前 attach 后立即 detach)。
- 同步读限制是隔离世界与主世界的硬边界,移植后如需提升,档 2 可引入
  页面调用侧的回调与批量读通道。
