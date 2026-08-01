const NEWTAB_URL = 'about:newtab';

export function isNewtabUrl(url: string): boolean {
  return !url || url === 'about:blank' || url === NEWTAB_URL || url.startsWith('data:');
}
