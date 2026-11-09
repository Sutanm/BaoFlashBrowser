import Store from 'electron-store';
import log from 'electron-log';

/**
 * 窗口几何/顺序持久化（SDD: docs/specs/multi-window-plan.md §6.5 / §7 P5）。
 *
 * 只存"怎么把窗口摆回来"，不含标签会话（后者在渲染层 IndexedDB，按
 * `tab-session:<windowKey>` 分片）。写入由 index.ts 在 resize/move/退出时防抖触发。
 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  key: string;
  bounds: WindowBounds;
  maximized: boolean;
  index: number;
}

interface WindowStateSchema {
  windows: WindowState[];
}

const MAX_WINDOWS = 8;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 200;
const WINDOW_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

let store: Store<WindowStateSchema> | null = null;

function getStore(): Store<WindowStateSchema> {
  if (!store) {
    store = new Store<WindowStateSchema>({
      name: 'window-state',
      defaults: { windows: [] },
    });
  }
  return store;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeBounds(value: unknown): WindowBounds | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const x = finite(raw.x);
  const y = finite(raw.y);
  const width = finite(raw.width);
  const height = finite(raw.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export function sanitizeWindowStates(raw: unknown): WindowState[] {
  if (!Array.isArray(raw)) return [];
  const result: WindowState[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (result.length >= MAX_WINDOWS) break;
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    const key = candidate.key;
    if (typeof key !== 'string' || !WINDOW_KEY_PATTERN.test(key) || seen.has(key)) continue;
    const bounds = sanitizeBounds(candidate.bounds);
    if (!bounds) continue;
    if (typeof candidate.maximized !== 'boolean') continue;
    const index = finite(candidate.index);
    if (index === null || !Number.isInteger(index) || index < 0) continue;
    seen.add(key);
    result.push({ key, bounds, maximized: candidate.maximized, index });
  }
  return result.sort((a, b) => a.index - b.index);
}

/** 从当前注册窗口采集可持久化状态，按给定 index 排序后重新编号。 */
export function windowStatesFromWindows(windows: Array<Omit<WindowState, 'index'> & { index?: number }>): WindowState[] {
  const ordered = windows
    .map((item, position) => ({
      ...item,
      index: typeof item.index === 'number' && Number.isInteger(item.index) && item.index >= 0 ? item.index : position,
    }))
    .sort((a, b) => a.index - b.index);
  const sanitized = sanitizeWindowStates(ordered.map((item, position) => ({
    key: item.key,
    bounds: item.bounds,
    maximized: item.maximized,
    index: position,
  })));
  return sanitized.map((item, position) => ({ ...item, index: position }));
}

export function loadWindowStates(): WindowState[] {
  try {
    return sanitizeWindowStates(getStore().get('windows'));
  } catch (error) {
    log.warn('[WindowState] load failed:', error instanceof Error ? error.message : String(error));
    return [];
  }
}

export function saveWindowStates(states: WindowState[]): void {
  try {
    getStore().set('windows', sanitizeWindowStates(states));
  } catch (error) {
    log.warn('[WindowState] save failed:', error instanceof Error ? error.message : String(error));
  }
}

/** 仅测试用：丢弃已缓存的 electron-store 句柄。 */
export function resetWindowStateStoreForTest(): void {
  store = null;
}
