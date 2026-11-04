# i18n 完善实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消灭项目内所有绕过 i18n 的硬编码中文，使英文界面完整（渲染层组件 + 主进程自动化消息 + Blockly 积木 + 原生对话框标题）。

**Architecture:** 新增 `automation` i18n 命名空间。主进程 `service.ts` 把动态消息改为结构化 `AutomationMessage`（key+参数），渲染层 `AutomationPanel` 用 `LL.automation.service.*` 翻译。Blockly 编辑器改为 locale 感知（重建定义 + 重注入，保留 XML 状态）。原生对话框标题由渲染层通过 IPC payload 传入。

**Tech Stack:** typesafe-i18n 5.27.1、React、Blockly 10.4.3、Electron 11、vitest。

## Global Constraints

- Electron 11.5.0 / Chromium 87 锁定，永不升级。
- baseLocale 为 `zh-CN`；`zh-CN/index.ts` 用 `BaseTranslation` 类型，`en/index.ts` 用 `Translation` 类型，两者 key 必须完全一致。
- 字典改动后必须跑 `npm run i18n` 重新生成 `i18n-types.ts`，否则 typecheck 失败。
- Blockly 积木 message0 使用 `%N` 占位符（非 `{param}`），积木定义串不做 LL 参数插值，直接 `LL.automation.blockly.*()` 无参调用。
- `src/renderer/i18n/` 下的生成文件（`i18n-types.ts`、`i18n-react.tsx`、`i18n-util*`）禁止手改。
- 不翻译：代码注释、品牌名（百度/B站/7k7k/4399）、`SettingsPanel` 的 `简体中文` 语言名。
- `npm run build` 不重建 `release/tests/` 产物；本次不改 userscript/session 相关源码，无 smoke 重建要求。
- 每个 IPC handler 的对话框标题必须保留 `?? 默认值` 兜底，避免破坏既有调用与测试。
- 服务单测 `tests/automation-service.test.ts` 通过 vitest 运行：`npx vitest run tests/automation-service.test.ts`。

---

### Task 1: 字典新增 `automation` 命名空间 + 零散对话框标题 key

**Files:**
- Modify: `src/renderer/i18n/zh-CN/index.ts`（新增 `automation` 命名空间，插在 `error` 之前）
- Modify: `src/renderer/i18n/en/index.ts`（同结构英文翻译）
- Generated: `src/renderer/i18n/i18n-types.ts`（`npm run i18n` 重新生成）

**Interfaces:**
- Produces: `LL.automation.page.*`、`LL.automation.panel.*`、`LL.automation.blockly.*`、`LL.automation.service.*`、`LL.automation.ipc.*`、`LL.settings.screenshot.dialogTitle`、`LL.userscript.installFileDialogTitle`、`LL.userscript.exportDialogTitle`。后续所有任务依赖这些 key。

- [ ] **Step 1: 在 zh-CN 字典新增 `automation` 命名空间**

在 `src/renderer/i18n/zh-CN/index.ts` 的 `// 错误` 注释之前插入：

```ts
  // 自动化
  automation: {
    page: {
      title: '自动化工作台',
      subtitle: '搭建脚本、管理识别素材，并在目标网页的自动化侧栏中运行。',
      loading: '正在加载自动化工作台…',
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
      deletePackageConfirm: '确定删除"{name}"吗？此操作会删除已安装的脚本包。',
      deleteAssetConfirm: '确定删除素材"{asset}"吗？',
      draftDefaultName: '新自动化脚本',
      copySuffix: '{name} 副本',
    },
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
      status: {
        idle: '等待检查', checking: '正在识别', ready: '已经就绪', countdown: '倒计时中',
        running: '正在执行', completed: '执行完成', failed: '执行失败', cancelled: '已停止',
      },
    },
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
      visible: '出现',
      hidden: '消失',
      leftButton: '左键',
      rightButton: '右键',
      middleButton: '中键',
      found: '识别到',
      notFound: '未识别到',
      logSample: '执行到这里',
      textSample: '你好',
      catEntry: '入口',
      catImage: '图像',
      catInput: '输入',
      catPage: '页面',
      catFlow: '流程',
      catDebug: '调试',
    },
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
  },
```

同时新增两个零散 key：

- 在 `settings.screenshot` 内追加 `dialogTitle: '选择截图保存目录',`。
- 在 `userscript` 内追加 `installFileDialogTitle: '安装用户脚本',` 和 `exportDialogTitle: '导出脚本',`。

- [ ] **Step 2: 在 en 字典新增同结构英文翻译**

在 `src/renderer/i18n/en/index.ts` 的 `error:` 之前插入 `automation` 命名空间（英文翻译）：

```ts
  automation: {
    page: {
      title: 'Automation Workbench',
      subtitle: 'Build scripts, manage recognition assets, and run them from the automation sidebar on a target page.',
      loading: 'Loading Automation Workbench…',
      newScript: 'New Script',
      importPackage: 'Import .baoauto',
      exportPackage: 'Export Package',
      saveChanges: 'Save Changes',
      warningDisabled: 'This build can create and edit scripts; page recognition and execution are still behind the experimental switch.',
      libraryTitle: 'Script Library',
      assetCount: '{count} assets',
      duplicateTitle: 'Duplicate Script',
      deleteTitle: 'Delete Script',
      emptyLibrary: 'No Scripts Yet',
      emptyLibraryHint: 'Create a script or import a `.baoauto` file exported from the workbench.',
      assetsTitle: 'Recognition Assets',
      mergeAssetsTitle: 'Merge Asset Folder',
      add: 'Add',
      noAssetsHint: 'This script has no image assets yet.',
      assetReferenced: 'Referenced by the script, cannot be deleted',
      assetUnreferenced: 'Not referenced by the script',
      replace: 'Replace',
      deleteAssetTitle: 'Delete Asset',
      removeAssetReferenceHint: 'Remove the asset references from the blocks first',
      name: 'Script Name',
      id: 'Script ID',
      description: 'Description',
      blocksTab: 'Blocks',
      jsonTab: 'JSON Code',
      applyJson: 'Validate and Apply JSON',
      emptyEditorTitle: 'Select or Import a Script',
      emptyEditorHint: 'Scripts appear in the library on the left.',
      createDialogTitle: 'New Automation Script',
      duplicateDialogTitle: 'Duplicate Automation Script',
      dialogIdHint: 'The script ID is used in the file name and cannot be changed after creation.',
      creating: 'Creating…',
      create: 'Create Script',
      cancel: 'Cancel',
      noticeImported: 'Imported {name}',
      noticeCreated: 'Script created and persisted',
      noticeDuplicated: 'Script copy created',
      noticeDeleted: 'Script deleted',
      noticeMerged: 'Asset folder merged, {count} assets total',
      noticeReplaced: 'Asset {asset} replaced',
      noticeAssetDeleted: 'Asset {asset} deleted',
      noticeLoaded: 'Script loaded',
      noticeSaved: 'Block changes saved to the current script package',
      noticeJsonApplied: 'JSON validated and synced to the blocks',
      noticeExported: 'Exported to {path}',
      noticeFallbackPath: 'selected location',
      noticeInitial: 'Import a script package or create a new script to get started.',
      deletePackageConfirm: 'Delete "{name}"? This will remove the installed script package.',
      deleteAssetConfirm: 'Delete asset "{asset}"?',
      draftDefaultName: 'New Automation Script',
      copySuffix: '{name} Copy',
    },
    panel: {
      openWorkbench: 'Open Automation Workbench',
      notEnabled: 'Automation execution is not enabled in this build.',
      scripts: 'Scripts',
      import: 'Import',
      emptyPackage: 'Import a `.baoauto` script package first',
      assetMeta: '{count} recognition assets · {id}',
      currentStep: 'Step {count} · {step}',
      webTargetHint: 'The current page can be used as the execution target',
      switchTargetHint: 'Switch to the page to operate on',
      captureAsset: 'Capture Asset from Current Page',
      dragToSelect: 'Drag to Select Recognition Area',
      captureAlt: 'Current page screenshot',
      selectedRect: 'Selected {w} × {h}',
      dragHint: 'Press and drag to select an area',
      saveAsAsset: 'Save as Script Asset',
      assetNamePlaceholder: 'captures/button.png',
      assetTestTitle: 'Asset Recognition Test',
      thresholdAria: 'Recognition threshold',
      testOnPage: 'Test on Current Page',
      matchResult: 'Match {score}% · Position {x}, {y} · {w} × {h}{ms}',
      matchResultMs: ' · {ms}ms',
      matchFail: 'Below the current threshold. Check the asset or lower the threshold.',
      debugStart: 'Step Start',
      debugNext: 'Next Step',
      runLog: 'Run Log',
      logEmpty: 'Steps and errors will appear here after running or stepping.',
      checkReady: 'Check Readiness',
      countdownStart: '3s Start',
      startNow: 'Start Now',
      stop: 'Stop',
      replaceAssetConfirm: 'Asset "{asset}" already exists. Replace it?',
      assetSaved: 'Asset {asset} saved ({w} × {h})',
      status: {
        idle: 'Awaiting Check', checking: 'Recognizing', ready: 'Ready', countdown: 'Countdown',
        running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped',
      },
    },
    blockly: {
      workspaceNotReady: 'Block workspace not ready',
      requireOneStart: 'The workspace must have exactly one entry block',
      unsupportedBlock: 'Unsupported block: {type}',
      defaultWorkflowName: 'New Automation Script',
      startUnconditional: 'Start unconditionally',
      execute: 'do %1',
      start: 'Ready when %1 matches %2',
      waitImage: 'Wait for image %1 at %2 for %3 ms',
      waitImageState: 'Wait for image %1 %2 for %3 ms',
      clickImage: 'Click image %1 with %2 %3 time(s) at %4',
      moveToImage: 'Move to image %1 at %2',
      delay: 'Wait %1 ms',
      keyPress: 'Press key %1',
      keyCombo: 'Key combo Ctrl %1 Alt %2 Shift %3 Win %4 + %5',
      holdKeyUntilImage: 'Hold %1 until image %2 %3 for %4 ms',
      textInput: 'Type text %1 every %2 ms',
      scroll: 'Scroll horizontal %1 vertical %2',
      navigate: 'Open URL %1',
      reload: 'Reload current page',
      log: 'Log %1',
      ifImage: 'If %1 image %2 matches %3',
      then: 'then %1',
      otherwise: 'else %1',
      repeat: 'Repeat %1 times',
      repeatUntilImage: 'Repeat until image %1 %2, max %3 times',
      visible: 'appears',
      hidden: 'disappears',
      leftButton: 'Left',
      rightButton: 'Right',
      middleButton: 'Middle',
      found: 'recognized',
      notFound: 'not recognized',
      logSample: 'reached here',
      textSample: 'Hello',
      catEntry: 'Entry',
      catImage: 'Image',
      catInput: 'Input',
      catPage: 'Page',
      catFlow: 'Flow',
      catDebug: 'Debug',
    },
    service: {
      state: { visible: 'appears', hidden: 'disappears' },
      status: {
        checkingAsset: 'Testing asset {asset}',
        assetMatch: 'Asset matched, score {score}%',
        assetNoMatch: 'Asset {asset} not recognized',
        readyCheckFailed: 'Readiness check failed: {detail}',
        runFailed: 'Execution failed: {detail}',
        assetTestStopped: 'Asset test stopped: {detail}',
        assetTestFailed: 'Asset test failed: {detail}',
        stepNext: 'Executing next step',
        scriptCompleted: 'Script completed',
        scriptStopped: 'Script stopped',
        imageMatch: 'Recognized {asset} · {score}% · {ms}ms',
        pausedNext: 'Paused, next: {step}',
      },
      step: {
        sequence: 'Run sequence',
        waitImage: 'Wait for image {asset}',
        waitImageState: 'Wait for image to {state} {asset}',
        clickImage: 'Click image {asset}',
        moveToImage: 'Move to image {asset}',
        delay: 'Wait {ms} ms',
        keyPress: 'Press key {key}',
        keyHoldUntilImage: 'Hold {key} until image {state} {asset}',
        textInput: 'Type text',
        scroll: 'Scroll page',
        navigate: 'Open page',
        reload: 'Reload page',
        log: 'Log {message}',
        ifImage: 'Check image {asset}',
        repeat: 'Repeat {times} times',
        repeatUntilImage: 'Repeat until {asset}',
      },
    },
    ipc: {
      openPackageTitle: 'Open Automation Script Package',
      openPackageFilter: 'BaoFlash Automation Scripts',
      replace: 'Replace',
      packageExistsTitle: 'Script Already Exists',
      packageExistsMessage: 'A script with the same ID already exists. Replace it with the imported file?',
      replaceAssetTitle: 'Replace Asset {asset}',
      imageAssetFilter: 'Image Assets',
      selectAssetDir: 'Select Asset Folder',
      exportPackageTitle: 'Export Automation Script Package',
    },
  },
```

