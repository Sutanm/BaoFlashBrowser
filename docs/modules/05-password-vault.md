# 05 · 密码存储、捕获与查看门禁

> 状态：按 **1.1.2（2026-11-02）** 源码核对，取代
> `docs/archive/modules-v1/05-password-vault.md`。行号会漂移，以语义为准。

## 1 范围与目标

主进程负责捕获登录提交、管理加密保险库、在允许时填充用户名/密码，并在查看明文前执行
验证门禁。凭据不得进入控制台日志或普通 renderer IPC；保存确认只携带短期 `captureId`。

**边界**：CDP 租约的通用语义见 03，页面生命周期见 01。

## 2 静态结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/password-capture.ts` | CDP `Runtime.addBinding` 捕获、动态表单观察、短期 pending credential、去重语义 |
| `src/main/modules/password-fill.ts` | 主框架与 CDP execution context 自动填充 |
| `src/main/modules/password-store.ts` | v2 保险库、DEK、wrap key、默认账号、站点排除、密钥状态机 |
| `src/main/modules/keyring.ts` | OS 后端探测与包装接口；无后端时回落 C′ |
| `src/main/modules/keyring-win-dpapi.ts` | Windows DPAPI 子进程后端 |
| `src/main/modules/keyring-linux-secret-tool.ts` | Linux Secret Service 后端（`secret-tool`，blob 为条目指针） |
| `src/main/modules/view-gate.ts` | 查看门禁：A 档 OS 验证 / C 档查看密码、失败计数与锁定 |
| `src/main/modules/view-gate-win.ts` | Windows `CredUIPromptForWindowsCredentials` + `LogonUserW` + SID 比对 |
| `src/main/modules/cdp-lease.ts` | 捕获与自动化的调试器租约互斥（`released` 标志区分"已释放但 debugger 仍附着"） |
| `src/webview-preload/password-form-observer.ts` | 只报告"出现了新的密码表单/焦点进入含密码框的表单" |
| `src/main/ipc/password.ipc.ts` | 状态、初始化、保存确认、忽略、删除、填充、查看、门禁设置 |

## 3 核心流程

### 3.1 捕获

1. 页面停止加载后，`tabs.ts` 在 `did-stop-loading` 调 `setupCapture(wc)`。
2. 捕获器取 `password-capture` 租约，通过 `Runtime.addBinding` 接收页面主世界的提交
   事件；跨域 iframe 使用 execution context，不依赖 `executeJavaScript`。
3. 主进程保存短期凭据，向 UI 发送不含密码的确认信息；用户确认后
   `password:save-confirm` 用 `captureId` 取回并写库。
4. 成功后 `removePendingCredential` + `notifyPasswordChanged()`。

**动态重开表单的重武装（2026-10-28，commit `4e2afa7`）**：换账号时第二次登录框常由
页面内脚本动态插入，不经过主文档加载周期，原实现不会重新挂捕获（表现为"第二次登录
完全无捕获、无提示"）。现在有三处配合：

- `password-form-observer` 用 `WeakSet` 记录已知密码框，只有新出现的输入框才上报；
  `focusin` 落在同一 `form` 内的任意输入框（如账号框）也强制上报。250ms 节流改为
  延迟合并，不丢事件。
- `TabManager.notifyPasswordFormDetected` 不再要求"自动填充已开启"才继续，且在
  `!wc.isLoading()` 时直接 `setupCapture(wc)` 重新武装；填充仍走 100ms debounce。
- `setupCapture` 的幂等判断新增 `!existing.cdpLease.released`：自动填充会短暂附着
  debugger，租约已释放但 `isAttached()` 仍为 true，旧判断会误认为"捕获仍在"，从而
  拒绝重建。

**"先插入、后显示"登录层的重武装（2026-11-10）**：`4e2afa7` 的"只认新出现的密码框"
把"登录层一开始 `display:none`、点击后才 `show()`"这种形态（实测 7k7k `#union`）的
信号一起删掉了 —— 插入时填不进去，显示时又没有新框。现在三条信号并存：

- **只在"此刻真能填"时才记为已知**：可见性判据与 `password-fill.ts` 页面侧
  `usable()` 一致（`disabled`/`readOnly`/隐藏域/computed display·visibility·opacity/
  `getBoundingClientRect` 尺寸）。隐藏期间不算已知，变可见后仍是新鲜信号。
