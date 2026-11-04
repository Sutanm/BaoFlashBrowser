# 密钥失败路径设计（规格增量）— 2026-09-21

> 关系：本文件是 `2026-09-03-auto-fill-keyring-design.md`（决策 1–9 定稿）的**增量规格**，
> 起因是 2026-09-21 的密码本全面失灵事故（详见
> `docs/../.workbuddy/memory/2026-09-21-password-vault-postmortem.md`）。
> 本文只补"密钥获取失败时怎么办"这一段语义，档位/数据形态/查看门禁仍以 09-03 规格为准。
> 实施任务见 `docs/superpowers/plans/2026-09-21-keyring-failure-path.md`。

## 背景与问题

09-03 规格定义了成功路径（A 档 keyring / C′ 本地弱保护）与档位选择，但**没有定义失败路径**。
实现自行补了一段："keyringUnwrap 失败 → 视为后端失配 → 搁置并轮换 wrap key"
（`src/main/modules/password-store.ts:242-247`）。这段补丁在 2026-09-20 15:02 把一把
**瞬时超时**（`reason=timeout`，DPAPI 探测在启动风暴下被打爆）当成永久失配，
把唯一的 wrap key 文件搁置清空，导致 DEK 永久不可解 —— 三个功能同时失效且全程静默。

一句话：**规格缺失处，实现选了唯一不可逆的那个选项。**

## 范围界定

**纳入**
- 密钥材料（wrap key / DEK）在读取路径失败时的语义：分类、保留、重试、可见性。
- `keyEnc` 的**后端亲和标签**（消除"解不开 = 损坏"的歧义）。
- 探测缓存策略、子进程超时预算、惰性重试入口。
- 状态暴露（IPC 字段 + 面板/设置页可见化）与重建库的**显式**入口。
- 可观测性（启动日志、真机故障注入探针）。

**不纳入（本次不动）**
- 档位定义、C′ 混淆算法、v2 数据形态字段（除新增 `keyEncBackend`）。
- view-gate / reveal（属 09-03 计划的 Task 5/6，本文件只声明依赖）。
- 自动化 / OpenCV / 下载 / 用户脚本；不引入任何第三方加密依赖。
- 存量 v1 数据处置（决策 8 不变：搁置不迁移）。

## 事故证据（摘要，全文见 postmortem）

```
[2026-09-20 15:02:03.308] [warn]  [Window] ready-to-show timed out after 8000ms
[2026-09-20 15:02:13.641] [info]  [keyring] no OS backend available (reason=timeout)
[2026-09-20 15:02:13.642] [warn]  [password-store] OS-keyring unwrap failed, rotating wrap key: timeout
[2026-09-20 15:02:13.643] [warn]  [password-store] legacy data shelved: ...password-autofill-key.json.legacy.bak
```

- 同一启动内 OpenCV 预热 10312ms、OCR 预热 11514ms —— 主进程/子进程 CPU 饱和，
  冷启动 PowerShell 的 10s 预算必被击穿。
- 实测：被搁置的密文用当前 DPAPI 后端**可以正常解开**（32B wrap key → 解封 `dekAutoFillEnc`
  得 32B DEK）。**密钥从未真正失效，是代码把它扔了。**
- 失败全程无任何用户可见信号；UI 上 `initialized=true` 且角标显示"A 档"，
  用户唯一感知是"功能突然不能用"。

## 设计原则（本文定稿）

### D1（P0）读路径零破坏

**任何读取/解封路径不得写盘、改名、清空密钥材料。** `_shelfFile()` 与 `store.clear()`
只允许出现在两类显式路径：

1. enroll：`initVault()` 首次建库、用户显式"重建密码本"；
2. 旧明文 key 迁移：`password-autofill-key.json` 中检出非空 `key`/`keyPlain`（决策 8：搁置不读）。

理由：读路径拿到的错误信息，不足以区分"这把 key 永久作废"与"这一刻拿不到"；
而这两个分支的正确处置截然相反（后者绝不能动文件）。自动轮换即等于**丢弃全部条目**，
这是产品级不可逆操作，不能由一次超时触发。

