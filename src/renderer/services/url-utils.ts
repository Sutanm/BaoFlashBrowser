export const NEWTAB_URL = 'about:newtab';
export const USERSCRIPTS_URL = 'about:userscripts';
export const AUTOMATION_URL = 'about:automation';

export function getHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export function isNewtabUrl(url: string): boolean {
  return !url || url === 'about:blank' || url === NEWTAB_URL || url.startsWith('data:');
}

export function isUserscriptsUrl(url: string): boolean {
  return url === USERSCRIPTS_URL;
}

export function isAutomationUrl(url: string): boolean {
  return url === AUTOMATION_URL;
}

export function isInternalPageUrl(url: string): boolean {
  return isNewtabUrl(url) || isUserscriptsUrl(url) || isAutomationUrl(url);
}
