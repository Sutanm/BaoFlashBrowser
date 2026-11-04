# 密钥失败路径加固实施计划（K1–K5）— 2026-09-21

> 关联规格：`docs/superpowers/specs/2026-09-21-keyring-failure-path-design.md`（决策 D1–D8，本文是其任务化）。
> 事故报告：`.workbuddy/memory/2026-09-21-password-vault-postmortem.md`。
> 既有主线计划：`docs/superpowers/plans/2026-09-03-auto-fill-keyring.md`（Task 3–7 未完成；本计划的 K 序列**插在其前面**，k 系列不改动其任务编号）。

**Goal:** 让"拿不到密钥"与"密钥损坏"分成两条语义完全不同的路径：前者**永不写盘**、可自愈；
后者保留文件、状态 `blocked`、只由用户显式决策重建。补上亲和标签、探测预算、状态暴露与
双护栏测试，使 09-20 那次超时不再产生任何不可逆后果。

**Hard Constraints（沿用 09-03 计划 + 本次新增）**
- 每个 Task 结束 `npm run typecheck` 必须 0 error；主进程 + IPC + preload + 类型 + 渲染层联动改动
  必须在同一 Task 内完成（禁止跨 Task 编译断裂）。
- **读路径零写盘**（D1）：任何 K 任务都不得在读取/解封失败时 rename / clear / set 密钥材料。
- 不改 OpenCV / 自动化 / 下载 / 用户脚本；不引入第三方加密依赖；不触碰 v1 数据处置（决策 8）。
- 探针必须落到 `tools/probe/probes/`（协议 `{id,name,needsElectron,timeoutMs,run(ctx)}`），
  且 **Electron 探针必须隔离 userData**（`tests/electron/isolate-user-data.cjs` 同款做法，
  绝不允许指向真实 `%APPDATA%\bao-flash-browser`）。
- 新增/改动字符串跑 `npm run i18n`；每 Task 独立中文 commit。

---

## 任务总览

| Task | 内容 | 依赖 | 验证门 | 可回退性 |
|------|------|------|--------|----------|
| K1 (P0) | 读路径零破坏 + 失败语义二分 | — | 门 K1 | 单 commit，无数据形态变更 → 直接 revert |
| K2 (P1) | `keyEncBackend` 亲和标签 + 历史密文只读试解 | K1 | 门 K2 | 附加字段，旧代码忽略 → revert 安全 |
| K3 (P1) | 探测 TTL + 预算放宽 + `ensureKeyLoaded()` 自愈 + 状态暴露 | K1,K2 | 门 K3 | 单 commit；新增通道可保留（无副作用） |
| K4 (P2) | 状态可见化（面板/设置页）+ 显式重建入口 | K3 | 门 K4 | 纯 UI/通道层 → revert 安全 |
| K5 (一次性) | 真机数据处置与旧数据找回 | — | 门 K5 | 不涉及仓库代码 |

**为什么 K1 单独先行**：K1 是唯一"停止流血"的改动 —— 不改它，下一次超时还会再丢一把 key。
K2–K4 都建立在"失败已不再破坏数据"这个前提上。

**与既有主线的关系**：查看密码（`password:reveal`）是 09-03 计划 Task 5/6 的未完成项，
**不是本次回归**。但顺序上有硬依赖：Task 5 接了 view-gate 之后才能解明文，而明文要能解出来
必须先有 K1–K3（DEK 可恢复）。建议顺序 **K1 → K2 → K3 → Task5 → Task6 → K4（K4 可与 Task5 并行）**。

---

## 实施记录（2026-09-21）

| 批次 | 状态 | commit | 验证 |
|------|------|--------|------|
| K1 读路径零破坏 + 失败二分 | ✅ 完成 | `901208e` | typecheck 三目标 0 error；lint 0 error；638 项单测通过 |
| K2 亲和标签 + 只读试解 | ✅ 完成 | `84a694d` | 同上 + 新增亲和 5 例；643 项 |
| K3 TTL/预算/自愈/状态暴露 | ✅ 完成 | `8d69df7` | typecheck/lint 0 error；649 项 |
| K4 状态可见化 + 重建入口 | ✅ 完成 | `7705a2a` | typecheck/lint 0 error；649 项；产物已重建并核对含新逻辑 |
| K5 真机数据处置 | ✅ 已完成 | — | 用户已通过密码本面板"重建密码本…"（敲 `REBUILD`）完成处置；库内现为 1 条真实条目，无遗留数据 |
| 探针 23（真机故障注入） | ⏳ 待补 | — | 需要为 password-store 增加可被 Electron 探针加载的 smoke 构件（新 build 脚本 + `scripts/smoke-bundles.cjs` 清单项），单独提交 |
| PasswordsPanel 三态渲染测试 | ✅ 已完成 | `b976a4d` | **2026-09-22 修正前提**：仓库 jsdom 基建不止覆盖 SettingsPanel（已有 `settings-panel.test.tsx` 等 7 个 `.tsx` 用例），ipc mock 与 i18n provider 包装的模板现成。落地于 `tests/passwords-panel-view-gate.test.tsx`（7 项，view-gate V4），并顺带查出两个渲染层缺陷（剩余次数被错误提示顶掉、倒计时基准陈旧）。 |

