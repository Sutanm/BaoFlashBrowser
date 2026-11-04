# 自动化工作台脚本编辑器语法高亮实施计划

> 日期：2026-09-11
> 状态：待实施

## 目标

为自动化工作台的 TS/JS 脚本编辑界面添加语法高亮支持，提升开发体验。

## 现状分析

- **自动化工作台** (`src/renderer/components/automation/AutomationPage.tsx:1026-1033`): 使用原生 `<textarea>`，无语法高亮
- **UserscriptEditor** (`src/renderer/components/userscripts/UserscriptEditor.tsx`): 已使用 CodeMirror 5，有完整语法高亮

## 方案

复用项目已安装的 CodeMirror 5，创建可复用的代码编辑器组件。

### 任务总览

| Task | 内容 | 完成门禁 |
|---|---|---|
| 1 | 创建通用 CodeMirror 编辑器组件 | 组件可渲染，支持 JS/TS 模式切换 |
| 2 | 修改 AutomationPage 集成新组件 | textarea 替换为 CodeMirror，语法高亮生效 |
| 3 | 样式适配 | 编辑器样式与自动化工作台主题一致 |
| 4 | 验证 | typecheck、lint 通过，手动验证高亮效果 |

## Task 1：创建通用 CodeMirror 编辑器组件

**文件：**
- Add: `src/renderer/components/common/CodeEditor.tsx`
- Add: `src/renderer/components/common/code-editor.css`

步骤：
- [ ] 创建 `CodeEditor` 组件，支持 `language` prop（`'javascript' | 'typescript'`）
- [ ] 复用 UserscriptEditor 的 CodeMirror 初始化逻辑和 ResizeObserver refresh
- [ ] 导入 CodeMirror JS 模式和 matchbrackets 插件
- [ ] 支持 controlled 模式（value + onChange）
- [ ] 创建配套 CSS，使用 CSS 变量适配主题

## Task 2：修改 AutomationPage 集成新组件

**文件：**
- Modify: `src/renderer/components/automation/AutomationPage.tsx`

步骤：
- [ ] 导入 `CodeEditor` 组件
- [ ] 将第 1026-1033 行的 `<textarea>` 替换为 `<CodeEditor>`
- [ ] 传递 `language={scriptLanguage}`、`value={scriptSource}`、`onChange` props
- [ ] 移除不再需要的 textarea 相关样式引用

## Task 3：样式适配

**文件：**
- Modify: `src/renderer/components/automation/automation.css`

步骤：
- [ ] 调整 `.code-pane` 内的编辑器容器高度（使用 `grid-template-rows: 42px minmax(0,1fr) auto`）
- [ ] 确保 CodeMirror 编辑器填满容器
- [ ] 调整编辑器背景色与现有 `#152033` 一致

## Task 4：验证

步骤：
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] 手动验证：自动化工作台脚本编辑器显示语法高亮
- [ ] 手动验证：JS/TS 模式切换正常工作

## 验收定义

1. 自动化工作台脚本编辑器显示行号
2. JavaScript/TypeScript 代码有语法高亮（关键字、字符串、注释等颜色不同）
3. 支持括号匹配
4. 编辑器可正常输入、编辑、保存
5. 类型检查和 lint 通过
