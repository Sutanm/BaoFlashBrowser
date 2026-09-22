// @vitest-environment node
/**
 * Windows CredUI 门禁后端（规格 §3/G5）。
 *
 * 纯函数分类用假 outcome 覆盖；子进程真机行为由本机 PowerShell 冒烟单独验证
 * （见 plan 2026-09-22-view-gate.md 的 V2 门②）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

const logMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('electron-log', () => ({ default: logMock }));

import {
  classifyVerifyOutcome, WinCredUiBackend, _psVerifyScript, _psVerifyFacts, VIEW_PROMPT_TEXT,
} from '../src/main/modules/view-gate-win';

describe('classifyVerifyOutcome：脚本机器码 → 语义（规格 §3 错误分类表）', () => {
  it('成功仅认 granted', () => {
    expect(classifyVerifyOutcome({ code: 'ok', value: 'granted' })).toEqual({ ok: true });
    expect(classifyVerifyOutcome({ code: 'ok', value: 'OK' })).toEqual({
      ok: false, kind: 'unavailable', reason: 'unexpected-payload',
    });
  });

  it('子进程层故障 → unavailable（fail closed，不计失败）', () => {
    expect(classifyVerifyOutcome({ code: 'spawn-error', message: 'ENOENT' }))
      .toEqual({ ok: false, kind: 'unavailable', reason: 'no-powershell' });
    expect(classifyVerifyOutcome({ code: 'timeout' }))
      .toEqual({ ok: false, kind: 'unavailable', reason: 'timeout' });
    expect(classifyVerifyOutcome({ code: 'bad-response' }))
      .toEqual({ ok: false, kind: 'unavailable', reason: 'bad-response' });
  });

  it('取消 / 凭据错 / 非当前用户 / 账户被锁', () => {
    expect(classifyVerifyOutcome({ code: 'exit-error', message: 'cancelled' }))
      .toEqual({ ok: false, kind: 'cancelled' });
    expect(classifyVerifyOutcome({ code: 'exit-error', message: 'bad-credential' }))
      .toEqual({ ok: false, kind: 'bad-credential' });
    expect(classifyVerifyOutcome({ code: 'exit-error', message: 'not-current-user' }))
      .toEqual({ ok: false, kind: 'not-current-user' });
    expect(classifyVerifyOutcome({ code: 'exit-error', message: 'account-locked' }))
      .toEqual({ ok: false, kind: 'account-locked' });
  });

  it('账户不可用 / 策略拒绝带原始 Win32 码（供诊断，同时触发降级）', () => {
    expect(classifyVerifyOutcome({ code: 'exit-error', message: 'unusable-account:1327' }))
      .toEqual({ ok: false, kind: 'unusable-account', reason: 'unusable-account:1327' });
    expect(classifyVerifyOutcome({ code: 'exit-error', message: 'denied:1385' }))
      .toEqual({ ok: false, kind: 'denied', reason: 'denied:1385' });
  });

  it('未知/异常文本一律归为 unavailable（不猜，不放行）', () => {
    expect(classifyVerifyOutcome({ code: 'exit-error', message: 'logon-failed:1385' }))
      .toEqual({ ok: false, kind: 'unavailable', reason: 'logon-failed:1385' });
    expect(classifyVerifyOutcome({ code: 'exit-error', message: 'exception:Add-Type 失败' }))
      .toEqual({ ok: false, kind: 'unavailable', reason: 'exception:Add-Type 失败' });
  });
});

describe('WinCredUiBackend', () => {
  afterEach(() => {
    delete process.env.BFB_VIEWGATE_SKIP_PROMPT;
    logMock.warn.mockClear();
  });

  it('verify() 只传提示文案，不传任何凭据（凭据只由系统对话框收集）', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 'ok', value: 'granted' });
    const backend = new WinCredUiBackend(exec);
    expect(await backend.verify()).toEqual({ ok: true });
    const [payload, timeout] = exec.mock.calls[0];
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(VIEW_PROMPT_TEXT);
    expect(timeout).toBe(120_000);
  });

  it('失败时留日志但不泄露任何凭据字段', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 'exit-error', message: 'bad-credential' });
    const backend = new WinCredUiBackend(exec);
    expect(await backend.verify()).toMatchObject({ ok: false, kind: 'bad-credential' });
    const logged = logMock.warn.mock.calls.flat().join(' ');
    expect(logged).toContain('bad-credential');
    expect(logged).not.toMatch(/password|pass=|lpszPassword/i);
  });

  it('verifyWithCredentials 需要显式打开 dev 钩子', async () => {
    const backend = new WinCredUiBackend(vi.fn());
    await expect(backend.verifyWithCredentials('u', 'p')).rejects.toThrow(/BFB_VIEWGATE_SKIP_PROMPT/);
  });

  it('verifyWithCredentials 把凭据经 stdin 传递（base64，不进命令行）', async () => {
    process.env.BFB_VIEWGATE_SKIP_PROMPT = '1';
    const exec = vi.fn().mockResolvedValue({ code: 'exit-error', message: 'bad-credential' });
    const backend = new WinCredUiBackend(exec);
    await backend.verifyWithCredentials('someone', 's3cret', 'WORKGROUP');
    const [payload] = exec.mock.calls[0];
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('someone\ns3cret\nWORKGROUP');
  });

  it('available() 只在 win32 为真', async () => {
    const backend = new WinCredUiBackend(vi.fn());
    expect(await backend.available()).toBe(process.platform === 'win32');
  });
});

describe('PowerShell 脚本的硬约束', () => {
  // 2026-09-22 本机实跑发现：Windows PowerShell 5.1 按 ANSI 解码 -Command 里的非 ASCII，
  // 中文会破坏引号配对 → 整段脚本语法错误。这条断言把该约束钉死。
  it('脚本必须纯 ASCII（非 ASCII 文案一律走 stdin）', () => {
    // eslint-disable-next-line no-control-regex
    expect(_psVerifyScript).toMatch(/^[\x00-\x7F]*$/);
    expect(_psVerifyScript).not.toContain(VIEW_PROMPT_TEXT);
  });

  it('stdout 只有 OK granted / ERR 两种语义（明文绝不进 stdout）', () => {
    const writes = _psVerifyScript.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('Write-Output'));
    expect(writes.length).toBeGreaterThan(0);
    for (const line of writes) {
      // 允许形状：ERR <码> / 'OK granted' / dev-only 的 DIAG（诊断，绝非授权语义）
      expect(line).toMatch(/Write-Output \(?("ERR " \+|'OK granted'|"DIAG |'DIAG )/);
    }
    // 授权只可能由这一行产生——它必须唯一存在
    expect(_psVerifyScript.match(/'OK granted'/g)).toHaveLength(1);
    expect(_psVerifyScript).not.toContain('$pass)');
    expect(_psVerifyScript).not.toContain('+ $pass');
  });

  it('包含系统对话框、LogonUser 与 SID 比对三要素', () => {
    expect(_psVerifyScript).toContain('CredUIPromptForWindowsCredentialsW');
    expect(_psVerifyScript).toContain('CredUnPackAuthenticationBufferW');
    expect(_psVerifyScript).toContain('LogonUserW');
    expect(_psVerifyScript).toContain('not-current-user');
    expect(_psVerifyScript).toContain('CoTaskMemFree');
  });

  // 用户反馈 2026-09-22：对话框要求重新输入"自己是谁"。generic 形态只给空用户名框。
  it('对话框走 logon 形态并预填当前用户（不得含 CREDUIWIN_GENERIC）', () => {
    expect(_psVerifyFacts.credUiFlags & 0x1).toBe(0);          // CREDUIWIN_GENERIC 必须关闭
    expect(_psVerifyFacts.credUiFlags & 0x200).toBe(0x200);    // ENUMERATE_CURRENT_USER
    expect(_psVerifyFacts.credUiFlags & 0x1000).toBe(0x1000);  // SECURE_PROMPT
    expect(_psVerifyFacts.credPackProtected).toBe(0x1);
    expect(_psVerifyScript).toContain('CredPackAuthenticationBufferW');
    // in-buffer 必须真的作为第 4、5 个参数交给对话框，否则预填不会生效
    expect(_psVerifyScript).toMatch(
      /CredUIPromptForWindowsCredentialsW\(\s*\n\s*\[ref\]\$info, 0, \[ref\]\$authPackage, \$inBuf, \$inSize,/,
    );
  });

  // 2026-09-22 本机实测：临时 WindowsIdentity 的 .Token 是悬空句柄（对象被终结时句柄已关）。
  // 表现是 -Command 下 100% 失败、-File 下侥幸通过；强制 GC 后两种投递都失败。
  it('自检路径保留 WindowsIdentity 引用（悬空令牌句柄必失败）', () => {
    expect(_psVerifyScript).toContain(
      '$script:ownIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    );
    expect(_psVerifyScript).toContain('$script:tokenHandle = $script:ownIdentity.Token');
    expect(_psVerifyScript).not.toMatch(
      /tokenHandle = \[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Token/,
    );
  });
});
