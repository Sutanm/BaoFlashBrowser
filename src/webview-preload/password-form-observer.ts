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
  let pendingReport: ReturnType<typeof setTimeout> | null = null;
  let pendingFocus = false;
  const knownInputs = new WeakSet<HTMLInputElement>();
  const reportIfNeeded = (force = false) => {
    if (stopped || !document.querySelector('input[type="password"]')) return;
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'));
    const freshInputs = inputs.filter((input) => !knownInputs.has(input));
    if (!force && freshInputs.length === 0) return;
    const now = Date.now();
    if (now - lastReportAt < 250) {
      pendingFocus ||= force;
      if (!pendingReport) pendingReport = setTimeout(() => {
        pendingReport = null;
        const focus = pendingFocus; pendingFocus = false;
        reportIfNeeded(focus);
      }, 250 - (now - lastReportAt));
      return;
    }
    if (pendingReport) clearTimeout(pendingReport);
    pendingReport = null; pendingFocus = false;
    lastReportAt = now;
    for (const input of inputs) knownInputs.add(input);
    report();
  };
  const start = () => {
    if (stopped || observer || !document.documentElement) return;
    observer = new MutationObserver(() => reportIfNeeded());
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
    if (target instanceof HTMLInputElement && (target.type === 'password'
      || target.form?.querySelector('input[type="password"]'))) reportIfNeeded(true);
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
    if (pendingReport) clearTimeout(pendingReport);
    observer?.disconnect();
    observer = null;
    document.removeEventListener('DOMContentLoaded', start);
    document.removeEventListener('focusin', onFocus, true);
  };
}
