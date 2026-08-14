const NEWTAB_URL = 'about:newtab';
const USERSCRIPTS_URL = 'about:userscripts';
const AUTOMATION_URL = 'about:automation';

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