被否方案：保留自动轮换 + 加强日志/告警 —— 不解决数据不可逆丢失，只是让丢失更可查。

### D2 失败语义二分：transient / deterministic

`keyringUnwrap` / `keyringWrap` 返回值从 `{ ok, reason }` 升级为
`{ ok, kind, reason, detail? }`，`kind: KeyringFailureKind`：

| kind | 触发条件（当前后端映射） | 语义 | 处置 |
|------|--------------------------|------|------|
| `backend-unavailable` | 探测未通过 / 无候选后端 / 平台不支持 | transient | 保留文件 · 状态 `retrying` · 退避重试 |
| `timeout` | 子进程超预算被 kill | transient | 同上 |
| `spawn-failed` | `no-powershell` / ENOENT / EPERM | transient（策略长期拦截则表现为持续 retrying） | 同上 |
| `protocol-error` | `bad-response` / `probe-mismatch`（子进程被干扰、输出被截断） | transient | 同上 |
| `decrypt-failed` | 后端明确拒绝解密（DPAPI `Unprotect` 报错、safeStorage 前缀不符） | deterministic | 保留文件 · 状态 `blocked` · 等用户决策 |
| `corrupt-local`（C′ 侧） | `keyLocal` 反混淆失败 / 长度不符 | deterministic | 保留文件 · 状态 `blocked` |

方向敏感：同一底层错误在 **wrap** 与 **unwrap** 方向语义不同。`ps-error:*` 在 unwrap 方向
（密文已存在、后端说解不开）是 `decrypt-failed`；在 wrap 方向（密文根本没生成，多为策略/环境
问题）是 `backend-unavailable`，可重试而无需用户介入。

**decrypt-failed 不得触发任何自动动作**：不轮换、不降级、不清理。UI 给两条路：
「重试」与「重建密码本（危险，需确认词）」。

被否方案：重试 N 次后自动轮换 —— 重试次数与"密文是否真的坏"无关，一次网络/AV/负载
抖动就可能耗尽 N 次，仍是不可逆丢失。

### D3 档位不可降级（A → C′ 在密码学上不成立）

C′ 需要 wrap key **明文**才能落盘，而该明文只能由 A 档后端解出。因此：

- A 档读不到 ⇒ 不能"降级到 C′ 继续用"；唯一出路是等后端恢复（transient）或用户显式重建（deterministic）。
- C′ 档读不到 ⇒ keyLocal 是自包含的，无外部依赖，失败即真损坏。

派生要求：**failure 必须可见**（当前完全静默），且必须给用户自助出口（见 D7/D8）。

### D4 后端亲和标签（消除"解不开 = 损坏"歧义）

`password-autofill-key.json` 新增 `keyEncBackend: KeyringBackendId | 'local' | null`：

- enroll 时与 keyEnc 同时写入（`_persistWrapKey`）；重建时同步刷新。
- 读取时优先用**亲和后端**解封；带标签但该后端在本机不可用 ⇒ `backend-unavailable`
  （transient，**不是**损坏）。
- **未带标签的历史密文**（09-03~09-21 之间的裸 base64，含当前真机 `.legacy.bak`）：
  按"未知亲和"逐个候选后端**只读试解**（上限 2 个候选，不落盘），成功即以正确标签回写；
  全部失败 ⇒ `decrypt-failed`（deterministic，保留文件）。
- 标签与后端实际能力不符 ⇒ 明确报错，不再表现为"随机解不开"。

### D5 探测与预算

- `detectKeyring()`：成功结果进程级缓存；失败结果改为 **TTL 缓存（15s）** 并导出
  `invalidateKeyring()` 供重试路径调用（生产链路必须有调用点，不再只有单测在用）。
- **读路径不再依赖往返探针**：有亲和标签时直接 unwrap（unwrap 本身就是最强探针）；
  往返探针只在 **enroll（写）之前**执行，避免写出一把当前后端解不开的 key。
- 预算调整：`unwrap 25s` / `wrap 20s` / `enroll 探针 25s`（原 10/15s 在启动风暴下已被实测击穿）；
  `BFB_KEYRING_TIMEOUT_MS` 环境变量可覆盖，供故障注入探针使用。

