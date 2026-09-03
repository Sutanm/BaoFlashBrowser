# Auto-fill 免解锁跨平台密钥后端实现计划 v2（修订版，采纳审计 16 条）

> **For agentic workers:** 按 Task 顺序逐任务实现，每任务完成后独立验证并 commit。步骤 checkbox 跟踪。关联规格：`docs/superpowers/specs/2026-09-03-auto-fill-keyring-design.md`（决策 1–8）与本文件 v2 修订。
> **修订记录：** 2026-09-03 收到计划审计一轮（16 条）与二轮（N1–N3）。P0（#1/#2/#3）通过"任务合并为垂直切片 + 全程保持可编译"解决；N1（Task5 缺 preload/types 联动）补 Files 清单；P1/P2 全部采纳，见各 Task 与采纳对照表。

**Goal:** keyring 多后端（win-dpapi / linux-secret-service / darwin-keychain / 预留 safeStorage）→ 档位 A/C′ → 数据形态 v2（无主密码）→ OS 查看门禁（Win LogonUser / mac keychain / C′ 兜底）。**不做 v1 兼容/迁移**。**每个 Task 结束必须 `npm run typecheck` 通过**（这是修订后的硬性门禁，防止中间态编译断裂）。

**Architecture:** `keyring.ts`（OS 密钥后端）+ `view-gate.ts`（查看门禁）为主进程新增模块；`password-store.ts` 改 v2（单一 DEK，无解锁态）；IPC/preload/electron.d.ts/shared types 与主进程同步；`PasswordsPanel` / `SettingsPanel` 随 v2 与查看保护重构。子进程探针按 AGENTS.md 放 `tools/probe/probes/`（协议 `{id,name,needsElectron,timeoutMs,run(ctx)}`，复用 `lib/timeout.cjs`）。

**Tech Stack:** Node `crypto`（AES-256-GCM；PBKDF2 仅兜底密码哈希）；PowerShell + .NET ProtectedData（DPAPI）；secret-tool；security CLI；Electron 11.5.0 锁定；Vitest unit（mock 平台层）；tools/probe 真机冒烟。

## Global Constraints（修订后）

- 不触碰 OpenCV / 视觉模块；零 native/第三方加密依赖。
- 子进程秘密一律经 stdin 或受控参数通道，禁止出现在命令行/日志；强制短超时（secret-tool 3s、DPAPI 10/15s、LogonUser 15s）。
- **每个 Task 结束保持可编译可测**：主进程与渲染层联动改动（模块/IPC/preload/类型/UI）必须在同一 Task 内完成，禁止跨 Task 留编译断裂。
- 无参 IPC 通道按仓库 ipc-wrapper 约束处理（审计 #5，细则见 Task 2/5）。
- 新增字符串跑 `npm run i18n`；每 Task 独立 commit（`feat(password): ...`）。
- 验证：`npm run typecheck`（每 Task 门禁）、`npm test -- --run`、`npm run check`（T7）、`npm run probe:deep` 相关探针。

---

## 任务总览（修订后，7 Task，每 Task 编译绿）

| Task | 内容 | 验证门 |
|------|------|--------|
| 1 | `keyring.ts` 骨架 + win-dpapi 后端 + 单测（**safe-storage.ts 不删**，审计 #1） | 门①：真实 Electron DPAPI 往返（`tools/probe/probes/20-keyring-dpapi.cjs`） |
| 2 | **v2 垂直切片**：password-store + password.ipc + shared types + electron.d.ts + preload + PasswordsPanel/SettingsPanel + i18n + 删 safe-storage.ts + 受影响测试（合并原 T2+T5，审计 #1/#2/#3/#6/#8/#9/#10/#14/#15/#16） | 门②：typecheck + unit 全绿 + 真机建库→重启→免密加载 |
| 3 | Linux `secret-tool` 后端（含 CI 两态配置脚本，审计 #13） | 门③：单测四路径 + CI 两态 |
| 4 | macOS `security` 后端（experimental） | 门④：单测（mac 真机待补验） |
| 5 | `view-gate.ts`（主进程）+ LogonUser + C′ 兜底密码 + reveal 授权制（审计 #8/#11/#12） | 门⑤：typecheck + reveal 门禁单测 |
| 6 | 查看保护 UI（验证模态 + 设置区块 + i18n）+ LogonUser 冒烟（审计 #4 收编探针） | 门⑥：Windows 失败路径自动 + 成功路径手动一次 |
| 7 | 回归 + capture/fill/tabs 语义断言 + 全量（审计 #4/#7） | 门⑦：`npm run check` + `npm run probe:deep` |

