// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPasswordFormObserver } from '../src/webview-preload/password-form-observer';

// jsdom 没有布局：默认 getBoundingClientRect 全 0，而 observer 与页面侧填充脚本
// 用同一套"可见才可填"判据。这里给原型打上真实尺寸，隐藏态用元素自身
// display/visibility 建模（jsdom 不会把祖先 display:none 反映到子元素 computed style）。
function stubInputLayout(): void {
  vi.spyOn(HTMLInputElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, bottom: 24, right: 120,
    width: 120, height: 24, toJSON: () => ({}),
  } as DOMRect);
}

describe('password form observer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    stubInputLayout();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports a dynamically inserted password field and throttles mutation bursts', async () => {
    const report = vi.fn();
    const dispose = installPasswordFormObserver(report, 30_000);

    document.body.insertAdjacentHTML('beforeend', '<form><input type="password"></form>');
    await Promise.resolve();
    expect(report).toHaveBeenCalledOnce();

    document.body.append(document.createElement('div'));
    await Promise.resolve();
    expect(report).toHaveBeenCalledOnce();
    dispose();
  });

  it('bounds mutation observation but keeps password focus as a late fallback', async () => {
    const report = vi.fn();
    const dispose = installPasswordFormObserver(report, 1_000);
    vi.advanceTimersByTime(1_000);

    document.body.insertAdjacentHTML('beforeend', '<input type="password">');
    await Promise.resolve();
    expect(report).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    document.querySelector('input')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(report).toHaveBeenCalledOnce();
    dispose();
  });

  it('detects an existing input converted into a password field', async () => {
    document.body.innerHTML = '<input type="text">';
    const report = vi.fn();
    const dispose = installPasswordFormObserver(report);
    vi.advanceTimersByTime(300);
    document.querySelector('input')!.type = 'password';
    await Promise.resolve();
    expect(report).toHaveBeenCalledOnce();
    dispose();
  });

  it('does not re-arm capture on unrelated DOM updates during a JSONP login', async () => {
    document.body.innerHTML = '<form><input name="username"><input type="password"></form>';
    const report = vi.fn();
    const dispose = installPasswordFormObserver(report);
    expect(report).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(300);
    document.body.append(document.createElement('script'));
    await Promise.resolve();
    expect(report).toHaveBeenCalledOnce();
    document.querySelector('input[name=username]')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(report).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('eventually reports a replacement login form inside the throttle window', async () => {
    document.body.innerHTML = '<form><input type="password"></form>';
    const report = vi.fn();
    const dispose = installPasswordFormObserver(report);
    vi.advanceTimersByTime(100);
    document.body.innerHTML = '<form><input type="password"></form>';
    await Promise.resolve();
    expect(report).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(150);
    expect(report).toHaveBeenCalledTimes(2);
    dispose();
  });

  // 2026-11-10（用户报告"必须点一下账号密码框才填"）：站点把整个登录层先以
  // display:none 插进 DOM，点击后再 show()（实测 7k7k #union）。插入时的密码框填不进去，
  // 显示时又没有"新密码框"出现 —— 旧逻辑于是彻底没有信号，只能等焦点落进输入框。
  it('reports again when a hidden password field becomes visible', async () => {
    const report = vi.fn();
    const dispose = installPasswordFormObserver(report);
    document.body.innerHTML = '<div id="union" style="display:none"><input type="password" style="display:none"></div>';
    await Promise.resolve();
    expect(report).not.toHaveBeenCalled();

    const input = document.querySelector<HTMLInputElement>('input')!;
    input.style.display = 'block';
    document.getElementById('union')!.style.display = 'block';
    // 可见性扫描按 250ms 合并（属性变化密集的页面不能每次读 computed style）
    await vi.advanceTimersByTimeAsync(300);
    expect(report).toHaveBeenCalledOnce();

    // 可见后即被记为已知，不再对无关变更重复上报
    document.body.append(document.createElement('div'));
    await Promise.resolve();
    expect(report).toHaveBeenCalledOnce();
    dispose();
  });

  it('reports on a click, which is how login dialogs are usually opened', async () => {
    const report = vi.fn();
    const dispose = installPasswordFormObserver(report);
    document.body.innerHTML = '<button id="open">登录</button><div id="union" style="display:none"><input type="password" style="display:none"></div>';
    await Promise.resolve();
    expect(report).not.toHaveBeenCalled();

    // 站点在自己的 click 处理器里显示登录层；observer 的 click 监听在冒泡阶段（站点之后）
    document.getElementById('open')!.addEventListener('click', () => {
      document.getElementById('union')!.style.display = 'block';
      document.querySelector<HTMLInputElement>('input')!.style.display = 'block';
    }, { once: true });
    document.getElementById('open')!.click();
    await Promise.resolve();
    expect(report).toHaveBeenCalledOnce();

    // 异步 show（click 处理器返回后才可见）由 150ms 复查兜底
    document.getElementById('union')!.style.display = 'none';
    document.querySelector<HTMLInputElement>('input')!.style.display = 'none';
    await vi.advanceTimersByTimeAsync(300);
    const before = report.mock.calls.length;
    document.getElementById('open')!.addEventListener('click', () => {
      setTimeout(() => {
        document.getElementById('union')!.style.display = 'block';
        document.querySelector<HTMLInputElement>('input')!.style.display = 'block';
      }, 80);
    }, { once: true });
    document.getElementById('open')!.click(); // 这一刻还看不见，立即复查必然空手
    await vi.advanceTimersByTimeAsync(400);   // 80ms 可见，150ms 复查命中
    expect(report.mock.calls.length).toBe(before + 1);
    dispose();
  });

  it('never reports a password field that stays hidden', async () => {
    const report = vi.fn();
    const dispose = installPasswordFormObserver(report);
    document.body.innerHTML = '<div id="union" style="display:none"><input type="password" style="display:none"></div>';
    await Promise.resolve();
    document.body.append(document.createElement('span'));
    await Promise.resolve();
    document.getElementById('union')!.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(report).not.toHaveBeenCalled();
    dispose();
  });

  it('allows filling after the page clears a previously filled form without input events', () => {
    document.body.innerHTML = '<form><input type="text"><input type="password"><button type="button">登录</button></form>';
    const report = vi.fn();
    const dispose = installPasswordFormObserver(report);
    const [user, password] = document.querySelectorAll<HTMLInputElement>('input');
    user.value = 'fixture-user';
    password.value = 'fixture-password';
    password.dispatchEvent(new Event('input', { bubbles: true }));
    user.value = '';
    password.value = '';
    document.querySelector('button')!.click();
    expect(report.mock.calls).toEqual([[true], [true]]);
    dispose();
  });

  it('sends no field values and stops all signals after disposal', async () => {
    const report = vi.fn();
    const dispose = installPasswordFormObserver(report);
    dispose();
    document.body.insertAdjacentHTML('beforeend', '<input type="password" value="secret">');
    await Promise.resolve();
    document.querySelector('input')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(report).not.toHaveBeenCalled();
  });
});
