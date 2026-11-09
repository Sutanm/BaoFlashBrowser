import { create } from 'zustand';
import type { DevToolEntry } from '@shared/types/devtoolbox';

export type DevToolTab = 'devtools' | 'capture' | 'flash' | 'main';
/** 停靠位置：底部 / 左侧 / 右侧 / 独立窗口（对齐 Chrome、Edge 的四种模式）。 */
export type DevToolDock = 'bottom' | 'left' | 'right' | 'undocked';

const MAX_ENTRIES = 2000;
const MIN_HEIGHT = 160;
const MIN_WIDTH = 320;
const DEFAULT_RATIO = 0.34;
const DEFAULT_WIDTH_RATIO = 0.42;
const HEIGHT_STORAGE_KEY = 'devtoolbox.height';
const WIDTH_STORAGE_KEY = 'devtoolbox.width';
const DOCK_STORAGE_KEY = 'devtoolbox.dock';

/**
 * 多窗口 P5：抽屉布局按窗口 key 分片。
 * 旧单键（devtoolbox.height/width/dock）保持兼容；拿到 windowKey 后改为
 * `<windowKey>:devtoolbox.*`，并立刻从新作用域重读一次，避免第二个窗口
 * 继承前一个窗口的布局。
 */
let storageScope = '';

function scopedKey(base: string): string {
  return storageScope ? `${storageScope}:${base}` : base;
}

function readStoredHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(scopedKey(HEIGHT_STORAGE_KEY));
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

let persistTimer: number | null = null;

function persistHeight(height: number): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    try {
      window.localStorage.setItem(scopedKey(HEIGHT_STORAGE_KEY), String(Math.round(height)));
    } catch {
      // 存储被禁用时忽略：高度只是展示偏好
    }
  }, 120);
}

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(scopedKey(WIDTH_STORAGE_KEY));
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

let persistWidthTimer: number | null = null;

function persistWidth(width: number): void {
  if (persistWidthTimer !== null) window.clearTimeout(persistWidthTimer);
  persistWidthTimer = window.setTimeout(() => {
    persistWidthTimer = null;
    try {
      window.localStorage.setItem(scopedKey(WIDTH_STORAGE_KEY), String(Math.round(width)));
    } catch {
      // 同上
    }
  }, 120);
}

function readStoredDock(): DevToolDock {
  try {
    const raw = window.localStorage.getItem(scopedKey(DOCK_STORAGE_KEY));
    if (raw === 'bottom' || raw === 'left' || raw === 'right' || raw === 'undocked') return raw;
  } catch {
    // 忽略
  }
  return 'bottom';
}

/** 抽屉所在容器的高度。真实容器拿不到时退回窗口高度（首帧/HMR 期间）。 */
function workspaceHeight(): number {
  const el = document.querySelector('.workspace-main');
  if (el instanceof HTMLElement && el.clientHeight > 0) return el.clientHeight;
  return window.innerHeight;
}

/** 允许抽屉顶到只留这一条页面（把 6px 拖拽把手留在可视区内，随时能拖回去）。 */
const RESIZE_HANDLE_STRIP = 24;

export function maxDrawerHeight(): number {
  // 以前是 window.innerHeight * 0.8：拿整窗高度算上限，但抽屉活在顶栏之下的工作区里，
  // 真到上限时抽屉会超出可视区；而且 80% 这个硬比例跟内容无关，用户会觉得"拖不动了"。
  return Math.max(MIN_HEIGHT, Math.floor(workspaceHeight() - RESIZE_HANDLE_STRIP));
}

export function defaultDrawerHeight(): number {
  return Math.max(MIN_HEIGHT, Math.round(window.innerHeight * DEFAULT_RATIO));
}

export function clampDrawerHeight(height: number): number {
  return Math.min(maxDrawerHeight(), Math.max(MIN_HEIGHT, Math.round(height)));
}

export function maxDrawerWidth(): number {
  // 左右停靠时给页面留至少 320px，避免把页面挤没
  return Math.max(MIN_WIDTH, Math.min(Math.floor(window.innerWidth * 0.8), window.innerWidth - 320));
}

export function defaultDrawerWidth(): number {
  return Math.max(MIN_WIDTH, Math.round(window.innerWidth * DEFAULT_WIDTH_RATIO));
}

export function clampDrawerWidth(width: number): number {
  return Math.min(maxDrawerWidth(), Math.max(MIN_WIDTH, Math.round(width)));
}