---

### Task 1: `keyring.ts` 骨架 + Windows DPAPI 后端（不删 safe-storage.ts）

**Files:**
- Add: `src/main/modules/keyring.ts`（类型、后端注册、探测链、缓存）
- Add: `src/main/modules/keyring-win-dpapi.ts`（PowerShell 子进程）
- Add: `tools/probe/probes/20-keyring-dpapi.cjs`（审计 #4，协议探针）
- Add: `tests/password-keyring.test.ts`

**Interfaces（草案）：** 同规格 §1 `KeyringBackend`/`KeyringStatus`；探测链 ①二进制 ②往返探针；顶层 `electron.safeStorage` 优先。

**修订要点（审计 #1）：** 本 Task **不删除** `src/main/utils/safe-storage.ts`。`password-store.ts#L10-14` 仍 import `isSafeStorageAvailable/encryptWithSafeStorage/decryptWithSafeStorage` 并多处调用——删除动作整体下放到 Task 2（password-store import 切换后）。本 Task 新增模块与现有代码**零交集**，独立可编译。

- [x] Step 1: `keyring.ts` 类型/注册表/`detectKeyring()`（缓存 + `clearKeyringCache()`）。
- [x] Step 2: `win-dpapi` 实现：PowerShell 常量脚本 + stdin payload + stdout `OK/ERR` 契约 + 超时 kill + 错误分类（`no-powershell`/`dotnet-missing`/`timeout`）。**支持 dev-only 环境变量 `BFB_POWERSHELL_CMD` 覆盖可执行路径**（供失败路径冒烟，审计 #11）。
- [x] Step 3: 单测（mock 层）：后端注册顺序、探测缓存/重试、DPAPI stdout 解析（OK/ERR/超时/非零退出）。
- [x] Step 4: `tools/probe/probes/20-keyring-dpapi.cjs`（`needsElectron: false` 纯 Node）：detect → wrap('probe') → unwrap 往返；失败打印 reason。
- [x] 门①：`npm run typecheck` 全绿（main+renderer+preload）；`npx vitest run --project unit tests/password-keyring*.test.ts` 22/22 通过；`npm run probe` 真机 `20-keyring-dpapi ... OK`；失败分支冒烟：`BFB_POWERSHELL_CMD` 指向不存在路径 → probe 返回 `spawn-error ENOENT`（后端判不可用落 C′，不崩溃）。

---

### Task 2: v2 垂直切片（模块 + IPC + 类型 + preload + 渲染层 + 删 safe-storage + 测试）

> **为什么合并（审计 #3 方案 A）：** `password.ipc.ts` L5/L29/L35/L41/L73/L79/L105 直接依赖 `setupMaster/unlockWithMaster/lock/isUnlocked/isInitialized`；`PasswordsPanel` 直接依赖 `api.setup/unlock/lock/status.unlocked`。若模块先删、IPC 后改、UI 最后改，每个中间点都编译失败。因此本 Task 一次性完成主进程 + 渲染层 + 类型 + 测试的 v2 切片，**作为单个逻辑变更提交**。

**Files:**
- Modify: `src/main/modules/password-store.ts`（v2 核心改造，见下）
- Modify: `src/main/ipc/password.ipc.ts`（通道重构）
- Modify: `src/shared/types/passwords.ts`（`PasswordStoreStatus` v2；新增 tier/viewGuard/reveal 结果类型）
- Modify: `src/renderer/types/electron.d.ts`（通道与 `pwd` API，原 ~L119-133）
- Modify: `src/preload/index.ts`（通道白名单 ~L24-27、`pwd` 绑定 ~L135-150）
- Modify: `src/renderer/components/panels/PasswordsPanel.tsx`（v2 流程）
- Modify: `src/renderer/components/panels/SettingsPanel.tsx`（隐私区文案）
- Modify: `src/renderer/i18n/zh-CN/index.ts`、`src/renderer/i18n/en/index.ts`（+`npm run i18n`）
- Delete: `src/main/utils/safe-storage.ts`（import 已切换后，审计 #1）
- Modify/Delete: `tests/password-autofill-key-protection.test.ts`（按 v2 重写或删除，审计 #14）
- Modify: 其他引用旧导出/`status.unlocked` 的测试（先 grep 定位，审计 #6/#14）
- Add: `tools/probe/probes/21-keyring-store.cjs`（真机门②）