- `MutationObserver` 的 `attributeFilter` 增加 `style` / `class`：`$(...).show()`
  这类"隐藏→可见"的唯一痕迹就是属性变化。
- 冒泡阶段的 `click` 监听（站点自己的处理器先跑完）在点击时立刻复查一次，并在 150ms
  后再复查一次，覆盖异步 show／动画结束后才可见的登录层；observer 到期（30s）后该兜底
  仍然有效。

### 3.2 填充

从保险库选取当前 URL 的账号，在主框架和 CDP execution context 中赋值，**不自动提交**。
空用户名条目只在"账号框为空或没有账号框"时填密码；账号框已有其他用户名时整体不填。

**提示文字不算"已填"（2026-11-10）**：老站点常把提示文字直接写进账号框的 `value`
（7k7k `#un_name value="用户名/邮箱/KK号"`，点击才清空、失焦再回填）。旧逻辑把这种
从没被用户编辑过的默认文本当成"用户已填了别的账号"，于是连密码一起放弃填充 ——
用户看到的正是"必须点一下账号密码框才填"。判据刻意收紧到三条同时成立才当空值：
`value` 非空、等于 `placeholder`/`aria-label`、且等于 HTML 上的 `value` 属性
（即从未被改写过）。用户自己敲进去的同名文字（`value` 属性为空）不受影响。

`password-fill.ts` 直接 `wc.debugger.attach('1.3')` 的窗口会与捕获竞争：
`4f124b4` 起按 250/500/1000/2000/3000ms 有限重试，成功即清表，到上限留
`attach retries exhausted`。

### 3.3 去重（Chrome 语义）

同一 host + 同一账号：

- 密码相同 → 静默跳过（日志 `(same password)` / `skip already-saved`）；
- 密码变了 → 照常提示（`prompting update`），保存即覆盖旧条目；
- 解不出明文 → 保守静默（`(key unavailable)`），避免误报。

**日志里看到 `skip already-saved` 不等于捕获失败。**

## 4 保险库、门禁与接口

### 4.1 数据与密钥

v2 无主密码、无锁定态。随机 DEK 用 AES-256-GCM 加密条目，再由设备 wrap key 包装：

- **档位 A**：Windows 走 DPAPI（PowerShell + .NET `ProtectedData`，CurrentUser 范围）；
  Linux 走 Secret Service（`secret-tool` 子进程 → GNOME Keyring / KWallet 兼容层）。
  macOS 后端未实现（`createPlatformBackend` 返回 null），会落到 C 档。
- **档位 C′**：本地可逆弱保护，保护级别近似 Chromium `basic_text`，只防文本直读。
- 旧 v1 密码本与旧明文 key 只改名为 `.legacy.bak` 搁置，不读取、不迁移。

**Linux 后端的形状差异**（`keyring-linux-secret-tool.ts`）：Secret Service 是条目库而不是
就地加解密，所以 `wrap` 产出的是**条目指针**而不是密文——`blob = ss1:<32 位 hex id>`，
密文实体留在 OS 密钥库里。把 key 文件拷到别的机器，拿到的只是一个查不到的 id。

失败语义按 `secret-tool` 的实测行为二分（**与 DPAPI 不同**）：

| 场景 | exit | stdout | stderr | 归类 |
|---|---|---|---|---|
| store 成功 | 0 | 空 | 空 | 成功 |
| lookup 命中 | 0 | 密文（无尾换行） | 空 | 成功 |
| lookup 未命中 | 1 | 空 | **空** | `decrypt-failed`（确定性） |
| D-Bus 连不上 | 1 | 空 | `secret-tool: Could not connect: …` | `backend-unavailable`（瞬时） |
| 守护未运行 / 集合锁定 | — | — | — | 挂起 → `timeout`（瞬时） |

即"条目不存在"与"后端不可达"**退出码相同**，只能靠 stderr 是否为空区分。照搬 DPAPI 的
"unwrap 失败即 decrypt-failed"会把一次 keyring 不可达误判成密文损坏，正是 2026-09-20 事故的
放大器。另外守护进程不在时的表现是**挂住直到超时**（不是报错），所以 probe/wrap/unwrap 都
强制超时（15s/10s/10s，`BFB_KEYRING_TIMEOUT_MS` 可覆盖），探针清理单独压到 3s。