同时追加零散 key：

- `settings.screenshot` 内追加 `dialogTitle: 'Choose Screenshot Folder',`。
- `userscript` 内追加 `installFileDialogTitle: 'Install Userscript',` 和 `exportDialogTitle: 'Export Script',`。

- [ ] **Step 3: 重新生成 i18n types**

Run: `npm run i18n`
Expected: 生成 `src/renderer/i18n/i18n-types.ts`，包含 `automation` 命名空间。无错误输出。

- [ ] **Step 4: typecheck 验证**

Run: `npm run typecheck`
Expected: 通过（此时尚无消费方，但字典结构必须合法）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/i18n/zh-CN/index.ts src/renderer/i18n/en/index.ts src/renderer/i18n/i18n-types.ts
git commit -m "feat(i18n): 新增 automation 命名空间与对话框标题 key"
```

---

### Task 2: 主进程结构化消息类型 `AutomationMessage`

**Files:**
- Modify: `src/shared/automation/types.ts`（追加 `AutomationMessage` 联合类型）
- Modify: `src/renderer/types/electron.d.ts`（`AutomationStatus.message`/`currentStep`/`logs[].message` 改为 `AutomationMessage`）

**Interfaces:**
- Consumes: 无（自包含）。
- Produces: `AutomationMessage` 类型。Task 3 的 `service.ts` 与 Task 4 的渲染层 resolver 都依赖它。注意该类型自引用（`status.pausedNext.params.step: AutomationMessage`），TS 联合类型支持自引用。

- [ ] **Step 1: 在 `src/shared/automation/types.ts` 末尾追加类型**

在文件末尾追加：

```ts
export type AutomationMessage =
  | { key: 'status.checkingAsset'; params: { asset: string } }
  | { key: 'status.assetMatch'; params: { score: string } }
  | { key: 'status.assetNoMatch'; params: { asset: string } }
  | { key: 'status.readyCheckFailed'; params: { detail: string } }
  | { key: 'status.runFailed'; params: { detail: string } }
  | { key: 'status.assetTestStopped'; params: { detail: string } }
  | { key: 'status.assetTestFailed'; params: { detail: string } }
  | { key: 'status.stepNext' }
  | { key: 'status.scriptCompleted' }
  | { key: 'status.scriptStopped' }
  | { key: 'status.imageMatch'; params: { asset: string; score: string; ms: string } }
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
  | { key: 'raw'; params: { text: string } };
```

- [ ] **Step 2: 更新 `electron.d.ts` 的 `AutomationStatus`**

在 `src/renderer/types/electron.d.ts` 顶部 import 追加：

```ts
import type { AutomationMessage } from '@shared/automation/types';
```

把 `interface AutomationStatus`（第 82-96 行）的字段改为：

```ts
interface AutomationStatus {
  enabled: boolean;
  state: 'idle' | 'checking' | 'ready' | 'countdown' | 'running' | 'completed' | 'failed' | 'cancelled';
  packageId?: string;
  workflowName?: string;
  tabId?: string;
  message?: AutomationMessage;
  currentStep?: AutomationMessage;
  executedSteps?: number;
  debugMode?: boolean;
  debugPaused?: boolean;
  logs?: Array<{
    id: number; timestamp: number; level: 'info' | 'success' | 'warning' | 'error'; message: AutomationMessage; step?: number;
  }>;
}
```

- [ ] **Step 3: 验证类型**

Run: `npx vitest run tests/automation-service.test.ts`
Expected: 通过（`service.ts` 尚未改动，但 `electron.d.ts` 类型独立编译通过）。同时跑 `npm run typecheck` 确认 renderer 类型无误。

- [ ] **Step 4: Commit**

```bash
git add src/shared/automation/types.ts src/renderer/types/electron.d.ts
git commit -m "feat(automation): 新增结构化消息类型 AutomationMessage"
```

---

### Task 3: 主进程 `service.ts` 改为发出结构化消息

**Files:**
- Modify: `src/main/modules/automation/service.ts`

**Interfaces:**
- Consumes: `AutomationMessage`（Task 2）。
- Produces: `AutomationServiceStatus.message: AutomationMessage | undefined`、`currentStep: AutomationMessage | undefined`、`AutomationLogEntry.message: AutomationMessage`。渲染层 Task 4 按此结构消费。

- [ ] **Step 1: 改 `AutomationServiceStatus` 与 `AutomationLogEntry` 类型**

在 `service.ts` 顶部 import 增加 `AutomationMessage`：

```ts
import type { AutomationMessage, AutomationStep, AutomationWorkflow } from '../../../shared/automation/types';
```

把第 15-35 行类型定义改为：

```ts
export type AutomationServiceStatus = {
  enabled: boolean;
  state: AutomationRunnerState;
  packageId?: string;
  workflowName?: string;
  tabId?: string;
  message?: AutomationMessage;
  currentStep?: AutomationMessage;
  executedSteps?: number;
  debugMode?: boolean;
  debugPaused?: boolean;
  logs?: AutomationLogEntry[];
};

export type AutomationLogEntry = {
  id: number;
  timestamp: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: AutomationMessage;
  step?: number;
};
```

- [ ] **Step 2: 改写 `describeStep` 返回结构化消息**

把 `describeStep` 方法整体替换为：

```ts
  private describeStep(step: AutomationStep): AutomationMessage {
    switch (step.type) {
      case 'sequence': return { key: 'step.sequence' };
      case 'wait-image': return { key: 'step.waitImage', params: { asset: step.asset } };
      case 'wait-image-state': return { key: 'step.waitImageState', params: { asset: step.asset, state: step.state } };
      case 'click-image': return { key: 'step.clickImage', params: { asset: step.asset } };
      case 'move-to-image': return { key: 'step.moveToImage', params: { asset: step.asset } };
      case 'delay': return { key: 'step.delay', params: { ms: step.durationMs } };
      case 'key-press': return { key: 'step.keyPress', params: { key: step.key } };
      case 'key-hold-until-image': return { key: 'step.keyHoldUntilImage', params: { key: step.key, state: step.state, asset: step.asset } };
      case 'text-input': return { key: 'step.textInput' };
      case 'scroll': return { key: 'step.scroll' };
      case 'navigate': return { key: 'step.navigate' };
      case 'reload': return { key: 'step.reload' };
      case 'log': return { key: 'step.log', params: { message: step.message } };
      case 'if-image': return { key: 'step.ifImage', params: { asset: step.condition.asset } };
      case 'repeat': return { key: 'step.repeat', params: { times: step.times } };
      case 'repeat-until-image': return { key: 'step.repeatUntilImage', params: { asset: step.condition.asset } };
    }
  }
```

- [ ] **Step 3: 改写所有 `setStatus`/`appendLog` 调用为结构化消息**

逐处替换：

1. `checkReady` 失败分支（第 232-233 行）：

```ts
      this.setStatus({ state: 'failed', message: { key: 'status.readyCheckFailed', params: { detail: this.errorMessage(error) } } });
      this.appendLog('error', { key: 'status.readyCheckFailed', params: { detail: this.errorMessage(error) } }, this.status.executedSteps);
```

2. `start` 失败分支（第 245-246 行）：

```ts
      this.setStatus({ state: session.runner.state, message: { key: 'status.runFailed', params: { detail: this.errorMessage(error) } } });
      this.appendLog('error', { key: 'status.runFailed', params: { detail: this.errorMessage(error) } }, this.status.executedSteps);
