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

现行 IPC 包括状态/初始化、列表、启停、自动捕获、自动填充、站点排除、保存确认、忽略、
删除、查看、默认账号、填充与重置。Linux Secret Service、
macOS Keychain 和查看门禁尚未接入；在门禁完成前 `password:reveal` 固定返回
`not-authorized`，不会把密码明文送入渲染层。

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
