export const PASSWORD_FORM_OBSERVER_LIFETIME_MS = 30_000;

/**
 * 与 `password-fill.ts` 里页面侧 `usable()` 保持同一套判据：可见、可写、不是
 * 隐藏域。站点常把整个登录层先以 `display:none` 插进 DOM、点击后 `show()`
 * （实测 7k7k `#union`），那时密码框"在 DOM 里"却填不进去 —— 所以"出现过"不等于
 * "能填"，不能只凭插入事件就把它记为已上报。
 */
function isUsablePasswordInput(input: HTMLInputElement): boolean {
  try {
    if (input.disabled || input.readOnly || input.type === 'hidden') return false;
    const style = window.getComputedStyle(input);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = input.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch {
    return false;
  }
}

/** 可见性判定要读 computed style / 布局，属性变化密集的页面不能每次都算。 */
const SCAN_INTERVAL_MS = 250;

/**
 * Report dynamically inserted password fields without sending field values.
 * The DOM observer is bounded; focus and click events remain as cheap fallbacks
 * for login dialogs opened later in a long-running game page.
 *
 * 2026-11-10 修正（用户报告"必须点一下输入框才填"）：此前只有**新出现的**密码框会
 * 上报（`WeakSet` 记已知）。登录层"先插入、后显示"这种最常见形态于是彻底没有信号：
 * 插入时填不进去（display:none），显示时没有新框出现，只能等用户把焦点点进输入框。
 * 现在三条都报了：可用密码框首次可用、可用性发生变化（`style`/`class` 变化也算）、
 * 以及任意点击（站点通常在 click 里同步/异步 show 登录层）。
 */
export function installPasswordFormObserver(
  report: () => void,
  observerLifetime = PASSWORD_FORM_OBSERVER_LIFETIME_MS,
): () => void {
  let observer: MutationObserver | null = null;
  let stopped = false;
  let lastScanAt = 0;
  let pendingScan: ReturnType<typeof setTimeout> | null = null;
  let pendingClick: ReturnType<typeof setTimeout> | null = null;
  const knownInputs = new WeakSet<HTMLInputElement>();
  const reportIfNeeded = (force = false) => {
    if (stopped) return;
    // 没有密码框的页面（绝大多数）只付一次选择器的钱。
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'));
    if (inputs.length === 0) return;
    const now = Date.now();
    if (!force && now - lastScanAt < SCAN_INTERVAL_MS) {
      // 合并扫描而不是丢弃事件：登录层显示往往就发生在这段窗口里。
      if (!pendingScan) pendingScan = setTimeout(() => {
        pendingScan = null;
        reportIfNeeded(false);
      }, SCAN_INTERVAL_MS - (now - lastScanAt));
      return;
    }
    if (pendingScan) clearTimeout(pendingScan);
    pendingScan = null;
    lastScanAt = now;
    // 只把"此刻真能填"的密码框算作已知：隐藏期间不算，等它变可见时仍是新鲜信号。
    const usable = inputs.filter(isUsablePasswordInput);
    if (usable.length === 0) return;
    const freshInputs = usable.filter((input) => !knownInputs.has(input));
    if (!force && freshInputs.length === 0) return;
    for (const input of usable) knownInputs.add(input);
    report();
  };
  const start = () => {
    if (stopped || observer || !document.documentElement) return;
    observer = new MutationObserver(() => reportIfNeeded());
    // `type` 覆盖"文本框被改成密码框"；`style`/`class` 覆盖"登录层由隐藏变可见"
    // —— 后者是 7k7k 这类 `$('#union').show()` 的唯一痕迹。
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['type', 'style', 'class'],
    });
    reportIfNeeded();
  };
  const onFocus = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && (target.type === 'password'
      || target.form?.querySelector('input[type="password"]'))) reportIfNeeded(true);
  };
  // 冒泡阶段（站点自己的 click 处理器先跑完，登录层通常此刻已经显示），并补一次
  // 延迟复查，覆盖异步 show / 动画结束后才可见的登录层。
  const onClick = () => {
    if (stopped) return;
    reportIfNeeded(true);
    if (pendingClick) clearTimeout(pendingClick);
    pendingClick = setTimeout(() => {
      pendingClick = null;
      reportIfNeeded(true);
    }, 150);
  };
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('click', onClick, false);
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
  const expiry = setTimeout(() => {
    observer?.disconnect();
    observer = null;
  }, Math.max(0, observerLifetime));
  return () => {
    stopped = true;
    clearTimeout(expiry);
    if (pendingScan) clearTimeout(pendingScan);
    if (pendingClick) clearTimeout(pendingClick);
    observer?.disconnect();
    observer = null;
    document.removeEventListener('DOMContentLoaded', start);
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('click', onClick, false);
  };
}
