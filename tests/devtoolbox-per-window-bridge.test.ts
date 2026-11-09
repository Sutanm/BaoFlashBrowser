// 多窗口 P4b：桥实例按窗口分桶，窗口关闭/退出只关自己。
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const bridgeModule = await import('../src/main/modules/devtoolbox-bridge');

describe('DevTools bridge registry (P4b)', () => {
  beforeEach(() => {
    bridgeModule.disposeAllDevToolsBridges();
  });

  it('creates one independent bridge per window', () => {
    const a = bridgeModule.getDevToolsBridge(1);
    const b = bridgeModule.getDevToolsBridge(2);
    expect(a).not.toBe(b);
    expect(bridgeModule.getDevToolsBridge(1)).toBe(a);
    expect(bridgeModule.getDevToolsBridgeCount()).toBe(2);
  });

  it('disposes only the targeted window bridge', () => {
    const a = bridgeModule.getDevToolsBridge(1);
    const b = bridgeModule.getDevToolsBridge(2);
    const shutdownA = vi.spyOn(a, 'shutdown');
    const shutdownB = vi.spyOn(b, 'shutdown');

    bridgeModule.disposeDevToolsBridge(1);

    expect(shutdownA).toHaveBeenCalledTimes(1);
    expect(shutdownB).not.toHaveBeenCalled();
    expect(bridgeModule.getDevToolsBridgeCount()).toBe(1);
    expect(bridgeModule.getDevToolsBridge(2)).toBe(b);
  });

  it('disposes every bridge on app shutdown', () => {
    const a = bridgeModule.getDevToolsBridge(1);
    const b = bridgeModule.getDevToolsBridge(2);
    const shutdownA = vi.spyOn(a, 'shutdown');
    const shutdownB = vi.spyOn(b, 'shutdown');

    bridgeModule.disposeAllDevToolsBridges();

    expect(shutdownA).toHaveBeenCalledTimes(1);
    expect(shutdownB).toHaveBeenCalledTimes(1);
    expect(bridgeModule.getDevToolsBridgeCount()).toBe(0);
  });
});
