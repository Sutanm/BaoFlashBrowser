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
    expect(msgs.some((m) => m.startsWith('listener env patched='))).toBe(true);
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
});