**本地验证（WSL 实测路径，Ubuntu 26.04 / libsecret 0.21.7）**：

```bash
sudo apt-get install -y libsecret-tools gnome-keyring
rm -rf ~/.local/share/keyrings                  # 清掉锁定的 Default_keyring
printf '\n' | gnome-keyring-daemon --unlock --components=secrets
node tools/probe/host.cjs --only 21             # 契约探针
```

两个坑：**不要**用 `dbus-run-session` 起新总线（新总线上守护没有已解锁集合，`store` 会
触发 `gcr-prompter` 图形提示，在无桌面环境里永久挂住）；探针 21 只验证 `secret-tool` 契约，
`keyring.ts` 的平台开关由 `tests/password-keyring.test.ts` 的「平台后端开关」用例覆盖。

**失败语义（D1–D8）**：

- transient（`timeout` / `spawn-failed` / `protocol-error` / `backend-unavailable`）→
  保留文件、状态 `retrying`、退避 0/3/10/30s；
- deterministic（`decrypt-failed` / `corrupt-local` / `key-length-mismatch` /
  `legacy-plaintext`）→ 保留文件、状态 `blocked`，等用户显式决策；
- 读路径零破坏：`_shelfFile()` / `clear()` 只允许出现在 enroll（建库/显式重建）与旧明文
  迁移；轮换 wrap key 只发生在 `initVault` / `resetAll`。
- **A 档读不到时不可降级 C′**：C′ 需要 wrap key 明文，而它只能由 A 档解出。
- 唯一允许销毁密钥的产品路径是 `password:rebuild-vault`（确认词 `REBUILD`）。

### 4.2 查看门禁（每次验证，无会话豁免）

`password:reveal` 的判定顺序固定为：**库可解密 → 条目存在 → 验证**。反过来会误导
（未建库报 missing）或白弹一次验证框。

- A 档：Windows 系统凭据对话框（`CredUIPromptForWindowsCredentials` + `LogonUserW` +
  SID 比对），明文不进入本应用进程；
- C 档：用户自定义查看密码，PBKDF2-HMAC-SHA256（250k 次）；
- 连续失败 **5 次锁 30 分钟**（`MAX_VIEW_FAILURES` / `VIEW_LOCK_MS`），锁定记录存独立
  store `password-view-guard`，**不随 `resetAll()` / 重建清除**；
- 触发锁定的那次仍返回 `wrong-credential` + `lockedForMs`，此后才返回 `locked`；
- 所有校验入口共用同一失败计数（含改密的 `current` 校验）；锁定期间不接受任何查看密码
  设置/修改，避免用"改密"绕过锁定；
- 取消对话框、`account-locked`、通道不可用、`needs-setup` 不计入失败。

### 4.3 IPC

| 通道 | 说明 |
| --- | --- |
| `password:status` | `enabled/initialized/tier/autoCapture/autoFill/autoFillReady/keyStatus/keyIssue/viewGuard/excludedSites` |
| `password:init` / `reset` / `rebuild-vault` | 建库 / 清空 / 显式重建（`REBUILD`） |
| `password:list` / `delete` / `set-default` | 条目管理 |
| `password:set-auto-capture` / `set-auto-fill` / `set-excluded-sites` | 开关与排除站点 |
| `password:save-confirm` / `ignore` | 保存确认 / 忽略 |
| `password:fill` | 指定 tab + 条目填充 |
| `password:reveal` | 门禁通过后返回明文，`mode` 标明 A/C |
| `password:set-view-password` / `reset-os-auth` | 设置/修改查看密码、重检系统验证 |
| `password:retry-key` | 失效探测缓存并重试一次（瞬时失败自愈） |

`tier` 取值 `A` / `C` / `none`；`keyStatus` 驱动 UI 三态（ok / retrying / blocked）。

## 5 安全不变量

- 密码不得进入 `console.log`、诊断、普通 renderer IPC 或 URL 查询串；`reveal` 的明文
  只经一次 IPC 出。
- 动态表单 observer 只发 presence signal，不读输入内容。
- 导航、刷新、前进、后退或引擎切换前先 `teardownCapture(wc)`；长期附着会冻结 JSONP
  和导航。
