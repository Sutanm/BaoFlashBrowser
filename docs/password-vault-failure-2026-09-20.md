# 密码本失效：诊断与修复记录（阶段一 · 2026-09-20 事故 / 2026-09-21 修复）

> **这是"密码本为什么失效"的第一阶段记录。** 阶段二（2026-09-22 捕获失灵）见
> [`password-capture-diagnosis-2026-09-22.md`](./password-capture-diagnosis-2026-09-22.md)。
>
> 两阶段的分界：09-20 的事故让**整个保险库**不可用（填充 / 保存 / 查看三个功能一起失效）；
> 09-22 处理的是**捕获链路本身**的缺陷。阶段一的修复（K1–K4）先落地，才有可能谈阶段二。

---

## 1. 一句话结论

**2026-09-20 15:02 一次 DPAPI 探测「超时」，被密码库当成"密钥后端失配"，于是把唯一的
wrap key 文件永久搁置并清空。** DEK 只由这把 key 包裹，`_dek` 从此解不出来——三个功能同时失效。
之后的每次启动都不再有 `keyEnc` 可试，**故障因此是永久的，不是当次会话的。**

事故的本质不是"环境坏了"，而是**规格缺了"失败路径"这一段**，实现自己补了一句
"解不开就轮换"——而那是整个系统里唯一不可逆的选项。

## 2. 完整时间线

| 时间 | 事件 |
|---|---|
| 2026-09-03 | v2 保险库定型（无主密码、A 档 OS keyring + C′ 兜底）；v1 旧库按决策 8 改名 `.legacy.bak` 搁置，不迁不读 |
| **2026-09-20 15:02** | **事故**：启动风暴中 DPAPI probe 超时 → `_loadWrapKey` 判定后端失配 → `_shelfFile` + `clear()`，唯一 wrap key 被销毁 |
| 2026-09-21 上午 | 事后取证：提交历史回溯 + userData/日志取证 + 密钥可恢复性实测（全程只读） |
| 2026-09-21 下午 | 规格增量 D1–D8（`docs/superpowers/specs/2026-09-21-keyring-failure-path-design.md`）+ 实施计划 K1–K5（`docs/superpowers/plans/2026-09-21-keyring-failure-path.md`）；K1–K4 落地并各自独立提交 |
| 2026-09-22 | 阶段二：捕获失灵专项（见另一份文档） |

## 3. 三个症状与代码的对应

| 症状 | 直接原因 | 位置 |
|---|---|---|
| 无法自动填充 | 自动填充链路首判 `if (!_dek) return null` | `password-store.ts` 的 `getFillCredentialForUrl`、`tabs.ts` 的 `_attemptPasswordFill` |
| 无法保存捕获 | `password:save-confirm` 守卫 `!isInitialized() \|\| !isDekReady()` → `'Password store not ready'` | `password.ipc.ts` 的 save-confirm |
| 无法查看密码 | **与密钥无关**：`password:reveal` 本就硬编码 `{ error: 'not-authorized' }`，view-gate（原计划 Task 5）从未接线 | `password.ipc.ts:129` |

> 第三条要单独指出：**即使密钥没坏，"查看明文"也一样不可用**——它是功能未实现，
> 不是本次事故的后果。排查时不要把它算进密钥故障。

## 4. 硬证据

### 4.1 真机日志（`%APPDATA%\bao-flash-browser\logs\main.log`）

```
[2026-09-20 15:01:52.721] [info]  [App] started, version 1.1.2
[2026-09-20 15:02:02.968] [info]  [Password] IPC registered (v2)
[2026-09-20 15:02:03.308] [warn]  [Window] ready-to-show timed out after 8000ms; showing fallback window
[2026-09-20 15:02:13.641] [info]  [keyring] no OS backend available (reason=timeout)
[2026-09-20 15:02:13.642] [warn]  [password-store] OS-keyring unwrap failed, rotating wrap key: timeout
[2026-09-20 15:02:13.643] [warn]  [password-store] legacy data shelved: ...\password-autofill-key.json.legacy.bak
```

同一次启动里 `ready-to-show` 超时 8s、OpenCV Worker 预热 10312ms、OCR Sidecar 预热 11514ms
—— 典型的**启动风暴**。DPAPI 后端是「spawn `powershell.exe` + `Add-Type` + `Protect`」子进程，
当时的 probe 预算 10s / unwrap 预算 15s，在这种负载下被打爆。
**一次超时 = 永久损坏**，这就是缺陷链的入口。

### 4.2 磁盘现状（2026-09-21 取证时）