export interface DevToolState {
  open: boolean;
  height: number;
  width: number;
  dock: DevToolDock;
  /** 独立窗口关闭后要回到的内嵌位置（不持久化）。 */
  lastEmbeddedDock: Exclude<DevToolDock, 'undocked'>;
  tab: DevToolTab;
  /**
   * 每个标签页各自记住"当前页面 / 外壳界面"的选择。
   * 面板只有一份（前端容器共用），但"想看哪个 target"是跟标签走的：
   * 在游戏页选了「当前页面」，切到新标签页再切回来应该还是「当前页面」。
   */
  tabTarget: Record<string, 'page' | 'shell'>;
  /**
   * 「刷新」用的计数器：自增即让 DevToolsTab 重新解析 target 并重建容器。
   * 放在 store 里是因为按钮已经挪到抽屉顶栏（和页签同一行），
   * 状态必须两个组件都能读写。
   */
  devtoolsReloadToken: number;
  entries: DevToolEntry[];

  setOpen: (open: boolean) => void;
  toggle: () => void;
  setHeight: (height: number) => void;
  setWidth: (width: number) => void;
  setDock: (dock: DevToolDock) => void;
  setTab: (tab: DevToolTab) => void;
  setTabTarget: (tabId: string, target: 'page' | 'shell') => void;
  bumpDevtoolsReload: () => void;
  ingest: (entries: DevToolEntry[]) => void;
  replaceEntries: (entries: DevToolEntry[]) => void;
  clearEntries: () => void;
}

const initialDock = readStoredDock();

export const useDevToolStore = create<DevToolState>((set) => ({
  open: false,
  height: readStoredHeight() ?? defaultDrawerHeight(),
  width: readStoredWidth() ?? defaultDrawerWidth(),
  dock: initialDock,
  lastEmbeddedDock: initialDock === 'undocked' ? 'bottom' : initialDock,
  tab: 'devtools',
  tabTarget: {},
  devtoolsReloadToken: 0,
  entries: [],

  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
  setHeight: (height) => {
    const next = clampDrawerHeight(height);
    persistHeight(next);
    set({ height: next });
  },
  setWidth: (width) => {
    const next = clampDrawerWidth(width);
    persistWidth(next);
    set({ width: next });
  },
  setDock: (dock) => {
    try {
      window.localStorage.setItem(scopedKey(DOCK_STORAGE_KEY), dock);
    } catch {
      // 忽略
    }
    set((state) => (dock === 'undocked'
      ? { dock, lastEmbeddedDock: state.dock === 'undocked' ? state.lastEmbeddedDock : state.dock }
      : { dock, lastEmbeddedDock: dock }));
  },
  setTab: (tab) => set({ tab }),
  setTabTarget: (tabId, target) => set((state) => ({ tabTarget: { ...state.tabTarget, [tabId]: target } })),
  bumpDevtoolsReload: () => set((state) => ({ devtoolsReloadToken: state.devtoolsReloadToken + 1 })),
  ingest: (incoming) => set((state) => {
    if (incoming.length === 0) return state;
    const merged = state.entries.concat(incoming);
    return { entries: merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged };
  }),
  replaceEntries: (entries) => set({
    entries: entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries,
  }),
  clearEntries: () => set({ entries: [] }),
}));

export const DEVTOOL_MIN_HEIGHT = MIN_HEIGHT;
export const DEVTOOL_MIN_WIDTH = MIN_WIDTH;

// ---------------------------------------------------------------------------
// 多窗口 P5：抽屉布局按窗口 key 分片。
// 旧单键（devtoolbox.height/width/dock）保持兼容；拿到 windowKey 后改为
// `<windowKey>:devtoolbox.*`，并立刻从新作用域重读一次，避免第二个窗口
// 继承前一个窗口的布局。
// ---------------------------------------------------------------------------
export function getDevToolStorageScope(): string {
  return storageScope;
}

export function setDevToolStorageScope(scope: string): void {
  const next = String(scope || '').trim();
  if (next === storageScope) return;
  storageScope = next;
  useDevToolStore.setState((state) => {
    const dock = readStoredDock();
    const height = readStoredHeight();
    const width = readStoredWidth();
    return {
      height: height === null ? state.height : clampDrawerHeight(height),
      width: width === null ? state.width : clampDrawerWidth(width),
      dock,
      lastEmbeddedDock: dock === 'undocked' ? 'bottom' : dock,
    };
  });
}
