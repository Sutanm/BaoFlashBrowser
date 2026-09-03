# Auto-fill 免解锁跨平台密钥后端设计（keyring 抽象 + A/C′ 双档 + OS 查看门禁）

- 日期：2026-09-03
- 状态：已评审（决策 1–8 全部定稿，待写实现计划）
- 目标作者：密码模块 / 主进程适配层
- 相关测量 / 实证：
  - 提交 `1346ab1`（9-01）引入 safeStorage 加密 auto-fill key，并规定"safeStorage 不可用时拒绝写入"。
  - 实测项目自带 Electron 11.5.0 真机：`require('electron').safeStorage === undefined`；官方 release notes 确认 safeStorage 字符串加密 API 为 **Electron 15.0.0** 才加入 → 1346ab1 在 Win/macOS/Linux 任何真机都恒走"不可用"分支。
  - 实测 Electron 11.5.0：`systemPreferences.setPassword/getPassword/deletePassword` 不存在 → 版本上无任何官方 OS 凭据封装。
  - 平台事实：Windows DPAPI / macOS Keychain / Linux 密码环（GNOME Keyring、KDE KWallet）均在登录会话内对应用透明解锁（Windows/macOS 登录即用；Linux 经 PAM 用登录密码自动解锁钥匙串）——**存取层三平台都不弹窗**。
  - Chrome/Edge "查看密码弹系统登录密码" 是浏览器**自加的二次身份确认**（Windows 用 `LogonUser`、macOS 用 LocalAuthentication），不是 OS 存储要求；Chromium 在 Linux **不加这道确认**（登录已解锁钥匙串即视为身份已验）。

## 背景与问题

密码本条目加密自研且正确（`crypto-helper.ts`：AES-256-GCM + authTag，iv12）。auto-fill 免解锁需要一把 wrap `key`：用它把 DEK 包成 `dekAutoFillEnc` 落盘，之后在无任何用户输入的情况下也能解开 DEK 去填充表单。

旧实现把这把 `key` **明文**放进 `password-autofill-key.json`；`1346ab1` 试图改为 safeStorage 加密后落盘，但：

1. **依赖了 Electron 11 上不存在的 API**（safeStorage 是 Electron 15 才有）→ 功能整体失效：每次填充都要主密码解锁。
2. **迁移字段名对不上**：旧明文 key 实际字段是 `key`，迁移逻辑读 `keyPlain`，永远迁不动。
3. 测试只跑过"不可用"分支（纯 Node 下 `require('electron')` 返回路径字符串），从未验证真机"可用"分支。

**产品硬性要求（评审决策 3、6、7）**：
- 密码自动填充**在任何平台、任何会话都不要求任何密码输入**（对齐 Chrome/Edge）。
- **不做应用主密码**：查看密码门禁 = OS 登录验证（类 Chrome），无 OS 通道的 C′ 环境提供**可选兜底查看密码（默认关）**。
- **不做存量兼容（决策 8）**：不提供旧格式（v1 密码本、旧明文 key 文件）的读取/迁移；发现旧文件仅非破坏性搁置（改名保留），数据形态全新起步。

密码学约束：免输入的前提 = 无任何用户输入的任意时刻系统都能取到 wrap key → 只可能来自 OS 密钥库（A 档）或本地弱保护落盘（C′ 档）。数据形态 **v2（无主密码）**：DEK 仅由 auto-fill wrap key 保管，无主密码链。

## 范围界定

本次改造范围：

- 新增 `src/main/modules/keyring.ts`（跨平台 OS 密钥后端抽象）。
- 平台后端：Windows DPAPI（PowerShell/.NET `ProtectedData` 子进程）、Linux `secret-tool`、macOS `security` CLI、预留 Electron ≥15 `safeStorage` 优先分支。
- `password-store.ts`：数据形态 v2（无主密码）+ A/C′ 双档 + C′ 本地弱保护落盘；旧文件搁置处理。
- 新增查看门禁 `view-gate.ts`：Windows `LogonUser` 校验、macOS login keychain 解锁校验（experimental）、Linux C′ 可选兜底查看密码（默认关）。
- 随主密码退役清理：解锁/锁定相关 IPC、状态与 UI（`password:unlock`/`lock`、锁屏态文案等）；auto-fill 状态 IPC 扩展档位字段。
- 设置页文案与 i18n（`zh-CN`/`en`）。
- 单元测试 + Windows DPAPI/LogonUser 子进程冒烟。