- `password-autofill-key.json` = `{"keyEnc":null,"keyLocal":null}`（38B）——被清空
- `password-autofill-key.json.legacy.bak`（388B，mtime 09-03 20:19）= 唯一存活的 `keyEnc`，
  解出为 262B 原始 DPAPI blob（头 `01000000d08c9ddf`）
- `password-store.json` = `version:2`、`dekAutoFillEnc` 有值、**`entries: []`**、三个开关全 true

### 4.3 密钥其实没丢（实测）

用当前 DPAPI 后端（`ProtectedData` / `CurrentUser` / 无 entropy）解 `.legacy.bak`：

```
dpapiOutcome       : OK x6mE1nxr8sYRWePvXtj3qwm5EEuaVMAHijTqqf52g0Y=
recoveredWrapKeyLen: 32          ← 32B wrap key 还原成功
dekRecovered       : true
dekLen             : 32          ← 用它解封 dekAutoFillEnc（AES-256-GCM）成功
```

⇒ **数据层没丢钥匙，是代码主动把它扔了。**

### 4.4 归因排除（避免误判）

09-11 日志里另有 26 条 `OS-keyring unwrap failed ... unwrap-failed`，它**不是真机故障**：
该字符串只存在于 `keyring.ts` 的 safeStorage 分支，而单测的假后端正好返回它，
且 electron-log 在纯 Node（vitest）下会写同一个日志文件。真机每次启动只打
`[keyring] backend active: win-dpapi`（Electron 11.5.0 无 safeStorage，与 09-03 实测一致）。
**读日志时要先按来源区分**，否则会把单测噪声当成真机告警。

## 5. 代码缺陷链（按危害排序，行号为修复前）

1. **P0 读路径做破坏性操作** —— `password-store.ts` 的 `_loadWrapKey`：任何 `keyringUnwrap`
   失败（含 `timeout` 这类瞬时错误）都执行 `_shelfFile()` + `clear()`。唯一钥匙被销毁，
   且没有任何"这是瞬时错误"的分支。
2. **P0 失败被永久缓存** —— `keyring.ts` 的 `detectKeyring()` 把失败结果
   （`{backend:null, reason:'timeout'}`）缓存到进程结束；`clearKeyringCache()` 当时只有单测在用，
   生产链路无调用点。一次超时污染整个会话，再经 #1 变成永久。
3. **P1 超时预算过紧且探测在启动路径上** —— `keyring-win-dpapi.ts`（probe 10s / unwrap 15s）。
   冷启动 PowerShell + `Add-Type` 在启动风暴下不稳。
4. **P1 密文无格式标签** —— `keyEnc` 只存裸 base64，无法区分来源后端（dpapi vs safeStorage）。
   后端一旦变化只能靠"解不开"发现，而当时对"解不开"的反应是销毁。
5. **P2 无自愈、无 UI 出口** —— `status.initialized=true` 而 `autoFillReady=false` 时，
   面板走"有库"分支（空列表 + 角标显示"A 档"），既不显示"启用密码管理器"按钮，
   也没有重置出口，用户无法自助恢复。

## 6. 修复（K1–K4）

### 6.1 设计主线：把两件被混为一谈的事分开

核心不变式只有一条：

> **D1 读路径零破坏**：`_shelfFile()` / `clear()` 只允许出现在 enroll（建库 / 显式重建）
> 与旧明文迁移两个显式路径。当前读路径仅两处 `_shelfFile` 调用（`password-store.ts:323`、`:427`），
> 且都只在**检出旧明文格式**时触发。

在它之上是失败语义二分：

| 类别 | kind | 处置 |
|---|---|---|
| transient | `timeout` / `spawn-failed` / `protocol-error` / `backend-unavailable` | **保留文件**，状态 `retrying`，退避 0·3s·10s·30s 自动重试 |
| deterministic | `decrypt-failed` / `corrupt-local` / `key-length-mismatch` / `legacy-plaintext` | **保留文件**，状态 `blocked`，只给「重试 / 重建密码本（需确认词）」 |

其他关键决策：`ps-error:*` **方向敏感**（unwrap 方向 = 后端说密文解不开 → deterministic；
wrap 方向 = 密文根本没生成 → 可重试）；**A 档故障不可降级 C′**（C′ 需要 wrap key 明文，
而它只能由 A 档后端解出——降级在密码学上不成立）；`keyEncBackend` 亲和标签消除
"解不开＝损坏"的歧义；往返探针移出读路径（读时 unwrap 本身就是最强探针）。

### 6.2 落地提交