- 自动化持有租约时捕获必须让步；释放后由页面生命周期重新附着。
- 自动填充只填字段，不提交。
- C′ 只防文本直读，UI 必须如实显示保护等级。

## 6 验证与雷区

- 单元：加密、保险库、URL 策略、填充策略、租约、失败路径、门禁 UI。
- 真机回归：4399 表单提交、7k7k JSONP、跨域 iframe、捕获开关关闭路径。
- **禁止在捕获脚本里创建 iframe 取"干净 API"**：注入由"新执行上下文创建"驱动，自建
  子帧会跑同一段脚本再建子帧（实测 71 vs 2 次 `script loaded`、57 vs 0 次栈溢出）。
- **捕获挂载时机**：挂在 `did-stop-loading`；广告密集页可能晚几十秒，期间输入不可见。
  排查"某站点捕获不到"时，先对齐日志里的 `setupCapture` 时间戳与用户操作时间。
- **别把"密码框出现在 DOM 里"当作"能填"**：登录层常见形态是"先
  `display:none` 插入、点击后 `show()`"。observer 必须按可见性（不是插入事件）
  判定新鲜度，并观察 `style`/`class`——否则又退化成"必须点一下输入框"。
- **fill 与 capture 争抢 debugger**：排查先搜 `CDP is already attached` 与
  `attach retries exhausted`。
- **跨站 iframe 里的登录表单捕获不到（已知限制，探针 56 固定）**：捕获脚本只注入主
  target 的 execution context；不同站点的子帧（OOPIF，如 7k7k 玩法页把游戏 HTML 放在
  `web.7k7k.com` 那层）不在该列表里，而 Electron 11 的 `debugger` 只能 attach 到
  webContents，拿不到 OOPIF 的 CDP session。判别方法（2026-11-10 起 `frame info`
  带三个字段）：主文档报 `pwInputs=N pwVisible=0 top=1`、整段会话**没有一条
  `first keydown` / `input pw`**，说明键盘输入根本没进被注入的文档 ——
  此时该站在哪一层登录，决定这条能不能支持。
- **同站跨源子帧是能捕获的（探针 58）**：子帧在 attach 前已存在、或 attach 之后才
  创建，都能注入并捕获到；所以"子 iframe 里登录没提示"要先分清是**同站**（该有提示，
  没有就是新 bug）还是**跨站**（上面那条限制）。注意去重键是 `host/username`：
  同一站点先后用同一账号登录只会提示一次，探针/联调时别把它当成"没捕获"。
- **纯 Node（vitest）下 electron-log 会写真实 `logs/main.log`**，含 `/mock/` 路径的行
  是单测噪声；先按来源区分，否则会把单测告警当成真机故障。
- 门禁在解密之前；不要把"已授权"缓存到 module 级变量。

## 7 故障史

| 时间 | 事件 | 记录 |
| --- | --- | --- |
| 2026-09-20 | DPAPI 探测超时被当成后端失配 → 唯一 wrap key 被销毁 → 填充/保存/查看同时失效 | [`password-vault-failure-2026-09-20.md`](../password-vault-failure-2026-09-20.md) |
| 2026-09-21 | 修复：读路径零破坏、失败二分、亲和标签、惰性自愈、UI 出口（K1–K4） | 同上 + [`specs/2026-09-21-keyring-failure-path-design.md`](../archive/superpowers/specs/2026-09-21-keyring-failure-path-design.md)（历史规格） |
| 2026-09-22 | 捕获链路三处缺陷：递归自造 iframe / submit 被当账号 / 空用户名被丢弃 | [`password-capture-diagnosis-2026-09-22.md`](../password-capture-diagnosis-2026-09-22.md) |
| 2026-10-28 | 换账号后第二次登录框无捕获：动态表单未重武装 + 租约已释放仍被当成有效会话 | [`password-switch-and-automation-timing-2026-10-28.md`](../password-switch-and-automation-timing-2026-10-28.md) |
| 2026-11-10 | 自动填充退化成"必须点一下账号密码框"：`4e2afa7` 删掉了"先插入后显示"登录层的信号；账号框预置提示文字被判成"用户已填别的账号" | 见 §3.1 末段与 §3.2；探针 `tools/probe/probes/52-password-autofill-rearm.cjs` |
