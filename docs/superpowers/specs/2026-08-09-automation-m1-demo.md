# 自动化平台 M1 Demo

日期：2026-08-09

## 本阶段交付

M1 在不修改正式 BrowserView 生命周期的前提下，交付了四个可独立移植的核心：

1. `.baoauto` 包格式和严格校验。
2. 素材目录递归扫描与变更监听。
3. 有执行预算、超时、取消和状态事件的流程解释器。
4. 可运行的 Blockly 中文工作台。

启动工作台：

```bash
npm run demo:automation
```

自动验证：

```bash
npm run probe:automation-workbench
npm test -- --run tests/automation-schema.test.ts tests/automation-assets-package.test.ts tests/automation-runtime.test.ts
```

## `.baoauto` 文件格式

`.baoauto` 是 ZIP 容器，不是不可读的私有二进制格式：

```text
daily-login.baoauto
├── manifest.json
├── workflow.json
└── assets/
    ├── pages/home.png
    └── buttons/start.png
```

`manifest.json` 固定声明格式版本、脚本 ID、工作流入口和素材根目录：

```json
{
  "format": "baoauto",
  "formatVersion": 1,
  "id": "daily-login",
  "name": "每日登录",
  "workflow": "workflow.json",
  "assets": "assets/"
}
```

直接写代码的用户只需编辑同结构的 `workflow.json`。工作台和代码模式最终进入同一个解释器，不维护两套执行逻辑。

## M1 工作流节点

- `sequence`：顺序执行。
- `delay`：等待指定毫秒。
- `wait-image`：轮询等待图片，支持相似度、区域和超时。
- `wait-image-state`：等待图片出现或消失。
- `click-image`：识别后点击，支持按键、次数和中心偏移。
- `move-to-image`：将鼠标移动到识别结果，用于悬停菜单。
- `key-press`：键盘输入和修饰键。
- `text-input`：输入中英文文本，可设置逐字间隔。
- `scroll`：横向或纵向滚轮。
- `navigate` / `reload`：打开 HTTP(S) 页面或刷新当前页面。
- `log`：向运行日志写入用户可读的调试信息。
- `if-image`：根据图片是否出现选择分支。
- `repeat`：有明确次数上限的循环。
- `repeat-until-image`：重复执行直到图片出现或消失，并有最大次数限制。
- `readyWhen`：脚本启动前提；没有识别到时保持未就绪，不执行正文。

## 安全和稳定边界

- 所有 JSON 都经过 Zod 严格校验，未知字段会被拒绝。
- 素材路径只允许包内相对 POSIX 路径，拒绝绝对路径、反斜杠和 `..`。
- ZIP 在解压前根据目录信息限制为 1200 个文件、64MB 解压体积。
- 素材扫描不跟随符号链接，默认限制 1000 个文件、单文件 16MB。
- 单个循环最多 1000 次；执行器默认最多执行 10000 个节点、嵌套 32 层。
- 图片等待必须有超时；执行可由 `AbortSignal` 或运行器取消。
- 找图、点击、按键和时间均通过驱动接口注入，运行器不持有桌面坐标。

## 接回正式项目时的边界

```text
Blockly 工作台 ──生成──> workflow.json
                           │
.baoauto 加载器 ──校验─────┤
                           ▼
                     AutomationRunner
                           │
            BrowserViewAutomationDriver
              ├─ screenshot.capture
              ├─ OpenCV Worker
              └─ transient CDP input
```

M2 已加入 `BrowserViewAutomationDriver` 边界：它负责最小化截图租约、设备像素到 CSS 像素换算、短时 CDP 输入和导航前 debugger 占用检查。正式接入仍需要 OpenCV matcher、标签生命周期协调器和 IPC。

## 暂未进入 M1 的功能

- 正式 BrowserView 驱动及标签生命周期绑定。
- OpenCV Worker、ROI、多尺度和透明 mask。
- 脚本签名、权限声明和来源信任。
- 工作台直接保存 `.baoauto`、素材缩略图和录制器。
- 并行流程、无限循环和任意 JavaScript 积木；这些需要单独安全设计。
