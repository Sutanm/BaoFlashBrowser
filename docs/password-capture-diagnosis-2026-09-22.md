# 密码捕获失灵：诊断与修复记录（阶段二 · 2026-09-22）

> **这是第二阶段。** 第一阶段（**密码本整体失效**：09-20 事故 + 09-21 修复）见
> [`password-vault-failure-2026-09-20.md`](./password-vault-failure-2026-09-20.md)。
>
> 两阶段的分界：
> - **阶段一（09-20 → 09-21）**：整个保险库不可用——自动填充 / 保存捕获 / 查看密码**同时**失效。
>   根因是唯一 wrap key 被代码销毁（`K1–K4` 已修）。
> - **阶段二（09-22，本文档）**：保险库恢复后，**捕获链路自身**的三个缺陷。
>
> 读这份文档前，请先接受阶段一的结论：**"密码本失效"和"某站点捕获不到"是两件事，
> 只是症状长得像。** 本阶段一开始就是把它们重新分开的。
>
> 现象：7k7k 上输入账号密码点登录没有保存提示，4399 正常。用户怀疑"某次提交弄坏了"或"站点改了登录行为"。
>
> 结论：**站点没有改，捕获脚本也没有被改坏。** 失灵由三处代码缺陷造成，其中一处是 09-21 引入的 P0 回归；
> 三处已在三个独立提交中修复并各自验证。
>
> **2026-09-22 已结案（见 §5）**：用户两次复现证明捕获链路全程正常（第一次捕获并保存成功，
> 第二次因"同账号已保存"按设计静默跳过）。复现同时暴露两处新缺陷（§5.1 fill 与 capture 争抢
> debugger 且不重试；§5.2 去重零提示），尚未修复。

---

## 1. 结论速览

| # | 缺陷 | 严重度 | 位置 | 修复 |
|---|---|---|---|---|
| 1 | `_baopPristineAdd` 递归自造 iframe（每次注入都在每个 frame 里再建 iframe） | **P0** | `password-capture.ts:77-100`（旧代码） | `20ffc06` |
| 2 | `findUserInput` 把提交按钮当账号框，用户名被填成按钮文字"提交" | P1 | `password-capture.ts:109-120` | `70e70e1` |
| 3 | 空用户名的登录被闸门静默丢弃（与 Chrome 行为不一致） | P2 | `password-capture.ts:515-521`、`password-store.ts:644`、`PasswordsPanel.tsx:227` | `75e7993` |

三者互不重叠，各自独立可回退。第 1 条是本次最要紧的发现——它由我们自己引入，且**在被证明之前一直是"隐形"的**。

---

## 2. 探索过程（含走过的弯路）

### 2.1 起点与第一次排除

故障报告有三个特征：4399 能捕获、7k7k 不能、历史日志里有 15 条
`skip already-saved host=web.7k7k.com`（末次 09-20 20:03）。

第一步先排除密钥（阶段一刚处理完的那件事，见
[`password-vault-failure-2026-09-20.md`](./password-vault-failure-2026-09-20.md)）：重建后
`password-store.json` 显示 `_enabled/_autoCapture/_autoFill` 全为 `true`、`_excludedSites=[]`、
`entries=0`，且 `key loaded backend=win-dpapi` 每次启动都成功 → **密钥与开关都不是原因**。

### 2.2 回溯提交：一条"假设被证伪"的支线

用户怀疑"某次提交破坏了捕获"。回溯 `password-capture.ts` 的历史改动，只有三类：
诊断（`d9d30c1`/`68cdca9`/`ee552ee`）、密钥失败路径（`901208e` 等）、工程（`c1b8d16`）。
**没有任何一次改动碰过 input/click/submit 的判定逻辑** → "提交改坏了脚本"这条不成立。

但这次回溯埋下了后面的伏笔：`ee552ee` 里的"干净 addEventListener 兜底"。

### 2.3 关键转折：把"站点问题"与"应用问题"切开

用户提议用 Playwright 测（并愿意提供账号）。实际上**不需要真实凭据**——假密码就能验证整条事件通路。

做法：搭"真机对拍台"，把生产 `CAPTURE_SCRIPT` 从源码用 esbuild 抽出（只 stub electron 运行时，
保留 `extractCredentialParams` 真实实现，否则等于测了个假脚本），塞进真实 Chromium +
Chrome/87 UA（与应用 `session-manager.ts:147` 一致），用 `exposeBinding('__baopReport')`
复刻应用的 `Runtime.addBinding`，直接打真站。

