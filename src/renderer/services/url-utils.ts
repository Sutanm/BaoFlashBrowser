export const NEWTAB_URL = 'about:newtab';
export const USERSCRIPTS_URL = 'about:userscripts';
export const AUTOMATION_URL = 'about:automation';

export function getHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export function isNewtabUrl(url: string): boolean {
  return !url || url === 'about:blank' || url === NEWTAB_URL || url.startsWith('data:');
}

/** 回环 / 本机地址：多半是调试服务，随时会停，不该为它发图标请求。 */
export function isLocalAddress(urlOrHost: string): boolean {
  const host = getHost(urlOrHost).toLowerCase();
  if (!host) return false;
  return host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || host === '[::1]'
    || host.endsWith('.localhost')
    || /^127\./.test(host);
}

/**
 * 决定条目图标的图片地址。返回 `null` 表示**不要发请求**，调用方显示首字母占位。
 *
 * 2026-11-13：这里原先是「没有 favicon 就请求 www.google.com/s2/favicons」。
 * 国内连不上 google.com，于是每一条都卡到超时才失败，把外壳控制台刷满
 * ERR_CONNECTION_TIMED_OUT；存过本地调试地址的条目还会刷 ERR_CONNECTION_REFUSED。
 * 现在一律不外发：有就用自己的，没有就用占位。
 */
export function resolveFaviconSrc(favicon: string | undefined, pageUrl: string): string | null {
  if (!favicon) return null;
  // data: / blob: 是内联资源，不产生网络请求，直接保留。
  if (/^(?:data|blob):/i.test(favicon)) return favicon;
  if (isLocalAddress(pageUrl) || isLocalAddress(favicon)) return null;
  return favicon;
}