**password-store v2 改造（审计 #2 全量函数清单）：**

- **数据形态：** `{ version: 2, dekAutoFillEnc: EncBlob, entries: Entry[], viewFallback?: { salt: string; hash: string } | null }` —— **viewFallback 预留位现在就写入 schema**（值恒 null，Task 5 才填充；审计 #9，避免 T5/T6 改 schema 引发 T2 测试回归）。
- **DEK 并轨（审计 #2）：** 删除模块级 `_dekFromMaster`（L63 及 L210/221/227-229/234/238/397/416-418/479-480/510-512 全部引用），统一为**单一 `_dek`**（语义 = 原 `_dekForAutoFill`）。下列函数必须显式列入改造清单，全部改读 `_dek`：
  - `getDecryptedPassword`（L325-331，原 `if (!_dekFromMaster) return null` → 无门禁纯解密函数，保留给 view-gate 调用）
  - `getEntriesForHost`（L363-375）
  - `getFillCredentialForUrl`（L342-361，原 `const dek = _dekForAutoFill || _dekFromMaster` → 直接 `_dek`）
  - 新增/维持 `getDek(): Buffer | null`（供 save-confirm 守卫与 fill 链路）
  - 增删改（`addEntry`/`updateEntry`/`deleteEntry` L261-317、L397 写入路径）不再有解锁分支，统一用 `_dek`
- **删除的 v1 导出（模块内移除，调用方同步）：** `validatePasswordStrength`（若无引用）、`setupMaster`、`unlockWithMaster`、`lock`、`isUnlocked`、`changeMaster`（L393）。`isInitialized()` 语义改为"v2 vault 存在且启用"。`dispose()` 保留（清 `_dek`）。
- **v2 初始化：** 新增 `initVault()`（无密码）：生成 DEK → 按档位 wrap（A/C′）→ 写 `dekAutoFillEnc` → `_dek` 置位。`init()` 保持启动加载。
- **旧文件搁置（审计 #10 收紧条件）：** 检测 v1 密码本 = `salt`/`dekMasterEnc` 字段**存在且非 null**（electron-store defaults 使全新文件也带 `salt:null`/`dekMasterEnc:null`，只查字段存在会误搁置全新机器）或 `version < 2`；旧明文 key = `password-autofill-key.json` 的 `keyPlain`/历史 `key` **非空**。命中 → `fs.rename` 为 `<name>.legacy.bak`，不读取。
- **C′ 落盘：** `keyLocal` 可逆混淆 + chmod 0600；**措辞统一（审计 #16）：仅"防文本直读"，不防任何主动攻击者**（等同 Chromium basic_text，与规格 §3 对齐）。
- **A/C′ 切换：** 启动探测 → 后端失配/可用切换统一走 `_ensureAutoFillWrap` 内部重包，不抛错（行为同规格 §3）。

**IPC 重构（审计 #3/#5/#8）：**

```ts
// password:status → { enabled, initialized, tier:'A'|'C'|'none', autoCapture, autoFill,
//                     autoFillReady, viewGuard:{ mode:'os-win'|'os-mac'|'keyring'|'none',
//                                                fallbackEnabled:boolean, reason?:string }, excludedSites }
// 删除：password:setup / password:unlock / password:lock
// 新增：
//   password:init                    无参 —— 按仓库 ipc-wrapper 约束：createValidatedHandler 用
//                                     z.object({}).optional() 或对应用法（先读 ipc-wrapper 源码确认，审计 #5）
//   password:reveal                  ({ id }) → { password?; error?: 'not-authorized'|'missing' }
//                                     Task2 占位恒返回 error:'not-authorized'（审计 #8 建议的顺序），
//                                     Task 5 接 view-gate 后真返回。中间态仅开发分支，UI 同步提示。
// 本 Task 不注册（无消费者，避免空通道）：password:verify-view / password:set-view-fallback /
//   password:clear-view-fallback —— Task 5 同步 preload + electron.d.ts + shared types 后再注册（审计 N2）。
// 守卫 v2 形态（审计 #8）：
//   password:save-confirm  L79 原 if(!isUnlocked()) → if (!isEnabled() || !getDek())
//                                    return { success:false, error:'Password store not ready' }
//   password:list          L73 原 if(!isUnlocked()) return [] → 去掉（v2 列表常显，审计 #8）
//   password:reveal        由 IPC 层先查 view-gate session 授权（Task5 起），未授权 → not-authorized
// 保留：password:list/save-confirm/ignore/delete/set-default/fill/toggle-enabled/set-auto-*/set-excluded-sites/reset
```