明确不动 / 不做：

- **不触碰 OpenCV / 视觉模块**（`src/main/modules/automation/`、vision-worker 等）。
- 不改条目加密算法与参数；PBKDF2 仅用于 C′ 可选兜底密码的哈希校验。
- 不新增任何第三方运行时依赖（keytar/@napi-rs/keyring 不引入）。
- 不改变 BrowserView / Ruffle / PPAPI 任何行为。
- **不做 v1 读取、不做 v1→v2 迁移、不做旧明文 key 迁移**（决策 8）；旧格式文件一律搁置不读。
- B 档（会话级内存 key）、C 档（知情明文开关）已否决，不实现。

## 现状（探索确认）

| 项 | 现状 |
|----|------|
| 加密工具 | `crypto-helper.ts` 纯 Node `crypto`；PBKDF2_ITER=250000、SALT_LEN=16、KEY_LEN=32、IV_LEN=12、AES-256-GCM + authTag |
| safeStorage 适配层 | `src/main/utils/safe-storage.ts`（注释称 Electron 11 运行时存在 —— 已被真机探测证伪） |
| auto-fill key 落盘 | `password-autofill-key.json`（electron-store），schema `{keyEnc, keyPlain}`，字段名与历史不符 |
| 免密链路 | `password-store.ts`：`_ensureAutoFillWrap` → `dekAutoFillEnc = encryptBuf(key, dek)`；`_loadAutoFillDek` 启动解出 `_dekForAutoFill` |
| 数据形态 | v1：`{version:1, salt, dekMasterEnc, entries[], dekAutoFillEnc}`；存在解锁/锁定状态机 |
| 渲染层 | `SettingsPanel.tsx` auto-fill 开关（`autoFill`/`autoFillReady`）；i18n 已有 `autoFill`/`autoFillHint`/`autoFillNeedsUnlock` |
| 打包目标 | win64/win32/linux（正式）；macOS experimental |
| 第三方依赖 | 无加密相关依赖；Electron 11.5.0（锁死，PPAPI Flash 原因） |

## 设计原则（本次讨论定稿）

1. **填充永不弹任何密码框（第一原则）。** 任何平台、任何会话，检测到登录表单直接填充；"查看密码"门禁按平台挂 OS 登录验证。
2. **OS 密钥库是主用档位，不是唯一档位。** 探测到可用 OS 密钥库 → 档位 A（真加密）；探测不到 → **档位 C′ 本地弱保护自动兜底**。二者都满足"永不因填充解锁"。
3. **探测失败是既定路径，不是错误分支。** 无 secret-tool、守护没跑、容器/Flatpak/Snap、服务器 → 自动落 C′。
4. **绝不静默。** 设置页明示当前档位与保护级别；C′ 提示"等同 Chrome basic_text 级别"与升 A 指引。
5. **旧数据不迁移、不读取。** 发现旧格式文件（v1 密码本/旧明文 key）→ 改名搁置（`.legacy.bak`），不删除、不读取、不迁移；新格式全新初始化。
6. **零新增 native 依赖。** 平台后端与 OS 校验一律"白盒子子进程 + 短超时"，参数契约化，防注入。
7. **查看门禁 = OS 登录验证，无应用主密码。** Windows `LogonUser`、macOS login keychain 解锁校验（experimental）；Linux A 档靠密码环（对齐 Chromium 不做二次验证）；C′ 提供可选兜底查看密码（默认关，仅哈希门禁，不包 DEK）。
8. **Windows 是第一验证平台**，Linux 是正式目标（GNOME/KDE 列入验收），macOS 按 experimental 对待。

## 档位与数据形态（核心）

