# 05 · 密码存储、捕获与自动填充

## 1 范围

该模块在主进程捕获登录提交、管理加密保险库，并在用户允许时填充用户名和密码。凭据不能经过控制台日志或携带明文进入渲染层；渲染层保存确认只携带短期 `captureId`。

## 2 当前结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/password-capture.ts` | CDP `Runtime.addBinding` 捕获、动态表单观察、短期 pending credential |
| `src/main/modules/password-fill.ts` | 主框架与 CDP execution context 自动填充 |
| `src/main/modules/password-store.ts` | v2 保险库、DEK、设备包装、默认账号和站点排除 |
| `src/main/modules/keyring.ts` | OS 密钥后端探测与包装接口；无后端时回落 C′ |
| `src/main/modules/keyring-win-dpapi.ts` | Windows DPAPI 子进程后端 |
| `src/main/modules/crypto-helper.ts` | 加密辅助 |
| `src/main/modules/cdp-lease.ts` | 密码捕获与自动化的调试器租约互斥 |
| `src/webview-preload/password-form-observer.ts` | 只报告“检测到密码表单”的存在信号 |
| `src/main/ipc/password.ipc.ts` | 状态、初始化、保存确认、忽略、删除、填充和设置 IPC |

## 3 核心流程

1. 页面停止加载后，`tabs.ts` 在允许捕获的站点调用 `setupCapture(wc)`。
2. 捕获器取得 `password-capture` CDP 租约，通过 `Runtime.addBinding` 接收页面世界提交事件；跨域 iframe 使用 execution context，不依赖 `executeJavaScript`。
3. 主进程保存短期凭据并向 UI 发送不含密码的确认信息。用户确认后，`password:save-confirm` 用 `captureId` 取回凭据并写入保险库。
4. 自动填充从保险库选取当前 URL 的账号，在主框架和 CDP context 中赋值，但不自动提交表单。

## 4 保险库与接口

当前数据格式为 v2，无主密码和锁定状态。随机 DEK 使用 AES-256-GCM 加密条目，
再由设备 wrap key 包装；Windows 优先用 DPAPI（档位 A），没有可用 OS 后端时使用
本地可逆弱保护（档位 C′，保护级别近似 Chromium `basic_text`）。旧 v1 密码本和旧明文
key 文件只会改名为 `.legacy.bak` 搁置，不读取、不迁移。

**密钥失败路径（2026-09-21 规格增量 D1–D8，务必按此理解"搁置"）**：

- **读路径零破坏**：`_shelfFile()` / `clear()` 只允许出现在 enroll（建库 / 显式重建）与旧明文
  迁移两个显式路径。读路径仅 `password-store.ts:323`、`:427` 两处调用，且都只在检出旧明文格式时触发。
  轮换 wrap key 只发生在 `initVault` / `resetAll` 这类显式重建路径。
- **失败语义二分**：transient（`timeout`/`spawn-failed`/`protocol-error`/`backend-unavailable`）
  → 保留文件、状态 `retrying`、退避重试；deterministic（`decrypt-failed`/`corrupt-local`/
  `key-length-mismatch`/`legacy-plaintext`）→ 保留文件、状态 `blocked`、等用户显式决策。
  `ps-error:*` 分类**方向敏感**（unwrap 方向=后端说密文解不开；wrap 方向=密文没生成，可重试）。
- **A 档故障不可降级 C′**：C′ 需要 wrap key 明文，而它只能由 A 档后端解出。
- 唯一允许销毁密钥的产品路径是 `password:rebuild-vault`（须提交确认词 `REBUILD`）。

现行 IPC 包括状态/初始化、列表、启停、自动捕获、自动填充、站点排除、保存确认、忽略、
删除、查看、默认账号、填充与重置，另加 `password:retry-key`（强制失效探测缓存并重试）
与 `password:rebuild-vault`；`password:status` 携带 `keyStatus` / `keyIssue` 供 UI 呈现三态。
Linux Secret Service、macOS Keychain 和查看门禁尚未接入；在门禁完成前 `password:reveal`
固定返回 `not-authorized`，不会把密码明文送入渲染层。

