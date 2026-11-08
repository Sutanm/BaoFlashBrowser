export const NEWTAB_URL = 'about:newtab';
export const USERSCRIPTS_URL = 'about:userscripts';
export const AUTOMATION_URL = 'about:automation';

export function getHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export function isNewtabUrl(url: string): boolean {
  return !url || url === 'about:blank' || url === NEWTAB_URL || url.startsWith('data:');
}
