# 最终回归记录

日期：2026-08-02

## 自动化覆盖

| 项目 | 验证内容 | 结果 |
| --- | --- | --- |
| Vitest | 配置规则、下载路径、重启恢复、密码学、标签会话、诊断脱敏 | 通过 |
| BrowserView smoke | 独立渲染进程、屏外隐藏、新标签切换、刷新 | 通过 |
| Ruffle smoke | `persist:` session、自定义协议、核心 JS、WASM、最小 SWF | 通过 |
| Compatibility fixture | 跨域 SWF 响应头、`crossdomain.xml`、61.com SWFObject 补丁 | 通过 |
| Release verification | Windows x64/ia32 解包资源与二进制架构 | 通过 |

兼容性 fixture 使用两个本地 HTTP 源和 Electron 11 BrowserView，避免用 BrowserWindow 或现代 Electron 代替生产环境。测试发现并修复了两个 `onBeforeRequest` 监听器互相覆盖、导致 `crossdomain.xml` 补丁失效的问题。

## 本轮未执行的外部站点操作

4399、7k7k、61.com 的公开页面访问被当前自动化环境的浏览器安全策略拒绝，因此没有绕过限制，也没有使用其他浏览器表面规避。登录回归还需要用户在本机应用中使用测试账号手动完成。

建议手工检查：

1. 61.com：页面不再提示 Flash 版本不兼容，游戏 SWF 能开始加载。
2. 4399：跨域登录 iframe 能提交，捕获开关关闭时不会附加 CDP 捕获器。
3. 7k7k：JSONP 登录完成后能继续跳转，刷新、前进和后退不会冻结。
4. 本地 SWF：设置 → 兼容性诊断 → 打开本地 SWF 游戏，确认 PPAPI 标签能播放测试文件。
5. 会话恢复：打开 PPAPI/Ruffle 混合标签并调整缩放，退出再启动后确认状态恢复。

## 安全边界

本项目必须固定 Electron 11.5.0 / Chromium 87 才能保留 PPAPI Flash。该内核和 Flash 插件都已停止安全更新，不适合作为普通浏览器处理邮箱、支付、网盘、办公系统或其他敏感网站。

- 仅访问可信的旧游戏站点和本地 SWF。
- 不在游戏站点复用重要账号密码。
- 密码本采用本地主密码加密，但不能弥补旧 Chromium 或 Flash 本身的漏洞。
- Ruffle 通常比原生 Flash 风险低；能正常运行的游戏优先使用内置 Ruffle。
- 导出诊断报告前仍建议人工检查内容，确认没有不希望分享的网站信息。
