# 10 · 网络代理与连接诊断

> 状态：按 **1.1.2（2026-11-02）** 源码核对。本文为 1.1.2 新增模块（旧版模块文档没有
> 代理章节）。面向用户的配置说明见 [`../proxy-settings.md`](../proxy-settings.md)。

## 1 范围与目标

全局代理作用于 `defaultSession` 与 `persist:` 两个 session，覆盖网页、下载与后台脚本。
模块还提供"检测未保存配置"的连接诊断，用独立内存 session 验证路由与 HTTP 响应。

**边界**：aria2 的路由翻译见 06；GitHub 模块的独立 transport 见 02。

## 2 静态结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/proxy.ts` | 应用配置、`testProxy` 诊断、32 个测试 session 上限 |
| `src/shared/types/proxy.ts` | `ProxySettings` schema、`toElectronProxy` 映射 |
| `src/main/ipc/config.ipc.ts` | 配置读写（含 `proxy`）与 `proxy:test` |
| `src/main/index.ts` | 启动期 `initializeProxy`（窗口/后台脚本/导航之前） |
| `src/renderer/components/panels/ProxySettingsCard.tsx` | 设置页「网络代理」表单与检测入口 |

## 3 配置模型

`ProxySettings`：

```ts
{ mode: 'system'|'direct'|'manual'|'pac',
  protocol: 'http'|'socks5',
  host: string, port: 1..65535, bypass: string, pacUrl: string }
```

校验（zod `superRefine`）：

- `manual`：host 只接受域名 / IPv4 / 带方括号的 IPv6；
- `pac`：必须是 `http(s)` URL，且**不得带用户名/密码**；
- `bypass`：禁止 `\r`、`\n`、`\0`；
- 所有字段 `strict()`，多余键直接拒绝。

## 4 与 Electron 11 的映射（关键陷阱）

Electron 11.5.0 的 `session.setProxy` **没有新版 `mode` 参数**，映射如下：

| 配置 | `toElectronProxy` 返回 | 说明 |
| --- | --- | --- |
| `system` | `null` | **不调用 `setProxy`**，让新 session 保持系统默认；不要用 `proxyRules:''` 代替 |
| `direct` | `{ proxyRules: '' }` | 空固定服务器规则 = 直连 |
| `manual` | `{ proxyRules: 'http://host:port', proxyBypassRules }` | SOCKS5 同理走 `socks5://` |
| `pac` | `{ pacScript: pacUrl }` | 由 PAC 决定分流 |

## 5 应用时机与生效语义

`initializeProxy(config.proxy)` 在 `whenReady` 内、**创建窗口与后台脚本之前**执行，且
`await`；失败时记录 `[Proxy] configuration failed; startup stopped` 并 `app.quit()`，
不会在"无代理"状态下继续启动。

- 同时应用到 `session.defaultSession` 与 `session.fromPartition('persist:')`；
- 设置页保存只写配置，**重启后生效**；保存到重启之间，网页与下载仍走旧配置；
- 代理在创建窗口/后台脚本前应用，避免首个请求漏过代理。

## 6 连接检测

`proxy:test` 接受 `{ proxy, url }`，在**全新内存 session** 中测试尚未保存的配置：

1. 全局串行：并发调用返回 `BUSY`；
2. 每次创建 `proxy-test-<n>` 的无缓存 session，**最多 32 个**（`TEST_LIMIT`）。
   Electron 11 会把 session 固定到进程生命周期，不能无限创建；
3. `setProxy` → `resolveProxy(url)` 得到实际路由；
4. `net.request({ redirect: 'manual' })` 请求目标；
5. 15 秒超时。

返回 `{ ok, route, statusCode?, error? }`，错误码：

| 错误码 | 含义 |
| --- | --- |
| `BUSY` | 已有检测在跑 |
| `TEST_LIMIT` | 32 次上限，需重启应用 |
| `TIMEOUT` | 15 秒未完成 |
| `PROXY_AUTH_REQUIRED` | 代理要求认证（本应用不提供账号密码） |
| `NETWORK_ERROR` | 请求失败 |

检测只验证 HTTP(S) 可达性，**不验证 Flash 内部 Socket**，也不等同系统 VPN。

## 7 与下载、后台脚本的关系

- 下载：aria2 通过 `session.resolveProxy(url)` 取**第一条**路由，翻译成 `all-proxy` 等
  选项；SOCKS/HTTPS 等 aria2 不支持的类型回退 Chromium，不降级直连（见 06）。
- 后台脚本：使用同一 `persist:` session，自然继承代理。
- GitHub 模块：独立 transport session，按当前代理单独 `setProxy`，避免与页面请求
  互相影响（见 02）。

## 8 安全与雷区

1. 不要用新版 `mode: 'system'` 之类的参数——Electron 11 不支持，属于静默失效。
2. `system` 必须"不调用 setProxy"，否则会把系统代理覆盖成空规则。
3. 检测 session 有 32 次硬上限；反复点"检测"到上限后只能重启，UI 应显示 `TEST_LIMIT`。
4. PAC URL 不允许内嵌凭据；不支持代理账号密码。
5. 应用启动时代理配置失败就退出，不要改成"忽略并继续"——否则会出现半配置状态。
6. 保存后不立即热切换是刻意行为（session 级代理切换会影响在途请求）。

## 9 验证

- `npm test -- --run tests/proxy.test.ts`（映射、schema、错误码）。
- `npm run probe:deep -- --only 15-proxy`（运行时解析路由）。
- `npm run test:e2e -- tests/e2e/proxy-settings.spec.ts`（需先构建）。
- aria2 实际路由：`npm run probe:deep -- --only 26-aria2-proxy`。
