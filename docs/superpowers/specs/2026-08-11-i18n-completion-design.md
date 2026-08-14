# i18n 完善：消灭硬编码中文

## 背景与目标

项目已接入 typesafe-i18n（baseLocale: `zh-CN`，`zh-CN`/`en` 双字典），字典本身完全同步。但存在一批绕过 i18n 的**硬编码中文**，导致英文界面下仍显示中文。本次目标：把用户可见的硬编码字符串全部移入字典，使英文界面完整。

**不翻译**：代码注释、品牌名（百度/B站/7k7k/4399）、设置页的 `简体中文` 语言名（按本语言显示惯例保留）。

## 扫描结果

| 文件 | 数量 | 性质 |
|------|------|------|
| `src/renderer/components/automation/AutomationPage.tsx` | ~44 | 工作台 UI、toast、确认框 |
| `src/renderer/components/automation/AutomationBlocklyEditor.tsx` | ~29 | 积木 message0/message1、toolbox 分类名、下拉选项、错误消息、默认名 |
| `src/renderer/components/panels/AutomationPanel.tsx` | ~28 | 侧栏面板、状态文本、日志 |
| `src/main/modules/automation/service.ts` | ~20 | 状态 message、currentStep、运行日志（主进程 → 渲染层展示） |
| `src/main/ipc/automation.ipc.ts` | ~9 | 原生对话框 title/buttons/filters |
| `src/renderer/components/shell/WindowControls.tsx` | 3 | title 提示 |
| `src/renderer/components/ErrorBoundary.tsx` | 3 | 错误兜底 |
| `src/renderer/App.tsx` | 1 | Suspense fallback |
| `src/main/ipc/download.ipc.ts` | 1 | 对话框 title |
| `src/main/ipc/screenshot.ipc.ts` | 1 | 对话框 title |
| `src/main/ipc/userscripts-admin.ipc.ts` | 3 | 对话框 title |

其余匹配均为代码注释，不改。

## 关键决策（已确认）

1. **主进程自动化消息**：结构化 key（A 方案）——主进程发 `AutomationMessage`（key+参数），渲染层翻译。
2. **Blockly 积木**：完整 i18n（A 方案）——locale 变化时重建定义并重新注入 workspace。
3. **对话框标题**：渲染层传标题（A 方案）——调用方在 IPC payload 里带上翻译后的文本，主进程直接用。
4. 品牌名 / 语言名保留原名。

## 设计一：结构化消息类型

在 `src/shared/automation/types.ts` 新增联合类型 `AutomationMessage`，覆盖 service.ts 里所有动态消息：

```ts
export type AutomationMessage =
  | { key: 'status.checkingAsset'; params: { asset: string } }
  | { key: 'status.assetMatch'; params: { score: string } }        // score 为 (x*100).toFixed(1)，模板带 % 号
  | { key: 'status.assetNoMatch'; params: { asset: string } }
  | { key: 'status.readyCheckFailed'; params: { detail: string } }
  | { key: 'status.runFailed'; params: { detail: string } }
  | { key: 'status.assetTestStopped'; params: { detail: string } }
  | { key: 'status.assetTestFailed'; params: { detail: string } }
  | { key: 'status.stepNext' }
  | { key: 'status.scriptCompleted' }
  | { key: 'status.scriptStopped' }
  | { key: 'status.imageMatch'; params: { asset: string; score: string; ms: string } }  // ms 为 toFixed(0) 或 '?'
  | { key: 'status.pausedNext'; params: { step: AutomationMessage } }
  | { key: 'step.sequence' }
  | { key: 'step.waitImage'; params: { asset: string } }
  | { key: 'step.waitImageState'; params: { asset: string; state: 'visible' | 'hidden' } }
  | { key: 'step.clickImage'; params: { asset: string } }
  | { key: 'step.moveToImage'; params: { asset: string } }
  | { key: 'step.delay'; params: { ms: number } }
  | { key: 'step.keyPress'; params: { key: string } }
  | { key: 'step.keyHoldUntilImage'; params: { key: string; state: 'visible' | 'hidden'; asset: string } }
  | { key: 'step.textInput' }
  | { key: 'step.scroll' }
  | { key: 'step.navigate' }
  | { key: 'step.reload' }
  | { key: 'step.log'; params: { message: string } }
  | { key: 'step.ifImage'; params: { asset: string } }
  | { key: 'step.repeat'; params: { times: number } }
  | { key: 'step.repeatUntilImage'; params: { asset: string } }
  | { key: 'raw'; params: { text: string } };  // 用户脚本 log 步骤的原文，不做结构化
```

