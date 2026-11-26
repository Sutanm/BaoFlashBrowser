# 冒烟 flake 治理（第一轮）

2026-11-25 · 起因：隐藏模式的整套串行冒烟里，`engine-rules` / `input` 等文件偶发 30 s 级超时，单跑却全过。每次"全绿"都带运气，会掩盖真实回归。

## 1. 症状：同一个签名出现在不同文件

| 轮次 | 失败文件 | 日志里的等待 |
| --- | --- | --- |
| r1-3 | `tabs.test.cjs:73` | `getByRole('button', { name: '第一个页面', exact: true })` 30 s |
| r2-3 | `tearoff.test.cjs:36` | 同上，10 s（shell 默认） |
| r3-2 | `engine.test.cjs:142`（走 `engine-helpers.cjs:16`） | `getByRole('button', { name: '来源刷新页' })` 30 s |

三次都是**"浏览器已经导航完，但等标签标题出现"** 这一类 Playwright 可见性等待；同一文件里的其它用例在失败前后都正常。

先排除的：

- 单跑 `engine-rules` 4 轮：4/4 通过，耗时稳定 15.5 s。
- 成对跑 `engine` + `input` 4 轮：4/4 通过。
- 残留进程：失败后 `electron` 进程数为 0；临时 profile 目录不增长（成功轮 0 新增）。
- 前台模式 58/58 全过（窗口是可见的）。

## 2. 先加诊断（无论机制如何都该有）

`tests/smoke/helpers.cjs`：

- 新增活动实例登记表（`launchApp()` 注册、`close()` 注销）；
- `waitFor()` 超时时自动 dump 现场并附到错误栈末尾：

```
[超时现场]
  C:\...\bao-next-smoke-Rbd2el: metrics={"byType":{"Browser":1,"GPU":1,"Utility":1,"Tab":2},"totalMB":504}
  shell={"ok":true,"tabs":1,"active":"","loading":false,"labels":["新标签页"]}
```

之前失败只剩一句 `waiting for ... to be visible`，现在能直接看到「进程是否还在、标签栏到底有什么」。

## 3. 改动：把"等标签出现"从 Playwright 可见性等待换成 DOM 状态轮询

新增 `waitForTabLabel(shell, title)`：轮询 `document.querySelectorAll('.tab')` 的文案，超时走 §2 的诊断。

替换覆盖了**所有** `navigate()` 站点：

| 文件 | 说明 |
| --- | --- |
| `tabs.test.cjs` | `navigate()` |
| `tearoff.test.cjs` | 5 处 |
| `startup.test.cjs` | 5 处 |
| `input.test.cjs` | 1 处 |
| `engine-helpers.cjs` | `navigate()`（`engine` / `engine-rules` 共用） |
| `isolation.test.cjs` | 2 处 |

## 4. 数据：3/10 → 0/7

| 阶段 | 轮数 | 失败 | 说明 |
| --- | --- | --- | --- |
| 改动前（r1 / r2 / r3） | 10 | **3** | tabs、tearoff、engine-helpers 各一次 |
| 改动后（r4 / r5） | **7** | **0** | 连续 7 轮全绿，约 21 分钟 |

每轮 51 通过 / 7 跳过 / 0 失败，耗时 172–180 s，与改动前一致（没有变慢）。

## 5. 机制：推断，未证实

最可能的解释：**隐藏窗口里 Playwright 的可见性等待会卡**，而 DOM 轮询不会。

- 隐藏模式（`BAO_SMOKE_HIDDEN=1`）下窗口从不 `show()`，渲染侧的合成/绘制路径与前台不同；
- Playwright 的 `waitFor({ state: 'visible' })` 依赖元素可操作性判定（布局盒 + 可见性），而我们的轮询只要求脚本能读 DOM；
- 这也解释了为什么**前台 58/58 从不 flake**、而隐藏模式下失败点总落在"等新元素出现"。

**但必须说明：失败在改动后没有再出现，所以没抓到带诊断的现场，"机制是可见性等待"仍属推断。** 统计上也不硬：若真实失败率仍是 30%，7 轮全绿的概率约 8%——倾向"确实改善"，但不是证明。

要坐实，下一步可以刻意构造：在隐藏窗口里对一个刚创建的元素做 `locator.waitFor({state:'visible'})` 并计时，与同条件下的 DOM 轮询对比（预期前者超时/极慢、后者毫秒级）。

## 6. 决策（2026-11-25）：维持双轨，不整体切前台

评估过"把所有用例都改成前台跑"，否决，理由按权重：

