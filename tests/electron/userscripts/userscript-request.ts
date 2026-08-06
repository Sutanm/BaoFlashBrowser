// GM_xmlhttpRequest policy: @connect validation, address classification and
// log redaction. Pure logic (no Electron imports); the network execution lives
// in GmRequestService below.
// Mirrors the planned src/main/modules/userscripts/userscript-request.ts.

import { net } from 'electron';

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
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return 'loopback';
  if (host === '::' || host === '0.0.0.0' || host === '0:0:0:0:0:0:0:0') return 'unspecified';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split('.').map(Number);
    const [a, b] = parts;
    if (a === 127) return 'loopback';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'linklocal';
    if (a === 100 && b >= 64 && b <= 127) return 'reserved';
    if (a === 192 && b === 0) return 'reserved';
    if (a === 192 && b === 0 && parts[2] === 2) return 'reserved';
    if (a >= 224) return 'reserved';
    return 'public';
  }
  if (host.startsWith('fe80:')) return 'linklocal';
  if (host.startsWith('fc') || host.startsWith('fd')) return 'private';
  if (host.startsWith('::ffff:')) return classifyAddress(host.slice(7));
  if (host.includes(':')) return 'reserved';
  return 'public';
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
