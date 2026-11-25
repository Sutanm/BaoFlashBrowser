# 前台验收第一次真正跑起来（附带修掉一个测试脚本 bug）

2026-11-25 · 起因：复盘时发现 `npm run smoke:foreground` 名义上存在，但那 7 条"前台专用"用例**从来没有真正执行过**。

## 1. 根因：`--foreground` 被脚本自己撤销了

`app/scripts/test.cjs`（修复前）：

```js
const env = { ...process.env }
delete env.BAO_SMOKE_BACKGROUND
if (flags.includes('--foreground')) delete env.BAO_SMOKE_HIDDEN   // ← ① 删掉
// 成品门禁：显式声明应为哪种 profile
if (flags.includes('--public')) env.BAO_EXPECT_PROFILE = 'public'
else if (suite === 'packaged') env.BAO_EXPECT_PROFILE = 'internal'
else env.BAO_SMOKE_HIDDEN = '1'                                    // ← ② 又设回来（这个 else 属于 ①② 之外的链）
```

`--foreground` 在 ① 把 `BAO_SMOKE_HIDDEN` 删掉，紧接着 ② 的 `else` 分支又把它设成 `'1'`。
子进程里 `hiddenSmoke` 恒为真 → 所有前台用例按"自动化模式"跳过。
**这不是覆盖不足，是开关失效。**

隔离复现：

```powershell
node -e "const flags=['--foreground'];\
const env={};\
delete env.BAO_SMOKE_HIDDEN;\
if (flags.includes('--public')) env.P=1; else if ('smoke'==='packaged') env.P=2; else env.BAO_SMOKE_HIDDEN='1';\
console.log(env.BAO_SMOKE_HIDDEN)"       # → 1
```

## 2. 修复

```js
const foreground = flags.includes('--foreground')
if (foreground) delete env.BAO_SMOKE_HIDDEN
if (flags.includes('--public')) env.BAO_EXPECT_PROFILE = 'public'
else if (suite === 'packaged') env.BAO_EXPECT_PROFILE = 'internal'
// 默认隐藏只对"非前台"生效
if (!foreground) env.BAO_SMOKE_HIDDEN = '1'
```

## 3. 修复后的实跑结果

命令：`node scripts/test.cjs smoke --foreground --serial`
（等价于 `npm run smoke:foreground`，加了 `--serial` 避免焦点争抢）

| 指标 | 修复前（名为前台、实为隐藏） | 修复后（真前台） |
| --- | --- | --- |
| 用例总数 | 58 | 58 |
| 通过 | 51 | **58** |
| 失败 | 0 | **0** |
| 跳过 | 7 | **0** |
| 用时 | 173 s | 130.9 s |

这次**首次真实执行**并通过的 7 条：

| 用例 | 之前为什么被跳过 |
| --- | --- |
| F11 全屏布局与 Esc 退出 | 原生全屏留给前台测试 |
| 最大化后视图随内容区调整 | 同上 |
| 双击标题栏最大化和还原 | 同上 |
| 权限白名单：fullscreen / pointerLock 放行 | 需要文档焦点 |
| Ruffle 画布焦点：点击播放器后键盘事件进入 SWF | 需要真实合成帧 |
| DevTools：Ctrl+Shift+I 开关页面视图的开发者工具 | 会打开独立窗口 |
| 叠加层预热后打开不是空白（本日新增） | 预热在隐藏模式下被禁用 |

结论：**这些路径本身是好的**——问题只在于它们一直没被跑到。原生 Flash 的插件内键盘回环、Ruffle 画布焦点、DevTools、全屏/最大化几何，现在都有实跑证据。

## 4. 现在的两套跑法

| 命令 | 模式 | 期望 |
| --- | --- | --- |
| `node scripts/test.cjs smoke`（默认，可 `--serial`） | 隐藏窗口、不抢焦点，适合 CI/后台 | 58 用例：51 通过 / 7 跳过 / 0 失败 |
| `npm run smoke:foreground`（建议再加 `--serial`） | 真实窗口与焦点 | 58 用例：**58 通过 / 0 跳过** |

两条都要求 `ELECTRON_EXEC_PATH` 指向自编译内核；前台模式期间**不要切走**，否则焦点类用例会失败（本机这次没有出现）。

## 5. 遗留

- 本次修复只动了测试脚本，**没有改应用代码**，因此不涉及内核/运行时变更。
- 隐藏模式下的 flake（`engine-rules`、`input` 偶发超时）与本次无关，仍待治理。
- 前台模式尚未纳入 CI（需要交互桌面），建议至少每次装配内核后手工跑一次。

## 6. 修正节（2026-11-25 22:40 追加）

本文是**当时的实测与决策记录**，保持原样不改写；此处只登记后来发生的变化：

| 项 | 当时 | 现在 |
| --- | --- | --- |
| 命名的闸门用例数 | 58 用例 / 58 通过 / 0 跳过 | **70 用例 / 70 通过 / 0 跳过**（期望值以 [app/README.md](../../app/README.md) 为准） |
| 隐藏并行 | 27 个文件 / 0 失败 | **28 个文件 / 0 失败**（84.6 s，2026-11-25 22:25 实测） |
| 新增的前台用例 | — | `overlay-prewarm-policy.test.cjs`（三档语义）、`shell-crash-heal.test.cjs`（外壳崩溃自愈，含隐藏模式） |

## 7. 修正节（2026-11-25 23:35 追加）

同一天又落了两套功能（两阶段引擎切换、休眠门禁按 ADR-0004 收紧），前台闸门重跑一次：

| 项 | 数值 |
| --- | --- |
| 内核 | `bao-v142-265-ppapi-sandbox+win-ppapi-process-sandbox+e39-batch4` |
| 前台串行 | **78 用例 / 78 通过 / 0 失败 / 0 跳过**，193.6 s（2026-11-25 23:31 实测） |
| 隐藏并行 | 29 个文件 / 0 失败，84.2 s |
| 用例数对得上 | 上表的 70 + `tab-discard` 新增 2（含 Flash 内容 / 加载中不睡）+ `engine-switch` 新增 6 = **78**，没有用例在改脚本或改引擎时被静默丢掉 |

原生 Flash 相关用例在本次前台里全部**真跑**（`本地 PPAPI 样本…`、`键盘事件进入 PPAPI 插件进程…`、`设置页：Flash 插件状态可读…`），没有出现"依赖 Flash 的用例被跳过却算通过"的情况。
`save → ack` **仍未实现**：批次 1 已让含 Flash 内容的标签永不自动休眠，而普通网页没有 Flash 运行态要存，所以这条协议目前没有消费者，会与"允许休眠含 Flash 标签"的开关一起做。
