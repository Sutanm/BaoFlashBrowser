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

function readStoredHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
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
      window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(Math.round(height)));
    } catch {
      // 存储被禁用时忽略：高度只是展示偏好
    }
  }, 120);
}

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
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
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(width)));
    } catch {
      // 同上
    }
  }, 120);
}

function readStoredDock(): DevToolDock {
  try {
    const raw = window.localStorage.getItem(DOCK_STORAGE_KEY);
    if (raw === 'bottom' || raw === 'left' || raw === 'right' || raw === 'undocked') return raw;
  } catch {
    // 忽略
  }
  return 'bottom';
}

export function maxDrawerHeight(): number {
  return Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.8));
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
  entries: DevToolEntry[];
  loaded: boolean;

  setOpen: (open: boolean) => void;
  toggle: () => void;
  setHeight: (height: number) => void;
  setWidth: (width: number) => void;
  setDock: (dock: DevToolDock) => void;
  setTab: (tab: DevToolTab) => void;
  ingest: (entries: DevToolEntry[]) => void;
  replaceEntries: (entries: DevToolEntry[]) => void;
  clearEntries: () => void;
  setLoaded: (loaded: boolean) => void;
}

const initialDock = readStoredDock();

export const useDevToolStore = create<DevToolState>((set) => ({
  open: false,
  height: readStoredHeight() ?? defaultDrawerHeight(),
  width: readStoredWidth() ?? defaultDrawerWidth(),
  dock: initialDock,
  lastEmbeddedDock: initialDock === 'undocked' ? 'bottom' : initialDock,
  tab: 'devtools',
  entries: [],
  loaded: false,

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
      window.localStorage.setItem(DOCK_STORAGE_KEY, dock);
    } catch {
      // 忽略
    }
    set((state) => (dock === 'undocked'
      ? { dock, lastEmbeddedDock: state.dock === 'undocked' ? state.lastEmbeddedDock : state.dock }
      : { dock, lastEmbeddedDock: dock }));
  },
  setTab: (tab) => set({ tab }),
  ingest: (incoming) => set((state) => {
    if (incoming.length === 0) return state;
    const merged = state.entries.concat(incoming);
    return { entries: merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged };
  }),
  replaceEntries: (entries) => set({
    entries: entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries,
  }),
  clearEntries: () => set({ entries: [] }),
  setLoaded: (loaded) => set({ loaded }),
}));

export const DEVTOOL_MIN_HEIGHT = MIN_HEIGHT;
export const DEVTOOL_MIN_WIDTH = MIN_WIDTH;
