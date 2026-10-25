/// <reference lib="dom" />

export function installGitHubImportMapBridge(publish: (text: string) => boolean): void {
  if (window.top !== window.self || location.origin !== 'https://github.com') return;
  let sent = '';
  const scan = (): void => {
    const script = document.querySelector('script[type="importmap"]');
    const text = script?.textContent || '';
    if (!text || text.length > 16384 || text === sent) return;
    if (publish(text)) {
      sent = text;
      document.documentElement?.setAttribute('data-bf-github-module-active', '1');
    }
  };
  scan();
  const observer = new MutationObserver(scan);
  observer.observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => { scan(); observer.disconnect(); }, { once: true });
}
