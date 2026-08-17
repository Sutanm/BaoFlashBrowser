# 03 · 视觉自动化平台

## 1 范围与目标

在浏览器内驱动一切可见目标（Flash 游戏、网页）的视觉自动化平台：
- **识别**：OpenCV 模板匹配 + 特征点匹配（ORB）；
- **编排**：Blockly 可视化工作流 → JSON 字节码 → xstate 状态机执行；
- **驱动**：经 CDP `Input.dispatch*` 注入鼠标/键盘（游戏内部阶段），以**图像坐标对齐游戏画布**;
- **内容分发包**：`.baoauto` ZIP 包（清单 + workflow.json + assets/）；
- **悬浮助手**：页面内提示条 + 快捷键，脚本抽认卡可交互。

**边界**：不处理密码（05），但会短时借用 CDP（经 beginAutomation 互斥）。

## 2 静态结构

| 文件 | 职责 |
|---|---|
| `src/main/modules/automation/automation-service.ts` | 服务入口：包发现/解析、执行会话、输出槽、资产解析、来自服务端脚本的远程 URL 加载 |
| `src/main/modules/automation/package.ts` | `.baoauto` 包校验与内容提取（规范化 sources + assets 解压到 `walnut-v1` 空间） |
| `src/main/modules/automation/vision-worker.ts` | OpenCV worker（匹配线程，通过 postMessage 隔离） |
| `src/main/modules/automation/vision-worker-matcher.ts` | worker 内 matcher 实现（模板 + ORB）；`native-image-template-provider.ts` 为 provider 形状 |
| `src/main/modules/automation/automation-runtime.ts` | `createAutomationRuntimeContext` —— xstate 解释器包装、节点执行、内部子状态机（assert/click/...）、末端结果窗口执行 |
| `src/main/modules/automation/browserview-driver.ts` | BrowserView driver：CDP 会话（beginAutomation 令牌）、截图、ImageData→图形、Input 注入恢复、保存门控、页面中断清理 |
| `src/main/modules/automation/screenshot.ts` | 通过 capturePage 取选项卡、配合 visibility 检查的截屏 |
| `src/main/modules/automation/plugin/` | 灰度判断、像素窗口滚动等辅助 |
| `src/main/modules/automation/monkey-patch.ts` | 悬浮助手注入（脚本禁用自动密码填充逻辑） |
| `src/shared/automation/schema.ts` | 包/脚本/工作流/资产 zod **schema 全集**；`opencv`/`tesseract` 可用性 swizzle |
| `src/shared/automation/types.ts` | 共享类型枚举 |
| `src/main/ipc/automation.ipc.ts` | beginAutomation/automation 包/输出/列表/助手工具/资产存储 IPC |
| `src/renderer/components/automation/` | 自动化工作台页（面板 + Blockly 编辑器 + 资产测试床 + 抽认卡助手） |

## 3 核心流程

### 3.1 会话执行

```
beginAutomation(tabId, target)
  ├─ 校验当前活动标签 + 可自动化 URL + 无并发会话
  ├─ 惰性连接 CDP（BrowserWindow debugger attach）× target
  ├─ 截图 → extractColorCanvas2 / ImageData.postLoadScale →
  │   templateMatcher(assets/…) + ORB叉检测 → result{bounds, score}
  ├─ assert→ 断言节点串 xstate
  ├─ click/… → Input.dispatchMouseEvent（相对图中对象中心）
  └─ release()/error → cdp 分离并恢复设备指标
```

### 3.2 字节码与执行

`workflow.json` → 节点列表 → xstate 顶层状态机（`script`/`assert`/`loop`/`fn`/`click`/`pause`…）+ per-node 子状态机；`assert` 与 `loop` 各自含超时/重试策略；顶层 `outputs` 由 `outputAttrs` 区间取值。

### 3.3 包与内容隔离

`.baoauto` → 压缩校验（zip central directory）→ 解压到**会话内临时空间 `walnut-v1`**（服务端来源在 release 后的临时目录）；资产路径经 `isPathWithinDirectory` 强校验，防路径穿越。服务端来源类型允许 `mjit`/`ssskj` 等远程包。

### 3.4 悬浮助手注入

`monkey-patch.ts` 注入页面提示条与快捷键；`Input.dispatchMouseEvent`/`dispatchKeyboardEvent` 落在活动引擎阶段（Ruffle/PPAPI 阶段均可用——CDP 作用于 compositor，不依赖插件）；助手小面板支持资产测试床（点击→服务端接收）。

## 4 数据模型与接口

- `AutomationPackage`（`backend/tools/manifest.json` 化）：`{ name, version, sources[], assets[], dependencies? }`。
- `WorkflowNode`：类型区分 `center/assert/click/pass/wait/output/fn/scroll/loop/end/pause/exit` 等；字段含 `nodeId`、`transform`、`post`、`outputAttrs`。
- `script.json` / `imageAssets.json`：资产清单（匹配在服务端/worker 双端可用）。
- IPC：`beginAutomation`（sendSync 返回令牌）、`automation:next-step`/`start`/`stop`/`waitOutput`、`asset‑store` 上传、`automation:list`、服务端脚本运行期间 CDP Transaction 打包。

## 5 安全边界与不变量

- **beginAutomation 仅当前活动标签**；单会话互斥（并发 begin 拒绝）。
- 令牌制：`assertCurrent(beginAutomation 令牌 + tabId + wc.id)` 校验后才驱动。
- CDP 附着期间**禁止导航**；任何导航/切换先 `releaseAutomation`。
- 资产与输出路径一律 `isPathWithinDirectory`；服务端来源的包只运行于限时临时目录。
- 自动化期间的截图输出走 caption gate（见 07），不泄露敏感画外内容。

## 6 兼容性

- **CDP 无关引擎**：Ruffle 与 PPAPI 标签同驱动（短路子帧差异）。
- OpenCV worker 需 `SharedArrayBuffer`/`crossOriginIsolated` 条件具备（构建期已开 CORS）。
- Tesseract OCR 可选（`openForOcr`/失败回退），平台差异以 `schema.ts` 的可用性 swizzle 暴露。

## 7 测试策略

- Electron smoke：`test:automation`（build-automation-m2-visual → m3-basic-workflow / m4-open-directory → automation-m5-visual-smoke：真实 CDP 骨架执行 + 匹配）。
- 探针：`probe:deep` 系列含自动化运行时探针（`04-logs`、服务端发布包可执行性）。
- 单测：schema 校验、xstate 状态机行为（vitest）。

## 8 雷区与注意事项

1. 自动化与密码捕获共用 CDP，**一次仅一个 debugger**（cdp-lease 串行化，见 05）；导航前必须 teardown。
2. 截屏用 `capturePage` 走**标签内容**，绝不用整窗截屏（宿主 UI 混入）。
3. 匹配对高分屏/缩放须按设备像素比换算（`postLoadScale`），否则坐标漂移。
4. 自动化暂停期间密码填充分配不可进行；显示器切换/引擎切换要重新 beginAutomation。

## 9 演进建议

- 目前依赖 Web 上下文的截屏频率较高；游戏内高帧动画可考虑“单帧+命中盒落点”缓存策略。
- 块级 `loop` 尚无运行时计数上限防御——建议 `npm run build` 前在 schema 上加循环墙。
- `AutomationPage-*.js` chunk 未列进 verifyAsar 清单（见 09），发布时需额外人工核验。