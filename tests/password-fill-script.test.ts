// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/main/modules/password-capture', () => ({ getCaptureContextIds: () => [] }));
import { buildPasswordFillExpression } from '../src/main/modules/password-fill';

function makeVisible(input: HTMLInputElement): void {
  input.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, bottom: 24, right: 120,
    width: 120, height: 24, toJSON: () => ({}),
  });
}

function run(username = 'bao', password = 'secret'): { filledFields: number; filledCredentials: number } {
  for (const input of Array.from(document.querySelectorAll('input'))) makeVisible(input);
  return window.eval(buildPasswordFillExpression(username, password));
}

describe('password fill page script', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('fills a login form and emits normal input events without submitting', () => {
    document.body.innerHTML = '<form><input autocomplete="username"><input type="password" autocomplete="current-password"></form>';
    const form = document.querySelector('form')!;
    const inputs = document.querySelectorAll('input');
    const submit = vi.fn();
    const inputEvent = vi.fn();
    form.addEventListener('submit', submit);
    inputs[1].addEventListener('input', inputEvent);

    expect(run()).toEqual({ filledFields: 2, filledCredentials: 1 });
    expect(inputs[0].value).toBe('bao');
    expect(inputs[1].value).toBe('secret');
    expect(inputEvent).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it('skips registration and password-change forms', () => {
    document.body.innerHTML = '<form><input autocomplete="username"><input type="password" autocomplete="new-password"><input type="password"></form>';
    expect(run()).toEqual({ filledFields: 0, filledCredentials: 0 });
    document.body.innerHTML = '<form action="/register"><input name="user"><input type="password"><button type="submit">注册</button></form>';
    expect(run()).toEqual({ filledFields: 0, filledCredentials: 0 });
  });

  it('does not overwrite a different username or a prefilled password', () => {
    document.body.innerHTML = '<form><input autocomplete="username" value="someone-else"><input type="password"></form>';
    expect(run()).toEqual({ filledFields: 0, filledCredentials: 0 });
    document.body.innerHTML = '<form><input autocomplete="username"><input type="password" value="existing"></form>';
    expect(run()).toEqual({ filledFields: 0, filledCredentials: 0 });
  });

  it('skips hidden login controls', () => {
    document.body.innerHTML = '<form><input autocomplete="username"><input style="display:none" type="password"></form>';
    expect(run()).toEqual({ filledFields: 0, filledCredentials: 0 });
  });

  // 2026-09-22：配合"用户名可为空"的条目（对齐 Chrome）。
  // 实测语义：这类条目只会填密码，且沿用"场地里已有别的用户名就整体不填"的既有保护——
  // 因为空用户名无法证明那条密码属于谁，宁可不填。
  it('空用户名条目只填密码：无账号框或账号框为空时填密码，账号框已有内容时不填', () => {
    // 账号框为空 → 填密码，账号框保持为空（不得写入空值）
    document.body.innerHTML = '<form><input autocomplete="username"><input type="password"></form>';
    let inputs = document.querySelectorAll('input');
    expect(run('', 'secret')).toEqual({ filledFields: 1, filledCredentials: 1 });
    expect(inputs[0].value).toBe('');
    expect(inputs[1].value).toBe('secret');

    // 压根没有账号框（卡号/手机号这类自助登录）→ 只填密码
    document.body.innerHTML = '<form><input type="password" autocomplete="current-password"></form>';
    inputs = document.querySelectorAll('input');
    expect(run('', 'secret')).toEqual({ filledFields: 1, filledCredentials: 1 });
    expect(inputs[0].value).toBe('secret');

    // 账号框已被填上别的用户名 → 整体不填（沿用既有保护，且不得清空用户已输入的用户名）
    document.body.innerHTML = '<form><input autocomplete="username" value="typed-by-user"><input type="password"></form>';
    inputs = document.querySelectorAll('input');
    expect(run('', 'secret')).toEqual({ filledFields: 0, filledCredentials: 0 });
    expect(inputs[0].value).toBe('typed-by-user');
  });
});