**落地时的两处偏差（相对上文任务书）**：
1. K1 的失败路径测试**并入** `tests/password-store-v2.test.ts`（而非新建
   `tests/password-keyring-failure-paths.test.ts`）：避免第二个 electron-store mock 漂移；
   keyring 侧分类矩阵另在 `tests/password-keyring.test.ts` 与 `tests/password-keyring-win.test.ts`。
2. K2 的亲和试解实现在 keyring 侧收敛为**单个** `keyringUnwrapAffine(blob, preferred)`
   ——试解顺序属于后端知识，放在 password-store 会让它知道后端 id 列表，mock 面也更大。
   相应测试落在 `tests/password-store-key-affinity.test.ts`（计划原文一致）。

**K1 顺带修正的"虚假信心测试"**：原 `password-store-v2.test.ts` 有一条用例断言
"OS unwrap 失败 → 文件搁置、DEK 不可用"，即把事故行为锁成了预期。已改为断言相反的不变式
（密钥材料原样保留、零写盘、状态 deterministic/transient）。这类测试与 c1b8d16 归档的
`tests/electron/userscripts/` 同源，值得作为一类问题继续普查。

---

### K1（P0）读路径零破坏 + 失败语义二分

**Files:**
- Modify `src/main/modules/keyring.ts` —— 新增 `KeyringFailureKind`，`keyringWrap/keyringUnwrap`
  返回 `{ ok:false; kind; reason; detail? }`；`resolveBackend`/各后端的 reason → kind 映射集中在一处
- Modify `src/main/modules/keyring-win-dpapi.ts` —— `classifyPsOutcome` 输出 kind
  （`no-powershell`→`spawn-failed`、`timeout`→`timeout`、`bad-response`→`protocol-error`、
  `empty-input`→`protocol-error`）；超时值改从 `BFB_KEYRING_TIMEOUT_MS` 读取（默认不变）。
  **`ps-error:*` 需按调用方向判定**：**unwrap** 方向 = 后端明确拒绝解密 → `decrypt-failed`；
  **wrap** 方向 = 环境/策略问题（Protect 失败，密文根本未生成）→ `backend-unavailable`（可重试）
- Modify `src/main/modules/password-store.ts` —— `_loadWrapKey`（L232-267）：
  **删除** L243-247 的 `_shelfFile` + `clear()` 分支与 L249-254 的长度不符搁置分支；
  改为返回 `{ key: Buffer|null; outcome: 'ok'|'transient'|'deterministic'; reason; backend }`；
  `_loadDekFromStore`（L308-318）据此维护模块级 `_keyStatus` / `_keyIssue`
  （本 Task 先只做内部状态 + 日志，IPC 暴露留 K3）
- Modify `tests/password-store-v2.test.ts` —— mock keyring（L34-47）返回带 kind 的结构；
  新增用例"unwrap 失败后 key 文件与 store 内容零变化"
- Add `tests/password-keyring-failure-paths.test.ts` —— 分类矩阵 + 零写盘断言
- Modify `tests/password-keyring.test.ts`、`tests/password-keyring-win.test.ts` —— 适配返回结构

**Interfaces（草案）:**
```ts
// keyring.ts
export type KeyringFailureKind =
  | 'backend-unavailable' | 'timeout' | 'spawn-failed' | 'protocol-error' | 'decrypt-failed';
export type KeyringUnwrapResult =
  | { ok: true; secret: string }
  | { ok: false; kind: KeyringFailureKind; reason: string; detail?: string };

// password-store.ts（内部）
type KeyLoadOutcome = { outcome: 'ok' | 'transient' | 'deterministic'; reason?: string; backend?: string | null };
```