`service.ts` 改动点：

- `AutomationServiceStatus.message`、`currentStep` 类型从 `string` 改为 `AutomationMessage`。
- `AutomationLogEntry.message` 从 `string` 改为 `AutomationMessage`。
- `describeStep(step)` 返回 `AutomationMessage`（而非字符串拼接）。
- `appendLog`、`setStatus` 的所有调用处改为构造 `AutomationMessage`。
- 运行日志的 `status.message`（来自 `log` 步骤）用 `{ key: 'raw', params: { text: event.message } }`。
- `step-paused` 消息用 `{ key: 'status.pausedNext', params: { step: description } }`。

**设计权衡**：`step.state`（visible/hidden）用布尔/枚举参数，翻译文本按 locale 选“出现/消失”或 "appear/disappear"，通过字典内分支逻辑处理（见设计二 `service.state` 子命名空间）。

**渲染层消费**：`AutomationPanel.tsx` 新增一个纯函数 `resolveMessage(msg: AutomationMessage): string`，接收 `LL`，通过 switch 把每个 key 映射到 `LL.automation.service.*` 调用。`raw` 直接返回 `text`。

## 设计二：字典结构

在 `zh-CN/index.ts` 与 `en/index.ts` 各新增 `automation` 命名空间，结构：

```ts
automation: {
  // 工作台页面（AutomationPage）
  page: {
    title: '自动化工作台',
    subtitle: '搭建脚本、管理识别素材，并在目标网页的自动化侧栏中运行。',
    newScript: '新建脚本',
    importPackage: '导入 .baoauto',
    exportPackage: '导出脚本包',
    saveChanges: '保存修改',
    warningDisabled: '当前版本可以创建和编辑脚本；网页识别与执行仍处于实验开关关闭状态。',
    libraryTitle: '脚本库',
    assetCount: '{count} 个素材',
    duplicateTitle: '复制脚本',
    deleteTitle: '删除脚本',
    emptyLibrary: '还没有脚本',
    emptyLibraryHint: '新建脚本或导入工作台导出的 `.baoauto` 文件。',
    assetsTitle: '识别素材',
    mergeAssetsTitle: '合并素材目录',
    add: '添加',
    noAssetsHint: '这个脚本尚未包含图片素材。',
    assetReferenced: '正在被脚本引用，不能删除',
    assetUnreferenced: '当前未被脚本引用',
    replace: '替换',
    deleteAssetTitle: '删除素材',
    removeAssetReferenceHint: '请先从积木中移除该素材引用',
    name: '脚本名称',
    id: '脚本 ID',
    description: '说明',
    blocksTab: '积木编辑',
    jsonTab: 'JSON 代码',
    applyJson: '校验并应用 JSON',
    emptyEditorTitle: '选择或导入一个脚本',
    emptyEditorHint: '脚本会显示在左侧脚本库中。',
    createDialogTitle: '新建自动化脚本',
    duplicateDialogTitle: '复制自动化脚本',
    dialogIdHint: '脚本 ID 将用于文件名，创建后不能直接修改。',
    creating: '正在创建…',
    create: '创建脚本',
    cancel: '取消',
    // notice / toast
    noticeImported: '已导入 {name}',
    noticeCreated: '新脚本已创建并持久保存',
    noticeDuplicated: '脚本副本已创建',
    noticeDeleted: '脚本已删除',
    noticeMerged: '素材目录已合并，共 {count} 个素材',
    noticeReplaced: '素材 {asset} 已替换',
    noticeAssetDeleted: '素材 {asset} 已删除',
    noticeLoaded: '脚本已载入',
    noticeSaved: '积木修改已保存到当前脚本包',
    noticeJsonApplied: 'JSON 已校验并同步到积木',
    noticeExported: '已导出到 {path}',
    noticeFallbackPath: '所选位置',
    noticeInitial: '导入脚本包或新建脚本后即可编辑',
    loading: '正在加载自动化工作台…',
    deletePackageConfirm: '确定删除"{name}"吗？此操作会删除已安装的脚本包。',
    deleteAssetConfirm: '确定删除素材"{asset}"吗？',
    draftDefaultName: '新自动化脚本',
    copySuffix: '{name} 副本',
  },
  // 侧栏面板（AutomationPanel）
  panel: {
    openWorkbench: '打开自动化工作台',
    notEnabled: '当前版本尚未启用自动化执行能力。',
    scripts: '脚本',
    import: '导入',
    emptyPackage: '先导入一个 `.baoauto` 脚本包',
    assetMeta: '{count} 个识别素材 · {id}',
    currentStep: '第 {count} 步 · {step}',
    webTargetHint: '当前网页可作为执行目标',
    switchTargetHint: '请切换到要操作的网页',
    captureAsset: '从当前网页截取素材',
    dragToSelect: '拖动框选识别区域',
    captureAlt: '当前网页截图',
    selectedRect: '已选 {w} × {h}',
    dragHint: '按住鼠标拖动框选',
    saveAsAsset: '保存为脚本素材',
    assetNamePlaceholder: 'captures/button.png',
    assetTestTitle: '素材识别测试',
    thresholdAria: '识别阈值',
    testOnPage: '在当前网页测试',
    matchResult: '匹配 {score}% · 位置 {x}, {y} · {w} × {h}{ms}',
    matchResultMs: ' · {ms}ms',
    matchFail: '未达到当前阈值，请检查素材或降低阈值。',
    debugStart: '单步启动',
    debugNext: '下一步',
    runLog: '运行日志',
    logEmpty: '运行或单步调试后，步骤和错误会显示在这里。',
    checkReady: '检查就绪',
    countdownStart: '3 秒启动',
    startNow: '立即启动',
    stop: '停止',
    replaceAssetConfirm: '素材"{asset}"已经存在，是否替换？',
    assetSaved: '已保存素材 {asset}（{w} × {h}）',
    // 状态文本（状态卡标题）
    status: {
      idle: '等待检查', checking: '正在识别', ready: '已经就绪', countdown: '倒计时中',
      running: '正在执行', completed: '执行完成', failed: '执行失败', cancelled: '已停止',
    },
  },
  // Blockly 编辑器（AutomationBlocklyEditor）
  blockly: {
    workspaceNotReady: '积木工作区尚未就绪',
    requireOneStart: '工作区必须且只能有一个入口积木',
    unsupportedBlock: '不支持的积木：{type}',
    defaultWorkflowName: '新自动化脚本',
    startUnconditional: '无条件启动',
    execute: '执行 %1',
    start: '识别到 %1 相似度 %2 时就绪',
    waitImage: '等待图片 %1 相似度 %2 超时 %3 毫秒',
    waitImageState: '等待图片 %1 %2 超时 %3 毫秒',
    clickImage: '点击图片 %1 %2 %3 次 相似度 %4',
    moveToImage: '移动到图片 %1 相似度 %2',
    delay: '等待 %1 毫秒',
    keyPress: '按键 %1',
    keyCombo: '组合键 Ctrl %1 Alt %2 Shift %3 Win %4 + %5',
    holdKeyUntilImage: '按住 %1 直到图片 %2 %3 超时 %4 毫秒',
    textInput: '输入文本 %1 间隔 %2 毫秒',
    scroll: '滚轮 横向 %1 纵向 %2',
    navigate: '打开网址 %1',
    reload: '刷新当前页面',
    log: '记录日志 %1',
    ifImage: '如果 %1 图片 %2 相似度 %3',
    then: '那么 %1',
    otherwise: '否则 %1',
    repeat: '重复 %1 次',
    repeatUntilImage: '重复直到图片 %1 %2 最多 %3 次',
    // 下拉选项
    visible: '出现', hidden: '消失',
    leftButton: '左键', rightButton: '右键', middleButton: '中键',
    found: '识别到', notFound: '未识别到',
    // 默认字段文本
    logSample: '执行到这里',
    textSample: '你好',
    // toolbox 分类
    catEntry: '入口', catImage: '图像', catInput: '输入', catPage: '页面', catFlow: '流程', catDebug: '调试',
  },
  // 主进程结构化消息（service.ts → AutomationPanel 消费）
  service: {
    state: { visible: '出现', hidden: '消失' },
    status: {
      checkingAsset: '测试素材 {asset}',
      assetMatch: '素材匹配成功，分数 {score}%',
      assetNoMatch: '未识别到素材 {asset}',
      readyCheckFailed: '就绪检查失败：{detail}',
      runFailed: '执行失败：{detail}',
      assetTestStopped: '素材测试已停止：{detail}',
      assetTestFailed: '素材测试失败：{detail}',
      stepNext: '正在执行下一步',
      scriptCompleted: '脚本执行完成',
      scriptStopped: '脚本已停止',
      imageMatch: '识别到 {asset} · {score}% · {ms}ms',
      pausedNext: '已暂停，下一步：{step}',
    },
    step: {
      sequence: '执行流程',
      waitImage: '等待图片 {asset}',
      waitImageState: '等待图片{state} {asset}',
      clickImage: '点击图片 {asset}',
      moveToImage: '移动到图片 {asset}',
      delay: '等待 {ms} 毫秒',
      keyPress: '按键 {key}',
      keyHoldUntilImage: '按住 {key} 直到图片{state} {asset}',
      textInput: '输入文本',
      scroll: '滚动页面',
      navigate: '打开网页',
      reload: '刷新页面',
      log: '日志 {message}',
      ifImage: '判断图片 {asset}',
      repeat: '重复 {times} 次',
      repeatUntilImage: '重复直到 {asset}',
    },
  },
  // 原生对话框（IPC）
  ipc: {
    openPackageTitle: '打开自动化脚本包',
    openPackageFilter: 'BaoFlash 自动化脚本',
    replace: '替换',
    packageExistsTitle: '脚本已经存在',
    packageExistsMessage: '脚本库中已有相同 ID 的脚本，是否使用导入文件替换？',
    replaceAssetTitle: '替换素材 {asset}',
    imageAssetFilter: '图片素材',
    selectAssetDir: '选择素材目录',
    exportPackageTitle: '导出自动化脚本包',
  },
}
```

