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

## B1 容器换代 ✅ 已完成（2026-11-06）

### B1.0 闸门（先跑，不过就停）

- [x] B1.1 `file://` → `ws://127.0.0.1` 连通性：**通过**（`file-ws-gate.cjs`）
- [x] B1.2  在 http 下确认生效；file:// 下的行为并入 B2 首次真机验证（预期等价：只读 query 参数）
- [x] B1.3 分区白名单不误伤前端自身资源（并入 B2）

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

## B2 去端口 ✅ 已完成（2026-11-06）

- [x] `getDevToolsTargetUrl()` 返回 `file:///<dist>/devtools_app.html?ws=…&can_dock=true`；
      `undocked` 走同一 URL（独立窗口）。
- [x] `devtoolbox.ts` 新增 `installDevToolsFileGuard(session)`：
      `session.fromPartition('persist:devtools').protocol.interceptFileProtocol('file', handler)`；
      允许根：`dist/devtools-frontend`、`dist/renderer`（`realpath` 归一化 + 尾分隔符比较）。
- [x] 删除 `ensureFrontendServer` / `frontendServer` / `frontendPort` / MIME 表 / 静态服务相关分支。
- [x] 打包路径：`app.getAppPath()` 兼容 asar。

**验证**：
- 启动后无静态服务端口；前端 target 仍出现。
- 前端内求值：`window.parent.electronAPI === undefined`（容器换代后已无 parent）、
  `fetch('file:///C:/Windows/win.ini')` 失败、`fetch('file:///<dist>/…js')` 成功。
- **设置持久**：DevTools 里把语言改成英文 → 重启 → 仍英文。
- 本地 `.swf` / 本地 html（同级 + 跨目录引用）全部正常。

## B3 桥传输迁移 ✅ 已完成（2026-11-06）

- [x] 前端 preload 暴露 `bfbBridge.{ send, onEvent }` → IPC → `devtoolsBridge`。
- [x] 删除 `useDevToolsBridgeRelay.ts` 的 postMessage 路径。
- [x] `BAO_DEVTOOLS_BRIDGE=1` 在 B2 之后必须**显式报错**，不得静默失效。

实际实现与计划的两处偏离，都是现场撞出来的：

1. **preload 另起一份**（`src/preload/devtools.ts` → `dist/devtools-preload.js`），
   不在主 preload 上加 API。原计划"`src/preload/index.ts` +1 API"会把整付
   `electronAPI`（含 `pwd.*`）送给前端，等于把 B2 的隔离目标作废。
2. **不做"显式报错"**。桥变成默认传输后 `BAO_DEVTOOLS_BRIDGE=1` 只是空开关，
   报错反而会让老的启动脚本失败；文档标注"不再有效、无副作用"。
   回退改为 `BAO_DEVTOOLS_PAGE_WS=1`。

顺带修掉两个会长期埋雷的问题：

- `devtoolbox.ts` ↔ `devtoolbox-bridge.ts` 循环依赖（桥要 `listDebugTargets`，
  容器又要桥来前置 attach）→ 端点查询抽到 `devtoolbox-targets.ts`。
- **绑定候选把前端自己当成了可绑定 target**：`isFrontendTarget` 只认 `?ws=`，
  桥模式 URL 是 `?can_dock=true` 漏网。切标签时新标签还是 about:blank，绑定走
  fallback 就把前端容器掳走，热切换随后因 targetId 相同早退 → 面板永远停在
  错误文档上。同时把 fallback 收紧成"只接受 `about:` 的无人占用 target"。

**验证**（2026-11-06 实跑）：`bridge-mode-check` 树命中 `#mark`、`bfbBridge=object`、
`electronAPI=undefined`、异常 0；`bridge-tab-switch-check` 容器未重建、URL 未变、
面板时间戳保留、树切到 TWO 且不再含 ONE；`BFB_PAGE_WS=1` 回退路径同样渲染正常；
`dock-switch-check` 四模式与独立窗口关回归内嵌正常。

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
