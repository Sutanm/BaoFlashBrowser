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
  report: (allowFill: boolean) => void,
  observerLifetime = PASSWORD_FORM_OBSERVER_LIFETIME_MS,
): () => void {
  let observer: MutationObserver | null = null;
  let stopped = false;
  let lastScanAt = 0;
  let pendingScan: ReturnType<typeof setTimeout> | null = null;
  let pendingClick: ReturnType<typeof setTimeout> | null = null;
  const knownInputs = new WeakSet<HTMLInputElement>();
  // 用户在这个文档里改过登录框内容之后……只有在**字段仍然非空**时才停止自动填充。
  // 2026-11-10 两次真机反馈把边界说清了：
  //   - 想改登新账号时被填回旧账号（字段有内容 → 不该再填）；
  //   - 退出登录、清空表单后却要等好几秒才填（字段已空 → 应该立刻填）。
  // 所以判据不是"动过手就再也不填"，而是"此刻表单里有没有用户输入的东西"。
  let userEdited = false;
  const loginFieldsFilled = (): boolean => {
    const pass = document.querySelector<HTMLInputElement>('input[type="password"]');
    if (!pass) return false;
    const scope = pass.form || document;
    const user = scope.querySelector<HTMLInputElement>('input[type="text"], input[type="email"], input[type="tel"]');
    return Boolean(pass.value) || Boolean(user && user.value);
  };
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
    // 重新隐回去的输入框要从"已知"里摘掉：站点常见的"退出登录 → 收起登录层 →
    // 再点登录展开"用的是同一批元素，否则第二次展开不会上报、也就不会自动填充
    // （表现为"清空表单后要等好几秒才填上"）。
    for (const input of inputs) if (!usable.includes(input)) knownInputs.delete(input);
    if (usable.length === 0) return;
    const freshInputs = usable.filter((input) => !knownInputs.has(input));
    if (!force && freshInputs.length === 0) return;
    for (const input of usable) knownInputs.add(input);
    // 站点可直接写 value 清空表单，不一定触发 input。
    if (userEdited && !loginFieldsFilled()) userEdited = false;
    report(!userEdited && usable.some((input) => !input.value));
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
  // 用户动过登录表单里的输入框后，按"此刻表单是否还有内容"决定要不要继续填。
  const markUserEdited = (event: Event) => {
    if (!event.isTrusted) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const loginField = target.type === 'password'
      || target.type === 'text' || target.type === 'email' || target.type === 'tel'
      || Boolean(target.form?.querySelector('input[type="password"]'));
    if (!loginField) return;
    userEdited = loginFieldsFilled();
  };
  // 冒泡阶段（站点自己的 click 处理器先跑完，登录层通常此刻已经显示），并补一次
  // 延迟复查，覆盖异步 show / 动画结束后才可见的登录层。
  // 点击按当前表单状态决定填充或只重新武装捕获。
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
  document.addEventListener('input', markUserEdited, true);
  document.addEventListener('keydown', markUserEdited, true);
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
    document.removeEventListener('input', markUserEdited, true);
    document.removeEventListener('keydown', markUserEdited, true);
    document.removeEventListener('click', onClick, false);
  };
}
