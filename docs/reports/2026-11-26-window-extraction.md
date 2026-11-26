# 窗口控制器瘦身（第一步）：判据纯化

2026-11-26 · 对应 A1 开工前的准备步（见 [m2-beta §2](../kickoff/m2-beta.md#2-agent-ready-浏览器底座a1)），
[ADR-0004 §2](../adr/0004-liveness-over-memory-reclaim.md) 硬门禁。

## 1. 为什么要做，以及为什么不是「3000 行就拆」

`browser-window.ts` 当时 3165 行，但真正的形态是这个：

| 事实 | 数字 |
| --- | --- |
| 单个闭包函数 `createBrowserWindow` | 492–2834 行 = **2340 行（74%）** |
| 该闭包内的函数 | **88 个** |
| 闭包内可变状态 | `tabs` / `engineSequence` / `discardBlocked` / `flashSeen` / `discardTimer` |
| 模块级单例引用 | `controllers` / `sessionWindows` / `activityLeases` / `engineRules`，41 处 |
| 最近 3 天改它的提交 | **41 / 113（36%）** |
| 依赖它的 smoke 文件 | 30 个（全量） |

所以问题不是"文件长"，而是**36% 的提交都要改同一处共享闭包，且每次都要跑全套 smoke**。
行数是结果，不是原因。机械按主题切文件只会造出一个 200 字段的 `context` 对象——行数降了、
耦合没降、回归面还多一层（架构 §17 已写死不得为此重写）。

本次采用的判据是两条，与行数无关：

1. **能不能被独立验证**：这段逻辑改错了，现在只能靠 30 个 smoke 文件里的某几条发现吗？
2. **会不会有第二个消费者**：能力层将来要不要用同一份判据？

## 2. 本次交付

| 文件 | 内容 | 为什么它值得单独存在 |
| --- | --- | --- |
| `app/src/main/address.ts` | `parseAddress`、`isWebAddress`、`placeholderTitle`、`sameDocument` | 四个都是「外部字符串不可信」的判断，历史上有过真实事故（占位标题让标签栏闪地址、`sameDocument` 把不同端口当同一文档） |
| `app/src/main/flash-probe.ts` | `FLASH_PROBE` 判据、`probeFlashContent`（逐帧）、`FlashPresenceCache`、`detectFlashContent`（缓存 + 降级） | ADR-0004 的唯一 Flash 判据。休眠扫描用它，A1 的 `flash-content` 错误码也必须用它——**判据出现第二份实现就等于有人能绕过休眠门禁** |
| `app/tests/unit/address.test.ts` | 19 条 | 地址边界（scheme、`host:port`、内联凭据、`javascript:`、结尾斜杠、端口） |
| `app/tests/unit/flash-probe.test.ts` | 15 条 | 跨帧、detached、fail-closed、阳性粘代际、**阴性不缓存** |

`browser-window.ts`：3165 → **3111**（-54 行），其中 `flashContentOf` 现在只做接线：

```ts
const flashPresence = new FlashPresenceCache()
function flashContentOf(tab: Tab, contents: WebContents): Promise<boolean> {
  return detectFlashContent({
    tabId: tab.id, binding: tab.binding, cache: flashPresence,
    frames: () => { try { return contents.mainFrame?.framesInSubtree } catch { return undefined } }
  })
}
```

## 3. 语义保持清单（逐条对应旧实现）

| 旧实现里的规矩 | 新实现里的落点 | 用例 |
| --- | --- | --- |
| 必须遍历所有帧（跨源 iframe 里的播放器） | `probeFlashContent` 迭代 `framesInSubtree` | 「主帧没有、iframe 里有 → 命中」 |
| detach 的帧跳过 | `if (frame.detached) continue` | 「不去执行脚本」，断言 `calls === 0` |
| 执行失败按「有」处理，且不再往下探 | 返回 `'unknown'` | 「抛错 → unknown，后续帧不被执行」 |
| 取不到主帧按「有」处理 | `frames` 返回 `undefined` 或抛错 → `true` | 两条独立用例 |
| 阳性按绑定代际粘住 | `FlashPresenceCache` 键是 `(tabId, binding)` | 「同一代际下不再执行脚本」 |
| **阴性不缓存** | 只有 `'hit'` 才 `mark` | 「页面后来插入播放器必须能被重新发现」 |
| 标签休眠/关闭时清缓存 | `forget(tabId)` | 「forget 之后重新探测」 |

## 4. 刻意没搬的东西

`safe()`（7 行，上百处调用）、`fail()`（3 行）、`currentTheme()`（3 行）、`popupSize()`（11 行）
留在原地。搬它们只产生 import 噪音，不带来任何可测性收益——**拆分的判据是可验证性，不是行数。**

## 5. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:unit` | **259/259**（225 → +34） |
| `npm run test:data` | 11/11 |
| 隐藏冒烟（全量，4 并发） | **30 个文件 0 失败**，98.7 s |
| `tab-discard`（含 3 条 Flash 硬门禁、迟插入、跨源 iframe） | 11/11 |
| 变异验证 | 把「只缓存阳性」改成「阴性也缓存」→ **2 条失败**；恢复后 15/15 |

`app/scripts/test-map.cjs` 新增两条映射：改 `address.ts` 跑地址相关的 7 条，改 `flash-probe.ts`
跑 `tab-discard` + `flash`（`flash-*` 通配规则会顺带带上 `plugin-input`/`startup`，宁可多跑）。

## 6. 未做

1. **休眠扫描的决策还没有纯化**：`sweepDiscard`(55 行) 里 5 个门禁与 30 秒节拍仍混在一起。
   它和 A1-b 的注册表提取共享同一批快照字段，合并做更省事，也避免两次改动同一段；
2. 闭包内 88 个函数没有变动，`browser-window.ts` 的结构性风险仍在——那正是 A1-b 要做的事。

## 7. 下一步（A1-b）

提取 Tab / Window / BrowsingContext 注册表；判据：行为零变化、现有 smoke 全绿、
`browser-window.ts` 净减、A1-a 的 `CapabilityWorld` 端口能直接接上。