| commit | 内容 |
|---|---|
| `901208e` | **读路径零破坏**——失败语义二分，`_loadWrapKey` 不再搁置/清空/轮换密钥 |
| `84a694d` | `keyEncBackend` 亲和标签 + `keyringUnwrapAffine` 只读试解（≤2 候选，成功才回写标签） |
| `8d69df7` | 失败结论 15s TTL + `invalidateKeyring()`；探针移出读路径；预算 10/15s → 25/20/25s；`ensureKeyLoaded()` 退避自愈；`keyStatus/keyIssue` + `password:retry-key` |
| `7705a2a` | 面板三态横幅（retrying / blocked）+ `password:rebuild-vault`（须敲 `REBUILD`，唯一允许销毁密钥的产品路径）+ 设置页状态行 + i18n |
| `ed368ad` | 规格 D1–D8 + 计划 K1–K5 与实施记录 |

验证：typecheck（main/preload/renderer）0 error、lint 0 error、单元测试全绿、`dist` 重建并逐项核对
新逻辑进产物。**另修掉一条"虚假信心测试"**：原用例断言"OS unwrap 失败 → 文件搁置、DEK 不可用"
——等于把事故行为锁成预期行为；已改为断言相反的不变式（材料原样保留 + 零写盘 + 状态分类正确）。

### 6.3 现场处置（当时库内 0 条目）

两条路，推荐前者：**重建**（面板琥珀横幅 → 「重建密码本…」→ 敲 `REBUILD`，零损失）；
或**保留原 DEK**（把 `.legacy.bak` 的 `keyEnc` 用 DPAPI 解出后回填 `password-autofill-key.json`
并补 `keyEncBackend: 'win-dpapi'`，§4.3 已实测可解）。实际执行的是重建（见阶段二文档）。

## 7. 遗留项（未完成，明确不装作完成）

1. **探针 23（真机故障注入）**：需要对 `password-store` 建一个能被 Electron 探针加载的 smoke 构件
   （新 build 脚本 + `scripts/smoke-bundles.cjs` 清单项）。
2. **面板三态渲染测试**：仓库 jsdom 基建当时只覆盖 SettingsPanel，补面板测试需先补 ipc mock 与
   i18n provider 包装。
3. **K5 数据处置**：一次性收尾（当前已通过"重建"完成，机制上仍留有计划条目）。
4. **`password:reveal` 接线（原 Task 5 view-gate）**：至今仍是 `not-authorized` 占位，
   即"查看明文"不可用——**这不是密钥问题**，是功能未实现。

## 8. 记录分布（本次为何"看起来没记录"）

阶段一的事实分散在三处，其中**只有后两处随仓库走**：

| 载体 | 内容 | 是否在仓库 |
|---|---|---|
| `docs/password-vault-failure-2026-09-20.md` | **本文档**——阶段一的正式记录 | ✅ |
| `docs/superpowers/specs/2026-09-21-keyring-failure-path-design.md` | 规格增量 D1–D8（含事故复述与决策理由） | ✅ |
| `docs/superpowers/plans/2026-09-21-keyring-failure-path.md` | 实施计划 K1–K5 + 落地记录与偏差 | ✅ |
| `.workbuddy/memory/2026-09-21-password-vault-postmortem.md` | 最初的完整事后分析（本文档的来源） | ❌ 在 `.workbuddy/memory/`（工作区记忆目录），不随仓库 |
| `.workbuddy/memory/2026-09-21.md`、`MEMORY.md` | 当日工作日志与长期项目笔记 | ❌ 同上 |

**教训**：`docs/superpowers/{specs,plans}` 是 SDD 的工作产物，写的是"要做什么、怎么做"；
而"事故是什么、证据是什么、为什么会发生"这类**复盘**必须单独成文放进 `docs/`，
否则它会止步于 agent 侧记忆目录，半年后没人找得到。

## 9. 影响文件

| 文件 | 相关职责 |
|---|---|
| `src/main/modules/password-store.ts` | `_loadWrapKey`（423）、`_loadDekFromStore`（520）、`initVault`（582）、`resetAll`（771）、`_shelfFile`（306）、`DETERMINISTIC_KEY_FAILURES`（116）、`getKeyStatus`（213） |
| `src/main/modules/keyring.ts` | `detectKeyring`（209）、`invalidateKeyring`（204）、`failureTtlMs`（172）、`keyringUnwrapAffine`（299） |
| `src/main/modules/keyring-win-dpapi.ts` | 探测/解包预算（60/63，现 25s）、`classifyPsOutcome`（162，方向敏感） |
| `src/main/ipc/password.ipc.ts` | `password:retry-key`（47）、`password:rebuild-vault`（153）、`password:reveal`（129，占位） |