结果：

| 页面 | 观测 |
|---|---|
| `web.7k7k.com/user/login.html` | `input pw len=1..14` → `click trigger` → `submit`，**3 条 capture**（click-login / submit / xhr） |
| `news.7k7k.com/pkt/`（应用里那个页面） | 点"登录"后面板开在**顶层文档**（`#un_name`/`#un_pass`），同样 `input pw len=1..14` |

更关键的是 frame 指纹与应用日志**逐字吻合**：`frame info pwInputs=2 host=news.7k7k.com`、
`frame info pwInputs=5 host=web.7k7k.com`。

> ⇒ **站点没改登录结构，脚本在真实浏览器里工作正常。故障在应用侧。**
> 这一步把后续所有排查成本砍掉一大半——不必再去猜站点。

### 2.4 对拍台的副产品：抓到自己的 P0

对拍台日志里出现 `Maximum call stack size exceeded`。顺着查：生产脚本在 `web.7k7k.com/user/login.html`
上曾上报出大量 `host` 为空的 `script loaded`（早期一次运行的观测窗里是 138 条）。
对照实验（同一页面、同一浏览器、同一观测窗，只换注入脚本）：

| 组 | 注入脚本 | `script loaded` | 页面栈溢出报错 |
|---|---|---|---|
| A | 最小脚本（只上报，不做任何 DOM 操作） | 2 | 0 |
| B | 生产脚本（含 `_baopPristineAdd`） | **71** | **57** |
| B′ | 生产脚本（删除该兜底后） | **2** | **0** |

机制：`_baopPristineAdd()` 为"取一份未被站点改写的 `addEventListener`"而创建一个同源
`about:blank` iframe；而**注入是按"新执行上下文创建"触发的**（`password-capture.ts:501-509`）
——我们建的子帧会跑同一段脚本，再建子帧，嵌套下去直到爆栈。

即：**这个兜底本身成了它想解决的问题。** 而它假设的威胁（站点劫持 `addEventListener`）
从未被任何实测证实——7k7k 两个页面与 4399 实测 `patched=false`；并且在空帧里它恒返回不可用值。

### 2.5 应用侧时间线：一个仍未闭合的问题

应用 14:22 那次会话（71 行日志）：

```
14:22:31.016  [PasswordCapture] setupCapture wc=2 url=https://news.7k7k.com/pkt/
14:22:31.075  DIAG: script loaded host=…            ×16（含 web.7k7k.com ×2、news.7k7k.com ×2）
14:22:32.547  DIAG: frame info pwInputs=5 host=web.7k7k.com
14:22:32.562  DIAG: frame info pwInputs=2 host=news.7k7k.com
（此后 ~30 秒：零 input pw、零 click any、零 submit、零 beforeunload）
14:23:03.883  [mouse-hook] exited with signal SIGTERM
```

已排除：站点（§2.3）、脚本（§2.3）、密钥（§2.1）、排除列表（`_excludedSites=[]`）、
自动化占位（该会话仅一次 `setupCapture`，无 `teardown`）。

剩余最可疑的两条，都是**应用侧时机问题**：

1. **捕获挂载点太晚**：挂在 `did-stop-loading`（`tabs.ts:506-515`），广告密集页
   （一次加载几十个 iframe）可能比 `dom-ready` 晚几十秒；这期间的输入完全不可见。
2. **detach 后不重挂**：`detach after capture`（`password-capture.ts:555-558`）之后，
   只在下一次页面加载或自动化释放（`tabs.ts:252`）时才重新 `setupCapture`。

**为此补了三行诊断**（已在产物里）：`frame info`（登录框在哪个 frame）、
`first keydown`（按键有没有进这个 frame）、`first input`（落在什么元素上）、
`listener env`（监听到底生效没有）。需要一次带新 `dist` 的复现才能闭合。

### 2.6 顺手做的下游审计

用户拍板"对齐 Chrome（允许空用户名保存）"后，先把整条链审了一遍，避免只撬闸门：

| 环节 | 审计结论 |
|---|---|
| 捕获闸门 | ❌ 要求 `user` 非空 → 需改 |
| `addEntry` 校验 | ❌ `!opts.username` 直接抛 `Incomplete params` → **不改这里，放开闸门只会变成"弹了提示但保存失败"** |
| 填充脚本 | ✅ 本就有 `&&savedUsername` 真值判断，空用户名不会清空用户已输入的用户名 |
| 保存提示 toast | ✅ 只显示 host，不看用户名 |
| 面板条目行 | ❌ `{entry.username}` 会留白 → 加"（无用户名）" |