- **preload 通道白名单（审计 #5 之"注册时机"）：** 若 `password:status` 在 PasswordsPanel `document start`（React mount）即查询，`registerPasswordIPC()` 必须在 main 启动早期（`app.whenReady` 前/首个窗口创建前）注册完毕——检查 `src/main/index.ts` 现有注册顺序，必要时把 password IPC 注册提前，避免竞态；本 Task Step 显式核对。

**渲染层（PasswordsPanel / SettingsPanel）：**
- PasswordsPanel：未初始化 → "启用密码管理器"单按钮（`password:init`，无密码输入）；已启用 → 列表常显；**删除** setup/unlock/lock 三套输入与 `api.setup/unlock/lock` 调用、`wrongPassword` 等状态；顶栏加档位徽标（tier A/C′）与查看保护状态行（占位，Task 6 细化）；查看/复制走 `api.reveal` → Task2 阶段收到 `not-authorized` → toast 提示"查看保护尚未接通（开发中间态）"。
- SettingsPanel：隐私区 autoFill 文案更新；删除 `autoFillNeedsUnlock` 引用。
- **引用面全查（审计 #6）：** Step 0 先跑 `grep -rn "status\.unlocked\|\.unlocked\|password:(setup|unlock|lock)\|api\.(setup|unlock|lock)" src/ tests/` 列全引用点（面板、toast、badge、测试），逐点更新；确认无业务残留后删词条。
- i18n：新增 `password.init*`/`password.tier*`；删除 `setup*/unlock*/lock*`、`autoFillNeedsUnlock` 废弃词条；跑 `npm run i18n`。

**删除 safe-storage.ts（审计 #1/#15）：** password-store 不再 import 后删除；其 L11 错误注释（"运行时 API 存在"）随文件消失；尾注记录该注释与真机证伪的对应关系（审计 #15）。

- [ ] Step 0: 全引用点 grep 清单（#6）。
- [ ] Step 1: shared types + password-store v2 全量改造（含 #2 函数清单、viewFallback 预留、搁置条件收紧、措辞统一）。
- [ ] Step 2: password.ipc.ts 重构 + preload + electron.d.ts（含无参通道用法核对、注册时机核对）。
- [ ] Step 3: PasswordsPanel / SettingsPanel v2 流程与文案 + 查看保护占位行。
- [ ] Step 4: i18n 清理与新增 + `npm run i18n`；删除 safe-storage.ts。
- [ ] Step 5: 重写/删除 `tests/password-autofill-key-protection.test.ts`；按 grep 清单更新其他测试（v2 语义 + reveal 占位）。
- [ ] 门②：`npm run typecheck` + `npm test -- --run` 全绿；真机探针 `21-keyring-store.cjs`：建 v2 → 填 2 条 → 重启 → 免密 list/fill；含 v1 旧文件时断言 `.legacy.bak` 搁置且新库正常。

---

### Task 3: Linux `secret-tool` 后端（含 CI 两态步骤）

**Files:**
- Add: `src/main/modules/keyring-linux-secret.ts`
- Modify: `src/main/modules/keyring.ts`（注册）
- Add: `tests/password-keyring-linux.test.ts`