### D6 惰性兜底与自愈

`password-store` 抽出 `ensureKeyLoaded(): Promise<KeyLoadOutcome>`（幂等 / 可重入 /
in-flight 去重），调用点：

1. 启动 `init()` 一次（不阻塞首屏，失败不影响启动）；
2. 自动重试定时器：0 / 3s / 10s / 30s（共 4 次，全部用 `unref()`，`dispose()` 清理）；
3. 按需触发：`tabs._attemptPasswordFill` 填充前、`password:save-confirm` 保存前、
   面板打开、用户点「重试」。

任一成功 ⇒ `keyStatus='ok'`，取消定时器，停表。自动重试用尽后不再自行重试，
只保留按需触发（避免常驻定时器）。

### D7 状态暴露与可见化（IPC + UI）

`PasswordStoreStatus` 增量：

```ts
keyStatus: 'ok' | 'loading' | 'retrying' | 'blocked';
keyIssue?: {
  kind: 'transient' | 'deterministic';
  reason: string;            // 归一化机器码，如 'timeout' / 'decrypt-failed'
  backend?: string | null;   // 实际使用的后端（或 null）
  attempts: number;
  nextRetryInMs?: number;
  hint?: 'wait' | 'rebuild' | 'no-backend';
};
```

- 面板：`blocked` → 横幅（原因 + 「重试」+「重建密码本…」危险按钮，需输入确认词）；
  `retrying` → 细字提示"密钥暂不可用，正在重试（第 N 次）"；`ok` → 现状不变。
- 只有 `initialized === true && keyStatus === 'ok'` 才显示 A/C′ 档位徽标；
  否则显示"密钥不可用"，避免 09-20 那种"显示 A 档但什么都做不了"的误导。
- 启动日志：成功 `[password-store] key loaded tier=A backend=win-dpapi took=340ms`；
  失败 `[password-store] key unavailable kind=timeout (attempt 1/4, next retry in 3s)`。

### D8 结构性护栏

- **单测级**：在 mock store 上记录全部 `set/clear/rename` 调用，断言 transient 与
  deterministic 失败路径的写入次数为 **0**（比字符串 grep 更硬，直接锁住 D1）。
- **源码级**（沿用 `tests/module-boundaries.test.ts` 风格）：`_shelfFile(` 的调用点必须落在
  显式白名单（enroll / 旧明文迁移）内，新增调用点即测试失败。

## 状态机

```
                 ┌──────────── init() / ensureKeyLoaded() ────────────┐
                 ▼                                                    │
  [uninitialized] ──initVault()──► [loading] ──成功──► [ok]            │
                                     │  transient                      │
                                     ├────────► [retrying] ──成功──────┘
                                     │              │ 用尽 4 次 / 确定性失败
                                     │              ▼
                                     │          [blocked] ──「重试」──► [loading]
                                     └─────────────────────┴──「重建密码本」──► [uninitialized] ─► initVault
```

不变式：
- `retrying` / `blocked` 期间 **keyEnc 文件与 store 内容字节不变**（D1/D8 单测守卫）。
- 只有 `[ok]` 允许 `getFillCredentialForUrl` / `addEntry` 返回真实数据；
  其余状态返回 null / `'Password store not ready'`（现状守卫保留，只是现在有正确的原因可见）。

## 安全分析（增量）

- 本设计**不降低**任何档位强度：A 档仍是 A 档，C′ 仍是 C′，无跨档写入。
- 唯一新增的密文读取行为是"未知亲和的只读试解"（D4），它只读、只在内存、失败不落盘。
- **可选决策点（需用户拍板）`keyEscrowLocal`**：enroll 时额外写一份 C′ 混淆副本作为离线恢复备份
  （默认**关**）。收益：OS 后端长期不可用时仍可自愈；代价：把 A 档的实际强度拉回 C′
  （能读盘的攻击者可解）。**推荐保持关闭** —— 本次事故的正确修法是"不破坏"而非"多存一份弱副本"。

