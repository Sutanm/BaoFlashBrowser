import type { Session } from 'electron';
import type { ProxySettings } from '@shared/types/proxy';
import { getActiveProxy } from './proxy';

/** Only the first route may be used: skipping an unsupported proxy to DIRECT
 * would silently bypass the user's policy. Chromium handles other routes. */
export function aria2ProxyOptions(route: string): Record<string, string> | null {
  const first = route.split(';')[0].trim();
  let proxy = '';
  if (first !== 'DIRECT') {
    const match = /^PROXY (\[[a-f\d:]+\]|[a-z\d.-]+):(\d+)$/i.exec(first);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
    proxy = `http://${match[1]}:${match[2]}`;
  }
  return {
    'all-proxy': proxy, 'http-proxy': proxy, 'https-proxy': proxy, 'ftp-proxy': proxy,
    'no-proxy': '',
  };
}

export async function resolveDownloadProxy(sess: Session, url: string, policy: ProxySettings = getActiveProxy()): Promise<Record<string, string> | null> {
  // Resolve system/PAC/bypass decisions through the actual Chromium session.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const route = await Promise.race([
      sess.resolveProxy(url),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Proxy resolution timeout')), 5000); }),
    ]);
    const options = aria2ProxyOptions(route);
    if (!options) return null;
    if (policy.mode === 'manual' && policy.protocol === 'http' && !policy.bypass) {
      const proxy = `http://${policy.host}:${policy.port}`;
      for (const key of ['all-proxy', 'http-proxy', 'https-proxy', 'ftp-proxy']) options[key] = proxy;
      // Match Chromium's implicit loopback bypass, also after redirection.
      options['no-proxy'] = 'localhost,.localhost,127.0.0.0/8,::1,169.254.0.0/16,fe80::/10';
    }
    return options;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
