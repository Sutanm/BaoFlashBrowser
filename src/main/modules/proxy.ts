import { net, session } from 'electron';
import { DEFAULT_PROXY, proxySettingsSchema, toElectronProxy, type ProxySettings, type ProxyTestResult } from '@shared/types/proxy';

let activeProxy: ProxySettings = { ...DEFAULT_PROXY };
let testing = false;
let testId = 0;
// Electron 11 pins Session objects for the process lifetime. Bound the number
// of isolated test contexts rather than retaining unlimited network contexts.
const MAX_TEST_SESSIONS = 32;

export function usesBrowserDownloads(): boolean {
  return activeProxy.mode !== 'system';
}

export async function initializeProxy(settings: ProxySettings): Promise<void> {
  const proxy = proxySettingsSchema.parse(settings);
  const config = toElectronProxy(proxy);
  if (config) {
    await Promise.all([session.defaultSession, session.fromPartition('persist:')].map((sess) => sess.setProxy(config)));
  }
  activeProxy = proxy;
}

/** Tests unsaved settings in a fresh memory session, without browser cookies. */
export async function testProxy(proxy: ProxySettings, url: string): Promise<ProxyTestResult> {
  if (testing) return { ok: false, route: '', error: 'BUSY' };
  if (testId >= MAX_TEST_SESSIONS) return { ok: false, route: '', error: 'TEST_LIMIT' };
  testing = true;
  let route = '';
  let request: Electron.ClientRequest | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sess = session.fromPartition(`proxy-test-${++testId}`, { cache: false });
    return await new Promise<ProxyTestResult>((resolve) => {
      let done = false;
      const finish = (result: ProxyTestResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        request?.abort();
        resolve(result);
      };
      timer = setTimeout(() => finish({ ok: false, route, error: 'TIMEOUT' }), 15000);
      void (async () => {
        const config = toElectronProxy(proxy);
        if (config) await sess.setProxy(config);
        route = await sess.resolveProxy(url);
        if (done) return;
        request = net.request({ url, session: sess, redirect: 'manual' });
        request.on('login', (_authInfo, callback) => {
          callback();
          finish({ ok: false, route, error: 'PROXY_AUTH_REQUIRED' });
        });
        request.on('error', () => finish({ ok: false, route, error: 'NETWORK_ERROR' }));
        request.on('response', (response) => finish({
          ok: response.statusCode >= 200 && response.statusCode < 400,
          route,
          statusCode: response.statusCode,
        }));
        request.end();
      })().catch(() => finish({ ok: false, route, error: 'NETWORK_ERROR' }));
    });
  } finally {
    clearTimeout(timer);
    testing = false;
  }
}
