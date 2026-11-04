# 07 · 截图系统

> 状态：按 **1.1.2（2026-11-02）** 源码核对，取代 `docs/archive/modules-v1/07-screenshots.md`。

## 1 范围与目标

截图系统对指定标签的 `webContents` 调用 `capturePage()`，可返回 PNG base64、保存 PNG，
或按矩形裁剪。它也为开发态实例提供受控的 loopback HTTP 入口。

**边界**：自动化取材/识图的帧几何见 03；截图目录配置与下载目录同属「设置 → 下载与截图」。

## 2 静态结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/screenshot.ts` | 捕获决策、活动/最小化判定、裁剪、目录解析、PNG 写入与大小限制 |
| `src/main/modules/screenshot-http.ts` | 开发态 `POST /screenshot`，回环 + token 门禁 |
| `src/main/ipc/screenshot.ipc.ts` | `capture` / `capture-active` / `get-dir` / `set-dir` / `reveal` |
| `src/main/modules/automation/browserview-capture-service.ts` | 自动化的帧归一化、区域捕获与 `FrameGeometry`（见 03） |

## 3 核心行为

### 3.1 捕获决策

`captureTab(tabId, opts)` 先判定：

| 条件 | 结果 |
| --- | --- |
| 标签不存在或无 BrowserView | `NO_TAB` |
| 窗口最小化且目标**不是**活动标签 | `MINIMIZED_INACTIVE`（拒绝） |
| 窗口最小化但目标**是**活动标签 | 允许，按容器尺寸捕获并保持 hidden |

允许时用 `incrementCapturerCount(size, stayHidden)` / `decrementCapturerCount` 成对包裹，
`size` 取当前容器 rect，保证最小化时画面不被压成 0×0。

### 3.2 裁剪与输出

- 传 `rect` → `capturePage(rect)`；不传 → `capturePage()` 全量。
- `save=true` 时写 PNG，`savePath` 只取安全文件名并强制 `.png`，最终路径必须落在截图
  目录内；返回 `filePath`。
- `returnData=true` 时返回 base64；PNG 超过 **16 MiB**（`MAX_SCREENSHOT_DATA_PNG_BYTES`）
  直接报错，避免把超大图塞进 IPC。
- **不支持** JPEG、整页滚动拼接。

### 3.3 目录解析

`getScreenshotDir()` 顺序：

1. `config.screenshotDir`；
2. `pictures/BaoFlashBrowser`（仅当 `pictures` 根目录存在且可写时使用）；
3. `userData/screenshots`（兜底）。

`set-dir` 额外校验：目录必须可写；**不允许位于 `userData` 内**（否则会污染应用数据
目录，也容易被清理逻辑误删）。

## 4 调试 HTTP 入口

仅当 `!app.isPackaged` **且** `BAO_SCREENSHOT_HTTP=1` 时启动；打包应用不会监听。

| 项 | 规则 |
| --- | --- |
| 地址 | 仅 `127.0.0.1`（回环），不绑定局域网 |
| 方法/路径 | 仅 `POST /screenshot`；GET 不带副作用，返回 404 |
| 鉴权 | `X-BAO-Token`，默认随机生成并在启动日志中打印；可用 `BAO_SCREENSHOT_TOKEN` 固定 |
| 端口 | 默认 44123，可用 `BAO_SCREENSHOT_PORT` 覆盖 |
| 来源 | 校验 `req.socket.remoteAddress` 属于回环集合 |
| 无标签 | 返回 `NO_TAB` |

请求体与参数只用于指定 tab/裁剪/是否返回数据；不能借此读取任意文件。

## 5 安全与不变量

- 截取的是**标签内容**，不是主窗口外壳，也不会带上原生对话框。
- 保存路径必须通过文件名清洗与目录边界检查（`isPathWithinDirectory`）。
- `reveal` 只允许截图目录内的已存在文件，否则返回 `PATH_DENIED` / `REVEAL_FAILED`。
- token 不写入仓库；HTTP 服务不绑定 `0.0.0.0`。
- 自动化识图指定区域时同样走 `capturePage(rect)`，匹配结果需加回区域原点再换算
  （见 03）。
- 页面浮窗（自动化助手）在截图时保持显示，不会为规避干扰而隐藏。

## 6 验证

- Vitest：捕获决策、目录解析、路径边界、HTTP 请求门禁与 token。
- Electron smoke：最小化活动标签截图、非活动标签拒绝。
- 外部调试只能通过本文规定的 HTTP 入口连接**正在运行**的实例；没有其他远程截图通道。