**要点（审计 #13 CI 步骤显式化）：**
- 探测① `secret-tool` 缺失 → `reason:'no-tool'`；探测② account=`auto-fill-key.probe` 往返，3s 超时 → `daemon-unreachable`；业务 account=`auto-fill-key`，service=`bao-flash-browser`，store 经 stdin；全部 3s 超时。
- CI ubuntu 两态（写入 CI 配置/脚本步骤，非口头）：
  - (a) `apt-get install -y libsecret-tools` + 启动无守护 → 探测② 超时 → 落 C′（验"装了 CLI 但守护没跑"）；
  - (b) 不装包 → 探测① 缺失 → 落 C′（`reason:'no-tool'`）。
  - 若 (a) 需验证真 A 档，用 `dbus-run-session` + `gnome-keyring-daemon --unlock`（headless），不可行则降级真机手动记录。
- KDE KWallet 兼容层不单独处理。

- [ ] Step 1: 实现 + 注册 + 单测四路径。
- [ ] Step 2: CI 配置脚本（上述两态）。
- [ ] 门③：typecheck + unit 绿；CI ubuntu 两态通过。

---

### Task 4: macOS `security` 后端（experimental）

**Files:** Add `src/main/modules/keyring-darwin.ts`；Modify `keyring.ts` 注册；Add 单测。

- `add/find/delete-generic-password`；svc=`bao-flash-browser`、acct=`auto-fill-key`；`-w` 参数可见性局限注释 + experimental；失败一律 `backend=null` 落 C′。
- [ ] Step 1-2: 实现 + 单测（mock 成功/失败）。
- [ ] 门④：typecheck + unit；mac 真机补验记录尾注。

---

### Task 5: `view-gate.ts`（主进程）+ LogonUser + C′ 兜底密码 + reveal 授权制

**Files:**
- Add: `src/main/modules/view-gate.ts`
- Modify: `src/main/modules/password-store.ts`（兜底密码哈希读写 `viewFallback` 字段，Task2 已预留）
- Modify: `src/main/ipc/password.ipc.ts`（verify-view / set/clear-view-fallback 真实现；reveal 由占位改为授权制）
- Modify: `src/main/utils/ipc-wrapper.ts`（如需支持无参 validated handler 模式，先读源码再定）
- Modify: `src/preload/index.ts`（**通道白名单新增三个通道** + `pwd` 绑定 `verifyView`/`setViewFallback`/`clearViewFallback` —— 白名单未含则 IPC 被静默丢弃，审计 N1）
- Modify: `src/renderer/types/electron.d.ts`（三通道 invoke 签名 + `pwd` 方法类型 —— 否则 Task 6 消费时 typecheck 失败，审计 N1）
- Modify: `src/shared/types/passwords.ts`（`ViewVerifyResult` / `SetViewFallbackResult` 等结果类型，审计 N1）
- Add: `tests/password-view-guard.test.ts`

**view-gate 草案：**
- `resolveViewGuard(): { mode:'os-win'|'os-mac'|'keyring'|'none'; fallbackEnabled:boolean }`
- `verifyView(password?)`：os-win/os-mac → `verifyOsIdentity`；fallbackEnabled → PBKDF2 比对；`keyring`(Linux A) → 直接 ok；`none`(C′ 未启用兜底) → ok（与 Chromium basic_text 环境一致）。
- session 授权：成功置模块内 flag（应用生命周期），`resetViewAuth()` 供退出/dispose 调。
- **LogonUser（审计 #11/#12）：**
  - PowerShell P/Invoke `LogonUserW(LOGON32_LOGON_NETWORK)`；密码经 stdin；15s 超时。
  - **失败计数跨会话持久**：electron-store `_viewGateFailCount`（审计 #12，进程内限次会漏算系统锁定策略）。首次失败即提示"连续失败可能锁定 Windows 账户"；错误码 **1909（ERROR_ACCOUNT_LOCKED_OUT）→ 本会话禁用 OS 验证并降级到可选兜底**。
  - 无密码账户/PIN-only（如 1327/1330 等分类）→ mode 降级，提示设兜底密码。
  - 失败路径冒烟支持：`BFB_POWERSHELL_CMD` 覆盖（复用 Task1 的 dev hook，审计 #11）。
- 兜底密码：set/clear（clear 为无参通道 → 按 ipc-wrapper 无参用法）。
- **reveal 授权制（审计 #8）：** `password:reveal` 先查 `isRevealAuthorized()` → 未授权返回 `not-authorized` → 已授权调 `getDecryptedPassword(id)`。