**Steps:**
- [ ] Step 1: `keyring.ts` kind 类型 + 映射表 + 两处返回结构改造（不改探测逻辑，K3 再动缓存）。
- [ ] Step 2: `keyring-win-dpapi.ts` 分类输出 kind；超时读环境覆盖（失败路径冒烟用）。
- [ ] Step 3: `password-store._loadWrapKey` 去破坏性分支；失败只返回 outcome，日志带 reason 与 backend；
      `_loadDekFromStore` 记录 `_keyStatus`；`isDekReady()` 语义不变。
- [ ] Step 4: 测试适配 + 新增零写盘断言（在 mock store 的 `set/clear` 上计数）。
- [ ] 门 K1：`npm run typecheck` 0 error；`npm test -- --run` 全绿；
      新用例断言"transient / deterministic 失败后 `password-autofill-key.json` 与
      `password-store.json` 的写入次数为 0，文件未被 rename"。

**验收锚点（回归防线）**：把 `tests/password-store-v2.test.ts` 里 fake 后端改成返回
`{ ok:false, kind:'timeout' }`，断言**不出现任何 `clear()` 调用** —— 这正是 09-20 事故的最小复现。

---

### K2（P1）`keyEncBackend` 亲和标签 + 历史密文只读试解

**Files:**
- Modify `src/main/modules/keyring.ts` —— 导出 `listCandidateBackends(platform)`（用于只读试解）
- Modify `src/main/modules/password-store.ts` —— `AutoFillKeySchema`（L56-62）增
  `keyEncBackend: KeyringBackendId | 'local' | null`（defaults 加 null）；
  `_persistWrapKey`（L217-229）写标签；`_loadWrapKey` 走亲和优先 + 未带标签候选试解；
  试解成功即回写标签（这是**成功路径**的写，允许）
- Add `tests/password-store-key-affinity.test.ts`
- Modify `tests/password-store-v2.test.ts`（schema 断言）

**Interfaces（草案）:**
```ts
// keyEncBackend 取值：'electron-safestorage' | 'win-dpapi' | 'linux-secret-service' | 'darwin-keychain' | 'local' | null
// 读取顺序：标签后端 → （标签为空时）候选只读试解（≤2）→ 全失败 = decrypt-failed
```

**Steps:**
- [ ] Step 1: schema + 写入路径带标签（含 C′ 写 `'local'`）。
- [ ] Step 2: 读取路径亲和优先；标签后端不可用 → `backend-unavailable`（transient，不试解、不写盘）。
- [ ] Step 3: 空标签走候选只读试解（每候选不写盘，成功后才回写标签）；全失败 → `decrypt-failed`。
- [ ] Step 4: 测试（四态：亲和命中 / 标签后端缺失 / 空标签试解成功 / 全失败保留文件）。
- [ ] 门 K2：typecheck + unit 绿；"空标签 + 第一候选能解"用例断言标签被回写为正确后端 id；
      "标签后端缺失"用例断言零写盘。

**兼容性**：新增字段是附加项，旧代码 `get('keyEnc')` 行为不变（electron-store 不校验未声明键）。
当前真机 `.legacy.bak` 正是"空标签"形态，因此本 Task 结束后即可用它做一次恢复验证（见 K5）。

---

### K3（P1）探测 TTL + 预算放宽 + `ensureKeyLoaded()` 自愈 + 状态暴露

**Files:**
- Modify `src/main/modules/keyring.ts` —— `detectKeyring()`（L144-155）：失败结果 TTL 缓存
  （15s，`KEYRING_FAILURE_TTL_MS` 可覆盖），新增并导出 `invalidateKeyring()`；
  **读路径不再调用往返探针**（有标签直接 unwrap）；探针只在 enroll 前执行
- Modify `src/main/modules/keyring-win-dpapi.ts` —— 默认预算 probe 25s / wrap 20s / unwrap 25s
- Modify `src/main/modules/password-store.ts` —— 新增导出 `ensureKeyLoaded()`（幂等 / in-flight 去重 /
  退避重试 0·3s·10s·30s，定时器 `unref()`，`dispose()` 清理）、`getKeyStatus()`；
  `init()` 改为调 `ensureKeyLoaded()`；`toggleEnabled` / `setAutoFill` 的 `_loadDekFromStore` 调用点同步
- Modify `src/main/ipc/password.ipc.ts` —— `password:status` 增 `keyStatus` / `keyIssue`；
  新增 `password:retry-key`（无参 `createHandler`：`invalidateKeyring()` → `ensureKeyLoaded()` → 返回状态）
- Modify `src/shared/types/passwords.ts` —— `PasswordStoreStatus` 增 `keyStatus` / `keyIssue`
  （结构见规格 D7）；新增 `KeyRetryResult`
