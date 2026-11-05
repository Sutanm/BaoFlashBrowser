import { create } from 'zustand';
import type { DevToolEntry } from '@shared/types/devtoolbox';

export type DevToolTab = 'devtools' | 'capture' | 'flash' | 'main';

const MAX_ENTRIES = 2000;
const MIN_HEIGHT = 160;
const DEFAULT_RATIO = 0.34;
const HEIGHT_STORAGE_KEY = 'devtoolbox.height';

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

export function maxDrawerHeight(): number {
  return Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.8));
}

export function defaultDrawerHeight(): number {
  return Math.max(MIN_HEIGHT, Math.round(window.innerHeight * DEFAULT_RATIO));
}

export function clampDrawerHeight(height: number): number {
  return Math.min(maxDrawerHeight(), Math.max(MIN_HEIGHT, Math.round(height)));
}

export interface DevToolState {
  open: boolean;
  height: number;
  tab: DevToolTab;
  entries: DevToolEntry[];
  loaded: boolean;

  setOpen: (open: boolean) => void;
  toggle: () => void;
  setHeight: (height: number) => void;
  setTab: (tab: DevToolTab) => void;
  ingest: (entries: DevToolEntry[]) => void;
  replaceEntries: (entries: DevToolEntry[]) => void;
  clearEntries: () => void;
  setLoaded: (loaded: boolean) => void;
}

export const useDevToolStore = create<DevToolState>((set) => ({
  open: false,
  height: readStoredHeight() ?? defaultDrawerHeight(),
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
