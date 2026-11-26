# M2 / A1-c（第一片）：统一能力入口接线

2026-11-26 · 对应[架构 §5 统一浏览器能力接口](../agent-automation-architecture.md#5-统一浏览器能力接口)、
[§18-A1 退出条件](../agent-automation-architecture.md#a1浏览器能力底座m2-当前工作)。

## 1. 这一步做了什么

A1-a 立了合同与校验器，A1-b 把代际收进账本；这一步让**一条真实的 UI 路径**走进去：

```text
外壳点击「保持活跃」
  → IPC keep-awake
  → runCapability({ actor: 'human-ui', action: 'tab.keepAwake', target: { tabId, expectedBindingId, expectedNavigationId } })
      → capabilityWorld()   // 异步快照：代际 / 加载态 / Flash 内容
      → validateCapabilityCall()
      → capabilityCalls.append()   // 结构化调用记录
      → setKeepAwake(tab, value)   // 分发到控制器原有的实现
  → { ok: true, state }
```

三个新部件：

| 部件 | 位置 | 作用 |
| --- | --- | --- |
| `capabilityWorld(invocation)` | 控制器闭包内 | 把「校验那一刻的事实」算成快照：`bindingId`/`navigationId` 来自账本，`loading` 来自 WebContents，`flashContent` 来自 `flash-probe`（**异步**），租约来自 `activityLeases` |
| `runCapability(invocation)` | 同上 | 校验 → 记录 → 分发；被拒时返回 `capability-denied` |
| `__baoCapabilityCalls()` | 未打包诊断钩子 | 让冒烟能断言「外壳动作真的过了能力入口」 |

## 2. 几个刻意的取舍

### 2.1 入口在控制器闭包里，而不是单独的 Service 类

动作实现依赖闭包状态（标签表、视图、窗口、活动标签）。把它们搬进一个 Service 等于重写，
而且会立刻出现两套实现（`run()` 一套、Service 一套）——正是架构 §5 规则 6 要避免的。
这一片的定位是**判定与审计**先接上，执行路径保持不变；等 14 个动作都过了入口，再把实现搬走。

### 2.2 为什么先接 `keep-awake`

三个理由：它有现成的 11 条休眠用例覆盖（`tab-discard`）；它的实现只有一个 `setKeepAwake()`
（改动面最小）；它是最能暴露「校验器与真实状态不一致」的动作——租约、Flash 门禁、代际三者都在这条路上。

### 2.3 被拒时的错误码

不把 21 个能力失败码灌进 `BrowserFailureCode`（那会让渲染层多 20 条 UI 文案）。做法是：
返回值用 `capability-denied`，稳定码写在 message 的括号里（`含 Flash 内容的标签不得被销毁（flash-content）`），
完整信息进调用记录。渲染层按 `capability-denied` 显示一句通用文案即可。

### 2.4 Flash 判定在快照里做

`capability-contract.ts` 是纯同步的，而 Flash 判定必须跨帧执行脚本。所以异步在
`capabilityWorld()` 里完成，校验器只吃快照。这样「含 Flash 内容的标签不得销毁」这条门禁
在**能力层**也是真的生效，而不是只写在文档里。

## 3. 证据

新增冒烟断言（`tab-discard` 的「保持活跃只作用于该标签」）：

```js
const capability = await app.evaluate(async () => globalThis.__baoCapabilityCalls())
assert.ok(capability.some((entry) =>
  entry.action === 'tab.keepAwake' && entry.outcome === 'ok' && entry.actor === 'human-ui'))
```

**变异验证**：把 `keep-awake` 分支改回直接 `setKeepAwake()`（绕过入口），该断言立刻失败
（`ERR_ASSERTION actual: false`）；恢复后 `tab-discard` 11/11。

## 4. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:unit` | 280/280 |
| `npm run test:data` | 11/11 |
| 隐藏冒烟（全量，4 并发） | **30 个文件 0 失败**，98.8 s |
| `tab-discard`（含新断言） | 11/11 |

## 5. 未做

1. **其余 13 个动作还没接**（`tab.close` 已在分发里支持但没有 UI 路径改走它，`tab.navigate`、
   `tab.move`、`tab.setEngine` 等仍是直连）；
2. **`ShellRef` 没有真实解析**：`capabilityWorld().shellElement` 恒为 `false`，外壳元素表随指认 UI 落地；
3. **WindowRegistry / BrowsingContextRegistry** 仍未建（见[接线报告 §6](2026-11-26-tab-registry-wiring.md#6-未做归到-a1-c)）；
4. **调用记录没有导出/查询入口**：`CapabilityCallLog` 只有 500 条环形缓冲与诊断钩子，
   审计导出属 A5。