- Modify `src/preload/index.ts` —— 白名单（L24-27）加 `password:retry-key`；`pwd` 绑定（L134-149）加 `retryKey`
- Modify `src/renderer/types/electron.d.ts` —— 通道 + `pwd.retryKey` 类型
- Modify `src/main/modules/tabs.ts` —— `OptionalTabServices.passwords`（L10-27）加 `ensureKeyLoaded?(): Promise<void>`；
  `_attemptPasswordFill`（L651-661）与 `fillPassword`（L688-697）在取凭据前 `await` 它
- Modify `src/main/index.ts`（L142-148）—— 装配处传递 `ensureKeyLoaded`
- Add `tools/probe/probes/23-keyring-failure-survival.cjs`

**Interfaces（草案）:**
```ts
export type PasswordKeyStatus = 'ok' | 'loading' | 'retrying' | 'blocked';
export interface KeyPasswordIssue {
  kind: 'transient' | 'deterministic';
  reason: string;
  backend?: string | null;
  attempts: number;
  nextRetryInMs?: number;
  hint?: 'wait' | 'rebuild' | 'no-backend';
}
export function getKeyStatus(): { status: PasswordKeyStatus; issue?: KeyPasswordIssue };
export async function ensureKeyLoaded(): Promise<{ status: PasswordKeyStatus; issue?: KeyPasswordIssue }>;
```
`getFillCredentialForUrl` / `addEntry` 等**同步签名不变**（触发点放在调用之前），把波及面限制在 tabs/IPC 两处。

**Steps:**
- [ ] Step 1: keyring 侧 TTL + invalidate + 探针移出读路径 + 预算放宽（含环境覆盖）。
- [ ] Step 2: `ensureKeyLoaded()` + 退避重试 + 状态机（含 `dispose()` / 关闭开关时清表）。
- [ ] Step 3: IPC/preload/d.ts/shared types 同步（`status` 增字段、`password:retry-key`）。
- [ ] Step 4: 填充/保存触发点接线（tabs + save-confirm 前 await）。
- [ ] Step 5: 启动日志（`key loaded ... took=` / `key unavailable kind=... attempt i/4`）。
- [ ] Step 6: 探针 23 —— 真 Electron + **隔离 userData** + `BFB_POWERSHELL_CMD` 指向
      "首轮 sleep > 超时、次轮正常"的 ASCII shim；断言：首轮后 key 文件字节不变、
      `keyStatus` 从 `retrying` 收敛到 `ok`、DEK 就绪。
- [ ] 门 K3：typecheck + unit 绿；`npm run probe:deep` 含 23 通过；
      单测断言"用尽 4 次自动重试即停表、后续按需触发仍可成功"。

---

### K4（P2）密钥状态可见化 + 显式重建入口

**Files:**
- Modify `src/main/ipc/password.ipc.ts` —— 新增 `password:rebuild-vault`
  （`createValidatedHandler`，schema `z.object({ confirm: z.literal('REBUILD') }).strict()`）：
  `resetAll()` → `initVault()` → `notifyPasswordChanged()` → 返回状态
- Modify `src/preload/index.ts`、`src/renderer/types/electron.d.ts` —— `pwd.rebuildVault(confirm)`
- Modify `src/shared/types/passwords.ts` —— `RebuildVaultResult`
- Modify `src/renderer/components/panels/PasswordsPanel.tsx` —— `keyStatus` 三态渲染：
  `blocked` 横幅（原因 + 「重试」+「重建密码本…」危险按钮，需输入确认词）、
  `retrying` 细字提示、档位徽标仅在 `ok` 时显示；`handleInit` 失败提示改为携带 reason
- Modify `src/renderer/components/panels/SettingsPanel.tsx` —— 隐私区增加一行密钥状态（读 `status.keyIssue`）
- Modify i18n（`zh-CN` / `en`）+ `npm run i18n`
- Add `tests/password-panel-key-status.test.tsx`（若面板测试基建支持；否则降级为纯函数渲染断言）

**Steps:**
- [ ] Step 1: IPC + preload/types（重建通道，确认词强校验）。
- [ ] Step 2: 面板三态 + 重试/重建交互（重建二次确认，文案明示"将丢弃当前密钥与条目"）。
- [ ] Step 3: 设置页状态行 + i18n + `npm run i18n`。
- [ ] Step 4: 测试（`blocked`/`retrying`/`ok` 三态渲染；`confirm` 缺失时 IPC 拒绝）。
- [ ] 门 K4：typecheck 0 / lint 0 / unit 绿；手动核对 blocked 态下按钮可达且重建走确认词。

