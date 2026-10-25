import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => void>(), wcs: new Map<number, unknown>() }));
vi.mock('electron', () => ({
  ipcMain: { on: (name: string, fn: (...args: unknown[]) => void) => state.handlers.set(name, fn) },
  webContents: { fromId: (id: number) => state.wcs.get(id) },
  session: {}, net: {},
}));
vi.mock('@main/modules/config', () => ({ loadConfig: vi.fn() }));
import { githubModuleRedirect, patchGitHubModuleCsp, setupGitHubModules } from '@main/modules/github-module-service';

describe('GitHub module bridge boundary', () => {
  const source = 'https://github.githubassets.com/assets/react-1234.js';
  setupGitHubModules();
  const send = (id: number, url: string, frameId: number, map: unknown) => {
    const event = { sender: { id, getURL: () => url, getProcessId: () => 41 }, processId: 41, frameId, returnValue: undefined };
    state.handlers.get('github-module:map')!(event, JSON.stringify(map));
    return event.returnValue;
  };
  it('rejects non-GitHub senders, subframes and non-CDN targets', () => {
    expect(send(1, 'https://evil.test/', 1, { imports: { react: source } })).toBe(false);
    expect(send(1, 'https://github.com/', 9, { imports: { react: source } })).toBe(false);
    expect(send(1, 'https://github.com/', 1, { imports: { react: 'https://127.0.0.1/x.js' } })).toBe(false);
  });
  it('keeps different documents on their own React versions', async () => {
    for (const id of [11, 12]) state.wcs.set(id, { getURL: () => 'https://github.com/', on: vi.fn(), once: vi.fn() });
    expect(send(11, 'https://github.com/', 1, { imports: { react: source } })).toBe(true);
    expect(send(12, 'https://github.com/', 1, { imports: { react: 'https://github.githubassets.com/assets/react-5678.js' } })).toBe(true);
    expect(await githubModuleRedirect(source, 11)).not.toEqual(await githubModuleRedirect(source, 12));
    expect(await githubModuleRedirect('https://evil.test/assets/a.js', 11)).toBeNull();
  });
  it('extends only script directives that already trust the same asset CDN', () => {
    const headers = { 'Content-Security-Policy': ["default-src 'none'; script-src github.githubassets.com 'sha256-test'; font-src github.githubassets.com"] };
    const output = patchGitHubModuleCsp(headers);
    expect(output['Content-Security-Policy'][0]).toContain("script-src github.githubassets.com 'sha256-test' bfb-github-module:");
    expect(output['Content-Security-Policy'][0]).toContain('font-src github.githubassets.com');
    expect(headers['Content-Security-Policy'][0]).not.toContain('bfb-github-module:');
    expect(patchGitHubModuleCsp({ 'Content-Security-Policy': ["script-src 'none'"] })['Content-Security-Policy']).toEqual(["script-src 'none'"]);
  });
});