## 决策记录与待拍板点

| # | 决策 | 状态 |
|---|------|------|
| D1 | 读路径零破坏（本次事故根因修复） | 本文定稿，待用户批准实施 |
| D2 | transient / deterministic 二分，deterministic 不自动处置 | 同上 |
| D3 | A → C′ 不可降级；failure 必须可见 | 同上 |
| D4 | `keyEncBackend` 亲和标签 + 历史密文只读试解 | 同上 |
| D5 | 失败 TTL 缓存 + 探针移出读路径 + 预算放宽 | 同上 |
| D6 | `ensureKeyLoaded()` 惰性可自愈 | 同上 |
| D7 | `keyStatus` / `keyIssue` 状态暴露与可见化 | 同上 |
| D8 | 写入次数断言 + 源码白名单守卫 | 同上 |
| Q1 | `keyEscrowLocal` 默认关，是否接受？（若开，需设置页显式开关 + 风险文案） | **已拍板（2026-09-21）：默认关闭，不实现** |
| Q2 | deterministic 失败后只给「重试 / 重建」两条路，不提供任何自动降级 | **已拍板（2026-09-21）：接受** |
| Q3 | 重建库的确认方式：输入确认词（推荐）还是二次弹窗 | **已拍板（2026-09-21）：输入确认词 `REBUILD`** |

## 与 09-03 规格的关系（patch 清单）

| 09-03 规格位置 | 增量 |
|----------------|------|
| §1 `KeyringBackend` 接口 | 返回值加 `kind`；探测失败可重试（TTL）；探针不再参与读路径 |
| §3 C′ 落盘 | `keyLocal` 反混淆失败 → `blocked`（deterministic），不再静默返回 null |
| §4 password-store 接入 | 新增 `ensureKeyLoaded()`、`keyStatus`；`_loadWrapKey` 去掉搁置/清空 |
| §6 数据形态 v2 | `password-autofill-key.json` 增 `keyEncBackend`（附加字段，不破坏现有文件） |
| §7 状态暴露 | `PasswordStoreStatus` 增 `keyStatus` / `keyIssue`；新增 `password:retry-key` / `password:rebuild-vault` |
| §风险 / §测试计划 | 补"失败路径不销毁"回归测试与真机故障注入探针（`23-keyring-failure-survival`） |

## 测试计划（增量）

| 层 | 手段 | 断言 |
|----|------|------|
| unit | `tests/password-keyring-failure-paths.test.ts` | transient/deterministic 分类正确；失败路径写入次数 = 0；TTL 到期后可重试成功 |
| unit | `tests/password-store-key-affinity.test.ts` | 带标签走亲和后端；标签后端缺失 → `backend-unavailable` 且零写盘；无标签试解成功 → 回写标签 |
| unit | `tests/password-store-v2.test.ts`（改） | 既有 v2 生命周期在失败路径改造后行为不变（成功路径回归） |
| unit | `tests/password-store-key-guard.test.ts`（新，D8） | `_shelfFile(` 调用点白名单 |
| probe | `tools/probe/probes/23-keyring-failure-survival.cjs` | 真 Electron + **隔离 userData** + `BFB_POWERSHELL_CMD` 指向"先慢后快"shim：首轮 timeout 后 key 文件字节不变，二次启动成功加载 |
| 真机 | 一次手动 | 慢启动场景下不出现"rotating wrap key"；面板在 blocked/retrying 下文案与按钮正确 |

## 风险

| 风险 | 缓解 |
|------|------|
| 重试定时器与进程退出竞态 | 全部 `unref()`；`dispose()` / `window-all-closed` 清理 |
| 修好后仍有人写出破坏性路径 | D8 双护栏（写入次数断言 + 源码白名单） |
| Windows 真机无法离线复现 09-20 场景 | 探针用 `BFB_POWERSHELL_CMD` shim 注入同形态失败（首轮慢→超时） |
| 历史裸 base64 密文试解失败被误判损坏 | 归入 `decrypt-failed` 且保留文件，UI 提示"可重试/可重建"，不自动动作 |