**Blockly 积木定义注意点**：Blockly 的 `message0` 用 `%1`/`%2` 占位符，而 typesafe-i18n 用 `{param}` 插值。积木定义字符串**必须保留 `%N` 占位符**，不经过 LL 参数插值——直接用 `LL.automation.blockly.waitImage()`（无参调用返回含 `%N` 的模板串）。其余字段名/值保持不变。

`en` 字典需翻译同结构，占位符与插值写法一致（`{asset}`、`%N`）。

## 设计三：Blockly 完整 i18n（重建注入）

`AutomationBlocklyEditor.tsx` 改造：

1. **模块级注册改为 locale 感知**：
   - 移除 `registered` 一次性标志。
   - `blockDefinitions` / `toolbox` 从模块常量改为工厂函数 `buildBlockDefinitions(LL)` / `buildToolbox(LL)`，从 `LL.automation.blockly.*` 取文本。
2. **`Blockly.setLocale` 随 locale 切换**：`locale === 'en' ? en : zhHans`，其中 `en` 从 `blockly/msg/en` 导入。
3. **locale 变化时重建 workspace**：
   - `useI18nContext()` 取当前 `locale`，作为 `useEffect` 依赖。
   - 变化时：记录当前 workspace 的 XML（`Blockly.Xml.workspaceToDom`），`workspace.dispose()`，重新 `defineBlocksWithJsonArray(buildBlockDefinitions(LL))`，重新 `Blockly.inject`，再用 `Blockly.Xml.domToWorkspace` 恢复积木布局（保留用户未保存的编辑）。
   - 首次挂载逻辑与现有代码一致（toolbox 颜色、MutationObserver、ResizeObserver 等一并重建）。
