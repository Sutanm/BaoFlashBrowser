// Version comparison and @updateURL host validation for the manual update
// flow. Pure module (no Electron imports) so it unit-tests in plain Vitest.

import { connectAllows } from './userscript-request';

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = String(a ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// Extract the host from a @match/@include URL pattern (scheme://host[:port]/*).
function hostOfMatchPattern(pattern: string): string | null {
  const text = String(pattern ?? '').trim();
  if (!text) return null;
  const afterScheme = text.replace(/^[a-z]+:\/\//i, '');
  const hostPart = afterScheme.split(/[/?#]/)[0] ?? '';
  const cleaned = hostPart.replace(/^\*\.?/, '');
  return cleaned && cleaned !== '*' ? cleaned.toLowerCase() : null;
}

// The update source host must be listed in @connect (with wildcard support) or
// share a host with a @match rule (weak path). data:/other schemes rejected.
export function updateHostAllowed(connect: string[], match: string[], updateUrl: string): boolean {
  let target: URL;
  try {
    target = new URL(updateUrl);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  const targetHost = target.hostname.toLowerCase();

  for (const entry of connect) {
    const rule = String(entry ?? '').trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return true;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2);
      if (targetHost === suffix || targetHost.endsWith('.' + suffix)) return true;
    } else if (rule === targetHost) {
      return true;
    }
  }

  for (const pattern of match) {
    const host = hostOfMatchPattern(pattern);
    if (!host) continue;
    if (host === targetHost || targetHost.endsWith('.' + host)) return true;
  }
  return false;
}

// GM_cookie domain gate: the target cookie host must be allowed by @connect
// (same-origin can never match for data: pages, mirroring background/xhr
// semantics). Pure wrapper over connectAllows.
export function cookieHostAllowed(connect: string[], pageUrl: string, host: string): boolean {
  if (!host) return false;
  return connectAllows(connect, pageUrl, 'https://' + host + '/');
}
