# 05 · 密码存储、捕获与自动填充

## 1 范围与目标

管理站点登录凭据：
- **捕获**：CDP 附着到登录页，`Runtime.addBinding` 观察密码字段/表单/提交，把凭据安全送主进程（**绝不**过 `console.log`/渲染层 IPC）；
- **存储**：加密保险库（`electron-store`、AES 加密、device-local 包装）与账号-URL 关联；
- **自动填充**：检测登录/密码字段时在页面直接填写（冒烟快，走 CDP `Input.insertText`/聚焦队列）。

**边界**：不掌握异步|表单语义；跨上下文（iframe）用 `Runtime.evaluate` contextId。

## 2 静态结构

| 文件 | 职责 |
|---|---|
| `src/main/modules/password-capture.ts` | CDP 捕获脚本（CAPTURE_SCRIPT 内联大字符串）+ main-frame/iframe 插入策略 + 提交事件监听 |
| `src/main/modules/password-fill.ts` | 跨 entry context 的自动填充（main frame + CDP 各 context） |
| `src/main/modules/password-store.ts` | 加密保险库：读取/写入、自定义主密、设备密钥包装 |
| `src/main/modules/crypto-helper.ts` | AES 加解密原语封装 |
| `src/main/modules/cdp-lease.ts` | CDP debugger 租约：密码 + 自动化**串行化** |
| `src/main/modules/url-privacy.ts` | URL 隐私（path 哈希防泄露日志） |
| `src/main/ipc/password.ipc.ts` | 密码 IPC（zod）；`password:form-detected` 仅发“有表单”信号 |

## 3 核心流程

### 3.1 捕获

```
did-stop-loading → _schedulePasswordFill
  ├─ getPasswordCapture(wc)?.attachToPage 租约 CDP
  ├─ Runtime.enable + Page.enable → addBinding('passwordCapture')
  ├─ Page.addScriptToEvaluateOnNewDocument(CAPTURE_SCRIPT)（页面世界观察）
  ├─ 表单提交 / 字段变更 → binding 回调 → main 收到凭据（A/B？多 site）
  └─ 捕获完成后 detach（短生命周期），绝不长期挂 debugger
```

`CATURE_SCRIPT` 用 `SafeStorage` IPC 发送凭据片段（片段化避免整串暴在事件日志）；事件仅含 `siteId + formDetected` 总行，凭据只经 `SafeStorage:set` 通道。

### 3.2 自动填充

登录表单出现 → 心跳轮询等待输入稳定 → 若命中保险库账号 → `Runtime.evaluate`（该 contextId）填入用户名/密码（`Input.insertText`），再触发提交前监听器不做注入。跨 iframe 表单用 contextId（executeJavaScript 触不到）。

### 3.3 凭据持久化

主进程收到 → `password-store.set(site, {username, password})` 写保险库：
- 默认设备密钥（`safeStorage` 包装）或用户自定义主密；
- AES-GCM，随机 IV，加盐 KDF；
- 读密后**内存仅保留到填充完成**，填充后短窗口内清除。

### 3.4 CDP 租约

`cdp-lease`：一次只能有一个 attach（密码捕获或自动化）；拿到租约才允许 `debugger.attach`；导航/引擎切换早释放（`teardownCapture` 先于 `reload`/`navigate`/`goBack`/`goForward`）。

## 4 数据模型与接口

- `StoredPassword`：`{ id, site, username, password?:string(加密), updatedAt }`（保险库强制加密）。
- `PasswordCaptureBinding` 事件：`{ source, form, site, fields[] }`。
- IPC：`password:store/get/delete`、`password:form-detected`、`password:search`、`safeStorage:*`。
- 私有 vault 密钥格式：读 `password-store` 导出 `encrypt/decrypt/rotate`。

## 5 安全边界与不变量

- 凭据**只经 SafeStorage 通道**进主进程；绝不 `console.log`、绝不渲染层。
- 发射前 `url-privacy` 对 path 哈希；日志无 token/查询串。
- 捕获只在用户主动允许的目标站点注入；表单才能触发（dynamic observer 只发存在性信号）。
- 保险库文件 ACL：device-local 包装防被其它进程读。
- debugger 租约强制串行：密码与自动化的 CDP 永不重叠加。

## 6 兼容性

- 登录提交方式差异（4399 `<form>` / 7k7k `<script>` JSONP）——注入点不同，捕获脚本以 position 兼容。
- iframe 跨域表单 → CDP contextId（非 executeJavaScript）。
- SPA 软导航：不重跑页面观察（`did-navigate-in-page` → `manager.spaNavigate`），不 patch history。

## 7 测试策略

- Electron smoke：`tests/electron/password-*`（表单捕获 + 填充冒烟，mock 全部 preload 通道 + 固定 userData，见 09/Landmines）。
- 单测：crypto/url-privacy/key-derivation/password-store 加解密往返、租约互斥时序。
- 探针：密码表单出现性信号（无凭据泄漏）。`probe:deep` 含 CDP 运行时健康。

## 8 雷区与注意事项

1. **`debugger.attach` 阻塞 `<script>` onload** —— JSONP 登录冻结：捕获完成即 detach；导航前 teardown。
2. **附着处导航冻结标签** —— 任何导航先 `teardownCapture(wc)`。
3. **did-fail-load 绝不 `wc.stop()`**。
4. 断言 `did-stop-loading` 重attach——自动化结束自动恢复绑定。

## 9 演进建议

- 密码自动填充对多站点需要“已保存则高亮表单”的轻量 UI，可在 01 的 toast 或悬浮助手挂点做。
- 建议给保险库补“自动登录已保存站点”开关（目前仅填充不自动提交）。