- [ ] Step 1: view-gate 纯逻辑 + 单测（四 mode、verify 成功/失败、限次、session flag、兜底 set/clear/wrong）。
- [ ] Step 2: Win LogonUser 后端 + 错误分类 + 持久计数 + 1909 降级。
- [ ] Step 3: IPC 接线（verify-view / set/clear-view-fallback / reveal 授权制）。
- [ ] 门⑤：typecheck + `npm test -- --run` 绿；reveal 未授权 → not-authorized 单测通过。

---

### Task 6: 查看保护 UI + 冒烟探针（审计 #4 收编）

**Files:**
- Modify: `src/renderer/components/panels/PasswordsPanel.tsx`（验证模态）
- Modify: `src/renderer/components/panels/SettingsPanel.tsx`（查看保护区块 + C′ 兜底开关）
- Modify: `src/renderer/i18n/zh-CN/index.ts`、`en/index.ts`（+`npm run i18n`）
- Modify: `tools/probe/probes/22-logonuser.cjs`（审计 #4；`needsElectron: true`）
- Add（如需）: `tests/password-view-guard-ui.test.tsx`（jsdom，若现有面板测试基建支持）

**UI：**
- PasswordsPanel：点"查看/复制" → 未授权时弹验证模态：按 `viewGuard.mode` 渲染（os-win/os-mac：系统登录密码输入框；fallback：兜底密码输入框；keyring/none：直接放行+提示）。验证成功后本会话不再重复弹。
- SettingsPanel"查看保护"区块：展示 mode 文案（Win/mac："查看密码需验证系统登录密码"；Linux A："由系统钥匙串保护"；C′：开关 + 设置/修改/清除兜底密码）。
- i18n 词条新增。

**探针：**
- `22-logonuser.cjs`：失败路径自动化（错误密码 → 断言 verify=false + 计数+1 + 1909 分支可 mock 注入）；成功路径**手动一次**（输入本机密码）确认 ok。
- 同文件附 `BFB_POWERSHELL_CMD=/nonexistent` 失败路径断言（#11）。
- Task1/2 的 `20/21` 探针如已放 `tools/probe/probes/` 则无需迁移（审计 #4 要求：**不再出现 `scripts/probe-*.cjs` 游离文件**）。

- [ ] Step 1: PasswordsPanel 验证模态 + reveal 成功渲染。
- [ ] Step 2: SettingsPanel 查看保护区块 + 兜底密码管理 UI。
- [ ] Step 3: i18n + `npm run i18n`。
- [ ] Step 4: `22-logonuser.cjs` + 手动成功路径一次。
- [ ] 门⑥：typecheck + unit 绿；Windows 真机：失败路径自动通过 + 成功路径手动记录。

---

### Task 7: 回归 + capture/fill/tabs 语义断言 + 全量

**Files / 动作：**
- **语义断言（审计 #7）：** password-store 对外部消费者保持**行为不变**：`password-capture.ts`（import `getMetaForHost/isAutoCaptureEnabled/isCaptureExcluded`）、`password-fill.ts`（import `type FillCredential`——若 Task5 改其字段需同步检查）、`tabs.ts`（import `getFillCredentialForUrl/isAutoFillEnabled`）。加一条集成断言测试：v2 下 capture 保存、fill 填充、meta 查询与 v1 输出一致（除解锁守卫差异）。
- **探针清点（审计 #4）：** `grep -rn "probe-keyring\|probe-logonuser\|probe-.*\.cjs" scripts/ tools/` ——确认冒烟探针全部在 `tools/probe/probes/` 且遵循协议；`scripts/` 无游离探针。
- **旧测试全面回归：** `grep -rn "setupMaster\|unlockWithMaster\|isUnlocked\|changeMaster\|password:(setup|unlock|lock)\|\.unlocked" tests/ src/` → 应零业务引用（Task2 门⑤已查，此处复查含 tests/）。
- 补强：`password-v2-lifecycle.test.ts`（若 Task2 未覆盖重启/搁置/切换）、`password-view-guard.test.ts` 补边角（#12 1909、#11 spawn 失败）。
- 尾注更新：mac 真机补验记录、LogonUser 成功路径手动记录、CI (a) 态 headless 可行性结论。

