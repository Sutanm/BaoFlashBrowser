// GM_cookie READ-ONLY service (list/get only — no set/delete, by design).
// Cookie access is gated by the @connect list of the calling script.

import { session } from 'electron';
import { cookieHostAllowed } from './userscript-versions';
import type { GmCookie } from '../../../shared/userscript-types';

const MAX_COOKIES = 100;

export interface GmCookieListFilter {
  url?: string;
  domain?: string;
  name?: string;
}

export interface GmCookieGetFilter {
  url: string;
  name: string;
}

function toGmCookie(c: Electron.Cookie): GmCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? '',
    path: c.path ?? '',
    secure: c.secure ?? false,
    httpOnly: c.httpOnly ?? false,
    expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined,
    session: c.session ?? false,
  };
}

function resolveHost(filter: { url?: string; domain?: string }): string | null {
  try {
    if (filter.url) return new URL(filter.url).hostname.toLowerCase();
    return (filter.domain ?? '').replace(/^\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

function cleanFilter(filter: Record<string, string | undefined>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

export class GmCookieService {
  list(
    wcId: number,
    scriptId: string,
    pageUrl: string,
    connect: string[],
    filter: GmCookieListFilter,
  ): Promise<{ ok: boolean; cookies?: GmCookie[]; error?: string }> {
    const host = resolveHost(filter);
    if (!host || !cookieHostAllowed(connect, pageUrl, host)) {
      return Promise.resolve({ ok: false, error: 'connect-denied' });
    }
    return session.fromPartition('persist:').cookies
      .get(cleanFilter({ url: filter.url, domain: filter.domain, name: filter.name }))
      .then((cookies) => ({ ok: true, cookies: cookies.slice(0, MAX_COOKIES).map(toGmCookie) }))
      .catch((error: Error) => ({ ok: false, error: error?.message ?? 'network' }));
  }

  get(
    wcId: number,
    scriptId: string,
    pageUrl: string,
    connect: string[],
    filter: GmCookieGetFilter,
  ): Promise<{ ok: boolean; cookie?: GmCookie | null; error?: string }> {
    const host = resolveHost({ url: filter.url });
    if (!host || !cookieHostAllowed(connect, pageUrl, host)) {
      return Promise.resolve({ ok: false, error: 'connect-denied' });
    }
    return session.fromPartition('persist:').cookies
      .get(cleanFilter({ url: filter.url, name: filter.name }))
      .then((cookies) => ({ ok: true, cookie: cookies[0] ? toGmCookie(cookies[0]) : null }))
      .catch((error: Error) => ({ ok: false, error: error?.message ?? 'network' }));
  }
}
