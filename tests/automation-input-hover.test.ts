import { describe, expect, it, vi } from 'vitest';
import { BrowserViewInputService, type BrowserViewInputServiceOptions } from '../src/main/modules/automation/browserview-input-service';

describe('automation native hover with CDP button input', () => {
  function fixture(options: Partial<BrowserViewInputServiceOptions> = {}) {
    const events: unknown[] = [];
    let attached = false;
    const target = {
      id: 99881, isDestroyed: () => false,
      sendInputEvent: vi.fn((event) => { events.push(event); }),
      debugger: {
        isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; },
        sendCommand: vi.fn(async (_method, event) => { events.push(event); }),
      },
    };
    const service = new BrowserViewInputService(target, {
      assertCurrent: () => {}, toDisplayPoint: (point) => ({ x: point.x * .5, y: point.y * .5 }),
      displayScale: () => ({ x: .5, y: .5 }), sleep: async () => {},
      ...options,
    });
    return { service, target, events };
  }

  it('injects hover before CDP double-click buttons without awaiting a mouseMoved frame ack', async () => {
    const { service, target, events } = fixture();
    await service.click({ x: 201, y: 101 }, 'left', 2, new AbortController().signal);
    expect(events).toEqual([
      { type: 'mouseMove', x: 101, y: 51 },
      { type: 'mousePressed', x: 100.5, y: 50.5, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 100.5, y: 50.5, button: 'left', clickCount: 1 },
      { type: 'mousePressed', x: 100.5, y: 50.5, button: 'left', clickCount: 2 },
      { type: 'mouseReleased', x: 100.5, y: 50.5, button: 'left', clickCount: 2 },
    ]);
    expect(target.debugger.isAttached()).toBe(false);
  });

  it('sends no native or CDP input after cancellation', async () => {
    const { service, events } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(service.click({ x: 1, y: 2 }, 'left', 1, controller.signal)).rejects.toThrow('cancelled');
    expect(events).toEqual([]);
  });

  it('preserves the held button on native drag motion and releases it through CDP', async () => {
    const { service, target } = fixture();
    await service.drag({ x: 20, y: 20 }, { x: 40, y: 40 }, 'left', 16, new AbortController().signal);
    expect(target.sendInputEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'] }));
    expect(target.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseMoved' }));
    expect(target.debugger.sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased', buttons: 0 }));
    expect(target.debugger.isAttached()).toBe(false);
  });

  it('subtracts input processing time from subsequent drag waits', async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => { clock += ms; });
    const { service, target } = fixture({ now: () => clock, sleep });
    target.sendInputEvent.mockImplementation(() => { clock += 8; });
    await service.drag({ x: 0, y: 0 }, { x: 100, y: 100 }, 'left', 80, new AbortController().signal);
    expect(sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)).toBe(48);
    expect(clock).toBe(96); // Initial move + scheduled 80ms + final move overhead.
  });

  it('skips obsolete intermediate moves when the clock passes the final deadline', async () => {
    let clock = 0;
    const { service, target } = fixture({ now: () => clock, sleep: async () => { clock += 200; } });
    await service.drag({ x: 0, y: 0 }, { x: 100, y: 100 }, 'left', 80, new AbortController().signal);
    expect(target.sendInputEvent).toHaveBeenCalledTimes(2);
    expect(target.sendInputEvent).toHaveBeenLastCalledWith(expect.objectContaining({ x: 50, y: 50, modifiers: ['leftButtonDown'] }));
  });

  it('releases the mouse and lease when cancelled during the drag wait', async () => {
    const controller = new AbortController();
    const { service, target } = fixture({ sleep: async () => { controller.abort(); } });
    await expect(service.drag({ x: 0, y: 0 }, { x: 100, y: 100 }, 'right', 80, controller.signal)).rejects.toThrow('cancelled');
    expect(target.sendInputEvent).toHaveBeenCalledOnce();
    expect(target.debugger.sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased', button: 'right', buttons: 0 }));
    expect(target.debugger.isAttached()).toBe(false);
  });

  it.each([['middle', 'middleButtonDown'], ['right', 'rightButtonDown']] as const)('preserves %s during motion', async (button, modifier) => {
    const { service, target } = fixture();
    await service.drag({ x: 0, y: 0 }, { x: 100, y: 100 }, button, 0, new AbortController().signal);
    expect(target.sendInputEvent).toHaveBeenLastCalledWith(expect.objectContaining({ button, modifiers: [modifier] }));
    expect(target.debugger.sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased', button, buttons: 0 }));
  });
});