**条目的用户名可以为空**（2026-09-22 起，对齐 Chrome）：没有用户名框（卡号/手机号即账号）
或捕获时用户名还没进 DOM 的登录同样会保存，面板显示"（无用户名）"，查重键为 `host + ''`。
自动填充侧：这类条目只在"账号框为空或页面没有账号框"时填密码；账号框已有别的用户名时**整体不填**
（空用户名无法证明那条密码属于谁）。

## 5 安全不变量

- 密码不得进入 `console.log`、诊断、普通 renderer IPC 或 URL 查询串。
- 动态表单 observer 只能发送 presence signal。
- 导航、刷新、前进、后退或引擎切换前先 `teardownCapture(wc)`；长期附着会冻结 JSONP 和导航。
- 自动化持有 CDP 租约时密码捕获必须让步；释放后由页面生命周期重新附着。
- 自动填充只填字段，不提交。
- 档位 C′ 只是防止文本直接读取，不抵御能读取用户文件的主动攻击者；UI 必须如实显示保护等级。

## 6 验证与雷区

- Vitest 覆盖加密、保险库、URL 策略、填充策略和租约。
- 真实站点回归保留 4399 表单提交、7k7k JSONP、跨域 iframe 与捕获开关关闭路径。
- 不要把 `Page.addScriptToEvaluateOnNewDocument` 当成用户脚本桥；这里的捕获脚本与用户脚本运行时职责不同。
- **捕获脚本里禁止创建 iframe 取"干净 API"**（2026-09-22 回归）：注入由"新执行上下文创建"驱动，
  我们自己建的子帧会跑同一段脚本、再建子帧。实测生产脚本 vs 最小脚本 = 71 vs 2 次 `script loaded`、
  57 vs 0 次栈溢出；有测试锁死（`tests/password-capture-binding.test.ts`）。
- **捕获挂载时机**：`setupCapture` 挂在 `did-stop-loading`（`tabs.ts:506-515`），广告密集页可能比
  `dom-ready` 晚几十秒，这期间的输入不可见；`detach after capture` 后只在下一次加载或自动化释放时
  重新挂载。排查"某站点捕获不到"时，先把应用日志里的 `setupCapture` 时间戳与用户操作时间对齐。
- **诊断行的判读**：`frame info`（登录框在哪个 frame）、`first keydown` / `first input`（按键有没有进
  这个 frame、落在什么元素上）、`listener env selftest=… addFnLen=… instOverridden=…`（监听是否生效）。
  完整判读矩阵见技能 `bao-password-capture-triage`。
- 纯 Node（vitest）下 electron-log 会写真实 `logs/main.log`，含 `/mock/` 路径的行是单测噪声——
  读日志先按来源区分，否则会把单测告警当成真机故障（09-11 的 26 条 `unwrap-failed` 就是这么误判的）。

## 7 故障史

| 时间 | 事故 | 记录 |
| --- | --- | --- |
| 2026-09-20 | DPAPI 探测超时被当成后端失配 → 唯一 wrap key 被销毁 → 填充/保存/查看三个功能同时失效 | [`docs/password-vault-failure-2026-09-20.md`](../password-vault-failure-2026-09-20.md) |
| 2026-09-21 | 修复：读路径零破坏 + 失败语义二分 + 亲和标签 + 惰性自愈 + UI 出口（K1–K4） | 同上；规格 [`specs/2026-09-21-keyring-failure-path-design.md`](../superpowers/specs/2026-09-21-keyring-failure-path-design.md)、计划 [`plans/2026-09-21-keyring-failure-path.md`](../superpowers/plans/2026-09-21-keyring-failure-path.md) |
| 2026-09-22 | 捕获链路三处缺陷（递归自造 iframe / submit 被当账号 / 空用户名被丢弃） | [`docs/password-capture-diagnosis-2026-09-22.md`](../password-capture-diagnosis-2026-09-22.md) |
