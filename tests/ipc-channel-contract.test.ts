// 多窗口 P2 静态契约（SDD: docs/specs/multi-window-plan.md §6.3）
//
// 三套白名单必须同步：preload 的 invoke/on 集合、renderer 的类型声明、
// shared/types/ipc.ts 的推送/载荷类型。历史上它们已经漂移过一次
// （devtoolbox:frontend-intent 不在白名单），所以这里做静态断言。
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const source = (relativePath: string): string => readFileSync(path.join(root, relativePath), 'utf8');

describe('multi-window IPC channel contract (P2)', () => {
  const preload = source('src/preload/index.ts');
  const preloadInvokeAllowlist = preload.slice(
    preload.indexOf('const ALLOWED_INVOKE_CHANNELS'),
    preload.indexOf('const ALLOWED_SEND_CHANNELS'),
  );
  const rendererTypes = source('src/renderer/types/electron.d.ts');
  const sharedIpc = source('src/shared/types/ipc.ts');

  it('whitelists win:get-context and win:new-window in preload', () => {
    for (const channel of ['win:get-context', 'win:new-window']) {
      expect(preloadInvokeAllowlist).toContain(`'${channel}'`);
    }
  });

  it('exposes both channels through the preload win API', () => {
    expect(preload).toMatch(/getContext:\s*\(\)\s*=>\s*safeInvoke\('win:get-context'\)/u);
    expect(preload).toMatch(/newWindow:\s*\([^)]*\)\s*=>\s*safeInvoke\('win:new-window'/u);
  });

  it('exposes the P7 tab-transfer methods (whitelist without methods crashes the renderer)', () => {
    expect(preload).toMatch(/moveTab:\s*\([^)]*\)\s*=>\s*safeInvoke\('win:move-tab'/u);
    expect(preload).toMatch(/tearOffTab:\s*\([^)]*\)\s*=>\s*safeInvoke\('win:tear-off-tab'/u);
    expect(preload).toMatch(/rendererReady:\s*\(\)\s*=>\s*safeInvoke\('win:renderer-ready'\)/u);
  });

  it('declares both channels in the renderer typings', () => {
    expect(rendererTypes).toContain("'win:get-context'");
    expect(rendererTypes).toContain("'win:new-window'");
    expect(rendererTypes).toMatch(/getContext\(\)/u);
    expect(rendererTypes).toMatch(/newWindow\(/u);
  });

  it('declares the window context payload in shared types', () => {
    expect(sharedIpc).toMatch(/export interface WindowContextPayload/u);
    expect(sharedIpc).toMatch(/windowKey:\s*string/u);
    expect(sharedIpc).toMatch(/isPrimary:\s*boolean/u);
  });
});
