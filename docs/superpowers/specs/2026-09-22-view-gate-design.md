# 查看门禁（view-gate）设计 —— 规格增量

> 目的：让"查看密码"真正可用，同时满足一个明确的产品目标——**防窥屏**（肩窥、旁观者、临时离开座位的人）。
> 这不是"防本地攻击者"的设计：C 档下 wrap key 本就以本地弱保护存储（`keyLocal`），
> 拿到文件系统写权限的人可以绕过本门禁。边界写在 §9，不假装。
>
> 上游：`docs/superpowers/plans/2026-09-03-auto-fill-keyring.md` Task 5/6（本文档取代其门禁部分）、
> `docs/superpowers/specs/2026-09-21-keyring-failure-path-design.md`（D1–D8，密钥失败路径）。

## 0. 现状（2026-09-22 核实，非照抄文档）

| 环节 | 现状 |
|---|---|
| `password:reveal` | `password.ipc.ts:129` 恒返回 `{ error: 'not-authorized' }`，**view-gate 从未接线** |
| preload 白名单 | `verify-view` / `set-view-fallback` / `clear-view-fallback` **一个都没有**（未进白名单的通道会被静默丢弃） |
| `view-gate.ts` | 不存在 |
| `viewFallback` 存储字段 | **已预留**：`password-store.ts:52` 的 `{ salt, hash } \| null`，`resetAll()`/建库时置 `null` |
| 渲染层 | **已就绪**：`PasswordsPanel.tsx` 的 `handleTogglePassword` 已调 `api.reveal` 并处理 `not-authorized` |
| `ViewGuardStatus` 类型 | 已定义（`mode` + `fallbackEnabled`），`password:status` 已返回，由 `resolveTierView()` 填充 |
| Linux/macOS OS 后端 | `keyring.ts` 的 `createPlatformBackend` 对两者 `return null`（T3/T4 未实现） |

⇒ 剩余工作集中在**主进程新模块 + 通道接线 + 渲染层模态**三块。

## 1. 铁律

- **G1 门禁在解密之前**：`getDecryptedPassword()` 只允许在门禁通过后被调用。任何路径都不得先解密再判断。
- **G2 明文只出一次**：明文仅经 `password:reveal` 的返回值送到渲染层；**不写日志、不落盘、不进错误信息**。日志只记状态与原因码。
- **G3 任何校验入口都计入失败计数**：否则"修改查看密码"会变成一个免计数的暴力破解口（oracle）。见 G6。

## 2. 档位 → 门禁形态（G4）

| 条件 | mode | 行为 |
|---|---|---|
| 未建库 / DEK 不可用（`keyStatus !== 'ok'`） | `none` | reveal 直接拒绝（`not-authorized`），不弹任何验证 |
| tier **A** 且平台 OS 验证后端可用 | `os-win` | 系统凭据对话框（§4） |
| tier **A** 但 OS 验证被判定不可用（G9） | `password` | 查看密码（§5） |
| tier **C** | `password` | 查看密码，**强制**：未设置则先引导设置 |
| tier A 但平台无 OS 后端（darwin/linux，T3/T4 未实现） | `password` | 查看密码。`reason='no-os-auth-backend'` |

**与旧草案的偏离**：旧草案给 darwin/linux A 档标 `os-mac` / `keyring` 并"直接放行"。
那在**后端不存在**的今天等于"无门禁"——与用户要求的防窥屏目标矛盾。
现改为：**只有真实存在可用的 OS 验证后端才用 OS 门禁，否则一律落到查看密码**。
将来 T3/T4 落地后只需在 `osBackendFor()` 注册，策略无需改动。

## 3. Windows 系统验证（G5）

**提示方式**：`CredUIPromptForWindowsCredentials`（`credui.dll`），
标志 `CREDUIWIN_GENERIC | CREDUIWIN_ENUMERATE_CURRENT_USER | CREDUIWIN_SECURE_PROMPT`。

选它而不选"应用内输入框 + `LogonUserW`"的理由：**明文密码完全不进入本应用进程**。
`CredUI` 在本应用进程外收集凭据，返回的是 packed 凭据缓冲；解包与校验都发生在
PowerShell 子进程内。应用内输入框则会让明文经过渲染层与 IPC。

**校验**：子进程内 `CredUnPackAuthenticationBufferW` → `LogonUserW(LOGON32_LOGON_NETWORK)` →
**用返回 token 的 SID 与本进程当前用户 SID 比对**，必须一致。

用 SID 比对（而不是比用户名字符串）是为了同时正确处理：本地账户、域账户、
Microsoft 账户（用户名与本地 `USERNAME` 不一致）。不一致 → `not-current-user`。

