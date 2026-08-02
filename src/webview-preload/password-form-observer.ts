export const PASSWORD_FORM_OBSERVER_LIFETIME_MS = 30_000;

/**
 * Report dynamically inserted password fields without sending field values.
 * The DOM observer is bounded; focus events remain as a cheap fallback for
 * login dialogs opened later in a long-running game page.
 */
export function installPasswordFormObserver(
  report: () => void,
  observerLifetime = PASSWORD_FORM_OBSERVER_LIFETIME_MS,
): () => void {
  let observer: MutationObserver | null = null;
  let stopped = false;
  let lastReportAt = 0;
  const reportIfNeeded = () => {
    if (stopped || !document.querySelector('input[type="password"]')) return;
    const now = Date.now();
    if (now - lastReportAt < 250) return;
    lastReportAt = now;
    report();
  };
  const start = () => {
    if (stopped || observer || !document.documentElement) return;
    observer = new MutationObserver(reportIfNeeded);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['type'],
    });
    reportIfNeeded();
  };
  const onFocus = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === 'password') reportIfNeeded();
  };
  document.addEventListener('focusin', onFocus, true);
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
  const expiry = setTimeout(() => {
    observer?.disconnect();
    observer = null;
  }, Math.max(0, observerLifetime));
  return () => {
    stopped = true;
    clearTimeout(expiry);
    observer?.disconnect();
    observer = null;
    document.removeEventListener('DOMContentLoaded', start);
    document.removeEventListener('focusin', onFocus, true);
  };
}