```

3. `startDebug` 失败回调（第 258-259 行）：

```ts
      this.setStatus({ state: session.runner.state, message: { key: 'status.runFailed', params: { detail: this.errorMessage(error) } }, debugPaused: false });
      this.appendLog('error', { key: 'status.runFailed', params: { detail: this.errorMessage(error) } }, this.status.executedSteps);
```

4. `continueDebug`（第 268 行）：

```ts
    this.setStatus({ state: this.status.state, debugPaused: false, message: { key: 'status.stepNext' } });
```

5. `testAsset` 开始（第 287 行）：

```ts
    this.setStatus({ state: 'checking', packageId, tabId, workflowName: entry.source.workflow.name, currentStep: { key: 'status.checkingAsset', params: { asset } }, executedSteps: 0, message: undefined });
```

6. `testAsset` 匹配结果（第 291-294 行）：

```ts
      this.setStatus({
        state: match ? 'ready' : 'idle', packageId, tabId, workflowName: entry.source.workflow.name,
        message: match
          ? { key: 'status.assetMatch', params: { score: (match.score * 100).toFixed(1) } }
          : { key: 'status.assetNoMatch', params: { asset } },
      });
```

7. `testAsset` catch（第 298-299 行）：

```ts
      this.setStatus({ state: cancelled ? 'cancelled' : 'failed', message: { key: cancelled ? 'status.assetTestStopped' : 'status.assetTestFailed', params: { detail: this.errorMessage(error) } } });
      this.appendLog(cancelled ? 'warning' : 'error', { key: cancelled ? 'status.assetTestStopped' : 'status.assetTestFailed', params: { detail: this.errorMessage(error) } });
```

8. `handleRuntimeEvent` 的 state 分支（第 439-440 行）：

```ts
      if (event.state === 'completed') this.appendLog('success', { key: 'status.scriptCompleted' }, this.status.executedSteps);
      else if (event.state === 'cancelled') this.appendLog('warning', { key: 'status.scriptStopped' }, this.status.executedSteps);
```

9. `handleRuntimeEvent` 的 step-paused（第 452 行）：

```ts
        currentStep: description, debugPaused: true, message: { key: 'status.pausedNext', params: { step: description } },
```

10. `handleRuntimeEvent` 的 image-match（第 455 行）：

```ts
      this.appendLog('success', { key: 'status.imageMatch', params: { asset: event.asset, score: (event.match.score * 100).toFixed(1), ms: event.match.matchMs?.toFixed(0) ?? '?' } }, this.status.executedSteps);
```

11. `handleRuntimeEvent` 的 log 分支（第 458-459 行）——用户脚本原文走 `raw`：

```ts
      this.setStatus({ state: this.status.state, packageId, tabId, workflowName, message: { key: 'raw', params: { text: event.message } } });
      this.appendLog('info', { key: 'raw', params: { text: event.message } }, this.status.executedSteps);
```

- [ ] **Step 4: 运行服务单测确认通过**

Run: `npx vitest run tests/automation-service.test.ts tests/automation-runtime.test.ts tests/automation-browserview-driver.test.ts`
Expected: 全部通过。`getStatus()` 初始值断言 `{ enabled: false, state: 'idle' }` 不受影响（message 为可选字段）。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 通过（`AutomationPanel` 尚未消费新类型，此时类型已就绪）。

- [ ] **Step 6: Commit**

```bash
git add src/main/modules/automation/service.ts
git commit -m "feat(automation): 主进程改为发出结构化消息 key"
```

---

### Task 4: 渲染层消息 resolver + `AutomationPanel` i18n

**Files:**
- Create: `src/renderer/components/automation/automation-message.ts`
- Test: `tests/automation-message.test.ts`
- Modify: `src/renderer/components/panels/AutomationPanel.tsx`

**Interfaces:**
- Consumes: `AutomationMessage`（Task 2）、`LL.automation.panel.*` / `LL.automation.service.*`（Task 1）。
- Produces: `resolveAutomationMessage(message: AutomationMessage, LL: TranslationFunctions): string`。`AutomationPage` 不直接用它，但 Blockly 编辑器错误提示走 `LL.automation.blockly.*`。

- [ ] **Step 1: 写失败测试**

创建 `tests/automation-message.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { TranslationFunctions } from '../src/renderer/i18n/i18n-types';
import { resolveAutomationMessage } from '../src/renderer/components/automation/automation-message';

const ll = {
  automation: {
    service: {
      state: { visible: () => 'appears', hidden: () => 'disappears' },
      status: {
        checkingAsset: vi.fn((p: { asset: string }) => `Testing ${p.asset}`),
        assetMatch: vi.fn((p: { score: string }) => `score ${p.score}%`),
        assetNoMatch: vi.fn((p: { asset: string }) => `no ${p.asset}`),
        readyCheckFailed: vi.fn((p: { detail: string }) => `check failed ${p.detail}`),
        runFailed: vi.fn((p: { detail: string }) => `run failed ${p.detail}`),
        assetTestStopped: vi.fn((p: { detail: string }) => `stopped ${p.detail}`),
        assetTestFailed: vi.fn((p: { detail: string }) => `failed ${p.detail}`),
        stepNext: vi.fn(() => 'next'),
        scriptCompleted: vi.fn(() => 'done'),
        scriptStopped: vi.fn(() => 'stopped'),
        imageMatch: vi.fn((p: { asset: string; score: string; ms: string }) => `img ${p.asset} ${p.score}% ${p.ms}ms`),
        pausedNext: vi.fn((p: { step: string }) => `paused next ${p.step}`),
      },
      step: {
        sequence: vi.fn(() => 'sequence'),
        waitImage: vi.fn((p: { asset: string }) => `wait ${p.asset}`),
        waitImageState: vi.fn((p: { asset: string; state: string }) => `wait ${p.state} ${p.asset}`),
        clickImage: vi.fn((p: { asset: string }) => `click ${p.asset}`),
        moveToImage: vi.fn((p: { asset: string }) => `move ${p.asset}`),
        delay: vi.fn((p: { ms: number }) => `delay ${p.ms}`),
        keyPress: vi.fn((p: { key: string }) => `key ${p.key}`),
        keyHoldUntilImage: vi.fn((p: { key: string; state: string; asset: string }) => `hold ${p.key} ${p.state} ${p.asset}`),
        textInput: vi.fn(() => 'type'),
        scroll: vi.fn(() => 'scroll'),
        navigate: vi.fn(() => 'navigate'),
        reload: vi.fn(() => 'reload'),
        log: vi.fn((p: { message: string }) => `log ${p.message}`),
        ifImage: vi.fn((p: { asset: string }) => `if ${p.asset}`),
        repeat: vi.fn((p: { times: number }) => `repeat ${p.times}`),
        repeatUntilImage: vi.fn((p: { asset: string }) => `until ${p.asset}`),
      },
    },
  },
} as unknown as TranslationFunctions;

