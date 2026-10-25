# 网络代理设置

入口：设置 → 网络代理。修改后点击“保存设置”，退出并重新启动浏览器生效。

支持跟随系统、直接连接、HTTP / SOCKS5 手动代理，以及 HTTP(S) PAC 地址。
手动代理的地址只填写主机名或 IP，端口单独填写；IPv6 地址使用方括号，例如 `[::1]`。
绕过规则使用分号分隔，例如 `*.example.com;192.168.0.0/16`。本机回环地址默认直连。
PAC 模式的分流规则由 PAC 文件决定。

“检测当前填写的配置”会用临时内存 Session 测试尚未保存的配置，显示解析出的路由和目标网站
HTTP 响应。它不会更改当前网页的代理，也不携带浏览器登录 Cookie。15 秒超时；每次启动最多
进行 32 次检测，以限制 Electron 11 无法释放的 Session 数量，达到上限后需重启。

代理在创建窗口和后台脚本之前应用到 `defaultSession` 和 `persist:`。
Electron 11.5.0 的 `setProxy` 不支持新版 `mode` 参数：跟随系统不覆盖新 Session 的配置；
直连使用空 `proxyRules`；手动代理使用固定规则；PAC 使用 `pacScript`。

手动、PAC 和直连模式下，新下载使用 Chromium，以遵循当前生效的代理设置；跟随系统时保留
原下载引擎设置，aria2 使用自身网络配置。保存后、重启前，网页和下载继续使用原有代理配置。
不提供代理账号密码设置；可连接无需认证的代理或本地代理客户端。

此功能不等同于系统 VPN。Flash 内部 Socket 等通信需要针对具体游戏验证。
连接检测验证 HTTP(S) 访问，不验证 Flash 内部通信。

验证：`npm run probe:deep -- --only 15-proxy`，
`npm test -- --run tests/proxy.test.ts`，
`npm run test:e2e -- tests/e2e/proxy-settings.spec.ts`（先构建）。
