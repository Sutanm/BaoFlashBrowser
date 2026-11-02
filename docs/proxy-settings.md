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

选择 aria2 下载引擎时，按下载网址调用当前 Session 的 `resolveProxy`，同步 Chromium 对
系统代理、PAC、自定义绕过规则的解析结果。首选路由为 HTTP 代理或直连时使用 aria2。
代理配置通过每个下载任务的 RPC 选项传入，显式覆盖各协议的代理配置，清理继承的代理环境变量，
并禁用外部 aria2.conf，避免其他配置覆盖浏览器设置。Chromium 默认的回环和链路本地地址绕过
也同步给 aria2。代理不可用时不会自动改为直连。

首选路由为 SOCKS、HTTPS 代理等 aria2 不支持的类型，或解析失败、超时时，使用 Chromium，
不会跳过首选代理去选择后面的 DIRECT。每个新任务和重建的重试任务重新解析路由。
Chromium 最初的下载重定向已完成，但如果 aria2 再次收到重定向，它会沿用该任务的路由；
目前没有实现 aria2 内部逐跳重新执行 PAC。对这种情况要求严格动态分流时，请选择 Chromium 引擎。
保存后、重启前，网页和下载继续使用原有代理配置。
不提供代理账号密码设置；可连接无需认证的代理或本地代理客户端。

目录和下载引擎统一在“设置 → 下载与截图”管理，显示包含默认目录在内的完整路径。
目录修改后立即生效；下载面板提供引擎与 aria2 就绪状态、打开下载文件夹的快捷入口，
各任务保留实际引擎标签。顶部就绪状态说明服务可用，不代表所有任务必定使用 aria2。

此功能不等同于系统 VPN。Flash 内部 Socket 等通信需要针对具体游戏验证。
连接检测验证 HTTP(S) 访问，不验证 Flash 内部通信。

验证：`npm run probe:deep -- --only 15-proxy`，
`npm test -- --run tests/proxy.test.ts`，
`npm run test:e2e -- tests/e2e/proxy-settings.spec.ts`（先构建）。
aria2 实际下载验证：`npm run probe:deep -- --only 26-aria2-proxy`。
