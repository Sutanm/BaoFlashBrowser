# 07 · 截图系统

## 1 范围

截图系统调用指定标签的 `webContents.capturePage()`，可返回 PNG base64、保存 PNG，或按 BrowserView 坐标裁剪。它也为开发态运行实例提供受控的 loopback HTTP 入口。

## 2 当前结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/screenshot.ts` | 捕获决策、隐藏/最小化标签捕获、裁剪、保存路径与 PNG 写入 |
| `src/main/modules/screenshot-http.ts` | `127.0.0.1:44123` 的开发态 POST 入口与 token 验证 |
| `src/main/ipc/screenshot.ipc.ts` | `capture`、`capture-active`、`reveal`、`set-dir` |
| `src/main/modules/automation/browserview-driver.ts` | 自动化截图及助手隐藏/恢复 |

## 3 核心行为

`captureTab(tabId, opts)` 先确认主窗口、BrowserView 和活动/最小化关系，再通过 `incrementCapturerCount` / `decrementCapturerCount` 成对捕获。非活动标签在允许时按当前容器尺寸捕获并保持 hidden。结果可包含尺寸、base64 数据和保存路径。

默认目录依次为配置的 `screenshotDir`、`Pictures/BaoFlashBrowser`、`userData/screenshots`。显式 `savePath` 只取安全文件名并强制 `.png`，最终路径必须位于截图目录内。当前实现不提供整页滚动拼接，也不支持 JPEG。

## 4 调试 HTTP 入口

只有开发态设置 `BAO_SCREENSHOT_HTTP=1` 才监听；打包应用不会启动。请求必须来自 loopback、使用 POST，并携带日志中生成的 `X-BAO-Token`。内部 React 页没有 BrowserView 时返回 `NO_TAB`。详细协议见截图设计文档的“调试 HTTP 口子”。

## 5 安全与兼容

- 截取的是标签内容，不是主窗口外壳。
- 保存路径必须通过文件名清洗和目录边界检查。
- token 不写入仓库，HTTP 服务不绑定局域网地址。
- 最小化活动标签已验证可捕获；最小化时拒绝捕获非活动标签。
- 自动化取材和识图截图不会隐藏悬浮助手或其他页面浮窗；用户负责将浮窗移出目标区域，或按需禁用助手。
- 自动化识图指定区域时直接使用 `capturePage(rect)`，匹配结果必须加回区域设备像素原点后再换算为 BrowserView 内容坐标；未指定区域时才捕获完整标签内容。

## 6 验证

Vitest 覆盖捕获决策、路径和 HTTP 请求门禁；自动化 Web/Ruffle 冒烟覆盖最小化截图。外部调试只能通过文档规定的 HTTP 入口连接正在运行的实例。