**错误分类**（`classified by PowerShell 退出码 → 稳定机器码`）：

| Win32 错误 | 机器码 | 计入失败 | 处理 |
|---|---|---|---|
| 1223 `ERROR_CANCELLED` | `cancelled` | **否** | 静默返回，不提示错误 |
| 1326 `ERROR_LOGON_FAILURE` | `bad-credential` | **是** | 提示剩余次数 |
| SID 不一致 | `not-current-user` | **是** | 同 `bad-credential` 的计数语义 |
| 1909 `ERROR_ACCOUNT_LOCKED_OUT` | `account-locked` | **否** | 明确提示"Windows 账户已锁定"，不再计数（继续计数无意义且会误伤） |
| 1327 / 1330 / 1331（空密码 / 密码过期 / 账户禁用） | `unusable-account` | 否 | **触发 G9 降级**：置 `osAuthUnavailable=true`，改走查看密码 |
| 1385（未授予网络登录权限）等策略拒绝 | `denied` | 否 | 同上，降级 |
| spawn 失败 / 超时 / 协议错误 | `unavailable` | 否 | **fail closed**：拒绝查看并给出原因；不降级（环境问题可重试） |

**预算**：OS 验证是**交互式**的（用户要去找密码、可能要切换输入法），
默认超时 **120s**（`BFB_VIEWGATE_TIMEOUT_MS` 可覆盖），远大于 DPAPI 的 25s。
取消会立即返回，不会真的等满。

**子进程纪律**（沿用 DPAPI 后端的既有约束，`keyring-win-dpapi.ts` 的注释即为规范）：
`windowsHide`、`-NoProfile -NonInteractive -ExecutionPolicy Bypass`、
stdout 首行契约 `OK <payload>` / `ERR <code>`、stderr 只进日志、超时 kill。

## 4. 查看密码（C 档强制，G6）

- **KDF**：PBKDF2-HMAC-SHA256，250k 迭代，16B 随机 salt，导出 32B（复用 `crypto-helper.ts` 的 `PBKDF2_ITER` / `SALT_LEN`）。零第三方依赖，与既有加密栈一致。
- **存储**：复用已预留的 `viewFallback` 字段，扩展为 `{ salt, hash, iter }`（`iter` 入库以便将来调参不误判旧记录）。
- **比对**：`crypto.timingSafeEqual`。长度不符即失败（不抛异常）。
- **口令策略**：长度 6–128；不做复杂度强制（目标是防窥屏，不是防爆破；爆破由 G7 的锁定负责）。
- **设置时机**：C 档首次查看时。reveal 返回 `needs-setup` → UI 引导设置（输入 + 确认二次）→ 设置成功后**当次直接视为已授权**（同一次交互意图），随后正常返回明文。
- **修改**：需先通过当前查看密码；`current` 校验失败**计入失败计数**（G3）。

## 5. 失败计数与锁定（G7）

- 连续失败 **5 次** → 锁定 **30 分钟**（`VIEW_LOCK_MS`）。
- **持久化**：独立 electron-store 文件 `password-view-guard.json`，字段
  `{ failCount, lockedUntil, osAuthUnavailable }`。
  **不随 `resetAll()` / 重建密码本清除** —— 锁定是关于"尝试"的记录，不是关于"数据"的。
- **不计入失败的**：用户取消、`account-locked`、`unavailable`、`needs-setup`、以及锁定期间的任何尝试。
- **锁定期间**：立即拒绝（`locked` + 剩余毫秒），**不累加、不延长**。理由：锁定期的语义是"等"，不是"越试越久"；
  累加会制造"越急越糟"的惩罚螺旋。
- **成功即清零**（`failCount=0, lockedUntil=null`）。
- **锁定期满**：下一次读取时清零，给回完整 5 次。
- **剩余次数对用户可见**（`remainingAttempts`）——避免"突然被锁"的惊吓。

## 6. 锁定的作用域（G8，**待用户确认**）

**本规格取"锁定只挡查看明文"**：锁定期间 `password:reveal` 被拒，
但**自动填充、保存捕获、删除条目、重建密码本不受影响**。

理由：门禁的目标是防窥屏，而填充不向屏幕暴露明文（写进输入框，看不到字符），
保存/删除也不泄露口令。把整库停摆只会惩罚用户而不提升安全性。
若认为该取"整库停摆"，改动是加法（在 fill/save 路径各加一次 `isViewLocked()` 判断），不影响本文档其余部分。

## 7. 忘记查看密码（G9，**待用户确认**）

**本规格取"只能重建密码本"**：没有"无损失重置查看密码"。