```text
档位 A —— 跨会话免密（OS 密钥库托管，真加密）
  启动即加载：keyEnc 由 OS 解密 → 解开 dekAutoFillEnc → 填充全程免输入。
  覆盖：Windows / macOS / 主流 Linux（GNOME Keyring、KDE KWallet 经兼容层）。

档位 C′ —— 跨会话免密（本地弱保护兜底，自动启用）
  无任何 OS 密钥库时自动启用：wrap key 以可逆混淆写入
    password-autofill-key.json（0600 权限），启动即解。
  保护级别：等同 Chromium 无 keyring 时的 basic_text。

数据形态 v2 —— 无主密码，无存量兼容
  { version: 2, dekAutoFillEnc, entries[], viewFallback?: {salt,hash} | null }
  viewFallback 为 C′ 可选兜底查看密码的哈希预留位（默认 null，实现期才填充，schema 从 v2 定型起即含此字段）
  DEK 仅由 auto-fill wrap key（A/C′）保管；无 salt / dekMasterEnc；
  无"解锁/锁定"状态。查看门禁 = OS 登录验证（或 C′ 可选兜底密码）。
```

**"填充/增删改"语义**：DEK 启动即在（`_dekForAutoFill`），填充与条目增删改都不要求任何输入；仅"查看/导出明文密码"走 OS 验证门禁。

**旧文件搁置（决策 8）**：`init()` 检测到 v1 密码本（含 `salt`/`dekMasterEnc`）或旧明文 key 文件 → 更名为 `<name>.legacy.bak` 保留（不删除，用户可自行处置），随后全新初始化 v2。不做任何读取/迁移。

## 方案概览

### 1. 新模块 `keyring.ts`（OS 密钥后端统一抽象）

```ts
// 概念接口（实现以源码为准）
export type KeyringBackendId =
  | 'electron-safestorage'   // 预留：Electron ≥15 时优先
  | 'win-dpapi'              // Windows: PowerShell + .NET ProtectedData
  | 'linux-secret-service'   // Linux: secret-tool (freedesktop Secret Service)
  | 'darwin-keychain';       // macOS: security CLI (experimental)

export interface KeyringBackend {
  readonly id: KeyringBackendId;
  isAvailable(): Promise<boolean>;   // 探测①：CLI 二进制存在 + 平台匹配
  probe(): Promise<boolean>;         // 探测②：往返探针（写→读→删），识别守护未运行/沙箱
  wrap(base64Secret: string): Promise<{ ok: true; blob: string } | { ok: false; reason: string }>;
  unwrap(blob: string): Promise<{ ok: true; secret: string } | { ok: false; reason: string }>;
  remove(blob: string): Promise<void>;
}

export interface KeyringStatus {
  backend: KeyringBackendId | null;   // null = 无任何可用 OS 后端 → 走 C′
  reason: string | null;
}
```

**探测链（进程内执行一次并缓存，失败可重试）：**

```text
① 二进制 / 平台前提存在？  ── 否 → backend=null (reason: no-tool)
   └─ 是 → ② 往返探针：store 一条探针值 → lookup 读回 → clear 删除（3s 超时）
          ── 失败/超时 → backend=null (reason: daemon-unreachable)
          └─ 成功 → backend=该平台后端
```

**后端选择优先级**：`electron.safeStorage`（未来升级自动命中）→ 平台子进程后端。backend=null 不视为错误，password-store 自动转 C′。

### 2. 平台后端实现要点

#### Windows：DPAPI（`win-dpapi`）
- 机制：与 Chrome 同级 DPAPI `CurrentUser`，经 `powershell.exe` 子进程加载 .NET `ProtectedData`（Electron 11 主进程无 native 直调途径）。
- 契约：`spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command', SCRIPT], { windowsHide: true })`；payload 经 stdin 不进参数；stdout 首行 `OK <base64>` / `ERR <code>: <msg>`；protect 10s / unprotect 15s 超时 kill；`Add-Type` 失败 → 落 C′。
- 探针：protect→unprotect 固定串比对。

