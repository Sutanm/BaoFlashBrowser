# 抽屉 DevTools 去端口改造 · 实施计划

- 日期：2026-11-06
- 规格：`docs/archive/superpowers/specs/2026-11-06-devtools-endpoint-removal.md`
- 顺序原则：**先换容器（不碰 URL），再去端口（file:// + 白名单）**。每批独立提交、独立验证、独立回退。

## 批次总览

| 批次 | 内容 | 产出 | 回退方式 |
| --- | --- | --- | --- |
| B1 | 前置闸门 + 容器换代（BrowserView 承载前端，URL 仍 http） | 前端不再依赖 iframe | 开关 `BAO_DEVTOOLS_LEGACY_HTTP=1` |
| B2 | URL 切 `file://`、分区白名单、删静态服务 | **端口消失 + 设置持久** | 同上 |
| B3 | 桥传输迁移到 preload（可选，可延后） | `BAO_DEVTOOLS_BRIDGE=1` 恢复可用 | 桥本就默认关 |

## B1 容器换代

### B1.0 闸门（先跑，不过就停）

- [x] B1.1 `file://` → `ws://127.0.0.1` 连通性：**通过**（`file-ws-gate.cjs`）
- [ ] B1.2 `can_dock=true` 在 file:// 下的行为（并入 B2 首次真机验证）
- [ ] B1.3 分区白名单不误伤前端自身资源（并入 B2）

### B1.1 主进程：视图生命周期

- `devtoolbox.ts` 新增：
  - `createDevToolsView()`：`new BrowserView({ webPreferences: { partition: 'persist:devtools', contextIsolation: true, nodeIntegration: false } })`，
    `win.addBrowserView`，`loadURL(getDevToolsTargetUrl('page'))`。
  - `setDevToolsViewBounds(rect)`：`view.setBounds()`，与 tab 的 `setBounds` 同一形状。
  - `destroyDevToolsView()`：`removeBrowserView` + `webContents.close()`，置空。
  - 主窗口关闭时一并销毁。
- `devtoolbox.ipc.ts` 新增三通道：`attach` / `set-bounds` / `detach`（带 sender 校验，复用 `isTrustedSender`）。
- `preload/index.ts` + `renderer/types/electron.d.ts`：同步暴露。

**验证**：`dock-switch-check.cjs` 四模式矩形不变；Elements 树渲染正常。

### B1.2 渲染层：占位与矩形上报

- `DevToolsTab.tsx`：`<iframe>` → `<div ref={hostRef} id="devtools-host">`；
  `useEffect` 里 `attach` → `ResizeObserver` 上报 `getBoundingClientRect()` → 卸载时 `detach`。
- 目标切换（当前页面 / 外壳界面）：改为先 `destroy` 再 `attach`（原实现靠 URL key 重载）。
- 桥模式：`BAO_DEVTOOLS_BRIDGE=1` 时保留 iframe 路径并打一条 warn（B3 再迁移）。

**验证**：
- 四模式 + 拖拽：复用 `drag-tear-frames.cjs`，要求逐帧延迟 <1 帧。
- 切标签：`tab-switch-check.cjs` 语义不变（targetId 绑定表仍生效）。
- 密码链路：`bridge-realsite-check.cjs` 的日志判据（`[PasswordCapture] attached` 正常）。

## B2 去端口

- [ ] `getDevToolsTargetUrl()` 返回 `file:///<dist>/devtools_app.html?ws=…&can_dock=true`；
      `undocked` 走同一 URL（独立窗口）。
- [ ] `devtoolbox.ts` 新增 `installDevToolsFileGuard(session)`：
      `session.fromPartition('persist:devtools').protocol.interceptFileProtocol('file', handler)`；
      允许根：`dist/devtools-frontend`、`dist/renderer`（`realpath` 归一化 + 尾分隔符比较）。
- [ ] 删除 `ensureFrontendServer` / `frontendServer` / `frontendPort` / MIME 表 / 静态服务相关分支。
- [ ] 打包路径：`app.getAppPath()` 兼容 asar。

**验证**：
- 启动后无静态服务端口；前端 target 仍出现。
- 前端内求值：`window.parent.electronAPI === undefined`（容器换代后已无 parent）、
  `fetch('file:///C:/Windows/win.ini')` 失败、`fetch('file:///<dist>/…js')` 成功。
- **设置持久**：DevTools 里把语言改成英文 → 重启 → 仍英文。
- 本地 `.swf` / 本地 html（同级 + 跨目录引用）全部正常。

## B3 桥传输迁移（可延后）

- [ ] 前端 preload 暴露 `bfbBridge.{ send, onEvent }` → IPC → `devtoolsBridge`。
- [ ] 删除 `useDevToolsBridgeRelay.ts` 的 postMessage 路径。
- [ ] `BAO_DEVTOOLS_BRIDGE=1` 在 B2 之后必须**显式报错**，不得静默失效。

**验证**：`bridge-mode-check.cjs` / `bridge-tab-switch-check.cjs` 复跑。

## 质量门（每批都要过）

```bash
npm run typecheck          # 0 错
npm run lint               # 0 警
npm test -- --run          # 865 全过
node tools/devtools-spike/dock-switch-check.cjs
node tools/devtools-spike/drag-tear-frames.cjs
node tools/devtools-spike/dock-shell-check.cjs
```

## 备注

- 容器换代会把前端从"外壳子帧"变成"独立 WebContents"，**这是 file:// 安全的前提**（规格铁律 B2），
  不能跳过直接改 URL。
- 任何一批出问题，优先用 `BAO_DEVTOOLS_LEGACY_HTTP=1` 回到 iframe + http，而不是回滚容器。