理由：只要存在非破坏性重置，旁观者拿到键盘就能自己重置再查看——
门禁对"坐在你电脑前的人"即形同虚设，与设定目标自相矛盾。
设置界面必须**明示**该后果（"忘记后只能重建密码本，将丢失全部条目"）。
重建走既有的 `password:rebuild-vault`（需 `REBUILD` 确认词），
它同时清空 `viewFallback` → 回到"未设置"状态。

## 8. A 档降级（G10，**待用户确认**）

Windows 账户用 PIN / Windows Hello，或账户被策略禁止网络登录时，OS 验证会判 `unusable-account` / `denied`。
此时**降级为查看密码**（持久化 `osAuthUnavailable=true`），而不是：
- 直接放行（等于无门禁）；
- 永久拒绝（用户彻底无法查看自己的密码）。

降级后若尚未设置查看密码，reveal 返回 `needs-setup` 引导设置。
`osAuthUnavailable` 只在**首次**判定时设置，不因后续瞬时失败（`unavailable`）触发。
设置页提供"重新检测系统验证"（清 `osAuthUnavailable` 复位）——否则用户在系统侧修好了（如补上密码），
应用不会自己回来。

## 9. IPC 表面（G11）

**只新增一个通道**，`password:reveal` 扩展一个可选参数：

| 通道 | 入参 | 返回 |
|---|---|---|
| `password:status`（既有，扩展） | — | `viewGuard: { mode, passwordSet, lockedForMs?, remainingAttempts?, reason? }` |
| `password:reveal`（既有，扩展） | `{ id, secret? }` | `{ password?, error?, remainingAttempts?, lockedForMs? }` |
| `password:set-view-password`（新增） | `{ password, current? }` | `{ success, error? }` |

`error` 取值：`'not-authorized'`（未通过 / 无门禁可用）、`'missing'`（条目不存在）、
`'locked'`、`'needs-setup'`、`'cancelled'`、`'wrong-credential'`、`'unavailable'`。

**为什么不做独立的 `verify-view` 通道**：门禁是"为这次查看"服务的，每一次查看都要重新验证（G12），
因此没有任何需要跨请求保存的"已授权"状态。把验证并入 reveal，通道更少、更难被绕过
（不存在"先 verify 再随便 reveal"的窗口）。

**类型变更**：`ViewGuardMode` 增加 `'password'`；`ViewGuardStatus.fallbackEnabled`
改名为 **`passwordSet`**（语义从"可选兜底是否启用"变为"查看密码是否已设置"），
消费方 `useDataStore.ts` 默认值、`SettingsPanel.tsx`、`PasswordsPanel.tsx` 同步更新。

**G12 无会话豁免**：成功率 ≠ 会话授权。**每一次查看都验证**（用户已拍板）。
模块不保存任何 `granted` 标志，因此也不存在"忘记吊销"的漏洞。
将来若要"本次会话 N 分钟"，改动点只在 `authorizeView()` 一处。

## 10. 安全边界与已知局限（诚实清单）

1. **计数文件可被本地篡改**：`password-view-guard.json` 是明文 JSON，能写该文件的人可以清零计数或解除锁定。
   与 C 档 `keyLocal` 的弱保护同级。加密封存（DPAPI）是可选的后续加固，本次不做。
2. **C 档不防本地攻击者**：`keyLocal` 反混淆可在本地完成，门禁只是 UI 层的阻挡。
3. **子进程内明文**：C 档查看密码、Windows packed 凭据解包后的明文，会短暂存在于
   PowerShell 子进程内存（字符串不可控地等待 GC）。不入日志、不入命令行参数、不入文件。
4. **不防内存转储 / 调试器**。
5. **UI 层明文**：渲染层拿到明文后会渲染与可能进剪贴板；"复制"按钮不清理剪贴板。

## 11. 明确不做

- 不做"本会话免重复验证"（G12）。
- 不做"无损失重置查看密码"（§7）。
- 不做 Linux `secret-tool` / macOS `security` 后端（T3/T4 仍独立）。
- 不把查看密码做成数据加密密钥（它不是 KEK，不参与 DEK 解包；忘记它不会导致数据不可解）。

## 12. 待确认项

| # | 项 | 本规格取值 | 影响面 |
|---|---|---|---|
| Q1 | 锁定作用域（G8） | 只挡查看明文 | 若要"整库停摆"，需在 fill/save 各加一处判断 |
| Q2 | 忘记查看密码（§7） | 只能重建 | 若要无损失重置，需新增一个通道 + UI 入口 |
| Q3 | A 档降级（G10） | 不可用时降级为查看密码 | 若要"只允许 OS 验证"，则 PIN 用户可能无法查看 |
