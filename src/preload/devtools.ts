import { contextBridge, ipcRenderer } from 'electron';

/**
 * DevTools 前端专用 preload（B3：桥传输从 iframe postMessage 迁到 preload）。
 *
 * **为什么不复用 `src/preload/index.ts`**：那份暴露的是整付 `electronAPI`
 * （`pwd.*` 能读密码库、`tab.*` 能开任意页面）。DevTools 前端跑在独立分区
 * 的 BrowserView 里，把全量 API 给它等于把 B2 的隔离目标当场作废。这里只暴露
 * 一条 CDP 管道，别的什么都没有。
 *
 * 桥本身（browser ws + flatten session、Target 域模拟、有序队列）在主进程
 * `modules/devtoolbox-bridge.ts`，本文件只做「页面 ⇄ 主进程」的搬运：
 *
 *   前端 M97 代码 ──window.bfbBridge── preload ──IPC── 主进程桥 ──ws── 目标页面
 *
 * 两条硬约束：
 * 1. **响应与事件必须逐条、按序回调**。桥把它们合进同一条有序流（16ms 合批），
 *    这里只按数组顺序照发；一旦改成 Promise 或分通道投递，Elements 树就会空洞
 *    （S15 的结论：`DOM.setChildNodes` 先于其响应到达时子节点会被丢弃）。
 * 2. **send 不返回 Promise 给页面**。M97 的 `sendRawMessage` 是同步接口，响应
 *    一律走有序流；把 Promise 漏到页面只会让前端多一条并行的完成路径。
 */

/** 与主进程 `devtoolbox:bridge-event` 同名，复用既有通道与白名单。 */
const EVENT_CHANNEL = 'devtoolbox:bridge-event';
const SEND_CHANNEL = 'devtoolbox:bridge-send';
const DETACH_CHANNEL = 'devtoolbox:bridge-detach';
/** 工作区（真实本地文件夹）——宿主侧实现见 modules/devtoolbox-workspace.ts。 */
const WORKSPACE_CHANNEL = 'devtoolbox:workspace';
/** 主进程 → 页面：工作区文件发生变更（外部编辑器改动）。 */
const WORKSPACE_CHANGES_CHANNEL = 'devtoolbox:workspace-changes';

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface EventPayload {
  events?: CdpMessage[];
  /** 主进程主动宣告断开（桥 socket 关闭 / target 消失）。 */
  disconnect?: string;
}

/** 前端发来的原始命令（还没校验过形状）。 */
interface RawCommand {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  sessionId?: unknown;
}

let messageListener: ((message: string) => void) | null = null;
let disconnectListener: ((reason: string) => void) | null = null;
/** 工作区文件变更的页面侧监听（bfb-workspace.js 注册）。 */
let workspaceChangeListener: ((payload: unknown) => void) | null = null;

ipcRenderer.on(WORKSPACE_CHANGES_CHANNEL, (_event, payload: unknown) => {
  workspaceChangeListener?.(payload);
});
/**
 * 外壳当前的停靠位置（bottom/left/right/undocked）。
 *
 * 原生 DevTools 自带一套停靠菜单，勾选状态读的是它自己的 `dockSide()`；我们的抽屉
 * 由外壳摆位，前端一直以为自己是初始值（实测永远勾着「停靠至底部」）。前端补丁
 * 让 `dockSide()` 优先返回这里，菜单勾选才和外壳一致。
 */
let shellDockSide = '';

ipcRenderer.on('devtoolbox:dock-side', (_event, side: unknown) => {
  if (typeof side === 'string' && side.length > 0 && side.length < 20) shellDockSide = side;
});

ipcRenderer.on(EVENT_CHANNEL, (_event, payload: EventPayload | undefined) => {
  if (!payload) return;
  if (payload.disconnect) {
    disconnectListener?.(payload.disconnect);
    return;
  }
  const events = payload.events;
  if (!events || events.length === 0) return;
  const listener = messageListener;
  if (!listener) return;
  for (const item of events) {
    // 逐条 JSON 化后立刻回调：同一批内的相对顺序 = 主进程入队顺序。
    try {
      listener(JSON.stringify(item));
    } catch {
      // 前端监听器自己抛错时不能拖死后续消息
    }
  }
});

