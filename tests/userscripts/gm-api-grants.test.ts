import { describe, expect, it } from 'vitest';
import { grantGmApi, type GmApi } from '../../src/webview-preload/userscripts/gm-api';

function fakeApi(): GmApi {
  const callable = (): void => undefined;
  return new Proxy({ info: { name: 'fixture' } }, {
    get(target, property) {
      if (property === 'info') return target.info;
      return callable;
    },
  }) as unknown as GmApi;
}

describe('userscript @grant enforcement', () => {
  it('exposes only explicitly granted capabilities', () => {
    const granted = grantGmApi(fakeApi(), [
      'GM_getValue',
      'GM.setClipboard',
      'GM_info',
      'unsafeWindow',
    ]);

    expect(Object.keys(granted.legacy)).toEqual(['GM_getValue', 'GM_setClipboard', 'GM_log']);
    expect(Object.keys(granted.modern)).toEqual(['getValue', 'setClipboard', 'log', 'info']);
    expect(granted.modern).not.toHaveProperty('xmlHttpRequest');
    expect(granted.legacy).not.toHaveProperty('GM_xmlhttpRequest');
    expect(granted.info).toEqual({ name: 'fixture' });
    expect(granted.unsafeWindow).toBe(true);
  });

  it('exposes only the non-privileged compatibility baseline when @grant is absent', () => {
    const granted = grantGmApi(fakeApi(), []);

    expect(Object.keys(granted.modern)).toEqual(['log', 'info']);
    expect(Object.keys(granted.legacy)).toEqual(['GM_log']);
    expect(granted.info).toEqual({ name: 'fixture' });
    expect(granted.modern).not.toHaveProperty('getValue');
    expect(granted.modern).not.toHaveProperty('xmlHttpRequest');
    expect(granted.unsafeWindow).toBe(false);
  });

  it('keeps spelling aliases within the same granted capability', () => {
    const granted = grantGmApi(fakeApi(), ['GM.xmlHttpRequest', 'GM_getResourceURL']);

    expect(granted.modern).toHaveProperty('xmlHttpRequest');
    expect(granted.modern).toHaveProperty('xmlhttpRequest');
    expect(granted.legacy).toHaveProperty('GM_xmlhttpRequest');
    expect(granted.modern).toHaveProperty('getResourceUrl');
    expect(granted.modern).toHaveProperty('getResourceURL');
  });
});
