# 自动化平台 M2 BrowserView 驱动边界

日期：2026-08-09

## 已实现

`BrowserViewAutomationDriver` 已实现执行器需要的 BrowserView 侧能力：

- 使用 `incrementCapturerCount` / `decrementCapturerCount` 获取最小化画面。
- 将找图返回的设备像素位置换算为 BrowserView CSS 像素。
- 短时附加 CDP，发送移动、单击/双击、按键、文本和滚轮事件。
- 每次输入结束均在 `finally` 中断开 debugger。
- 导航和刷新前拒绝已有 debugger 的标签，避免破坏密码捕获或冻结导航。
- 刷新等待 `did-finish-load`，并支持取消、失败和超时。
- 图像识别通过 `AutomationVisionMatcher` 注入，驱动不绑定某个 OpenCV 实现。

## 坐标约定

素材匹配在截图设备像素中完成。脚本中的 offset 使用 CSS 像素：

```text
截图中心设备像素 = match.x/y + match.width/height ÷ 2
CSS 点击位置      = 设备像素 × CSS 视口尺寸 ÷ 截图尺寸 + offset
```

例如 1350×840 截图对应 900×560 BrowserView 时，设备像素需要除以 1.5。该换算已由单元测试覆盖。

## 正式接入前的剩余门

1. 在 TabManager 中提供稳定的当前 webContents/视口句柄，继续遵守 current-WebContents guard。
2. 为密码捕获与自动化建立显式 CDP 租约协调，不能互相 detach。
3. 导航前调用现有密码捕获 teardown，加载完成后按原生命周期重新附加。
4. 用真实 Ruffle BrowserView 做驱动级最小化端到端测试；PPAPI 仍受当前主机插件不渲染阻塞。

## 视觉 Worker 验证结果

视觉 matcher 已使用 `@techstark/opencv-js` 接入独立 `worker_threads`：

- 模板原始像素和 Worker 内 OpenCV Mat 均有 LRU 缓存与数量/内存上限。
- 支持 CSS ROI，并在提交 Worker 前转换为截图设备像素。
- 支持 0.25～4 倍的有界多尺度列表，最多 16 个比例。
- 支持 PNG Alpha 遮罩；遮罩模式使用 OpenCV 支持 mask 的归一化相关方法。
- 请求有共享内存上限、超时和取消；超时/取消会终止并重建 Worker。
- OpenCV.js 在 Node Worker 初始化后无法接收普通入站消息，因此请求通过固定上限的
  `SharedArrayBuffer` 通道提交，由 Worker 定时轮询；结果仍由 `postMessage` 返回。
- Electron 11 主进程缺少全局 `AbortController`，已加入只覆盖本项目所需能力的兼容层。

真实 M2 探针结果：

- BrowserView 最小化：是。
- ROI 模板得分：0.9880111。
- Worker 匹配耗时：本机复跑为 13～21 ms。
- 设备像素定位：(158, 548)。
- CDP 点击：成功，页面收到 `isTrusted=true`。
- 动作结束后 debugger：已断开。

运行：

```bash
npm run probe:automation-m2
```