/**
 * 页面可用的唯一接口。
 *
 * `onOpen` 直接回调是成立的：主进程只有在 `bridge.attach()` 成功之后才创建
 * 承载前端的 WebContents（见 `devtoolbox.ts:attachDevToolsView`），所以本
 * preload 能跑起来时桥一定已就绪，不存在「连上了但没 target」的中间态。
 */
const bfbBridge = {
  onOpen(callback: () => void): void {
    setTimeout(() => {
      try {
        callback();
      } catch {
        // 前端回调异常不影响桥
      }
    }, 0);
  },

  onMessage(callback: (message: string) => void): void {
    messageListener = callback;
    // 就绪握手：主进程的挂起 replay（重开抽屉时 attach 先于本页加载，replay
    // 的 styleSheetAdded 等事件不能在空 listener 上放行）等这一刻才发。
    void ipcRenderer.invoke('devtoolbox:bridge-frontend-ready').catch(() => {
      // 桥不在（探针单独驱动等）：静默
    });
  },

  onDisconnect(callback: (reason: string) => void): void {
    disconnectListener = callback;
  },

  /**
   * 发送一条前端原始 CDP 命令（JSON 字符串）。
   *
   * `id` 必须原样带上：桥据此把响应塞进有序流而不是走返回值；丢了 id 就等于
   * 退回「响应与事件分两路」的旧形态。
   */
  send(raw: string): void {
    let parsed: RawCommand | null = null;
    try {
      parsed = JSON.parse(raw) as RawCommand;
      // eslint 的空 catch 更糟：这里静默丢弃非法 JSON 是有意的（前端不该发这种）
    } catch {
      return;
    }
    if (!parsed || typeof parsed.method !== 'string' || parsed.method.length === 0) return;
    const id = typeof parsed.id === 'number' && parsed.id > 0 ? parsed.id : undefined;
    void ipcRenderer
      .invoke(SEND_CHANNEL, {
        method: parsed.method,
        params: parsed.params as Record<string, unknown> | undefined,
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
        id,
      })
      .then((result: { ok?: boolean; error?: { message?: string } } | null) => {
        // 正常情况下响应走有序流，这里只接桥自身的失败（未连接 / 参数非法）。
        if (result && result.ok === false) {
          disconnectListener?.(result.error?.message || 'bridge-error');
        }
      })
      .catch(() => {
        // 主进程已退出或通道被销毁：静默，前端靠 did-close 收尾
      });
  },

  disconnect(): void {
    void ipcRenderer.invoke(DETACH_CHANNEL).catch(() => {
      // 同上
    });
  },

  /**
   * 会话轮换：同一 target 拆了重挂（新 session = 全新 DOM agent）。
   *
   * 只给 sdk.js 的 getMatchedStyles 垫片用：87 号 DOM agent bug 复发、本地
   * documentUpdated 重取兜不住时升级调用。fire-and-forget——垫片不关心结果，
   * 桥重建完会发 documentUpdated，前端按既有逻辑重建面板。桥内有 3s 冷却。
   */
  rotate(): void {
    void ipcRenderer.invoke('devtoolbox:bridge-rotate').catch(() => {
      // 桥不在（探针单独驱动等）：静默，前端靠下一次错误重试
    });
  },

  /**
   * 把「原生 DevTools 界面里的框架级操作」转给外壳。
   *
   * 原生前端自己带一套停靠菜单和一个关闭按钮，但停靠/关闭是**外壳**的事：
   * 抽屉在四边怎么摆、关掉是收起抽屉还是关窗口，前端都不知道。所以这两处被
   * 补丁改成只发意图（`{ dock }` / `{ close }`），由外壳的 store 落地，
   * 前端自己不再改 dockSide（否则它会在 BrowserView 里画出错的布局）。
   */
  shell(intent: { dock?: string; close?: boolean }): void {
    if (!intent || typeof intent !== 'object') return;
    const payload: { dock?: string; close?: boolean } = {};
    if (typeof intent.dock === 'string' && intent.dock.length > 0 && intent.dock.length < 20) payload.dock = intent.dock;
    if (intent.close === true) payload.close = true;
    if (payload.dock === undefined && payload.close === undefined) return;
    ipcRenderer.send('devtoolbox:frontend-intent', payload);
  },

  /**
   * 外壳当前的停靠位置，供前端补丁里的 `dockSide()` 优先采用。
   * 没收到过就返回空串，前端退回自己的值。
   */
  dockSide(): string {
    return shellDockSide;
  },

  /**
   * 工作区（DevTools「设置 → 工作区 → 添加文件夹」）。
   *
   * 内置前端跑在 hosted mode，原生宿主的 `addFileSystem` 只是个假实现（塞一个
   * `filesystem:devtools://…/overrides` 假条目，第二次点击还会撞 project 重名）。
   * 这里把真实的目录选择与文件读写交给主进程（modules/devtoolbox-workspace.ts），
   * 页面侧的虚拟 DOM FileSystem 在构建期注入的 bfb-workspace.js 里。
   *
   * 只暴露「按授权根目录名 + 相对路径」操作，不含任何绝对路径直读能力。
   */
  workspace: {
    list(): Promise<unknown> {
      return invokeWorkspace('list');
    },
    pick(type: string): Promise<unknown> {
      return invokeWorkspace('pick', { type });
    },
    remove(fileSystemPath: string): Promise<unknown> {
      return invokeWorkspace('remove', { fileSystemPath });
    },
    readDir(name: string, relative: string): Promise<unknown> {
      return invokeWorkspace('readDir', { name, relative });
    },
    stat(name: string, relative: string): Promise<unknown> {
      return invokeWorkspace('stat', { name, relative });
    },
    readFile(name: string, relative: string): Promise<unknown> {
      return invokeWorkspace('readFile', { name, relative });
    },
    writeFile(name: string, relative: string, base64: string): Promise<unknown> {
      return invokeWorkspace('writeFile', { name, relative, base64 });
    },
    createFile(name: string, relative: string, exclusive: boolean): Promise<unknown> {
      return invokeWorkspace('createFile', { name, relative, exclusive });
    },
    createDirectory(name: string, relative: string): Promise<unknown> {
      return invokeWorkspace('createDirectory', { name, relative });
    },
    deletePath(name: string, relative: string, recursive: boolean): Promise<unknown> {
      return invokeWorkspace('deletePath', { name, relative, recursive });
    },
    move(name: string, relative: string, to: string): Promise<unknown> {
      return invokeWorkspace('move', { name, relative, to });
    },
    search(fileSystemPath: string, query: string): Promise<unknown> {
      return invokeWorkspace('search', { fileSystemPath, query });
    },
    /** 订阅主进程推来的文件变更（外部编辑器改了工作区里的文件时触发）。 */
    onChanges(callback: (payload: unknown) => void): void {
      workspaceChangeListener = callback;
    },
  },
};

/**
 * 工作区统一入口：一条通道 + action 字段，主进程按 action 分派并做 zod 校验。
 *
 * 失败一律 resolve 成 `{ ok: false, error }` 而不是 reject：页面侧的虚拟
 * FileSystem 把这些结果翻译成 DOMException 回调，reject 会让调用方多一条分支。
 */
function invokeWorkspace(action: string, payload?: Record<string, unknown>): Promise<unknown> {
  return ipcRenderer
    .invoke(WORKSPACE_CHANNEL, { action, ...(payload ?? {}) })
    .catch((error: unknown) => ({
      ok: false,
      error: { name: 'InvalidStateError', message: error instanceof Error ? error.message : String(error) },
    }));
}

contextBridge.exposeInMainWorld('bfbBridge', bfbBridge);