### 2.7 环境坑（本沙箱）

想用真实 Electron 11 + 生产模块把应用那条链跑通，失败在环境上，记录下来省得下次再试：

- `ELECTRON_RUN_AS_NODE` 被注入，且**只要变量存在就生效**，`VAR=` 清不掉，必须 `env -u`。
  否则 Electron 退化成纯 Node，`require('electron')` 会解析到 npm 包（返回可执行文件路径字符串），
  表现为 `Cannot read property 'commandLine' of undefined` —— 极易误判成代码坏了。
- Windows 下 Electron 是 GUI 子系统，**stdout 不进 bash 管道**：探针结果必须写文件。
- 直接 `electron <appDir>` 在本沙箱静默退出（exit 0、无输出）；项目自带的
  `tools/probe/host-electron.cjs` 同样受影响。
  ⇒ **应用内验证交给用户跑一次 + 读日志，不要在这条路上继续加器材。**

---

## 3. 原因（逐条）

### 缺陷 1（P0）：`_baopPristineAdd` 递归自造 iframe

- 引入：`ee552ee`（09-21），本意是防"站点劫持 `addEventListener` 屏蔽外部监听"。
- 机制：注入由 `Runtime.executionContextCreated` 驱动（每个新上下文注入一次）
  → 我们的 iframe 是新的执行上下文 → 也跑同一段脚本 → 再建 iframe → 递归。
- 后果：单次页面加载多出数十个空帧 + 数十次栈溢出异常（实测 69 / 57）。
- 定位方式：对照实验（§2.4）。它是**唯一一个由我们造成、且证据完全在自己手里的缺陷**。

### 缺陷 2：`findUserInput` 把提交按钮当账号框

- 位置：`password-capture.ts:109-120`（旧版）。
- 机制：候选选择器含 `input[name*="login"]`、`input[id*="user"]` 这类**宽匹配**，
  而旧守卫只排除了 `password` / `hidden`。登录页账号框一为空（先输密码、或站点 JS 后填），
  就命中 `type=submit` 的 `<input value="提交">`，把按钮文字当用户名上报。
- 实测：7k7k 登录页 3 条 capture 的 `user` **全是"提交"**。
- 影响：保存下来的账号是垃圾值；且 `skip already-saved` 的查重键 `host/username` 跟着错，
  该站后续真实账号的登录不再被识别为已保存。

### 缺陷 3：空用户名被静默丢弃

- 位置：闸门 `password-capture.ts:515-521`（旧版 `if (!data.user || …) continue;`）。
- 机制：有些登录页先填密码、用户名由站点 JS 后补，或压根没有用户名框（卡号/手机号即账号）。
  这类登录 `user` 为空 → 整条捕获被 `continue` 掉，用户侧表现为"没有保存提示"，且日志里
  **连一行都不留**（闸门在 DIAG 之后，但 capture 事件被丢弃时不打任何日志）。
- 与 Chrome 的差异：Chrome 允许保存无用户名的凭据。

---

## 4. 修复

| commit | 范围 | 关键改动 |
|---|---|---|
| `20ffc06` | `password-capture.ts`、`password-capture-binding.test.ts` | 整段删除 `_baopPristineAdd` 与 cleanAdd 兜底链；`_baopOn` 收敛为原生注册；诊断行改为 `listener env selftest=… addFnLen=… instOverridden=…`（便宜的劫持旁证：实现源码长度 + 实例级改写） |
| `70e70e1` | `password-capture.ts`、`password-capture-binding.test.ts` | `findUserInput` 增加非文本类型黑名单：`password/hidden/submit/button/image/reset/checkbox/radio/file/range/color` |
| `75e7993` | `password-capture.ts`、`password-store.ts`、`PasswordsPanel.tsx`、i18n（zh-CN/en + 生成物）、3 个测试文件 | 闸门只要求密码长度 ≥2；`user` 缺失/非字符串归一化为 `''`（避免 `undefined` 进查重键）；`addEntry` 只要求 host + password；面板空用户名显示"（无用户名）" |

### 4.1 修复后的语义（都已用测试锁住）

**空用户名条目**：

| 场景 | 行为 |
|---|---|
| 账号框为空，或页面没有账号框 | 只填密码，账号框保持为空（不写入空值） |
| 账号框已有别的用户名 | **整体不填**（沿用既有保护——空用户名无法证明那条密码属于谁） |

