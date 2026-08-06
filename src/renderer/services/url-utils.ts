const NEWTAB_URL = 'about:newtab';
const USERSCRIPTS_URL = 'about:userscripts';

export function isNewtabUrl(url: string): boolean {
  return !url || url === 'about:blank' || url === NEWTAB_URL || url.startsWith('data:');
}

export function isUserscriptsUrl(url: string): boolean {
  return url === USERSCRIPTS_URL;
}

export function isInternalPageUrl(url: string): boolean {
  return isNewtabUrl(url) || isUserscriptsUrl(url);
}
