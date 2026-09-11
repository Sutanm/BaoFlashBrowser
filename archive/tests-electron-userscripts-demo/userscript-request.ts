// GM_xmlhttpRequest policy: @connect validation, address classification and
// log redaction. Pure logic (no Electron imports); the network execution lives
// in GmRequestService below.
// Mirrors the planned src/main/modules/userscripts/userscript-request.ts.

import ipaddr from 'ipaddr.js';

export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_CONCURRENT_PER_SCRIPT = 2;
export const DEFAULT_MAX_CONCURRENT_GLOBAL = 16;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'host',
  'origin',
  'referer',
  'content-length',
]);

export type AddressClass = 'loopback' | 'private' | 'linklocal' | 'unspecified' | 'public' | 'reserved';

export function classifyAddress(hostname: string): AddressClass {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return 'reserved';
  if (host === 'localhost') return 'loopback';
  if (!ipaddr.isValid(host)) return 'public';
  const addr = ipaddr.parse(host);
  if (addr.kind() === 'ipv4') {
    const range = addr.range();
    switch (range) {
      case 'loopback': return 'loopback';
      case 'private': return 'private';
      case 'linkLocal': return 'linklocal';
      case 'unspecified': return 'unspecified';
      case 'carrierGradeNat':
      case 'broadcast':
      case 'reserved': return 'reserved';
      default: return 'public';
    }
  }
  const range = addr.range();
  if (range === 'linkLocal') return 'linklocal';
  if (range === 'uniqueLocal') return 'private';
  if (range === 'unspecified') return 'unspecified';
  if (range === 'loopback') return 'loopback';
  if (range === 'ipv4Mapped') {
    const embedded = (addr as ipaddr.IPv6).toIPv4Address();
    return classifyAddress(embedded.toString());
  }
  return 'reserved';
}

export function isBlockedUrl(url: string, allowedLoopbackHosts?: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return true;
  const classification = classifyAddress(parsed.hostname);
  if (classification === 'public') return false;
  if (classification === 'loopback' && allowedLoopbackHosts?.includes(parsed.hostname)) return false;
  return true;
}

export function connectAllows(connect: string[], scriptOrigin: string, targetUrl: string): boolean {
  let target: URL;
  let source: URL;
  try {
    target = new URL(targetUrl);
    source = new URL(scriptOrigin);
  } catch {
    return false;
  }
  // Same-origin by the standard definition (protocol + host + port).
  if (target.origin === source.origin) return true;
  const targetHost = target.hostname.toLowerCase();
  for (const entry of connect) {
    const rule = entry.trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return true;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2);
      if (targetHost === suffix || targetHost.endsWith('.' + suffix)) return true;
    } else if (rule === targetHost) {
      return true;
    }
  }
  return false;
}

export function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.search) return `${parsed.origin}${parsed.pathname}?<redacted>`;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

export function redactHeadersForLog(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(String(name || '').toLowerCase());
}

export function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isSensitiveHeader(name)) result[name] = value;
  }
  return result;
}