**为什么不把重建做成"自动降级"**：轮换 = 丢弃所有条目，属产品级不可逆操作，必须由人显式确认
（规格 Q2/Q3 待拍板确认形式）。

---

### K5（一次性）真机数据处置

**不入库代码**（避免仓库内出现"解密用户密钥文件"的工具）。流程写入
`.workbuddy/memory/2026-09-21-password-vault-postmortem.md` 尾注，由用户在其终端执行或授权我执行。

- [ ] Step 0: 备份（**已完成**）：4 个文件已拷至 `%TEMP%\bao-diag\backup`
      （`password-autofill-key.json`、`.legacy.bak`、`password-store.json`、`password-store.json.legacy.bak`）。
      建议用户再拷一份到持久目录（`%TEMP%` 会被清理）。
- [ ] Step 1: 二选一处置
      - (a) **重建（推荐，当前 `entries: []`，零数据损失）**：面板「重建密码本」或直接删除
        `password-autofill-key.json` + `password-store.json` 后走 `password:init`。
      - (b) **保留 DEK**：用 DPAPI（CurrentUser / 无 entropy）解 `.legacy.bak.keyEnc` → 32B wrap key
        → 以 `password-autofill-key.json` 的 `keyEnc` + `keyEncBackend: 'win-dpapi'` 写回
        → 启动验证 `dekAutoFillEnc` 能解出 32B DEK（**该路径已于 09-21 实测成功**）。
- [ ] Step 2: 可选 —— v1 单条找回（`web.7k7k.com` / `q379630001`）需旧主密码：
      离线用 PBKDF2(250k, SHA-256, salt) → KEK → 解 `dekMasterEnc` → 解条目 `passwordEnc`。
      salt/dekMasterEnc 均在 `password-store.json.legacy.bak` 内；不做则按决策 8 放弃。
- [ ] 门 K5：处置后应用启动日志出现 `[password-store] key loaded tier=A backend=win-dpapi`
      且 `password:status` 返回 `keyStatus:'ok'`、`autoFillReady:true`（K3 落地后）。

---

## 验证矩阵（汇总）

| 层 | 落点 | 断言 |
|----|------|------|
| unit | `tests/password-keyring-failure-paths.test.ts` | kind 映射矩阵；失败零写盘；TTL 到期可重试 |
| unit | `tests/password-store-key-affinity.test.ts` | 亲和命中 / 标签后端缺失 / 空标签试解回写 / 全失败保留 |
| unit | `tests/password-store-v2.test.ts`（改） | 成功路径行为回归不变；失败路径 0 次写入 |
| unit | `tests/password-store-key-guard.test.ts`（可选 D8） | `_shelfFile(` 调用点白名单 |
| unit | `tests/password-panel-key-status.test.tsx` | 三态渲染 + 重建确认词 |
| probe | `tools/probe/probes/23-keyring-failure-survival.cjs` | 真机故障注入：首轮 timeout 不破坏，次轮自愈 |
| probe | `tools/probe/probes/20-keyring-dpapi.cjs`（既有） | 改造后仍往返 OK |
| 手动 | 真机慢启动一次 | 日志无 `rotating wrap key`；面板 blocked/retrying 文案正确 |

## 提交与批次

| 批次 | commit message（中文） | 门禁 |
|------|------------------------|------|
| K1 | `fix(password): 读路径零破坏——密钥解封失败不再搁置轮换` | typecheck + unit |
| K2 | `feat(password): keyEnc 后端亲和标签与历史密文只读试解` | typecheck + unit |
| K3 | `feat(password): 密钥惰性自愈（探测 TTL/预算/退避重试）与状态暴露` | typecheck + unit + probe:deep |
| K4 | `feat(password): 密码本密钥状态可见化与显式重建入口` | typecheck + lint + unit |
| 收口 | `docs(password): 密钥失败路径规格增量与事故报告` | — |

K1 与 K2 建议**分开提交**：K1 是可立即止血的最小改动，K2 引入新字段，混在一起会掩盖
"不破坏"这条不变式的独立可验证性（用户可只 cherry-pick K1 上线）。

## 本次明确不做

- view-gate / reveal 接线（既有计划 Task 5/6，依赖 K1–K3 完成后做）。
- `keyEscrowLocal`（enroll 时额外写 C′ 副本做离线恢复）—— 规格 D 段"可选决策点"，
  **默认关**，需用户单独拍板，不并入本次批次。
- 任何对 C′ 混淆算法、档位定义、v2 数据形态字段的改动（`keyEncBackend` 除外）。
- v1 数据迁移（决策 8 不变）。
