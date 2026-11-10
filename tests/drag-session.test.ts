import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

const windows = vi.hoisted(() => new Map<number, unknown>());
vi.mock('electron', () => ({
  screen: {
    getCursorScreenPoint: () => ({ x: 400, y: 400 }),
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  },
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn() } }));
vi.mock('../src/main/modules/window', () => ({ getWindowById: (id: number) => windows.get(id) }));

import { getDragFollowWindowId, startDragFollow, stopDragFollow } from '../src/main/modules/drag-session';

function makeWindow(id: number) {
  const win = Object.assign(new EventEmitter(), {
    id,
    getBounds: () => ({ x: 0, y: 0, width: 1100, height: 760 }),
    isDestroyed: () => false,
    isVisible: () => true,
    moveTop: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setBounds: vi.fn(),
  });
  windows.set(id, win);
  return win;
}

it('only stops the matching session and cleans up when its window closes', () => {
  const source = makeWindow(1);
  const following = makeWindow(2);
  const onStop = vi.fn();
  const id = startDragFollow(following as never, source as never, 'tab', onStop);

  try {
    expect(stopDragFollow(2, 'tab', id)).toBeNull();
    expect(stopDragFollow(1, 'tab', id + 1)).toBeNull();
    expect(stopDragFollow(1, 'other-tab', id)).toBeNull();
    expect(getDragFollowWindowId()).toBe(2);
    expect(onStop).not.toHaveBeenCalled();

    source.emit('closed');
    expect(getDragFollowWindowId()).toBeNull();
    expect(following.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(onStop).toHaveBeenCalledOnce();
  } finally {
    stopDragFollow(1, 'tab', id);
    windows.clear();
  }
});
