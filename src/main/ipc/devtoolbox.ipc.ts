import { z } from 'zod';
import { ipcMain } from 'electron';
import path from 'path';
import { createHandler, createValidatedHandler } from '../utils/ipc-wrapper';
import {
  attachDevToolsView,
  clearDevToolEntries,
  closeDevToolsWindow,
  destroyDevToolsView,
  getDevToolSnapshot,
  getDevToolsFrontendContents,
  getDevToolsTargetUrl,
  openDevToolsWindow,
  openNativeDevTools,
  probeActivePage,
  resolveDebugPort,
  resolveTargetId,
  setDevToolsViewBounds,
} from '../modules/devtoolbox';
import { devToolsBridge } from '../modules/devtoolbox-bridge';
import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspacePath,
  listWorkspaceRoots,
  moveWorkspacePath,
  pickWorkspaceRoot,
  readWorkspaceDirectory,
  readWorkspaceFile,
  removeWorkspaceRoot,
  searchWorkspacePath,
  setWorkspaceChangeSink,
  statWorkspacePath,
  warmWorkspaceIndexes,
  writeWorkspaceFile,
} from '../modules/devtoolbox-workspace';
import { getMainWindow } from '../modules/window';

const target = z.enum(['page', 'shell']);

/**
 * 桥的 IPC 有两个来源，都必须精确校验：
 * - **外壳 renderer**：只调 `attach`（切标签热切换）与 `stats`（探针/诊断）；
 * - **前端容器自己的 WebContents**：`send` / `detach`。B3 之前它经 iframe
 *   postMessage 中继、sender 仍是外壳；迁到 preload 后前端直接说话，校验对象变了。
 */
function isTrustedSender(event: { sender: Electron.WebContents }): boolean {
  const win = getMainWindow();
  if (win && !win.isDestroyed() && event.sender === win.webContents) return true;
  const frontend = getDevToolsFrontendContents();
  return Boolean(frontend && event.sender === frontend);
}

const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
}).strict();

const bridgeSendSchema = z.object({
  method: z.string().min(1).max(120),
  params: z.record(z.unknown()).optional(),
  // 前端带 sessionId 时忽略（桥为单 target 世界）；保留字段以对齐协议形状。
  sessionId: z.string().min(1).max(120).optional(),
  // 前端请求 id：给了就代表「响应走有序流」，桥不再用 IPC 返回值回传。
  id: z.number().int().positive().optional(),
}).strict();

/** 相对授权根目录的路径：必须是相对路径，绝对路径一律拒绝（夹取在主进程再做一次）。 */
const workspacePathArg = z.string().max(4096).refine((value) => !path.isAbsolute(value), 'must be relative');

/** 工作区 action 分派：`list`/`pick` 之外一律要带根目录名与相对路径。 */
const workspaceActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('pick'), type: z.string().max(40).optional() }).strict(),
  z.object({ action: z.literal('remove'), fileSystemPath: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('readDir'), name: z.string().min(1).max(120), relative: workspacePathArg }).strict(),
  z.object({ action: z.literal('stat'), name: z.string().min(1).max(120), relative: workspacePathArg }).strict(),
  z.object({ action: z.literal('readFile'), name: z.string().min(1).max(120), relative: workspacePathArg }).strict(),
  z.object({
    action: z.literal('writeFile'),
    name: z.string().min(1).max(120),
    relative: workspacePathArg,
    // base64：上限 32MB 的原始字节（≈44MB 文本），足够覆盖 DevTools 里会编辑的文件
    base64: z.string().max(48 * 1024 * 1024),
  }).strict(),
  z.object({
    action: z.literal('createFile'),
    name: z.string().min(1).max(120),
    relative: workspacePathArg,
    exclusive: z.boolean(),
  }).strict(),
  z.object({ action: z.literal('createDirectory'), name: z.string().min(1).max(120), relative: workspacePathArg }).strict(),
  z.object({
    action: z.literal('deletePath'),
    name: z.string().min(1).max(120),
    relative: workspacePathArg,
    recursive: z.boolean(),
  }).strict(),
  z.object({
    action: z.literal('move'),
    name: z.string().min(1).max(120),
    relative: workspacePathArg,
    to: workspacePathArg,
  }).strict(),
  z.object({
    action: z.literal('search'),
    fileSystemPath: z.string().min(1).max(4096),
    query: z.string().max(500).optional(),
  }).strict(),
]);