#### Linux：Secret Service（`linux-secret-service`）
- 机制：`secret-tool`（libsecret CLI）对接 freedesktop Secret Service —— GNOME Keyring / KWallet（Plasma 5+ 兼容层）/ KeePassXC。
- 覆盖目标（决策 1）：主流 GNOME Keyring 与 KDE KWallet 均为正式覆盖对象，冒烟验收各验一次；非主流自动落 C′。
- 契约：service=`bao-flash-browser`、account=`auto-fill-key`；store 经 stdin；每次调用 3s 超时；探针 account=`auto-fill-key.probe`，避免误清真实值。

#### macOS：Keychain（`darwin-keychain`，experimental）
- 机制：`security add/find/delete-generic-password`。
- 已知局限：`-w` 秘密出现在进程参数（无 stdin 便捷通道）；本轮实现但标注局限，失败落 C′。

### 3. C′ 本地弱保护落盘（password-store 侧）

- 触发：keyring backend=null。
- 形态：wrap key 可逆混淆写入 `password-autofill-key.json`（`keyLocal`，base64 + 掩码，量级等同 Chromium `basic_text`）+ chmod 0600。**能力声明收敛：仅"防文本直读/防误拷贝"，不防任何主动攻击者**（与 basic_text 对齐，不做真安全宣称）。
- 每次启动解混淆 → 解 `dekAutoFillEnc` → 跨会话可用。
- 与 A 互斥切换：探测到 OS 后端 → 重建 `keyEnc` 删 `keyLocal`；后端失配（跨机器）→ 删 `keyEnc` 转 C′。

### 4. `password-store.ts` 接入改造（v2）

| 现状函数 | 改造后行为 |
|----------|-----------|
| `_readAutoFillKey` | 按档位读（A：`keyring.unwrap(keyEnc)`；C′：解混淆 `keyLocal`） |
| `_writeAutoFillKey` | 按档位写（A：wrap 成功写 `keyEnc`；C′：混淆写 `keyLocal` + chmod 0600）；两档都必然成功，无"拒绝写入"分支 |
| `_ensureAutoFillWrap` | 不再抛错；按档位落盘 wrap key，写 `dekAutoFillEnc`，置 `_dekForAutoFill` |
| `_loadAutoFillDek` | 启动即解出 `_dekForAutoFill`（A/C′ 均跨会话）；v2 并轨为**单一 `_dek`**（原 `_dekFromMaster` 全量删除，含各读写函数引用） |
| `getDecryptedPassword` / `getEntriesForHost` / `getFillCredentialForUrl` | v2 下不再依赖主密码解锁态，统一改读 `_dek`；`getDecryptedPassword` 保持纯解密函数语义，由 view-gate 授权后调用 |
| `getDek()`（新增） | 返回当前 `_dek` 供 save-confirm 守卫与 fill 链路使用（v2 无解锁态） |
| `setupMaster` / `unlockWithMaster` / `lock` / `isUnlocked` | v2 无主密码概念 → 随主密码退役删除/置空；调用方（IPC/UI）同步清理 |
| `init()` | ① 旧文件搁置（v1/旧明文 key → `.legacy.bak`）② keyring 探测缓存 ③ 按 A/C′ 加载 | 

### 5. 查看门禁（OS 验证）—— 新模块 `view-gate.ts`

| 平台/档位 | 查看密码门禁 | 机制 |
|-----------|-------------|------|
| Windows（A，恒有） | OS 登录密码 | 应用内弹窗 → 子进程 `LogonUser` 校验（与 Chrome 同机制）；密码经 stdin、限次防账户锁定 |
| macOS（A，experimental） | OS 登录密码 | `security unlock-keychain -p <pw> login.keychain-db` 成功即身份正确（T6 冒烟验证细节） |
| Linux A 档 | 依赖密码环，不二次验证 | 对齐 Chromium：登录即解锁钥匙串 = 身份已验 |
| Linux C′ 档 | **可选兜底查看密码（默认关）** | 设置页可启用；PBKDF2 哈希校验，仅作 UI 门禁（如实标注不提供文件级保护） |
| Windows 无密码/PIN-only 账户 | 降级同 C′ | 无可用密码校验通道 → 提示并走可选兜底 |