4. **默认工作流名**：`loadIntoWorkspace` 的 fallback 名改用 `LL.automation.blockly.defaultWorkflowName()`（或由父组件传入）。
5. **编译期错误消息**：`compile()` 的 `不支持的积木`/`积木工作区尚未就绪`/`工作区必须且只能有一个入口积木` 改抛带 key 的错误，或直接由 `AutomationPage` 捕获后翻译。**简化做法**：这些错误字符串直接改为 `LL.automation.blockly.*`（编辑器内可通过 hook 取到 LL）。

**注入重建的边界**：
- 编辑器随 `key={selectedId}` 已由 `AutomationPage` 重挂载，locale 重建只在 settings 语言切换时发生（低频）。
- `AutomationPage` 的 `saveBlocks` 在编译异常时已 `catch` 并把 `error.message` 显示到 notice——需同步处理（编辑器抛出的中文错误改为 LL 文本）。

## 设计四：对话框标题由渲染层传入

改 IPC 入参签名，调用方在 payload 里带翻译后的文本。涉及：

| 通道 | 现有签名 | 改动 |
|------|---------|------|
| `download:set-dir` | 无参 | 加 `{ title }` |
| `screenshot:set-dir` | 无参 | 加 `{ title }` |
| `automation:open-package` | `{}` | 加 `{ title, filterName, replace, cancel, existsTitle, existsMessage }` |
| `automation:replace-asset` | `{ packageId, asset }` | 加 `{ title, filterName }` |
| `automation:import-assets` | `{ packageId }` | 加 `{ title }` |
| `automation:export-package` | `{ packageId }` | 加 `{ title, filterName }` |
| `userscripts:install-file` | `{}` | 加 `{ title }` |
| `userscripts:export-source` | `{ id }` | 加 `{ title }` |

