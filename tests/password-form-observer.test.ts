// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPasswordFormObserver } from '../src/webview-preload/password-form-observer';

describe('password form observer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
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