**用户名取值**：账号框为空 → `user:""`；填上账号 → `user:"<真实值>"`。

**查重键**：`host + ''`（不再出现 `host/undefined`）。

### 4.2 验证方式

- 单测：113 文件 / **659 项通过**，typecheck（main/preload/renderer）0 error，
  lint 0 error（34 条既有 warning）。本次为三处修复共补 7 条回归用例：
  "注入不得自造 iframe"1 条、"不得把提交按钮当账号"1 条、空用户名链 5 条
  （闸门 3 + 存储 1 + 填充语义 1）。
- 真机对拍台复测（每次改脚本都重跑）：
  - 删除兜底前 / 后：`script loaded` 71 → **2**，栈溢出 57 → **0**，捕获能力无损（3 条 capture 全在）。
  - 用户名：`"提交"` → `""`（空账号框）/ `"baop_probe_user"`（填上账号）。
- 产物核对：`dist/main.js` 中旧闸门、旧 `addEntry` 校验、`_baopPristineAdd` 均已消失，
  新诊断与归一化代码在位；`dist/renderer/bundle.js` 含 `noUsername`。

### 4.3 测试基建的两处修正（值得单独记）

1. `password-capture-lifecycle.test.ts` 原先把 `getMainWindow` 固定打桩为 `null`
   —— 结果"捕获到底有没有上报"在单测里**完全不可见**。已改为可观测桩，
   现在能直接断言 `send('password:captured', {…username})`。
2. `shownToastKeys` / `globalPendingCredentials` 是**模块级**状态：
   新用例最初用同一个 host，第二条被"已提示过"去重直接吞掉。测试内已注明"跨用例必须换 host"。

---

## 5. 结案（2026-09-22 用户复现）

**原结论"应用侧为何零事件"已闭合：捕获链路从头到尾就没坏过。** 用户当天两次复现（11:29 / 11:53，
`news.7k7k.com/pkt/`）给出完整证据链：

```
11:29:16.452  setupCapture wc=2 url=https://news.7k7k.com/pkt/
11:29:16.47x  DIAG: listener env selftest=true addFnLen=45 instOverridden=false   ×16
11:29:18.523  DIAG: first keydown tag=INPUT type=password pwDoc=5
11:29:18.52x  DIAG: input pw len=1..10 host=web.7k7k.com
11:29:20.929  DIAG: click any tag=A txt=登录 ... hasRawPass=10 login=true
11:29:20.931  DIAG: click trigger isBtn=false isLogin=true
11:29:20.932  [PasswordCapture] detach after capture source=click-login
11:29:20.932  [PasswordCapture] captured host=web.7k7k.com source=click-login   ← 捕获成功
11:29:22      密码本新增：web.7k7k.com / username=q379630001 / title=pkt-login   ← 保存成功
```

第二次（11:53，同账号再登一次）：

```
11:53:58.365  DIAG: input pw len=10 host=web.7k7k.com
11:53:59.332  DIAG: click any tag=A txt=登录 ... hasRawPass=10 login=true
11:53:59.333  DIAG: click trigger isBtn=false isLogin=true
11:53:59.333  [PasswordCapture] skip already-saved host=web.7k7k.com   ← 被"已保存同账号"去重跳过
```

⇒ 输入、点击、上报、保存全部正常。第二次没有提示是**设计行为**（同 host + 同账号不再重复弹提示），
参见 §5.2。另可注意 `username=q379630001` 是真实账号而非按钮文字，说明 `70e70e1` 的修复同样生效。

### 5.1 复现中发现的缺陷 A：fill 与 capture 争抢 debugger，且不重试

```
11:29:29.534  [PasswordCapture] setupCapture wc=4 url=https://news.7k7k.com/pkt/
11:29:29.535  [warn] [PasswordCapture] attach failed: CDP is already attached by an unmanaged client
```

`password-fill.ts:113` 直接 `wc.debugger.attach('1.3')`，**绕过 `cdp-lease`**（它在 `finally`
里会 detach，所以只是一个几十毫秒的窗口）。但捕获的 `setupCapture` 撞进这个窗口时，
`acquireCdpLease` 会抛 `CDP is already attached by an unmanaged client`；而
`password-capture.ts` 只打一行 warn 就 `return`，**没有任何重试** → **那个标签页此后完全无捕获**。
日志里 wc=4（用户的第二个 7k7k 标签）正是如此。

