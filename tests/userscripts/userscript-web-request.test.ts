import { describe, expect, it } from 'vitest';
import { createWebRequestObserver } from '@main/modules/userscripts/userscript-web-request';

describe('GM_webRequest observer isolation', () => {
  it('delivers only requests from the registered webContents and honors excludes', () => {
    const observer = createWebRequestObserver();
    const sent: Array<{ wcId: number; payload: unknown }> = [];
    observer.setSend((wcId, _channel, payload) => sent.push({ wcId, payload }));
    observer.setMatch('script-a', {
      match: ['https://example.com/*'],
      include: [],
      exclude: ['https://example.com/private/*'],
      excludeMatch: [],
    });
    observer.register({ wcId: 10, documentId: 'doc-a', scriptId: 'script-a' });
    observer.register({ wcId: 20, documentId: 'doc-b', scriptId: 'script-a' });

    observer.notifyBeforeRequest({ webContentsId: 10, url: 'https://example.com/api?token=secret', method: 'GET' });
    observer.notifyBeforeRequest({ webContentsId: 10, url: 'https://example.com/private/x', method: 'GET' });

    expect(sent).toHaveLength(1);
    expect(sent[0].wcId).toBe(10);
    expect(JSON.stringify(sent[0].payload)).not.toContain('secret');
  });
});
