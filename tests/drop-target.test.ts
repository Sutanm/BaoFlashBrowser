import { describe, expect, it } from 'vitest';
import { resolveBandTarget, resolveDropIntent, resolveDropTarget, resolveWindowMergeTarget } from '../src/main/utils/drop-target';

const winA = { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } };
const winB = { id: 2, bounds: { x: 900, y: 0, width: 800, height: 600 } };

describe('drag drop target (P7)', () => {
  it('hits the window under the cursor', () => {
    expect(resolveDropTarget({ x: 100, y: 100 }, [winA, winB])).toEqual({ kind: 'window', id: 1 });
    expect(resolveDropTarget({ x: 1000, y: 100 }, [winA, winB])).toEqual({ kind: 'window', id: 2 });
  });

  it('treats the window edge as exclusive for the neighbour', () => {
    expect(resolveDropTarget({ x: 900, y: 10 }, [winA, winB])).toEqual({ kind: 'window', id: 2 });
    expect(resolveDropTarget({ x: 1700, y: 10 }, [winA, winB])).toEqual({ kind: 'new-window' });
  });

  it('drops outside every window as a tear-off', () => {
    expect(resolveDropTarget({ x: 2000, y: 100 }, [winA, winB])).toEqual({ kind: 'new-window' });
  });

  it('treats negative coordinates as a tear-off (monitor left of / above primary)', () => {
    // 主屏左侧或上方的副屏坐标是负数，旧实现把它当"虚拟桌面外"直接拒掉。
    expect(resolveDropTarget({ x: -5, y: 10 }, [winA])).toEqual({ kind: 'new-window' });
    expect(resolveDropTarget({ x: 10, y: -5 }, [winA])).toEqual({ kind: 'new-window' });
    expect(resolveDropTarget({ x: -1900, y: 200 }, [winA])).toEqual({ kind: 'new-window' });
  });
});

describe('drag drop intent (P7)', () => {
  it('moves the tab into another window regardless of the drop zone', () => {
    expect(resolveDropIntent({ kind: 'window', id: 2 }, 1, false)).toEqual({ kind: 'move-to-window', id: 2 });
    expect(resolveDropIntent({ kind: 'window', id: 2 }, 1, true)).toEqual({ kind: 'move-to-window', id: 2 });
  });

  it('tears off when the drop point is outside every window', () => {
    expect(resolveDropIntent({ kind: 'new-window' }, 1, false)).toEqual({ kind: 'tear-off' });
  });

  it('tears off when dropped on the owner window content area', () => {
    // 最大化窗口铺满工作区，屏幕内只剩这一种落点，必须能拖出。
    expect(resolveDropIntent({ kind: 'window', id: 1 }, 1, true)).toEqual({ kind: 'tear-off' });
  });

  it('cancels when dropped back on the owner window chrome', () => {
    expect(resolveDropIntent({ kind: 'window', id: 1 }, 1, false)).toEqual({ kind: 'cancel' });
  });
});

describe('drag drop tabbar band (P7 tear-off)', () => {
  it('only hits the top band of a window', () => {
    // 600 高的窗口，带高默认 48：y=20 命中，y=200 不命中。
    expect(resolveBandTarget({ x: 100, y: 20 }, [winA])).toEqual(winA);
    expect(resolveBandTarget({ x: 100, y: 200 }, [winA])).toBeNull();
    expect(resolveBandTarget({ x: 100, y: 48 }, [winA])).toBeNull();
  });

  it('skips the following window so the drop can reach the one underneath', () => {
    // 跟手窗口挂在指针右下方，本身也在候选列表里；不排除就会永远命中自己。
    expect(resolveBandTarget({ x: 100, y: 20 }, [winA, winB], [winA.id])).toBeNull();
    expect(resolveBandTarget({ x: 100, y: 20 }, [winA, winB], [winB.id])).toEqual(winA);
  });

  it('clamps the band to short windows', () => {
    const tiny = { id: 3, bounds: { x: 0, y: 0, width: 400, height: 20 } };
    expect(resolveBandTarget({ x: 10, y: 19 }, [tiny], [], 48)).toEqual(tiny);
    expect(resolveBandTarget({ x: 10, y: 20 }, [tiny], [], 48)).toBeNull();
  });
});

describe('single-tab window drag merge (P7)', () => {
  // 单标签窗口按住标签拖的是整个窗口，落点靠"两条标签栏重叠"判定。
  const dragged = { id: 7, bounds: { x: 100, y: 100, width: 1100, height: 760 } };

  it('merges when the two tab strips overlap under the cursor', () => {
    // 目标窗口上沿比被拖窗口高 10px：指针（被拖窗口标签栏 y=130）同时落在目标带内。
    const target = { id: 9, bounds: { x: 600, y: 90, width: 1000, height: 700 } };
    expect(resolveWindowMergeTarget({ x: 700, y: 130 }, dragged, [target])).toEqual(target);
  });

  it('ignores the drop when the cursor is not on the drag window strip', () => {
    // 缩放窗口/从工具栏拖动时指针不在标签栏带内：不能因为标签栏正好重叠就吞并窗口。
    const target = { id: 9, bounds: { x: 600, y: 90, width: 1000, height: 700 } };
    expect(resolveWindowMergeTarget({ x: 700, y: 400 }, dragged, [target])).toBeNull();
  });

  it('does not merge windows that are merely side by side', () => {
    const neighbour = { id: 9, bounds: { x: 1300, y: 100, width: 900, height: 700 } };
    // 指针在被拖窗口标签栏里，但目标标签栏带在 x >= 1300，够不到。
    expect(resolveWindowMergeTarget({ x: 700, y: 130 }, dragged, [neighbour])).toBeNull();
  });

  it('never merges into itself', () => {
    expect(resolveWindowMergeTarget({ x: 700, y: 130 }, dragged, [dragged])).toBeNull();
  });
});