- 兜底密码与旧"主密码"的本质区别：**不包 DEK**，只是查看门禁（哈希校验）；不设的用户完全无感（默认关）。
- 查看门禁同样用于"导出密码"。

### 6. 数据形态 v2（无存量兼容）

```text
v2: { version: 2, dekAutoFillEnc: EncBlob, entries: Entry[], viewFallback?: { salt: string; hash: string } | null }
```

- 新装/首次初始化直接生成 v2，**无需任何密码输入**。
- 旧 v1 文件与旧明文 key 文件 → 改名搁置 `.legacy.bak`，不读不迁（决策 8）。**检测条件收紧**：v1 判定 = `salt`/`dekMasterEnc` 字段**存在且非 null**，或 `version < 2`（electron-store defaults 使全新文件也带 `salt:null`/`dekMasterEnc:null`，仅查字段存在会误搁置新机器）；旧明文 key 判定 = `password-autofill-key.json` 中 `keyPlain`/历史 `key` **非空**。
- 条目写入仍用 DEK（AES-256-GCM）；DEK 由 wrap key 解开后常驻 `_dekForAutoFill`。

### 7. 状态暴露与设置页（IPC + i18n）

- auto-fill 状态 IPC：`{ enabled, tier: 'A'|'C'|'none', ready, reason? }`。
- 解锁/锁定相关 IPC 与状态随主密码退役清理。
- 设置页文案（新增 i18n keys，`npm run i18n`）：

| 状态 | 渲染文案（示意） |
|------|-----------------|
| A 档 ready | "系统钥匙串保护：跨会话自动填充；查看密码时验证系统登录密码" |
| C′ 档 ready | "当前环境无系统钥匙串，已启用本地弱保护（等同 Chrome basic_text 级别）；跨会话自动填充" |
| 查看门禁提示（Windows/macOS） | "查看密码需输入系统登录密码" |
| 可选兜底密码（C′/无密码账户） | 开关 + 说明"当前系统无法验证登录密码，可设置查看密码（可选，默认关）" |

### 8. `safe-storage.ts` 处置

**整体删除 `src/main/utils/safe-storage.ts`，不留占位**（决策 2）；未来 Electron ≥15 由 keyring.ts 顶层 `safeStorage` 分支接管（新路）。

## 决策记录（评审结论，2026-09-03 定稿）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | Linux 后端覆盖 | 只认 secret-tool；**至少覆盖 GNOME Keyring 与 KDE KWallet**（兼容层），双环境冒烟验收；非主流落 C′ |
| 2 | `safe-storage.ts` | **删除不留占位**；Electron ≥15 走 keyring.ts 顶层 safeStorage 分支 |
| 3 | 填充语义 | 自动填充、不解密码本直接填，对齐 Chrome/Edge；仅查看密码要求验证 |
| 4 | macOS 本轮范围 | 本轮实现 darwin-keychain（experimental 标注） |
| 5 | 设置页文案 | A / C′（含保护级别提示）/ 查看门禁提示三态，符合预期 |
| 6 | 兜底架构 | **A 主用 + C′ 本地弱保护自动兜底**（B/C 否决） |
| 7 | 查看门禁与主密码 | **应用主密码退役**：查看门禁 = OS 登录验证（Win `LogonUser`、mac login keychain 解锁、Linux A 靠密码环）；C′ 提供可选兜底查看密码（默认关，不包 DEK） |
| 8 | 存量用户 | **不做存量兼容/迁移**：旧格式文件改名搁置 `.legacy.bak`（不读不删），新格式 v2 全新起步 |

## 时序（关键路径）

- **首启（任意平台）**：`init()` → 旧文件搁置（如有）→ keyring 探测 → 无 vault 则生成 v2（无密码）→ 按 A/C′ 落盘 wrap key + `dekAutoFillEnc` → `_dekForAutoFill` 就绪 → 填充可用（跨会话）。
- **查看密码（Windows）**：点查看 → 弹窗输入系统登录密码 → 子进程 `LogonUser` 校验 → 通过则解密展示。
- **查看密码（C′，未设兜底）**：直接可看（等同 Chromium basic_text 环境行为）。
- **C′ → A 升级 / 后端失配**：探测到 OS 后端 → 重建 `keyEnc` 删 `keyLocal`（或反向），无需任何输入。

