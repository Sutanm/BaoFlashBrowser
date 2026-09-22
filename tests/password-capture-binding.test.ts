// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_SCRIPT } from '../src/main/modules/password-capture';

vi.mock('../src/main/modules/password-store', () => ({
  getMetaForHost: () => [], isAutoCaptureEnabled: () => true, isCaptureExcluded: () => false,
}));
vi.mock('../src/main/modules/window', () => ({ getMainWindow: () => null }));

describe('password capture page transport', () => {
  // 脚本自带 window.__baop_pw_capture 幂等守卫（同一 frame 只注入一次）；
  // 同一测试文件共享 jsdom window，故每个用例前清掉它，保证重新注入。
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__baop_pw_capture;
  });

  it('uses the CDP binding and never writes a captured password to console.log', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const fetch = vi.fn().mockResolvedValue(undefined);
    Object.assign(window, { __baopReport: report, fetch });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    document.body.innerHTML = '<form><input name="username" value="bao"><input type="password" value="secret"></form>';

    window.eval(CAPTURE_SCRIPT);
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const payloads = report.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(payloads).toContainEqual(expect.objectContaining({ _type: 'baop_capture', user: 'bao', pass: 'secret' }));
    expect(consoleSpy).not.toHaveBeenCalled();

    window.fetch('/login', { method: 'POST', body: 'username=Bao+User&password=SeCrEt%21' });
    const fetchPayloads = report.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(fetchPayloads).toContainEqual(expect.objectContaining({
      _type: 'baop_capture', user: 'Bao User', pass: 'SeCrEt!', source: 'fetch',
    }));

    consoleSpy.mockRestore();
    vi.useRealTimers();
  });

  // 2026-09-21 回归防线：7k7k 上"有 frame info、零 input 事件"，
  // 需要能证明"输入监听本身是好的"（否则会把页面侧问题误判成我们的 bug）。
  it('密码框输入会产生 input pw 诊断，且上报监听环境自检结果', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    Object.assign(window, { __baopReport: report });
    document.body.innerHTML = '<form><input name="username"><input id="pass" type="password"></form>';

    window.eval(CAPTURE_SCRIPT);
    const pass = document.getElementById('pass') as HTMLInputElement;
    pass.value = 'abcd';
    pass.dispatchEvent(new Event('input', { bubbles: true }));

    const msgs = report.mock.calls.map(([value]) => String(JSON.parse(String(value)).msg ?? ''));
    expect(msgs.some((m) => m.startsWith('input pw len=4'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('listener env selftest='))).toBe(true);
    expect(msgs.some((m) => m.includes('selftest=true'))).toBe(true);
    vi.useRealTimers();
  });

  it('非密码输入会记录首次落点（用于识别 type=text + 遮罩的伪密码框）', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    Object.assign(window, { __baopReport: report });
    document.body.innerHTML = '<form><input id="fake" type="text" name="pwdMask"></form>';

    window.eval(CAPTURE_SCRIPT);
    const fake = document.getElementById('fake') as HTMLInputElement;
    fake.value = 'x';
    fake.dispatchEvent(new Event('input', { bubbles: true }));

    const msgs = report.mock.calls.map(([value]) => String(JSON.parse(String(value)).msg ?? ''));
    expect(msgs.some((m) => m.startsWith('first input tag=INPUT type=text id=fake name=pwdMask'))).toBe(true);
    vi.useRealTimers();
  });

  // 2026-09-22 回归防线：脚本曾在每个 frame 里造一个同源 about:blank iframe
  // 去取"未被改写的 addEventListener"。注入是按"新执行上下文创建"触发的，子帧会跑同一段
  // 脚本、再建子帧……实测同一页面多出 69 个空帧、57 次栈溢出。这里锁死：注入不得建 frame。
  it('注入脚本不得自造 iframe（历史回归：iframe 取干净 API 会导致嵌套自繁殖）', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    Object.assign(window, { __baopReport: report });
    document.body.innerHTML = '';
    document.body.appendChild(document.createElement('div'));
    const iframesBefore = document.querySelectorAll('iframe').length;

    window.eval(CAPTURE_SCRIPT);

    expect(document.querySelectorAll('iframe').length).toBe(iframesBefore);
    expect(iframeCountInDomTree()).toBe(0);
    // 自检仍要在（它才是判断"监听到底生效没有"的唯一手段）
    const msgs = report.mock.calls.map(([value]) => String(JSON.parse(String(value)).msg ?? ''));
    expect(msgs.some((m) => m.startsWith('listener env selftest='))).toBe(true);
    vi.useRealTimers();
  });

  // 2026-09-22 回归防线：findUserInput 的选择器含 input[name*="login"]、input[id*="user"] 等宽匹配，
  // 旧守卫只排除 password/hidden —— 账号框一为空就会命中 type=submit 的按钮，把按钮文字当用户名
  // （实测 7k7k 登录页 3 条 capture 的 user 全是"提交"）。
  it('账号框为空时不得把 submit 按钮当账号；有值时正常取用', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    Object.assign(window, { __baopReport: report });
    document.body.innerHTML = [
      '<form id="login">',
      '<input id="username" name="username">',
      '<input id="password" type="password">',
      '<input id="loginbtn" name="loginsubmit" type="submit" value="提交">',
      '</form>',
    ].join('');

    window.eval(CAPTURE_SCRIPT);
    const userField = document.getElementById('username') as HTMLInputElement;
    const passField = document.getElementById('password') as HTMLInputElement;
    const captures = (): Record<string, string>[] => report.mock.calls
      .map(([value]) => JSON.parse(String(value)))
      .filter((p) => p._type === 'baop_capture');

    // 账号框为空 → 宁可为空字符串，也绝不能把提交按钮的文字当账号
    passField.value = 'abcd';
    passField.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('login')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(captures().length).toBeGreaterThan(0);
    expect(captures().every((c) => c.user === '')).toBe(true);

    // 账号填上后仍要能正常取到（修 bug 不能把正路一起堵死）
    const report2 = vi.fn();
    Object.assign(window, { __baopReport: report2 });
    userField.value = 'bao';
    passField.value = 'abcd';
    passField.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('login')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const second = report2.mock.calls
      .map(([value]) => JSON.parse(String(value)))
      .filter((p) => p._type === 'baop_capture');
    expect(second.map((c) => c.user)).toContain('bao');
    vi.useRealTimers();
  });
});

/** 递归统计整棵树（含子 document）里的 iframe，避免只查浅层就误判。 */
function iframeCountInDomTree(): number {
  let count = 0;
  const walk = (node: Document | ShadowRoot | Element): void => {
    count += node.querySelectorAll('iframe').length;
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return count;
}
