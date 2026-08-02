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