| 理由 | 说明 |
| --- | --- |
| **丢失后台状态覆盖** | 隐藏模式跑的是"窗口不可见/被遮挡"路径，正是 Flash 挂机、后台节流、叠加层预热的场景；全切前台等于把这块永久移出回归 |
| **抢焦点 + 不能并行** | 每次跑都弹窗激活；默认 4 并发会互抢焦点（`tearoff` 焦点竞态已有记录）→ 只能 `--serial`，无人值守场景（含 agent 跑测试）不可用 |
| **确定性与速度** | 前台 58/58 依赖"用户别动鼠标"；实测隐藏并行 ≈60 s / 前台串行 130 s / 隐藏串行 173 s |

确定的跑法：

| 场景 | 命令 | 期望 |
| --- | --- | --- |
| 日常 / 无人值守 | `node scripts/test.cjs smoke`（默认并行、隐藏窗口） | 51 通过 / 7 跳过 / 0 失败 |
| **换内核后的必经闸门** | `npm run smoke:foreground --serial` | **58 通过 / 0 跳过** |

剩余 25 处 Playwright 可见性等待：**不预先改造**，等它们在实际运行中 flake 时按本轮手法处理（换 DOM 轮询或补诊断）。这样避免为"可能不会发生"的问题改动 12 个文件。

## 7. 遗留

| 项 | 说明 |
| --- | --- |
| 其余 Playwright 可见性等待 | 整套里还有约 25 处（`getByRole(...).waitFor()` 等）。若在别处再 flake，照同一手法换或补诊断。 |
| 诊断开销 | 只在**超时**时执行，正常路径零成本（`liveApps` 只是一个 Set）。 |
| 临时 profile 残留 | 历史上有 87 个 `bao-next-smoke-*` 目录（失败/中断的运行留下的），已清理；成功轮不再新增。 |
| 前台套件 | 改动后重跑：**58/58 通过、0 跳过**。 |

## 8. 修正节（2026-11-25 22:40 追加）

本文的双轨结论（日常隐藏并行 / 换内核后前台闸门）不变，只有数字需要更新：

| 项 | 当时 | 现在 |
| --- | --- | --- |
| 前台闸门 | 58 通过 / 0 跳过 | **70 通过 / 0 跳过**（`npm run smoke:foreground -- --serial`，162 s） |
| 隐藏并行 | 27 个文件 / ≈60 s | **28 个文件 / 84.6 s / 0 失败** |
| 隐藏模式下被跳过的用例 | 7 条 | 前台专属用例增加了 `overlay-prewarm-policy`、`overlay-prewarm-hidden` 等，跳过数随用例数同步变化 |

同时新增两条 flake 相关经验：① 前台套件里"地址栏草稿被状态广播清空"曾伪装成随机 30 s 超时（详见
[overlay demo §7.4](../discussions/2026-11-25-overlay-shared-process-demo.md)）；② 渲染进程崩溃后 Playwright 的 Page 永久失效，
崩溃类断言必须由主进程写诊断文件（`BAO_SELFHEAL_TRACE`）。

## 9. 修正节（2026-11-26 追加）：`openPage` 的标题等待会吃掉 30 s

一次全量隐藏并行（4 并发）里 `tab-discard` 的「关闭持有租约的标签后……」失败：

```
Error: 标签 H 没有加载完
  at waitFor (helpers.cjs:155)  ← tests/smoke/tab-discard.test.cjs:342 openPage
[超时现场] shell={"tabs":2,...,"loading":false,"labels":["新标签页","127.0.0.1:1719/h"]}
```

现场的特征是：**地址已提交、`loading` 为 false、标题恰好等于 URL**。
`describe()` 的标题来自 `contents.getTitle()`，Chromium 只有在文档没有 `<title>` 时才回落到 URL，
所以这是「文档没落地」而不是「标题事件丢了」——错误页或响应没到达都会长这样。

处置与结论：

| 项 | 结果 |
| --- | --- |
| 单独跑 `--only=tab-discard --jobs=1` | **11/11 通过**，该用例 4.5 s |
| 随后全量并行复跑 | **30 个文件 0 失败**，98.8 s |
| 判定 | 并发下的资源竞争（4 个 Electron 实例 + 进程内 fixture server），**不是产品回归**——本次改动没有新增任何运行时导入 |
| 未做 | 没有据此改 `openPage`：把标题等待改成「地址 + loading」会掩盖真正的加载失败，方向是错的 |

以后若再次命中，先看现场里的 `labels` 是否等于 URL：是，则按并发加载失败处理；不是，才是标题逻辑问题。