describe('resolveAutomationMessage', () => {
  it('resolves raw text', () => {
    expect(resolveAutomationMessage({ key: 'raw', params: { text: 'hello' } }, ll)).toBe('hello');
  });
  it('translates status messages with params', () => {
    expect(resolveAutomationMessage({ key: 'status.checkingAsset', params: { asset: 'a.png' } }, ll)).toBe('Testing a.png');
  });
  it('translates step messages and localizes the visible/hidden state', () => {
    expect(resolveAutomationMessage({ key: 'step.waitImageState', params: { asset: 'a.png', state: 'visible' } }, ll)).toBe('wait appears a.png');
    expect(resolveAutomationMessage({ key: 'step.waitImageState', params: { asset: 'a.png', state: 'hidden' } }, ll)).toBe('wait disappears a.png');
  });
  it('resolves nested pausedNext step recursively', () => {
    expect(resolveAutomationMessage({ key: 'status.pausedNext', params: { step: { key: 'step.clickImage', params: { asset: 'b.png' } } } }, ll)).toBe('paused next click b.png');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/automation-message.test.ts`
Expected: FAIL，`Cannot find module`（文件尚未创建）。

- [ ] **Step 3: 实现 resolver**

创建 `src/renderer/components/automation/automation-message.ts`：

```ts
import type { AutomationMessage } from '@shared/automation/types';
import type { TranslationFunctions } from '@renderer/i18n/i18n-types';

export function resolveAutomationMessage(message: AutomationMessage, LL: TranslationFunctions): string {
  const s = LL.automation.service;
  switch (message.key) {
    case 'raw':
      return message.params.text;
    case 'status.checkingAsset':
      return s.status.checkingAsset(message.params);
    case 'status.assetMatch':
      return s.status.assetMatch(message.params);
    case 'status.assetNoMatch':
      return s.status.assetNoMatch(message.params);
    case 'status.readyCheckFailed':
      return s.status.readyCheckFailed(message.params);
    case 'status.runFailed':
      return s.status.runFailed(message.params);
    case 'status.assetTestStopped':
      return s.status.assetTestStopped(message.params);
    case 'status.assetTestFailed':
      return s.status.assetTestFailed(message.params);
    case 'status.stepNext':
      return s.status.stepNext();
    case 'status.scriptCompleted':
      return s.status.scriptCompleted();
    case 'status.scriptStopped':
      return s.status.scriptStopped();
    case 'status.imageMatch':
      return s.status.imageMatch(message.params);
    case 'status.pausedNext':
      return s.status.pausedNext({ step: resolveAutomationMessage(message.params.step, LL) });
    case 'step.sequence':
      return s.step.sequence();
    case 'step.waitImage':
      return s.step.waitImage(message.params);
    case 'step.waitImageState':
      return s.step.waitImageState({ asset: message.params.asset, state: message.params.state === 'visible' ? s.state.visible() : s.state.hidden() });
    case 'step.clickImage':
      return s.step.clickImage(message.params);
    case 'step.moveToImage':
      return s.step.moveToImage(message.params);
    case 'step.delay':
      return s.step.delay(message.params);
    case 'step.keyPress':
      return s.step.keyPress(message.params);
    case 'step.keyHoldUntilImage':
      return s.step.keyHoldUntilImage({ key: message.params.key, asset: message.params.asset, state: message.params.state === 'visible' ? s.state.visible() : s.state.hidden() });
    case 'step.textInput':
      return s.step.textInput();
    case 'step.scroll':
      return s.step.scroll();
    case 'step.navigate':
      return s.step.navigate();
    case 'step.reload':
      return s.step.reload();
    case 'step.log':
      return s.step.log(message.params);
    case 'step.ifImage':
      return s.step.ifImage(message.params);
    case 'step.repeat':
      return s.step.repeat(message.params);
    case 'step.repeatUntilImage':
      return s.step.repeatUntilImage(message.params);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/automation-message.test.ts`
Expected: PASS（4 个用例全绿）。

- [ ] **Step 5: 改 `AutomationPanel.tsx` 消费结构化消息 + i18n**

改 import 与组件头：

```tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bug, Camera, Check, Clock3, Play, ScanSearch, Square, StepForward, Upload, Workflow, X } from 'lucide-react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { resolveAutomationMessage } from '../automation/automation-message';
import '../automation/automation.css';
```

删除模块级 `statusText` 常量（第 17-20 行）。

在组件内 `const api = window.electronAPI.automation;` 前加：

```tsx
  const { LL } = useI18nContext();
```

`saveCapturedAsset` 的 confirm 与消息改为：

```tsx
    if (selected?.assets.includes(assetName.trim()) && !window.confirm(LL.automation.panel.replaceAssetConfirm({ asset: assetName.trim() }))) return;
```

```tsx
      setStatus((current) => ({ ...current, message: { key: 'raw', params: { text: LL.automation.panel.assetSaved({ asset: saved.asset, w: saved.width, h: saved.height }) } } }));
```

**关键**：`status.message` 现在是 `AutomationMessage`。组件内 **全部 6 处** `setStatus((current) => ({ ...current, state: 'failed', message: error instanceof Error ? error.message : String(error) }))`（原第 71、86、94、101、111、132 行）必须改为把错误文本包进 `raw`，否则 typecheck 报错。把每一处替换为：

```tsx
    setStatus((current) => ({ ...current, state: 'failed', message: { key: 'raw', params: { text: error instanceof Error ? error.message : String(error) } } }));
```

（`run`/`testAsset`/`startDebug`/`continueDebug`/`captureFrame`/`saveCapturedAsset` 的 catch 块各一处。）

改 JSX：

```tsx
          <strong>{LL.automation.panel.status[status.state]()}</strong>
          <small>
            {status.currentStep
              ? LL.automation.panel.currentStep({ count: status.executedSteps ?? 0, step: resolveAutomationMessage(status.currentStep, LL) })
              : status.message
                ? resolveAutomationMessage(status.message, LL)
                : (isWebTarget ? LL.automation.panel.webTargetHint() : LL.automation.panel.switchTargetHint())}
          </small>
          {status.currentStep && status.message && <em>{resolveAutomationMessage(status.message, LL)}</em>}
```

其余硬编码字符串逐个替换为 `LL.automation.panel.*`：

- `打开自动化工作台` → `{LL.automation.panel.openWorkbench()}`
- `当前版本尚未启用自动化执行能力。` → `{LL.automation.panel.notEnabled()}`
- `<span>脚本</span>` → `<span>{LL.automation.panel.scripts()}</span>`
- `导入` → `{LL.automation.panel.import()}`
- `先导入一个 `.baoauto` 脚本包` → `{LL.automation.panel.emptyPackage()}`
- `{selected.assets.length} 个识别素材 · {selected.id}` → `{LL.automation.panel.assetMeta({ count: selected.assets.length, id: selected.id })}`
- `从当前网页截取素材` → `{LL.automation.panel.captureAsset()}`
- `拖动框选识别区域` → `{LL.automation.panel.dragToSelect()}`
- `alt="当前网页截图"` → `alt={LL.automation.panel.captureAlt()}`
- ` · 已选 ...` → ` · {LL.automation.panel.selectedRect({ w: Math.round(selection.width), h: Math.round(selection.height) })}`
- `' · 按住鼠标拖动框选'` → `` ` · ${LL.automation.panel.dragHint()}` ``
- `placeholder="captures/button.png"` → `placeholder={LL.automation.panel.assetNamePlaceholder()}`
- `保存为脚本素材` → `{LL.automation.panel.saveAsAsset()}`
- `素材识别测试` → `{LL.automation.panel.assetTestTitle()}`
- `aria-label="识别阈值"` → `aria-label={LL.automation.panel.thresholdAria()}`
- `在当前网页测试` → `{LL.automation.panel.testOnPage()}`
- 匹配结果模板行改为：

```tsx
          {assetMatch
            ? LL.automation.panel.matchResult({ score: (assetMatch.score * 100).toFixed(1), x: Math.round(assetMatch.x), y: Math.round(assetMatch.y), w: Math.round(assetMatch.width), h: Math.round(assetMatch.height), ms: assetMatch.matchMs === undefined ? '' : LL.automation.panel.matchResultMs({ ms: assetMatch.matchMs.toFixed(0) }) })
            : LL.automation.panel.matchFail()}
```

- `单步启动` → `{LL.automation.panel.debugStart()}`
- `下一步` → `{LL.automation.panel.debugNext()}`
- `运行日志` → `{LL.automation.panel.runLog()}`
- 日志空提示 → `{LL.automation.panel.logEmpty()}`
- `检查就绪` → `{LL.automation.panel.checkReady()}`
- `3 秒启动` → `{LL.automation.panel.countdownStart()}`
- `立即启动` → `{LL.automation.panel.startNow()}`
- `停止` → `{LL.automation.panel.stop()}`
- 日志条目 `<p>{entry.message}</p>` → `<p>{resolveAutomationMessage(entry.message, LL)}</p>`

- [ ] **Step 6: typecheck + 全量单测**

Run: `npm run typecheck && npx vitest run`
Expected: 全部通过。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/automation/automation-message.ts tests/automation-message.test.ts src/renderer/components/panels/AutomationPanel.tsx
git commit -m "feat(automation): 渲染层解析结构化消息并 i18n 自动化侧栏面板"
```

---

### Task 5: `AutomationPage.tsx` i18n

**Files:**
- Modify: `src/renderer/components/automation/AutomationPage.tsx`

**Interfaces:**
- Consumes: `LL.automation.page.*`（Task 1）。Blockly 编辑器 `compile()` 抛出的错误现在已是 LL 文本（Task 6），`error.message` 可直接显示。
- Produces: 无新增接口。

- [ ] **Step 1: 引入 i18n context**

顶部 import 加：

```tsx
import { useI18nContext } from '@renderer/i18n/i18n-react';
```

组件内第一行加：

```tsx
  const { LL } = useI18nContext();
```

- [ ] **Step 2: 替换状态字符串**

- `useState('导入脚本包或新建脚本后即可编辑')` → `useState(LL.automation.page.noticeInitial())`
- `setDraftName('新自动化脚本')` → `setDraftName(LL.automation.page.draftDefaultName())`
- `setDraftName(`${workflow.name} 副本`)` → `setDraftName(LL.automation.page.copySuffix({ name: workflow.name }))`
- `setNotice('新脚本已创建并持久保存')` → `setNotice(LL.automation.page.noticeCreated())`
- `setNotice('脚本副本已创建')` → `setNotice(LL.automation.page.noticeDuplicated())`
- `setNotice('脚本已删除')` → `setNotice(LL.automation.page.noticeDeleted())`
- `setNotice('脚本已载入')` → `setNotice(LL.automation.page.noticeLoaded())`
- `setNotice('积木修改已保存到当前脚本包')` → `setNotice(LL.automation.page.noticeSaved())`
- `setNotice('JSON 已校验并同步到积木')` → `setNotice(LL.automation.page.noticeJsonApplied())`
- `throw new Error('积木工作区尚未就绪')` → `throw new Error(LL.automation.blockly.workspaceNotReady())`

带参 toast 替换为：

- `` setNotice(`已导入 ${result.name}`) `` → `setNotice(LL.automation.page.noticeImported({ name: result.name }))`
- `` setNotice(`素材目录已合并，共 ${result.assets?.length ?? 0} 个素材`) `` → `setNotice(LL.automation.page.noticeMerged({ count: result.assets?.length ?? 0 }))`
- `` setNotice(`素材 ${selectedAsset} 已替换`) `` → `setNotice(LL.automation.page.noticeReplaced({ asset: selectedAsset }))`
- `` setNotice(`素材 ${selectedAsset} 已删除`) `` → `setNotice(LL.automation.page.noticeAssetDeleted({ asset: selectedAsset }))`
- `` setNotice(`已导出到 ${result.filePath ?? '所选位置'}`) `` → `setNotice(LL.automation.page.noticeExported({ path: result.filePath ?? LL.automation.page.noticeFallbackPath() }))`

confirm 替换：

- `` !window.confirm(`确定删除“${workflow.name}”吗？此操作会删除已安装的脚本包。`) `` → `!window.confirm(LL.automation.page.deletePackageConfirm({ name: workflow.name }))`
- `` !window.confirm(`确定删除素材“${selectedAsset}”吗？`) `` → `!window.confirm(LL.automation.page.deleteAssetConfirm({ asset: selectedAsset }))`

- [ ] **Step 3: 替换 JSX 文案**

按 key 替换（`LL.automation.page.*`）：`title`、`subtitle`、`newScript`、`importPackage`、`exportPackage`、`saveChanges`、`warningDisabled`、`libraryTitle`、`duplicateTitle`、`deleteTitle`、`assetCount`、`emptyLibrary`、`emptyLibraryHint`、`assetsTitle`、`mergeAssetsTitle`、`add`、`noAssetsHint`、`assetReferenced`、`assetUnreferenced`、`replace`、`deleteAssetTitle`、`removeAssetReferenceHint`、`name`、`id`、`description`、`blocksTab`、`jsonTab`、`applyJson`、`emptyEditorTitle`、`emptyEditorHint`、`createDialogTitle`、`duplicateDialogTitle`、`dialogIdHint`、`creating`、`create`、`cancel`。

具体位置对照：
- `<h1><Workflow />自动化工作台</h1>` → `<h1><Workflow />{LL.automation.page.title()}</h1>`
- 副标题 `<p>搭建脚本、管理识别素材，并在目标网页的自动化侧栏中运行。</p>` → `<p>{LL.automation.page.subtitle()}</p>`
- `新建脚本` → `{LL.automation.page.newScript()}`；`导入 .baoauto` → `{LL.automation.page.importPackage()}`；`导出脚本包` → `{LL.automation.page.exportPackage()}`；`保存修改` → `{LL.automation.page.saveChanges()}`
- warning 文本 → `{LL.automation.page.warningDisabled()}`
- `<strong>脚本库</strong>` → `<strong>{LL.automation.page.libraryTitle()}</strong>`
- `title="复制脚本"` → `title={LL.automation.page.duplicateTitle()}`；`复制` → `{LL.automation.page.duplicateTitle()}`；`title="删除脚本"` → `title={LL.automation.page.deleteTitle()}`；`删除` → `{LL.automation.page.deleteTitle()}`
- `{item.id} · {item.assets.length} 个素材` → `{item.id} · {LL.automation.page.assetCount({ count: item.assets.length })}`
- `还没有脚本` → `{LL.automation.page.emptyLibrary()}`；`新建脚本或导入工作台导出的 `.baoauto` 文件。` → `{LL.automation.page.emptyLibraryHint()}`
- `<strong>识别素材</strong>` → `<strong>{LL.automation.page.assetsTitle()}</strong>`；`title="合并素材目录"` → `title={LL.automation.page.mergeAssetsTitle()}`；`添加` → `{LL.automation.page.add()}`
- `这个脚本尚未包含图片素材。` → `{LL.automation.page.noAssetsHint()}`
- `正在被脚本引用，不能删除` → `{LL.automation.page.assetReferenced()}`；`当前未被脚本引用` → `{LL.automation.page.assetUnreferenced()}`
- `替换` → `{LL.automation.page.replace()}`；`title={assetReferenced ? '请先从积木中移除该素材引用' : '删除素材'}` → `title={assetReferenced ? LL.automation.page.removeAssetReferenceHint() : LL.automation.page.deleteAssetTitle()}`
- `<label>脚本名称...` → `<label>{LL.automation.page.name()}...`；`脚本 ID` → `{LL.automation.page.id()}`；`说明` → `{LL.automation.page.description()}`
- `{assets.length} 个识别素材` → `{LL.automation.page.assetCount({ count: assets.length })}`
- `积木编辑` → `{LL.automation.page.blocksTab()}`；`JSON 代码` → `{LL.automation.page.jsonTab()}`
- `校验并应用 JSON` → `{LL.automation.page.applyJson()}`
- `选择或导入一个脚本` → `{LL.automation.page.emptyEditorTitle()}`；`脚本会显示在左侧脚本库中。` → `{LL.automation.page.emptyEditorHint()}`
- dialog 标题：`scriptDialog === 'create' ? '新建自动化脚本' : '复制自动化脚本'` → `scriptDialog === 'create' ? LL.automation.page.createDialogTitle() : LL.automation.page.duplicateDialogTitle()`
- `脚本 ID 将用于文件名，创建后不能直接修改。` → `{LL.automation.page.dialogIdHint()}`
- `取消` → `{LL.automation.page.cancel()}`；`{busy ? '正在创建…' : '创建脚本'}` → `{busy ? LL.automation.page.creating() : LL.automation.page.create()}`
- `saveBlocks` 里 `if (!compiled) throw new Error('积木工作区尚未就绪')` → `if (!compiled) throw new Error(LL.automation.blockly.workspaceNotReady())`

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/automation/AutomationPage.tsx
git commit -m "feat(i18n): 自动化工作台页面接入 i18n"
```

---

### Task 6: `AutomationBlocklyEditor.tsx` 完整 i18n（积木定义 + locale 重建）

**Files:**
- Modify: `src/renderer/components/automation/AutomationBlocklyEditor.tsx`

**Interfaces:**
- Consumes: `LL.automation.blockly.*`（Task 1）、`blockly/msg/en`。
- Produces: 保持对外接口 `AutomationBlocklyEditorHandle { compile(): AutomationWorkflow; load(workflow): void }` 不变。`compile()` 抛出的错误文案为 LL 文本。

- [ ] **Step 1: 改写为 locale 感知**

整文件替换为（注意：Blockly 的 message 串含 `%N` 占位符，直接取 LL 字符串，不做参数插值）：

```tsx
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as Blockly from 'blockly';
import * as zhHans from 'blockly/msg/zh-hans';
import * as enMessages from 'blockly/msg/en';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { AutomationStep, AutomationWorkflow, SequenceStep } from '@shared/automation/types';

export interface AutomationBlocklyEditorHandle {
  compile(): AutomationWorkflow;
  load(workflow: AutomationWorkflow): void;
}

function buildBlockDefinitions(LL: ReturnType<typeof useI18nContext>['LL']): any[] {
  const b = LL.automation.blockly;
  const appear = b.visible();
  const disappear = b.hidden();
  return [
    { type: 'bao_start_unconditional', message0: b.startUnconditional(), message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], colour: 265 },
    { type: 'bao_start', message0: b.start(), args0: [{ type: 'field_input', name: 'ASSET', text: '' }, { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], colour: 265 },
    { type: 'bao_wait_image', message0: b.waitImage(), args0: [{ type: 'field_input', name: 'ASSET', text: 'button.png' }, { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao_wait_image_state', message0: b.waitImageState(), args0: [{ type: 'field_input', name: 'ASSET', text: 'button.png' }, { type: 'field_dropdown', name: 'STATE', options: [[appear, 'visible'], [disappear, 'hidden']] }, { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao_click_image', message0: b.clickImage(), args0: [{ type: 'field_input', name: 'ASSET', text: 'button.png' }, { type: 'field_dropdown', name: 'BUTTON', options: [[b.leftButton(), 'left'], [b.rightButton(), 'right'], [b.middleButton(), 'middle']] }, { type: 'field_number', name: 'COUNT', value: 1, min: 1, max: 3 }, { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao_move_to_image', message0: b.moveToImage(), args0: [{ type: 'field_input', name: 'ASSET', text: 'button.png' }, { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao_delay', message0: b.delay(), args0: [{ type: 'field_number', name: 'DURATION', value: 500, min: 0, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 45 },
    { type: 'bao_key_press', message0: b.keyPress(), args0: [{ type: 'field_input', name: 'KEY', text: 'Enter' }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_key_combo', message0: b.keyCombo(), args0: [{ type: 'field_checkbox', name: 'CONTROL', checked: true }, { type: 'field_checkbox', name: 'ALT', checked: false }, { type: 'field_checkbox', name: 'SHIFT', checked: false }, { type: 'field_checkbox', name: 'META', checked: false }, { type: 'field_input', name: 'KEY', text: 'A' }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_hold_key_until_image', message0: b.holdKeyUntilImage(), args0: [{ type: 'field_input', name: 'KEY', text: 'Space' }, { type: 'field_input', name: 'ASSET', text: 'done.png' }, { type: 'field_dropdown', name: 'STATE', options: [[appear, 'visible'], [disappear, 'hidden']] }, { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_text_input', message0: b.textInput(), args0: [{ type: 'field_input', name: 'TEXT', text: b.textSample() }, { type: 'field_number', name: 'INTERVAL', value: 0, min: 0, max: 10000 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_scroll', message0: b.scroll(), args0: [{ type: 'field_number', name: 'X', value: 0, min: -100000, max: 100000 }, { type: 'field_number', name: 'Y', value: 480, min: -100000, max: 100000 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_navigate', message0: b.navigate(), args0: [{ type: 'field_input', name: 'URL', text: 'https://example.com/' }], previousStatement: null, nextStatement: null, colour: 170 },
    { type: 'bao_reload', message0: b.reload(), previousStatement: null, nextStatement: null, colour: 170 },
    { type: 'bao_log', message0: b.log(), args0: [{ type: 'field_input', name: 'MESSAGE', text: b.logSample() }], previousStatement: null, nextStatement: null, colour: 65 },
    { type: 'bao_if_image', message0: b.ifImage(), args0: [{ type: 'field_dropdown', name: 'MODE', options: [[b.found(), 'found'], [b.notFound(), 'missing']] }, { type: 'field_input', name: 'ASSET', text: 'button.png' }, { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }], message1: b.then(), args1: [{ type: 'input_statement', name: 'THEN' }], message2: b.otherwise(), args2: [{ type: 'input_statement', name: 'ELSE' }], previousStatement: null, nextStatement: null, colour: 330 },
    { type: 'bao_repeat', message0: b.repeat(), args0: [{ type: 'field_number', name: 'TIMES', value: 2, min: 1, max: 1000 }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], previousStatement: null, nextStatement: null, colour: 20 },
    { type: 'bao_repeat_until_image', message0: b.repeatUntilImage(), args0: [{ type: 'field_input', name: 'ASSET', text: 'button.png' }, { type: 'field_dropdown', name: 'UNTIL', options: [[appear, 'visible'], [disappear, 'hidden']] }, { type: 'field_number', name: 'MAX', value: 20, min: 1, max: 1000 }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], previousStatement: null, nextStatement: null, colour: 20 },
  ];
}

function buildToolbox(LL: ReturnType<typeof useI18nContext>['LL']): Blockly.utils.toolbox.ToolboxDefinition {
  const b = LL.automation.blockly;
  return {
    kind: 'categoryToolbox',
    contents: [
      { kind: 'category', name: b.catEntry(), colour: '265', contents: ['bao_start_unconditional', 'bao_start'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catImage(), colour: '205', contents: ['bao_wait_image', 'bao_wait_image_state', 'bao_click_image', 'bao_move_to_image'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catInput(), colour: '120', contents: ['bao_key_press', 'bao_key_combo', 'bao_hold_key_until_image', 'bao_text_input', 'bao_scroll'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catPage(), colour: '170', contents: ['bao_navigate', 'bao_reload'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catFlow(), colour: '330', contents: ['bao_if_image', 'bao_repeat', 'bao_repeat_until_image', 'bao_delay'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catDebug(), colour: '65', contents: [{ kind: 'block', type: 'bao_log' }] },
    ],
  };
}

function number(block: Blockly.Block, field: string): number { return Number(block.getFieldValue(field)); }
function assetCondition(block: Blockly.Block) { return { type: 'image-visible' as const, asset: String(block.getFieldValue('ASSET')), threshold: number(block, 'THRESHOLD') || .9 }; }
function modifiers(block: Blockly.Block): Array<'alt' | 'control' | 'meta' | 'shift'> {
  return ([['ALT', 'alt'], ['CONTROL', 'control'], ['META', 'meta'], ['SHIFT', 'shift']] as const)
    .filter(([field]) => block.getFieldValue(field) === 'TRUE')
    .map(([, modifier]) => modifier);
}

function compileSequence(LL: ReturnType<typeof useI18nContext>['LL'], first: Blockly.Block | null): SequenceStep {
  const steps: AutomationStep[] = [];
  for (let block = first; block; block = block.getNextBlock()) steps.push(compileBlock(LL, block));
  return { type: 'sequence', steps };
}

function compileBlock(LL: ReturnType<typeof useI18nContext>['LL'], block: Blockly.Block): AutomationStep {
  switch (block.type) {
    case 'bao_wait_image': return { type: 'wait-image', asset: String(block.getFieldValue('ASSET')), threshold: number(block, 'THRESHOLD'), timeoutMs: number(block, 'TIMEOUT') };
    case 'bao_wait_image_state': return { type: 'wait-image-state', asset: String(block.getFieldValue('ASSET')), state: block.getFieldValue('STATE') === 'hidden' ? 'hidden' : 'visible', threshold: .9, timeoutMs: number(block, 'TIMEOUT') };
    case 'bao_click_image': return { type: 'click-image', asset: String(block.getFieldValue('ASSET')), threshold: number(block, 'THRESHOLD'), button: block.getFieldValue('BUTTON'), clickCount: number(block, 'COUNT') as 1 | 2 | 3 };
    case 'bao_move_to_image': return { type: 'move-to-image', asset: String(block.getFieldValue('ASSET')), threshold: number(block, 'THRESHOLD') };
    case 'bao_delay': return { type: 'delay', durationMs: number(block, 'DURATION') };
    case 'bao_key_press': return { type: 'key-press', key: String(block.getFieldValue('KEY')) };
    case 'bao_key_combo': return { type: 'key-press', key: String(block.getFieldValue('KEY')), modifiers: modifiers(block) };
    case 'bao_hold_key_until_image': return { type: 'key-hold-until-image', key: String(block.getFieldValue('KEY')), asset: String(block.getFieldValue('ASSET')), state: block.getFieldValue('STATE') === 'hidden' ? 'hidden' : 'visible', threshold: .9, timeoutMs: number(block, 'TIMEOUT') };
    case 'bao_text_input': return { type: 'text-input', text: String(block.getFieldValue('TEXT')), intervalMs: number(block, 'INTERVAL') };
    case 'bao_scroll': return { type: 'scroll', deltaX: number(block, 'X'), deltaY: number(block, 'Y') };
    case 'bao_navigate': return { type: 'navigate', url: String(block.getFieldValue('URL')) };
    case 'bao_reload': return { type: 'reload' };
    case 'bao_log': return { type: 'log', message: String(block.getFieldValue('MESSAGE')) };
    case 'bao_if_image': return { type: 'if-image', condition: assetCondition(block), negate: block.getFieldValue('MODE') === 'missing', then: compileSequence(LL, block.getInputTargetBlock('THEN')), else: compileSequence(LL, block.getInputTargetBlock('ELSE')) };
    case 'bao_repeat': return { type: 'repeat', times: number(block, 'TIMES'), body: compileSequence(LL, block.getInputTargetBlock('DO')) };
    case 'bao_repeat_until_image': return { type: 'repeat-until-image', condition: { type: 'image-visible', asset: String(block.getFieldValue('ASSET')), threshold: .9 }, until: block.getFieldValue('UNTIL') === 'hidden' ? 'hidden' : 'visible', maxIterations: number(block, 'MAX'), delayMs: 200, body: compileSequence(LL, block.getInputTargetBlock('DO')) };
    default: throw new Error(LL.automation.blockly.unsupportedBlock({ type: block.type }));
  }
}

function setField(block: Blockly.Block, name: string, value: unknown): void {
  if (value !== undefined && block.getField(name)) block.setFieldValue(String(value), name);
}

function createStep(LL: ReturnType<typeof useI18nContext>['LL'], workspace: Blockly.WorkspaceSvg, step: AutomationStep): Blockly.BlockSvg {
  const map: Record<AutomationStep['type'], string> = {
    sequence: 'bao_delay', 'wait-image': 'bao_wait_image', 'wait-image-state': 'bao_wait_image_state',
    'click-image': 'bao_click_image', 'move-to-image': 'bao_move_to_image', delay: 'bao_delay',
    'key-press': 'bao_key_press', 'key-hold-until-image': 'bao_hold_key_until_image', 'text-input': 'bao_text_input', scroll: 'bao_scroll', navigate: 'bao_navigate',
    reload: 'bao_reload', log: 'bao_log', 'if-image': 'bao_if_image', repeat: 'bao_repeat', 'repeat-until-image': 'bao_repeat_until_image',
  };
  if (step.type === 'sequence') throw new Error('sequence cannot be rendered as a statement block');
  const blockType = step.type === 'key-press' && step.modifiers?.length ? 'bao_key_combo' : map[step.type];
  const block = workspace.newBlock(blockType); block.initSvg(); block.render();
  switch (step.type) {
    case 'wait-image': setField(block, 'ASSET', step.asset); setField(block, 'THRESHOLD', step.threshold); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'wait-image-state': setField(block, 'ASSET', step.asset); setField(block, 'STATE', step.state); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'click-image': setField(block, 'ASSET', step.asset); setField(block, 'THRESHOLD', step.threshold); setField(block, 'BUTTON', step.button); setField(block, 'COUNT', step.clickCount); break;
    case 'move-to-image': setField(block, 'ASSET', step.asset); setField(block, 'THRESHOLD', step.threshold); break;
    case 'delay': setField(block, 'DURATION', step.durationMs); break;
    case 'key-press':
      setField(block, 'KEY', step.key);
      setField(block, 'ALT', step.modifiers?.includes('alt') ? 'TRUE' : 'FALSE');
      setField(block, 'CONTROL', step.modifiers?.includes('control') ? 'TRUE' : 'FALSE');
      setField(block, 'META', step.modifiers?.includes('meta') ? 'TRUE' : 'FALSE');
      setField(block, 'SHIFT', step.modifiers?.includes('shift') ? 'TRUE' : 'FALSE');
      break;
    case 'key-hold-until-image': setField(block, 'KEY', step.key); setField(block, 'ASSET', step.asset); setField(block, 'STATE', step.state); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'text-input': setField(block, 'TEXT', step.text); setField(block, 'INTERVAL', step.intervalMs); break;
    case 'scroll': setField(block, 'X', step.deltaX); setField(block, 'Y', step.deltaY); break;
    case 'navigate': setField(block, 'URL', step.url); break;
    case 'log': setField(block, 'MESSAGE', step.message); break;
    case 'if-image': setField(block, 'ASSET', step.condition.asset); setField(block, 'THRESHOLD', step.condition.threshold); setField(block, 'MODE', step.negate ? 'missing' : 'found'); connectSequence(LL, workspace, block, 'THEN', step.then); if (step.else) connectSequence(LL, workspace, block, 'ELSE', step.else); break;
    case 'repeat': setField(block, 'TIMES', step.times); connectSequence(LL, workspace, block, 'DO', step.body); break;
    case 'repeat-until-image': setField(block, 'ASSET', step.condition.asset); setField(block, 'UNTIL', step.until); setField(block, 'MAX', step.maxIterations); connectSequence(LL, workspace, block, 'DO', step.body); break;
    case 'reload': break;
  }
  return block;
}

function connectSequence(LL: ReturnType<typeof useI18nContext>['LL'], workspace: Blockly.WorkspaceSvg, parent: Blockly.Block, inputName: string, sequence: SequenceStep): void {
  let previous: Blockly.BlockSvg | null = null;
  for (const step of sequence.steps) {
    const block = createStep(LL, workspace, step);
    if (!previous) parent.getInput(inputName)?.connection?.connect(block.previousConnection);
    else previous.nextConnection?.connect(block.previousConnection);
    previous = block;
  }
}

const AutomationBlocklyEditor = forwardRef<AutomationBlocklyEditorHandle, { initialWorkflow?: AutomationWorkflow }>(function AutomationBlocklyEditor({ initialWorkflow }, ref) {
  const { LL, locale } = useI18nContext();
  const hostRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const workflowRef = useRef(initialWorkflow);
  const xmlRef = useRef<Element | null>(null);
  workflowRef.current = initialWorkflow;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    Blockly.setLocale(locale === 'en' ? enMessages : zhHans);
    Blockly.defineBlocksWithJsonArray(buildBlockDefinitions(LL));
    const workspace = Blockly.inject(host, { toolbox: buildToolbox(LL), trashcan: true, renderer: 'geras', zoom: { controls: true, wheel: true, startScale: .82, minScale: .45, maxScale: 1.4 }, grid: { spacing: 20, length: 3, colour: '#d9e2ef', snap: true } });
    const categoryColours = ['#7b59ad', '#5688a8', '#58a966', '#58a99f', '#ad587b', '#9aaa52'];
    host.querySelectorAll('.blocklyToolboxCategory').forEach((category, index) => {
      category.querySelector<HTMLElement>('.blocklyTreeRow')?.style.setProperty('--bao-category-colour', categoryColours[index] || '#5677a8');
    });
    const syncFlyoutState = (): void => {
      host.classList.toggle('bao-flyout-collapsed', !host.querySelector('.blocklyTreeSelected'));
    };
    const toolboxElement = host.querySelector('.blocklyToolboxDiv');
    const toolboxObserver = new MutationObserver(syncFlyoutState);
    if (toolboxElement) toolboxObserver.observe(toolboxElement, { attributes: true, attributeFilter: ['class'], subtree: true });
    syncFlyoutState();
    workspaceRef.current = workspace;
    if (xmlRef.current) {
      Blockly.Xml.domToWorkspace(xmlRef.current, workspace);
      xmlRef.current = null;
    } else {
      loadIntoWorkspace(LL, workspace, workflowRef.current ?? { formatVersion: 1, id: 'new-automation', name: LL.automation.blockly.defaultWorkflowName(), root: { type: 'sequence', steps: [] } });
    }
    const observer = new ResizeObserver(() => Blockly.svgResize(workspace)); observer.observe(host);
    return () => {
      observer.disconnect();
      toolboxObserver.disconnect();
      if (workspaceRef.current) xmlRef.current = Blockly.Xml.workspaceToDom(workspaceRef.current);
      workspace.dispose();
      workspaceRef.current = null;
    };
  }, [locale, LL]);

  useImperativeHandle(ref, () => ({
    compile: () => {
      const workspace = workspaceRef.current; if (!workspace) throw new Error(LL.automation.blockly.workspaceNotReady());
      const starts = workspace.getTopBlocks(true).filter((block) => block.type === 'bao_start' || block.type === 'bao_start_unconditional');
      if (starts.length !== 1) throw new Error(LL.automation.blockly.requireOneStart());
      const source = workflowRef.current;
      const conditional = starts[0].type === 'bao_start';
      const readyAsset = conditional ? String(starts[0].getFieldValue('ASSET') || '').trim() : '';
      return {
        formatVersion: 1,
        id: source?.id ?? 'new-automation',
        name: source?.name ?? LL.automation.blockly.defaultWorkflowName(),
        description: source?.description,
        ...(readyAsset ? { readyWhen: { type: 'image-visible' as const, asset: readyAsset, threshold: number(starts[0], 'THRESHOLD') } } : {}),
        root: compileSequence(LL, starts[0].getInputTargetBlock('DO')),
      };
    },
    load: (workflow) => { workflowRef.current = workflow; if (workspaceRef.current) loadIntoWorkspace(LL, workspaceRef.current, workflow); },
  }), [LL]);

  return <div ref={hostRef} className="automation-blockly-host" />;
});

function loadIntoWorkspace(LL: ReturnType<typeof useI18nContext>['LL'], workspace: Blockly.WorkspaceSvg, workflow: AutomationWorkflow): void {
  workspace.clear();
  const start = workspace.newBlock(workflow.readyWhen ? 'bao_start' : 'bao_start_unconditional'); start.initSvg(); start.render();
  if (workflow.readyWhen) { setField(start, 'ASSET', workflow.readyWhen.asset); setField(start, 'THRESHOLD', workflow.readyWhen.threshold ?? .9); }
  connectSequence(LL, workspace, start, 'DO', workflow.root);
  start.moveBy(36, 30);
}

export default AutomationBlocklyEditor;
```

**注意**：`Blockly.defineBlocksWithJsonArray` 对同名类型重复注册是覆盖语义，直接重复调用即可，无需先 delete。`xmlRef` 保存前一个 workspace 的 DOM，locale 变化重建时先 `dispose()`（cleanup 内），再注入新 workspace 并 `domToWorkspace` 恢复布局。`useEffect` 依赖 `[locale, LL]`，每次语言切换重跑；首次挂载走 `loadIntoWorkspace` 分支。

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 通过。若 `enMessages` 类型不兼容 `setLocale`，检查 `blockly/msg/en.d.ts` 导出 shape，必要时 `import * as enMessages from 'blockly/msg/en'` 已满足。

- [ ] **Step 3: 运行相关单测确认无回归**

Run: `npx vitest run tests/automation-schema.test.ts`
Expected: 通过（该测试覆盖 workflow 序列化，不涉编辑器渲染）。

- [ ] **Step 4: 手动验证提示**

Run: `npm start` 后切英文界面，打开 `about:automation`，确认积木/toolbox/下拉均为英文；切回中文后积木布局保留。此步为人工检查，不做自动断言。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/automation/AutomationBlocklyEditor.tsx
git commit -m "feat(i18n): Blockly 积木定义完整 i18n 并支持 locale 重建"
```

---

### Task 7: 零散组件 i18n（WindowControls / ErrorBoundary / App fallback）

**Files:**
- Modify: `src/renderer/components/shell/WindowControls.tsx`
- Modify: `src/renderer/components/ErrorBoundary.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `LL.win.*`、`LL.error.*`、`LL.retry`、`LL.automation.page.loading`（Task 1）。
- Produces: 无。

- [ ] **Step 1: 改 `WindowControls.tsx`**

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';

const WindowControls: React.FC = () => {
  const { LL } = useI18nContext();
  const [isMaximized, setIsMaximized] = useState(false);
```

三个 `title` 替换：

- `title="最小化"` → `title={LL.win.minimize()}`
- `title={isMaximized ? '还原' : '最大化'}` → `title={isMaximized ? LL.win.restore() : LL.win.maximize()}`
- `title="关闭"` → `title={LL.win.close()}`

- [ ] **Step 2: 改 `ErrorBoundary.tsx`**

类组件不能直接调 hook。把渲染 fallback 的内部文案改为函数组件消费 i18n。在文件顶部 import：

```tsx
import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
```

新增一个小函数组件：

```tsx
const ErrorFallbackContent: React.FC<{ message?: string }> = ({ message }) => {
  const { LL } = useI18nContext();
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', padding: 24, color: 'var(--text-secondary)',
    }}>
      <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 8, color: 'var(--text-primary)' }}>
        {LL.error.title()}
      </div>
      <div style={{ fontSize: 13, opacity: 0.7, textAlign: 'center', maxWidth: 400 }}>
        {message || LL.error.default()}
      </div>
      <button
        onClick={() => this.setState({ hasError: false, error: null })}
        style={{
          marginTop: 16, padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
          background: 'var(--accent)', color: '#fff', fontSize: 13,
        }}
      >
        {LL.retry()}
      </button>
    </div>
  );
};
```

但 `this.setState` 在函数组件内不可用——**改为**把 fallback 拆成两段：`ErrorBoundary` 类组件保留，内部渲染改为：

```tsx
  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return <ErrorBoundaryInner message={this.state.error?.message} onRetry={() => this.setState({ hasError: false, error: null })} />;
    }
    return this.props.children;
  }
```

并新增函数组件（放在类定义之前）：

```tsx
const ErrorBoundaryInner: React.FC<{ message?: string; onRetry: () => void }> = ({ message, onRetry }) => {
  const { LL } = useI18nContext();
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', padding: 24, color: 'var(--text-secondary)',
    }}>
      <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 8, color: 'var(--text-primary)' }}>
        {LL.error.title()}
      </div>
      <div style={{ fontSize: 13, opacity: 0.7, textAlign: 'center', maxWidth: 400 }}>
        {message || LL.error.default()}
      </div>
      <button
        onClick={onRetry}
        style={{
          marginTop: 16, padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
          background: 'var(--accent)', color: '#fff', fontSize: 13,
        }}
      >
        {LL.retry()}
      </button>
    </div>
  );
};
```

`ErrorBoundary` 类定义保留原逻辑，只是 render fallback 改调 `ErrorBoundaryInner`。

- [ ] **Step 3: 改 `App.tsx` Suspense fallback**

`AppInner` 已有 `LL`。把：

```tsx
<Suspense fallback={<div className="internal-page-loading">正在加载自动化工作台…</div>}><AutomationPage /></Suspense>
```

改为：

```tsx
<Suspense fallback={<div className="internal-page-loading">{LL.automation.page.loading()}</div>}><AutomationPage /></Suspense>
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/shell/WindowControls.tsx src/renderer/components/ErrorBoundary.tsx src/renderer/App.tsx
git commit -m "feat(i18n): 窗口控件/错误兜底/加载 fallback 接入 i18n"
```

---

### Task 8: 原生对话框标题由渲染层传入

**Files:**
- Modify: `src/main/ipc/download.ipc.ts`（`download:set-dir`）
- Modify: `src/main/ipc/screenshot.ipc.ts`（`screenshot:set-dir`）
- Modify: `src/main/ipc/automation.ipc.ts`（open/replace/import/export 四个对话框）
- Modify: `src/main/ipc/userscripts-admin.ipc.ts`（install-file、export-source）
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/components/panels/DownloadsPanel.tsx`、`src/renderer/components/panels/SettingsPanel.tsx`、`src/renderer/components/userscripts/UserscriptsPage.tsx`、`src/renderer/components/automation/AutomationPage.tsx`、`src/renderer/components/panels/AutomationPanel.tsx`

**Interfaces:**
- Consumes: `LL.automation.ipc.*`、`LL.download.selectDir`、`LL.settings.screenshot.dialogTitle`、`LL.userscript.installFileDialogTitle`、`LL.userscript.exportDialogTitle`（Task 1）。
- Produces: IPC payload 增加可选 i18n 字段；preload 方法签名扩展。所有字段保留 `?? 默认值` 兜底。

- [ ] **Step 1: `download.ipc.ts` 的 `download:set-dir` 接受 title**

把：

```ts
  ipcMain.handle('download:set-dir', async () => {
```

改为：

```ts
  ipcMain.handle('download:set-dir', async (_event, payload?: { title?: string }) => {
```

把：

```ts
      title: '选择下载目录',
```

改为：

```ts
      title: payload?.title ?? '选择下载目录',
```

- [ ] **Step 2: `screenshot.ipc.ts` 的 `screenshot:set-dir` 接受 title**

把：

```ts
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: getScreenshotDir(),
        title: '选择截图保存目录',
      });
```

改为：

```ts
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: getScreenshotDir(),
        title: (payload?.title as string | undefined) ?? '选择截图保存目录',
      });
```

并在 handler 开头接收 payload：

```ts
  ipcMain.handle('screenshot:set-dir', async (_event, payload?: { title?: string }) => {
```

- [ ] **Step 3: `automation.ipc.ts` 四个对话框接受 i18n 字段**

`automation:open-package`：

```ts
  createValidatedHandler('automation:open-package', z.object({
    title: z.string().optional(),
    filterName: z.string().optional(),
    replace: z.string().optional(),
    cancel: z.string().optional(),
    existsTitle: z.string().optional(),
    existsMessage: z.string().optional(),
  }).optional(), async (payload) => {
    const win = getWin() ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, {
      title: payload?.title ?? '打开自动化脚本包',
      properties: ['openFile'],
      filters: [{ name: payload?.filterName ?? 'BaoFlash 自动化脚本', extensions: ['baoauto'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    const filePath = result.filePaths[0];
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new Error('automation package exceeds 32MB');
    await service.whenReady();
    const bytes = new Uint8Array(await fs.promises.readFile(filePath));
    let loaded: Awaited<ReturnType<AutomationService['loadPackage']>>;
    try { loaded = await service.loadPackage(bytes); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('automation script already exists:')) throw error;
      const confirmation = await dialog.showMessageBox(win, {
        type: 'question', buttons: [payload?.replace ?? '替换', payload?.cancel ?? '取消'], defaultId: 0, cancelId: 1,
        title: payload?.existsTitle ?? '脚本已经存在', message: payload?.existsMessage ?? '脚本库中已有相同 ID 的脚本，是否使用导入文件替换？',
      });
      if (confirmation.response !== 0) return { canceled: true as const };
      loaded = await service.loadPackage(bytes, true);
    }
    return { canceled: false as const, ...loaded };
  });
```

`automation:replace-asset`：

```ts
  createValidatedHandler('automation:replace-asset', z.object({ packageId, asset: assetId, title: z.string().optional(), filterName: z.string().optional() }).strict(), async ({ packageId: id, asset, title, filterName }) => {
    await service.whenReady();
    const win = getWin() ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, { title: title ?? `替换素材 ${asset}`, properties: ['openFile'], filters: [{ name: filterName ?? '图片素材', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
```

`automation:import-assets`：

```ts
  createValidatedHandler('automation:import-assets', z.object({ packageId, title: z.string().optional() }).strict(), async ({ packageId: id, title }) => {
    await service.whenReady();
    const win = getWin() ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No window available');
    const result = await dialog.showOpenDialog(win, { title: title ?? '选择素材目录', properties: ['openDirectory'] });
```

`automation:export-package`：

```ts
  createValidatedHandler('automation:export-package', z.object({ packageId, title: z.string().optional(), filterName: z.string().optional() }).strict(), async ({ packageId: id, title, filterName }) => {
    await service.whenReady();
    const entry = service.getPackage(id);
    const win = getWin() ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No window available');
    const result = await dialog.showSaveDialog(win, {
      title: title ?? '导出自动化脚本包',
      defaultPath: `${entry.workflow.id}.baoauto`,
      filters: [{ name: filterName ?? 'BaoFlash 自动化脚本', extensions: ['baoauto'] }],
    });
```

- [ ] **Step 4: `userscripts-admin.ipc.ts` 两处对话框**

`userscripts:install-file`：

```ts
  createValidatedHandler('userscripts:install-file', z.object({ title: z.string().optional() }).optional(), async (payload) => {
    const win = getWindow();
    const options: Electron.OpenDialogOptions = {
      title: payload?.title ?? '安装用户脚本',
      properties: ['openFile'],
      filters: [{ name: 'Userscript', extensions: ['js', 'user.js', 'txt'] }],
    };
```

`userscripts:export-source`：

```ts
  createValidatedHandler('userscripts:export-source', z.object({ id: z.string(), title: z.string().optional() }), async (payload) => {
    const source = getUserscriptSource(payload.id);
    if (source === undefined) return { ok: false, error: 'not-found' };
    const script = listUserscripts().find((s) => s.id === payload.id);
    const win = getWindow();
    const options: Electron.SaveDialogOptions = {
      title: payload.title ?? '导出脚本',
      defaultPath: defaultExportFileName(script?.metadata.name ?? payload.id),
      filters: [{ name: 'Userscript', extensions: ['user.js', 'js'] }],
    };
```

- [ ] **Step 5: `src/preload/index.ts` 方法签名扩展**

- `dl.setDir`: `setDir: (title?: string) => safeInvoke('download:set-dir', { title }),`
- `screenshot.setDir`: `setDir: (title?: string) => safeInvoke('screenshot:set-dir', { title }),`
- `userscripts.installFile`: `installFile: (title?: string) => safeInvoke('userscripts:install-file', { title }),`
- `userscripts.exportSource`: `exportSource: (id: string, title?: string) => safeInvoke('userscripts:export-source', { id, title }),`
- `automation.openPackage`: 改为接收 i18n 参数：

```ts
    openPackage: (i18n?: { title?: string; filterName?: string; replace?: string; cancel?: string; existsTitle?: string; existsMessage?: string }) => safeInvoke('automation:open-package', i18n),
```

- `automation.replaceAsset`: `replaceAsset: (packageId: string, asset: string, i18n?: { title?: string; filterName?: string }) => safeInvoke('automation:replace-asset', { packageId, asset, ...i18n }),`
- `automation.importAssets`: `importAssets: (packageId: string, i18n?: { title?: string }) => safeInvoke('automation:import-assets', { packageId, ...i18n }),`
- `automation.exportPackage`: `exportPackage: (packageId: string, i18n?: { title?: string; filterName?: string }) => safeInvoke('automation:export-package', { packageId, ...i18n }),`

- [ ] **Step 6: `electron.d.ts` 类型同步**

- `invoke(channel: 'download:set-dir', payload: { title?: string }): Promise<string>;`
- `invoke(channel: 'screenshot:set-dir', payload: { title?: string }): Promise<ScreenshotSetDirResult>;`
- `dl.setDir(title?: string): Promise<string>;`
- `screenshot.setDir(title?: string): Promise<ScreenshotSetDirResult>;`
- `userscripts.installFile(title?: string): Promise<...>;`（保持原返回类型）
- `userscripts.exportSource(id: string, title?: string): Promise<...>;`
- `automation.openPackage(i18n?: { title?: string; filterName?: string; replace?: string; cancel?: string; existsTitle?: string; existsMessage?: string }): Promise<...>;`
- `automation.replaceAsset(packageId: string, asset: string, i18n?: { title?: string; filterName?: string }): Promise<...>;`
- `automation.importAssets(packageId: string, i18n?: { title?: string }): Promise<...>;`
- `automation.exportPackage(packageId: string, i18n?: { title?: string; filterName?: string }): Promise<...>;`

- [ ] **Step 7: 渲染层调用处传翻译文本**

`DownloadsPanel.tsx`（第 117 行）：

```tsx
    const newDir = await window.electronAPI?.dl?.setDir(LL.download.selectDir());
```

`SettingsPanel.tsx`（第 168 行，需确认该组件内有 `LL`）：

```tsx
      const result = await window.electronAPI.screenshot.setDir(LL.settings.screenshot.dialogTitle());
```

`UserscriptsPage.tsx`：

```tsx
      const result = (await window.electronAPI.userscripts.installFile(LL.userscript.installFileDialogTitle())) as { ok: false; error: string } | { source: string };
```

```tsx
    const result = (await window.electronAPI.userscripts.exportSource(script.id, LL.userscript.exportDialogTitle())) as { ok: boolean; path?: string; error?: string };
```

`AutomationPage.tsx`：

```tsx
      const result = await api.openPackage({
        title: LL.automation.ipc.openPackageTitle(),
        filterName: LL.automation.ipc.openPackageFilter(),
        replace: LL.automation.ipc.replace(),
        cancel: LL.automation.page.cancel(),
        existsTitle: LL.automation.ipc.packageExistsTitle(),
        existsMessage: LL.automation.ipc.packageExistsMessage(),
      });
```

```tsx
      const result = await api.importAssets(selectedId, { title: LL.automation.ipc.selectAssetDir() });
```

```tsx
      const result = await api.replaceAsset(selectedId, selectedAsset, { title: LL.automation.ipc.replaceAssetTitle({ asset: selectedAsset }), filterName: LL.automation.ipc.imageAssetFilter() });
```

```tsx
    const result = await api.exportPackage(selectedId, { title: LL.automation.ipc.exportPackageTitle(), filterName: LL.automation.ipc.openPackageFilter() });
```

`AutomationPanel.tsx`（`importPackage` 内）：

```tsx
      const result = await api.openPackage({
        title: LL.automation.ipc.openPackageTitle(),
        filterName: LL.automation.ipc.openPackageFilter(),
        replace: LL.automation.ipc.replace(),
        cancel: LL.automation.page.cancel(),
        existsTitle: LL.automation.ipc.packageExistsTitle(),
        existsMessage: LL.automation.ipc.packageExistsMessage(),
      });
```

- [ ] **Step 8: typecheck + 全量单测**

Run: `npm run typecheck && npx vitest run`
Expected: 全部通过。

- [ ] **Step 9: Commit**

```bash
git add src/main/ipc/download.ipc.ts src/main/ipc/screenshot.ipc.ts src/main/ipc/automation.ipc.ts src/main/ipc/userscripts-admin.ipc.ts src/preload/index.ts src/renderer/types/electron.d.ts src/renderer/components/panels/DownloadsPanel.tsx src/renderer/components/panels/SettingsPanel.tsx src/renderer/components/userscripts/UserscriptsPage.tsx src/renderer/components/automation/AutomationPage.tsx src/renderer/components/panels/AutomationPanel.tsx
git commit -m "feat(i18n): 原生对话框标题由渲染层传入翻译文本"
```

---

### Task 9: 最终验证

**Files:** 无代码改动。

- [ ] **Step 1: 全量校验**

Run: `npm run i18n && npm run typecheck && npm run lint && npm test -- --run`
Expected: 全部通过（i18n 生成无 diff、typecheck 通过、lint 通过、vitest 全绿）。

- [ ] **Step 2: 硬编码残留扫描**

Run:
```powershell
Get-ChildItem -Recurse -File src/renderer -Include *.tsx,*.ts | Where-Object { $_.FullName -notmatch 'i18n' } | ForEach-Object { (Select-String -LiteralPath $_.FullName -Pattern '[\u4e00-\u9fff]' -ErrorAction SilentlyContinue).Count } | Measure-Object -Sum
```
Expected: 仅剩注释中的中文（automation 组件内注释行、`NewTabPage` 品牌名注释、`SettingsPanel` 的 `简体中文` 除外，均为允许保留项）。逐文件确认 `AutomationPage.tsx`、`AutomationBlocklyEditor.tsx`、`AutomationPanel.tsx`、`WindowControls.tsx`、`ErrorBoundary.tsx` 无 JSX 中文残留。

- [ ] **Step 3: 手工验收清单**

1. 英文界面下 `about:automation` 全英文。
2. Blockly 积木/toolbox/下拉/右键菜单为英文；切换语言后布局保留。
3. 自动化侧栏状态文本、运行日志为英文。
4. 下载/截图/用户脚本对话框标题为英文。
