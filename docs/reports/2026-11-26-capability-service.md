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

## 6. 同日追加：其余标签动作全部接线

第一片只接了「保持活跃」。同一天把外壳能做的标签动作全部收进同一个入口：

| 外壳命令 | 能力动作 | 分发（执行仍用原函数） |
| --- | --- | --- |
| `select` | `tab.activate` | `select(tab)` |
| `close` | `tab.close` | `closeTab(tab)` |
| `duplicate` | `tab.duplicate` | `duplicateTab(tab)` |
| `pin` | `tab.pin` | `setPinned(tab, value)` |
| `mute` | `tab.mute` | `toggleMuted(tab)`（先比对目标值） |
| `move` | `tab.move` | `moveTab(tab, index)` |
| `navigate` | `tab.navigate` | `navigateTab(tab, address)` |
| `reload` | `tab.reload` | `reloadTab(tab)` |
| `set-engine` | `tab.setEngine` | `switchEngine(tab, engine)` |
| `tearoff` | `tab.tearoff` | `tearOffTab(controller, …)` |

不进能力层的两个：`tab-menu`（纯外壳交互，不改变浏览器状态）、`snapshot`（只读投影）。
没有 UI 生产者的三个：`tab.discard`（架构 §7 规则 12 只给自动化）、`tab.list`、`shell.invoke`
（外壳元素表随指认 UI 落地）。

### 6.1 分发必须幂等

能力动作携带的是「要变成什么」（`value` / `index`），不是「翻转一下」。UI 与自动化共用这条
路径时，翻转语义在重试下会变成两次翻转——所以 `pin` / `mute` 都先比对目标值再动，
即使调用方重复发同一条命令也不会抖。

### 6.2 能力码 → 界面码

界面已有自己那套稳定码与文案。新增 `browserCodeFor()` 做映射：`unknown-tab` 直接对上，
「调用方请求不合法」一组归到 `invalid-command`，门禁与代际失效统一 `capability-denied`，
细节留在调用记录的稳定码里。**不为 21 个能力码新增 21 条 UI 文案**。

### 6.3 踩到的坑：Flash 探测不能挂在每个动作上

第一版 `capabilityWorld()` 对**所有**动作都做 Flash 探测。那是跨帧 `executeJavaScript`，
给每次点击加了可观的延迟，后果不是"慢一点"——`tab-duplicate-ruffle` 立刻失败：
地址栏 Enter（异步导航）与随后的 `set-engine` 之间本来就有竞态窗口，探测把它撑大到必然触发。

修法：**只有 `tab.discard` 才探**（ADR-0004 的门禁只挂在这一个动作上）。
修完该用例从 37 s 超时失败变成 3.5 s 通过。

这条值得记住：**把"校验"接到热路径上，代价往往不是校验本身，而是校验里那个顺手做的 IO。**

### 6.4 证据

`tab-ops` 新增断言（外壳标签动作的真实执行路径）：

```js
const capability = await app.evaluate(async () => globalThis.__baoCapabilityCalls())
assert.deepEqual([...new Set(okRecords.map((entry) => entry.actor))], ['human-ui'])
for (const expected of ['tab.duplicate', 'tab.pin', 'tab.mute', 'tab.move', 'tab.setEngine'])
  assert.ok(names.has(expected), `能力记录里缺少 ${expected}`)
assert.ok(!JSON.stringify(engineRecord).includes('ruffle'), '调用记录写入了动作参数')
```

**变异验证**：把 `duplicate` / `pin` / `mute` 三个分支改回直连控制器 → 断言在 `tab-ops:122`
失败；恢复后通过。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:unit` | 283/283（新增 3 条映射用例） |
| `npm run test:data` | 11/11 |
| 隐藏冒烟（全量，4 并发） | **30 个文件 0 失败**，98.2 s |
