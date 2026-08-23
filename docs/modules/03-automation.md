# 03 · 视觉自动化平台

## 1 范围与目标

自动化平台用 BrowserView 截图和 OpenCV 模板匹配定位网页、Ruffle 或 PPAPI 内容中的可见目标，再通过 CDP 发送可信鼠标和键盘输入。用户通过 Blockly 或 JSON 编辑同一份工作流，并可把工作流和素材打包为 `.baoauto`。

自动化只控制应用内指定标签，不控制桌面或其他应用；密码捕获由 05 模块负责，两者通过 CDP 租约互斥。

## 2 当前结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/automation/service.ts` | 包管理、运行会话、状态、日志、历史、素材测试与取材 |
| `src/main/modules/automation/runtime.ts` | xstate 生命周期与工作流节点执行 |
| `src/main/modules/automation/browserview-driver.ts` | 截图、坐标换算、CDP 输入、助手截图隐藏/恢复 |
| `src/main/modules/automation/vision-worker.cjs` | 独立 worker 中的 OpenCV 匹配与缓存 |
| `src/main/modules/automation/vision-worker-matcher.ts` | worker 协议、请求队列、超时和资源释放 |
| `src/main/modules/automation/native-image-template-provider.ts` | 从已安装包加载模板像素 |
| `src/main/modules/automation/package.ts` | `.baoauto` ZIP 序列化、导入、体积/路径/数量校验 |
| `src/main/modules/automation/assets.ts` | 素材扫描和目录监视 |
| `src/shared/automation/schema.ts`、`types.ts` | 工作流、条件、步骤、manifest 和能力类型 |
| `src/main/ipc/automation.ipc.ts` | 工作台 IPC；所有输入由 zod 验证 |
| `src/renderer/components/automation/` | 工作台、Blockly/JSON 编辑、素材测试台和样式 |
| `src/main/modules/userscripts/bundled-scripts/automation-frame-assistant.user.js` | 页面内悬浮助手 |

## 3 核心流程

### 3.1 编辑与保存

`AutomationPage` 持有当前脚本与工作流，`AutomationBlocklyEditor` 负责 Blockly 与 schema 工作流的转换。切换脚本前必须提交当前编辑器状态；新脚本通过 React `key` 建立独立编辑器实例。JSON 只有经过“校验并应用”后才更新工作流，避免未应用文本覆盖积木。

### 3.2 执行

```
automation:start / debug-start
  → AutomationService 选择已安装包和目标 tab
  → TabManager.beginAutomation(tabId) 获取独占句柄
  → AutomationRunner 按 schema 执行 sequence/condition/loop/input 节点
  → BrowserViewAutomationDriver 截图、匹配、复核并发送 CDP Input
  → 状态、日志和历史写回工作台/侧栏/悬浮助手
  → 完成、取消或异常时释放 worker 请求、按键和 CDP 租约
```

模板匹配默认尝试 `0.75 / 1 / 1.25` 三种缩放。图片组在同一帧中比较多个成员并采用最高分结果；透明素材可使用 alpha 遮罩。

### 3.3 包与素材

`.baoauto` 是 ZIP，包含 manifest、`workflow.json` 和 `assets/`。导入限制为 32 MiB IPC 包、1200 个文件和 64 MiB 解压总量，并拒绝绝对路径、`..`、非图片素材和非法脚本 ID。安装后的包保存在应用数据目录，不从任意包路径执行代码。

### 3.4 悬浮助手

内置用户脚本通过受控 `userscript:automation-*` IPC 读取脚本、状态、素材预览，启动/停止执行并保存框选素材。新页面首次读取历史 `completed` 只初始化 UI；仅实际观察到 `running → completed` 时显示一次完成提示。

## 4 主要接口

- 包与工作流：`automation:list-packages`、`get-package`、`create-package`、`duplicate-package`、`delete-package`、`validate-workflow`、`update-workflow`、`open/install/export-package`。
- 素材：`import-assets`、`link/sync-asset-folder`、`get/delete/replace-asset`、`capture/save-captured-asset`。
- 识别与执行：`warmup-vision`、`test-asset`、`check-ready`、`start`、`debug-start/continue`、`cancel`、`status`。
- 主进程通过 `automation:status-changed` 向渲染层广播结构化状态。

## 5 安全边界与不变量

- 只允许当前有效 BrowserView 和匹配的 WebContents 使用自动化句柄；引擎切换或导航会使旧句柄失效。
- CDP 与密码捕获通过 `cdp-lease.ts` 互斥；导航前必须释放调试器。
- 输入前可重新匹配并检查最大位移，降低动画帧或误识别导致的误点击。
- 所有包、素材和导出路径都必须经过 schema、大小和目录边界检查。
- 自动化不理解业务语义；账号、交易、删除等不可逆操作保留人工确认。

## 6 测试与发布门

- Vitest：`tests/automation-*.test.ts`、`tests/automation-assets-package.test.ts`、`tests/automation-service.test.ts` 等。
- 工作台冒烟：`npm run probe:automation-m4`。
- Web/Ruffle/PPAPI 注册与输入：`npm run probe:automation-m5-engines`。
- 用户脚本助手：`npm run test:userscripts-admin`。
- PPAPI 插件注册可自动验证，但真实游戏渲染、识图和可信输入仍需人工发布回归。

## 7 雷区

1. 不要在脚本切换时仅替换 JSON 文本而保留旧 Blockly workspace。
2. 截图时助手必须短暂隐藏并在 `finally` 中恢复。
3. 取消或失败必须释放已按下按键、worker 请求、调试器和自动化句柄。
4. 修改内置助手后必须运行构建它的用户脚本管理冒烟，避免测试旧 bundle。