- [ ] Step 1: capture/fill/tabs 语义断言测试。
- [ ] Step 2: 探针/旧测试/残留 grep 复查（#4/#7/#14）。
- [ ] Step 3: `npm run check`（i18n + typecheck + lint + unit + build）全程通过。
- [ ] Step 4: `npm run probe:deep` 相关探针（20/21/22）复跑并记录。
- [ ] 门⑦：全绿 + 尾注冒烟记录完整。

---

## 审计采纳对照表（16 条 → 落点）

| # | 优先级 | 落点 |
|---|--------|------|
| 1 | P0 | Task1 不删 safe-storage；删除移至 Task2 Step4 |
| 2 | P0 | Task2 显式列入 3 读函数 + 全量 `_dekFromMaster` 引用并轨单一 `_dek`（含 L238/397/479 等）；规格 §4 同步补 |
| 3 | P0 | Task2 合并主进程+IPC+preload+types+UI 为垂直切片（方案 A）；规格 §4 同步补 |
| 4 | P1 | 探针全部移 `tools/probe/probes/20/21/22-*.cjs`，遵循协议；Task7 复查无游离探针 |
| 5 | P1 | Task2/5 显式核对无参通道与 ipc-wrapper 用法、`password:status` 注册时机（main/index.ts 启动早期） |
| 6 | P1 | Task2 Step0 grep 全引用面；Task7 复查 |
| 7 | P1 | Task7 capture/fill/tabs 语义断言；Task5 改 FillCredential 需同步 password-fill.ts |
| 8 | P1 | Task2 save-confirm 守卫 v2 化 + reveal 占位 not-authorized；Task5 授权制 |
| 9 | P1 | Task2 v2 schema 预留 `viewFallback?:{salt,hash}\|null` |
| 10 | P1 | Task2 搁置条件收紧：字段"存在且非 null"或 `version<2`；keyPlain/key 非空才算旧明文 |
| 11 | P2 | Task1/6：`BFB_POWERSHELL_CMD` dev hook 失败路径冒烟（GPO/AppLocker 不可模拟处注释说明） |
| 12 | P2 | Task5：失败计数跨会话持久（electron-store `_viewGateFailCount`）、1909 → 降级兜底 |
| 13 | P2 | Task3 CI 两态配置步骤显式化 |
| 14 | P2 | Task2 Step5 显式重写/删除 `tests/password-autofill-key-protection.test.ts` |
| 15 | P2 | safe-storage.ts 删除时注释随之消失；尾注记录与真机证伪的对应 |
| 16 | P2 | Task2 措辞统一"防文本直读，不防任何主动攻击者"，与规格对齐 |
| N1 | P0 | Task5 Files 补 `preload/index.ts`（白名单+pwd 绑定）/`electron.d.ts`（通道+方法类型）/`shared/types/passwords.ts`（结果类型），Task6 只消费就绪绑定 |
| N2 | P2 | Task2 IPC 草案显式注释"verify-view/set/clear-view-fallback 本 Task 不注册，Task5 同步 types 后注册" |
| N3 | P2 | 规格补丁时机定稿：评审轮已应用，Task1 期间独立 docs commit，Task2 开工前规格与计划 v2 对齐 |

## 尾注

- macOS darwin-keychain 与 view-gate mac 路径本机不可验 → experimental + 待 mac 真机补验（不阻塞主线）。
- Windows LogonUser 成功路径依赖本机账户密码 → 仅手动验证一次（Task6 门⑥）。
- CI ubuntu (a) 态 headless GNOME Keyring 若不可行 → 降级真机手动记录；(b) 态必须自动化。
- v1 `.legacy.bak` 由用户自行处置，应用不提供恢复入口（决策 8）。
- safe-storage.ts 旧注释"Electron 11 运行时 API 存在"为错误结论（真机探测 `undefined`），随文件删除消失（审计 #15）。
- **设计规格配套补丁（审计 #2/#9/#16/#10 的规格侧 + 审计 N3 定时机）：** §4 增 3 读函数 + `getDek` 行、§6 v2 schema 注 `viewFallback` 预留、§3/§6 C′ 措辞与搁置条件收紧 —— **已在评审轮应用**；作为独立 docs commit（`docs(spec): sync password v2 design`）在 Task 1 期间提交，**不并入 Task 1 代码改动**；Task 2 开工前规格必须已与计划 v2 对齐（若发现规格与计划不一致，先改规格再动代码）。