export function registerDevToolboxIPC(): void {
  // 两个只读探测都收 tabId：主进程的"活动标签"比渲染层晚一拍，靠它会读到上一个页面。
  const tabIdArg = z.object({ tabId: z.string().min(1).max(120).nullable().optional() }).strict();

  createHandler<unknown, ReturnType<typeof getDevToolSnapshot>>('devtoolbox:snapshot', (args) => {
    const parsed = tabIdArg.safeParse(args ?? {});
    return getDevToolSnapshot(parsed.success ? parsed.data.tabId : undefined);
  });

  createHandler<void, void>('devtoolbox:clear', () => {
    clearDevToolEntries();
  });

  // 独立窗口：停靠位置设为 undocked 时由渲染层拉起；关窗后主进程回发事件
  createValidatedHandler(
    'devtoolbox:open-devtools-window',
    z.object({ target: target.optional(), tabId: z.string().min(1).max(120).nullable().optional() }).strict(),
    (args: { target?: 'page' | 'shell'; tabId?: string | null }) => openDevToolsWindow(args.target ?? 'page', args.tabId),
  );

  createHandler<void, void>('devtoolbox:close-devtools-window', () => {
    closeDevToolsWindow();
  });

  // 内嵌前端视图（B1 容器换代）：BrowserView 承载前端，bounds 由渲染层上报
  createValidatedHandler(
    'devtoolbox:attach-devtools-view',
    z.object({ target, tabId: z.string().min(1).max(120).nullable().optional() }).strict(),
    (args: { target: 'page' | 'shell'; tabId?: string | null }) => attachDevToolsView(args.target, args.tabId),
  );

  createValidatedHandler(
    'devtoolbox:set-devtools-bounds',
    boundsSchema,
    (args: { x: number; y: number; width: number; height: number }) => {
      setDevToolsViewBounds(args);
    },
  );

  // 拖拽专用同步通道：渲染层在 ResizeObserver 回调里等这一步，跨进程多走一次
  // 外壳把当前停靠位置推给前端：原生「停靠侧」菜单的勾选状态读的是前端自己的
  // dockSide()，不推的话永远勾在初始值上（实测在右侧停靠时勾着「底部」）。
  createValidatedHandler(
    'devtoolbox:set-dock',
    z.object({ dock: z.enum(['bottom', 'left', 'right', 'undocked']) }).strict(),
    (args: { dock: 'bottom' | 'left' | 'right' | 'undocked' }) => {
      const frontend = getDevToolsFrontendContents();
      if (frontend && !frontend.isDestroyed()) frontend.send('devtoolbox:dock-side', args.dock);
    },
  );

  // 原生 DevTools 界面里的「停靠 / 关闭」：前端只发意图，由外壳的 store 落地。
  // 前端自己不改 dockSide —— 它跑在 BrowserView 里，改自己的停靠只会画出错的布局。
  ipcMain.on('devtoolbox:frontend-intent', (event, args: unknown) => {
    const frontend = getDevToolsFrontendContents();
    if (!frontend || event.sender !== frontend) return;
    const parsed = z.object({
      dock: z.enum(['bottom', 'left', 'right', 'undocked']).optional(),
      close: z.boolean().optional(),
    }).strict().safeParse(args);
    if (!parsed.success) return;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('devtoolbox:frontend-intent', parsed.data);
  });

  // 异步投递就会晚一帧，快速拖拽时"布局到位、画面还停在上一帧"非常刺眼。
  // **必须先写 returnValue**：不写的话渲染线程会一直被挂住（不是超时，是卡死）。
  ipcMain.on('devtoolbox:set-devtools-bounds-sync', (event, args: unknown) => {
    event.returnValue = true;
    if (!isTrustedSender(event)) return;
    const parsed = boundsSchema.safeParse(args);
    if (!parsed.success) return;
    setDevToolsViewBounds(parsed.data);
  });

  createHandler<void, void>('devtoolbox:detach-devtools-view', () => {
    destroyDevToolsView();
  });

  // DevTools 前端只认 WebSocket，这里给出可直接喂给 iframe 的 ws 地址。
  createValidatedHandler(
    'devtoolbox:devtools-url',
    z.object({ target, tabId: z.string().min(1).max(120).nullable().optional() }).strict(),
    (args: { target: 'page' | 'shell'; tabId?: string | null }) => getDevToolsTargetUrl(args.target, args.tabId),
  );

  createValidatedHandler(
    'devtoolbox:open-native',
    z.object({ target }).strict(),
    (args: { target: 'page' | 'shell' }) => openNativeDevTools(args.target),
  );

  createHandler<unknown, Awaited<ReturnType<typeof probeActivePage>>>('devtoolbox:probe-page', (args) => {
    const parsed = tabIdArg.safeParse(args ?? {});
    return probeActivePage(parsed.success ? parsed.data.tabId : undefined);
  });

  // ---- CDP 桥（桥 v2） ----
  // 这几个通道不走 createHandler：需要 sender 校验（规格 §2 铁律 B5），
  // 而公共 wrapper 不接收 event。
  // B3 之后前端就是事件终点：直接投给前端容器的 WebContents，由它的 preload
  // 逐条回调给页面。**不再经外壳 renderer 中转**——那是 iframe 时代的形状。
  devToolsBridge.setEventSink((events) => {
    const frontend = getDevToolsFrontendContents();
    if (frontend) {
      frontend.send('devtoolbox:bridge-event', { events });
      return;
    }
    // 前端容器不在（page-ws 路径，或桥被探针单独驱动）时退回外壳 renderer，
    // 让 `bridge.onEvents` 至少还有观察窗口。
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('devtoolbox:bridge-event', { events });
  });

  ipcMain.handle('devtoolbox:bridge-attach', async (event, args?: { target?: 'page' | 'shell'; tabId?: string | null }) => {
    if (!isTrustedSender(event)) return { ok: false, error: { message: 'untrusted-sender' } };
    const port = resolveDebugPort();
    if (!port) return { ok: false, error: { message: 'no-port' } };
    // 目标由渲染层指定：桥模式 URL 恒定，切 page/shell 不会重建容器，
    // 只能靠这一次 attach 换 target。
    // **tabId 必须由渲染层给**：切标签是渲染层先更新、主进程后跟上的，
    // 用主进程的"活动标签"会在这段窗口里绑到上一个页面（实测：切到新标签页
    // 后仍显示旧页面的 Elements，且因为 URL 恒定再也不会重解析）。
    const targetId = await resolveTargetId(args?.target === 'shell' ? 'shell' : 'page', args?.tabId);
    if (!targetId) return { ok: false, error: { message: 'no-target' } };
    try {
      const { sessionId } = await devToolsBridge.attach(targetId, port);
      return { ok: true, targetId, sessionId };
    } catch (error) {
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  });

  ipcMain.handle('devtoolbox:bridge-detach', async (event) => {
    if (!isTrustedSender(event)) return { ok: false, error: { message: 'untrusted-sender' } };
    await devToolsBridge.detach();
    return { ok: true };
  });

  // 会话轮换（同一 target 拆了重挂）：87 号 DOM agent bug 的前端垫片在本地恢复
  // 兜不住时调用。新 session = 全新 DOM agent 与节点 id 空间，等价于用户手工
  // 「切外壳再切回当前页」。桥内有 3s 冷却，风暴下不会无限重建。
  ipcMain.handle('devtoolbox:bridge-rotate', async (event) => {
    if (!isTrustedSender(event)) return { ok: false, error: { message: 'untrusted-sender' } };
    return devToolsBridge.rotate();
  });

  // 前端就绪握手：preload 在页面注册 onMessage 后调用。主进程据此放行挂起的
  // replay——在此之前 styleSheetAdded 等 enable 伴生事件投出去只会被空 listener
  // 蒸发（重开抽屉样式永久转圈的根因，2026-11-09 真机实证）。
  ipcMain.handle('devtoolbox:bridge-frontend-ready', async (event) => {
    if (!isTrustedSender(event)) return { ok: false, error: { message: 'untrusted-sender' } };
    devToolsBridge.markFrontendReady();
    return { ok: true };
  });

  ipcMain.handle('devtoolbox:bridge-send', async (event, args: unknown) => {
    if (!isTrustedSender(event)) return { ok: false, error: { message: 'untrusted-sender' } };
    const parsed = bridgeSendSchema.safeParse(args);
    if (!parsed.success) return { ok: false, error: { message: 'invalid-arguments' } };
    return devToolsBridge.send(parsed.data.method, parsed.data.params, parsed.data.sessionId, parsed.data.id);
  });

  ipcMain.handle('devtoolbox:bridge-stats', (event) => {
    if (!isTrustedSender(event)) return null;
    return devToolsBridge.getStats();
  });

  // ---- 工作区（真实本地文件夹） ----
  // 一条通道 + action 分派：页面侧的虚拟 FileSystem 只传「授权根目录名 + 相对路径」，
  // 绝对路径由主进程按清单解析（见 modules/devtoolbox-workspace.ts 的安全边界）。
  //
  // 文件变更走反向推送（`devtoolbox:workspace-changes` → 前端 preload → bfb-workspace.js
  // 派发 FileSystemFilesChangedAddedRemoved），这样外部编辑器的改动 Sources 能自己刷新。
  warmWorkspaceIndexes();
  setWorkspaceChangeSink((fileSystemPath, change) => {
    const frontend = getDevToolsFrontendContents();
    if (frontend && !frontend.isDestroyed()) {
      frontend.send('devtoolbox:workspace-changes', { fileSystemPath, change });
    }
  });

  ipcMain.handle('devtoolbox:workspace', async (event, args: unknown) => {
    if (!isTrustedSender(event)) return { ok: false, error: { name: 'SecurityError', message: 'untrusted-sender' } };
    const parsed = workspaceActionSchema.safeParse(args);
    if (!parsed.success) return { ok: false, error: { name: 'InvalidModificationError', message: 'invalid-arguments' } };
    const payload = parsed.data;
    switch (payload.action) {
      case 'list':
        return { ok: true, roots: listWorkspaceRoots() };
      case 'pick':
        return pickWorkspaceRoot(payload.type ?? '');
      case 'remove':
        return removeWorkspaceRoot(payload.fileSystemPath);
      case 'readDir':
        return readWorkspaceDirectory(payload.name, payload.relative);
      case 'stat':
        return statWorkspacePath(payload.name, payload.relative);
      case 'readFile':
        return readWorkspaceFile(payload.name, payload.relative);
      case 'writeFile':
        return writeWorkspaceFile(payload.name, payload.relative, payload.base64);
      case 'createFile':
        return createWorkspaceFile(payload.name, payload.relative, payload.exclusive);
      case 'createDirectory':
        return createWorkspaceDirectory(payload.name, payload.relative);
      case 'deletePath':
        return deleteWorkspacePath(payload.name, payload.relative, payload.recursive);
      case 'move':
        return moveWorkspacePath(payload.name, payload.relative, payload.to);
      case 'search':
        return searchWorkspacePath(payload.fileSystemPath, payload.query ?? '');
      default:
        return { ok: false, error: { name: 'InvalidModificationError', message: 'unknown-action' } };
    }
  });
}