修法（择一）：`setupCapture` 对这个特定错误安排一次短延迟重试（最小改动）；
或让 fill 也走 `cdp-lease`（多一个 owner）。

### 5.2 复现中发现的缺陷 B：去重零提示（用户直接踩到）

`skip already-saved`（`password-capture.ts:546`）在"同 host + 同账号"时静默跳过，
**既不打点也不提示**。用户因此无法区分"没捕获"和"已保存过所以不提示"，会再次误判成功能坏了。
Chrome 的行为是"密码变了才提示更新"。这是本次误判的直接来源，也是 §2.5 里"零日志"体感的成因。

### 5.3 小观察：同一 frame 被注入两次

`input pw len=10` 每次上报两遍 → 主世界与 `contextIsolation` 隔离世界各被注入一次
（`window.__baop_pw_capture` 守卫是 per-window 的，两个世界是两个 window）。
功能无害（有去重），但日志量翻倍，可按 execution context 去重。

---

## 6. 可复现的对拍台（已沉淀为技能）

`~/.workbuddy/skills/bao-password-capture-triage/`：

```
tools/build-script.mjs    # 从源码抽出生产 CAPTURE_SCRIPT（只 stub electron 运行时）
tools/capture-lab.cjs     # 真实 Chromium + 真站 + 真实绑定，假凭据即可
SKILL.md                  # 判读矩阵、已证实的陷阱、本机环境坑
```

```bash
REPO=/d/java_workspace/BaoFlashBrowser
S="$HOME/.workbuddy/skills/bao-password-capture-triage/tools"
OUT=/c/Users/95470/AppData/Local/Temp/bao-cap-lab
node "$S/build-script.mjs" "$OUT"
BAO_OUT="$OUT" NODE_PATH="$REPO/node_modules" node "$S/capture-lab.cjs" https://news.7k7k.com/pkt/
```

判读：**本台出现 `input pw len=N` 而应用里没有 ⇒ 脚本与站点无罪，去查应用侧**；
本台也没有 ⇒ 站点/脚本问题，在本台加诊断（改脚本 → 重跑 `build-script.mjs`，秒级迭代）。

---

## 7. 方法论教训

1. **先切分责任域，再读日志。** 这次真正的转折点是"把站点/脚本与应用侧切开"，
   而不是任何一次日志细读。此前的所有猜测（站点反自动填充、登录框改结构、弹窗未挂捕获）
   都因为缺少这条分割线而白费。
2. **注入的仪器本身可能制造故障。** `_baopPristineAdd` 就是为了排查而加的"兜底"，
   它造成的伤害远大于它防的风险。凡是要在每个 frame / 热路径上执行的注入，都必须做
   **对照实验**（最小脚本 vs 生产脚本，比次数与错误数）。
3. **"没有日志"要用可观测桩变成"有日志"。** `getMainWindow` 被打桩成 `null`
   让"捕获是否上报"在单测里不可见；捕获闸门丢弃事件时也不打日志 —— 两处都直接导致过误判。
4. **放开一个闸门之前先审下游。** 空用户名这条链上，闸门、`addEntry` 校验、面板展示三处
   都会坏；只改闸门会从"静默不提示"变成"提示了但保存失败"，是更糟的失败。
5. **模块级状态会跨用例污染测试。** `shownToastKeys` 这类"跨会话去重"的设计在测试里
   需要显式换 key，否则得到的是假绿/假红。
6. **诚实标注未闭合项。** §5 那件事没有定量结案，就不要把它算进"已修复"。

---

## 附：相关文件

| 文件 | 作用 |
|---|---|
| `src/main/modules/password-capture.ts` | 页面侧 `CAPTURE_SCRIPT` + CDP 消息处理（闸门、去重、detach） |
| `src/main/modules/password-store.ts` | 条目存取（`addEntry` 校验在此） |
| `src/main/modules/tabs.ts` | `setupCapture` 的五个触发点（160/195/252/515/639） |
| `src/renderer/components/panels/PasswordsPanel.tsx` | 条目列表与操作 |
| `tests/password-capture-binding.test.ts` | 注入脚本的行为（含"不得自造 iframe""不得把按钮当账号"回归防线） |
| `tests/password-capture-lifecycle.test.ts` | CDP 生命周期 + 捕获闸门 |
| `tests/password-fill-script.test.ts` | 填充脚本语义（含空用户名语义） |
| `docs/superpowers/specs/2026-09-21-keyring-failure-path-design.md` | 密钥失败路径规格（上一件事，与本次无重叠） |
