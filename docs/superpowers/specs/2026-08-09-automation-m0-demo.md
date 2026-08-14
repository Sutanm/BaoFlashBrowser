# 视觉自动化 M0 Demo 结果

日期：2026-08-09

## 目标

在不接入正式标签生命周期和工作台的前提下，验证以下关键能力：

1. Electron 11 BrowserView 最小化后仍能截图。
2. 最小化状态下可通过短时 CDP 发送可信鼠标和键盘输入。
3. OpenCV 从截图动态定位素材后可以完成点击闭环。
4. Blockly 可在 Chromium 87 中创建自定义积木并完成 JSON 往返。
5. 候选流程、压缩和目录监听依赖可由当前工具链加载。
6. Ruffle SWF 在最小化状态下可接收短时 CDP 鼠标输入。

## 固定环境

- Windows x64
- Electron 11.5.0
- Chromium 87.0.4280.141
- BrowserView 视口：900×560 CSS 像素
- 截图：1350×840 设备像素（DPR 1.5）

## 已通过

### 最小化输入

- 聚焦窗口下 `webContents.sendInputEvent` 对照点击成功。
- 窗口最小化后 `capturePage` 返回完整 1350×840 图像。
- 短时 `Input.dispatchMouseEvent` 点击成功且页面收到 `isTrusted=true`。
- 短时 `Input.dispatchKeyEvent` 键盘输入成功且页面收到 `isTrusted=true`。
- 每个动作后 debugger 均已断开。
- debugger 断开后 BrowserView 导航正常。

### 视觉闭环

- 使用 `@techstark/opencv-js@4.5.5-release.2`。
- 从初始页面裁取按钮素材，将按钮移动到另一位置后再最小化窗口。
- `TM_CCOEFF_NORMED` 匹配得分：0.9880117。
- 匹配耗时：129 ms（首次基准，未使用 ROI、灰度缓存或 Worker）。
- 定位结果与页面实际设备像素位置误差：x=0、y=0。
- 根据截图尺寸和 BrowserView CSS 视口换算坐标后，CDP 点击成功。

### 工作台依赖

- Blockly 10.4.3 在 Chromium 87 中加载成功。
- 自定义 `bao_wait_image` 积木创建成功。
- 工作区 JSON 保存、清空和恢复成功，字段值保持不变。

### Ruffle 输入

- 使用 Ruffle 官方 `from_shumway/button1` 视觉回归 SWF（MIT/Apache-2.0）。
- SWF 舞台为 550×400，按钮目标点为 (250, 200)。
- BrowserView 最小化后仍能取得完整画面。
- CDP 鼠标悬停、按下、释放能够驱动按钮蓝色/绿色状态切换。
- 单次状态切换的画面变化比例为 0.2119038。
- 动作结束后 debugger 已断开。

### PPAPI 环境诊断

- Chromium 能枚举 `Shockwave Flash / pepflashplayer64.dll`。
- 自动化探针和仓库原有 `screenshot-v20-gate.cjs` 均显示“无法加载插件”。
- 因 SWF 未进入渲染态，本轮不能验证 PPAPI 输入；探针以
  `registered: true, rendered: false` 明确记录，不将占位页误判为输入失败。

## 证据

运行命令：

```bash
npm run probe:automation-input
npm run probe:automation-visual
npm run probe:automation-blockly
npm run probe:automation-flash
```

运行产物位于 `release/automation-probe/`，包括前后截图、素材图片和 JSON 结果。

## 当前决策

HTML BrowserView 和 Ruffle 路径为 **GO**。已经证明本项目不需要真实桌面坐标或恢复窗口，也能完成截图、找图和可信输入闭环。

暂时不能宣称整个自动化平台为 GO。以下验证门仍未完成：

1. 在能实际渲染 PPAPI SWF 的主机上验证短时 CDP 鼠标和键盘输入。
2. 登录、JSONP、刷新、前进后退以及密码捕获 CDP 生命周期冲突。
3. 多尺度、局部区域、透明 mask、多素材和持续运行性能。
4. Win32 和 Linux 行为。

## 依赖决策

- `blockly@10.4.3`：保留，进入工作台原型。
- `@techstark/opencv-js@4.5.5-release.2`：保留，下一步移入专用 Worker。
- `xstate@5.31.1`：保留，用于任务生命周期，不用于解释全部积木。
- `fflate@0.8.3`：保留，用于 `.baoauto` 包。
- `chokidar@3.6.0`：保留；3.x 支持 Node 12，禁止自动升级到 4/5。

所有版本应保持精确锁定。Electron 版本不得因这些依赖而升级。