- preload 侧新增 `safeInvoke` 入参（每个通道的 `electronAPI.*` 方法加可选 `i18n?: {...}` 或显式参数），**渲染层调用处**用 `LL.automation.ipc.*` / `LL.download.*` 等传入。
- IPC handler 用 `payload.title ?? '默认值'` 兜底，避免破坏现有调用方与测试。
- 由于 dialog 只接受字符串，主进程不感知 locale，翻译完全来自渲染层。

**注意**：`download:set-dir`、`screenshot:set-dir`、`userscripts:install-file`、`userscripts:export-source` 的标题分别放各自命名空间（`download.*`、`screenshot.*`、`userscript.*`），`automation:*` 的放 `automation.ipc.*`。

## 设计五：零散组件

- `WindowControls.tsx`：3 个 title 改用 `LL.win.minimize/maximize/restore/close`（`win` 命名空间已有对应 key）。
- `ErrorBoundary.tsx`：类组件不能直接用 hook → 包一层函数组件或读取 `useI18nContext`（ErrorBoundary 挂在 `App` 内、`TypesafeI18n` Provider 之下，可用 hook）。3 个文本改用 `LL.error.title` / `LL.error.default` / `LL.retry`。
- `App.tsx` Suspense fallback：`正在加载自动化工作台…` 改用 `LL.automation.page.loading`（新增 key）。

## 验证

1. `npm run i18n`（新增字典 key 后重新生成 types）。
2. `npm run typecheck`。
3. `npm run lint`。
4. `npm test -- --run`（自动化 service 单测需适配 `AutomationMessage` 结构；`automation-service.test.ts` 断言的是 package 名称/资产，受影响较小，但需检查 status/log 相关断言）。
5. 手动验证：切到英文界面，检查
   - `about:automation` 工作台全部文本为英文；
   - Blockly 积木/toolbox/下拉/右键菜单为英文；
   - 自动化侧栏状态文本、日志为英文；
   - 下载/截图/用户脚本对话框标题为英文；
   - 切换语言后 Blockly 积木布局不丢失。

## 不做的事

- 不翻译代码注释与内部错误（如 `automation asset is missing`，仅在主进程日志出现，不经 UI）。
- 不翻译品牌名与语言名。
- 不引入主进程 i18n 字典（对话框标题走渲染层传入）。
- 不升级 typesafe-i18n / Blockly / Electron。