## 安全分析（威胁模型）

| 攻击者能力 | A 档 | C′ 档 |
|------------|------|-------|
| 仅能读 userData 文件 | 密文 blob；解不开 OS 托管的 key | 密文 blob + 本地混淆 key → 可解（等同 Chromium basic_text 环境） |
| 同用户进程注入/调试 | 全部 | 全部 |
| 磁盘镜像拷走 userData | 无法跨机器解密 | key 随文件带走 → 可解 |
| 坐到你登录着的电脑前 | 查看被 OS 登录密码门禁挡住（Windows/macOS）；Linux 无二次验证（登录即已证明） | 查看被可选兜底密码挡住（若启用）；未启用直接可看 |

- 与 Chromium 对齐：无 keyring 的 Linux 用 `basic_text` 混淆兜底；C′ 即对应档位。无应用主密码后，数据静态保护由 A/C′ 提供，与应用 UI 门禁解耦。
- 明确不做：对抗管理员/root、防内存 dump、防同用户恶意进程、旧数据兼容。
- 子进程秘密（DPAPI/LogonUser/keychain）一律经 stdin 传递，不进进程参数。

## 风险

- **Windows DPAPI / LogonUser 子进程路径未在真实运行时验证**（会话沙箱拦截 PowerShell）。缓解：验证门① = 真实 Electron 主进程 protect/unprotect 往返；LogonUser 紧随验证。
- **LogonUser 边界**：无密码账户、PIN-only（Windows Hello）无法用密码校验；域策略可能锁账户 → 限次 + 降级可选兜底。
- **secret-tool 阻塞等待解锁**（PAM/钥匙串锁定）→ 3s 超时判不可用落 C′。
- **C′/可选兜底密码保护级别低于 OS 门禁** → 仅无 OS 通道环境启用/默认关；设置页如实标注。
- **主密码退役牵动 UI/IPC 面广**（解锁/锁定状态、设置页密码区块、autoFillNeedsUnlock 文案）→ 随 T5/T6 一并清理，避免残留死代码与误导文案。
- **范围已实质扩大**：从"修复 key 落盘"扩展为"密码安全模型重设计"，按 T1–T7 分阶段，各任务独立验证门。

## 测试计划

- 单元（Vitest，mock keyring/OS 校验）：
  - 档位判定（A/C′/待初始化）、C′ 混淆往返 + 0600、A↔C′ 切换、后端失配。
  - v2 生命周期：初始化无密码、填充/增删改不要求输入、重启后仍可用。
  - 旧文件搁置：检测 v1 密码本 / 旧明文 key → `.legacy.bak` 且不读取。
  - 查看门禁：Win LogonUser 判定、mac keychain 判定、C′ 兜底密码哈希开关与失败限次。
- 集成冒烟（Windows，真实 Electron）：DPAPI 往返 + LogonUser 往返 + 端到端 auto-fill 链路。
- Linux 冒烟（CI ubuntu）：GNOME Keyring 与无 keyring（C′）两态；KDE 补验记录在案。
- 回归：`npm run check` 全程通过；既有密码相关测试按 v2/无主密码语义调整后不回归。

## 实施顺序（写入 plan 的输入）

1. **T1**：`keyring.ts` 骨架 + `win-dpapi` + DPAPI 往返冒烟（验证门①）。
2. **T2**：password-store v2 数据形态 + A/C′ 状态机 + C′ 落盘 + 旧文件搁置。
3. **T3**：Linux `secret-tool` 后端 + 探测/降级 C′。
4. **T4**：macOS `security` 后端（experimental）。
5. **T5**：主密码退役清理（IPC/UI 解锁态移除、设置页密码区块重构、i18n）。
6. **T6**：`view-gate.ts`（Win LogonUser / mac keychain 解锁 / C′ 可选兜底密码）+ 状态 IPC/文案。
7. **T7**：测试补全与回归（unit + 冒烟 + `npm run check`）。
