import { spawn } from 'child_process';
import type { KeyringBackend, KeyringFailure, KeyringFailureKind } from './keyring';

/**
 * keyring-win-dpapi.ts — Windows DPAPI 后端。
 *
 * Electron 11 主进程（Node 12）无 native 途径直调 DPAPI，故经 powershell.exe
 * 子进程加载 .NET System.Security.Cryptography.ProtectedData —— 与 Chrome 在
 * Windows 存密码同级（CurrentUser 范围）。
 *
 * 安全约束：
 * - payload（base64 秘密）经 stdin 传入，绝不进入命令行参数（ps 可见）。
 * - stdout 首行契约：`OK <base64>` / `ERR <code>`；stderr 仅日志。
 * - 强制超时（probe 25s / wrap 20s / unwrap 25s），超时 kill。预算按"冷启动 PowerShell +
 *   Add-Type 在机器繁忙时的实测耗时"设定（2026-09-20 事故：10s 预算在启动风暴下被击穿），
 *   宁可等也不误判；`BFB_KEYRING_TIMEOUT_MS` 可覆盖（故障注入探针/单测用）。
 * - dev-only 覆盖：BFB_POWERSHELL_CMD 可替换可执行路径，用于失败路径冒烟
 *   （GPO 强制执行策略 / AppLocker 拦 Add-Type 的场景无法在本进程模拟，
 *   由该 hook 覆盖 spawn 失败路径，真实策略拦截依赖真机验证）。
 */

const PS_PROTECT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Security',
  '  $line = [Console]::In.ReadLine()',
  '  if ([string]::IsNullOrEmpty($line)) { Write-Output "ERR empty-input"; exit 1 }',
  '  $bytes = [Convert]::FromBase64String($line)',
  '  $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  "  Write-Output ('OK ' + [Convert]::ToBase64String($enc))",
  '}',
  'catch {',
  '  Write-Output ("ERR " + $_.Exception.Message)',
  '  exit 1',
  '}',
].join('\n');

const PS_UNPROTECT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Security',
  '  $line = [Console]::In.ReadLine()',
  '  if ([string]::IsNullOrEmpty($line)) { Write-Output "ERR empty-input"; exit 1 }',
  '  $bytes = [Convert]::FromBase64String($line)',
  '  $dec = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  "  Write-Output ('OK ' + [Convert]::ToBase64String($dec))",
  '}',
  'catch {',
  '  Write-Output ("ERR " + $_.Exception.Message)',
  '  exit 1',
  '}',
].join('\n');

const PROBE_PLAIN = 'keyring-probe-42';

/**
 * 子进程预算。可用 `BFB_KEYRING_TIMEOUT_MS` 覆盖（故障注入探针与单测用）。
 * 预算一律 > 冷启动 PowerShell + Add-Type 的实测耗时，宁可等也不误判（规格 D5）。
 */
const DEFAULT_PROBE_WRAP_TIMEOUT_MS = 25_000;
const DEFAULT_PROBE_UNWRAP_TIMEOUT_MS = 25_000;
const DEFAULT_WRAP_TIMEOUT_MS = 20_000;
const DEFAULT_UNWRAP_TIMEOUT_MS = 25_000;

function budgetMs(fallback: number): number {
  const raw = Number(process.env.BFB_KEYRING_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export type PsOutcome =
  | { code: 'ok'; value: string; exitCode?: number }
  | { code: 'timeout' }
  | { code: 'spawn-error'; message: string }
  | { code: 'exit-error'; message: string; exitCode?: number; stderr?: string }
  | { code: 'bad-response'; exitCode?: number; stderr?: string };

export function runPowerShell(script: string, payloadB64: string, timeoutMs: number): Promise<PsOutcome> {
  return new Promise((resolve) => {
    const exe = process.env.BFB_POWERSHELL_CMD || 'powershell.exe';
    let child;
    try {
      child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: 'spawn-error', message: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (outcome: PsOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already dead */ }
      finish({ code: 'timeout' });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on('error', (error) => {
      finish({ code: 'spawn-error', message: error.message });
    });
    child.on('close', (code: number | null) => {
      const exitCode = code ?? undefined;
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
      const match = first ? /^(OK|ERR)\s+(.*)$/.exec(first) : null;
      if (!match) {
        finish({ code: 'bad-response', exitCode, stderr: stderr.slice(0, 500) });
        return;
      }
      if (match[1] === 'OK') {
        finish({ code: 'ok', value: match[2], exitCode });
        return;
      }
      finish({ code: 'exit-error', message: match[2], exitCode, stderr: stderr.slice(0, 500) });
    });

    child.stdin.on('error', () => { /* EPIPE after exit */ });
    child.stdin.end(`${payloadB64}\n`);
  });
}

/** 失败子集（'ok' 之外的全部 outcome），供类型安全的方向敏感分类使用。 */
export type PsFailureOutcome = Exclude<PsOutcome, { code: 'ok' }>;

/**
 * 子进程失败结果 → 失败语义分类（规格 D2）。
 *
 * 方向敏感：`unwrap` 方向的 `ps-error:*` = 后端明确说"这段密文解不开"（确定性失败，
 * 调用方必须保留文件等用户决策）；`wrap` 方向 = 密文根本没生成（环境/策略问题，可重试）。
 * `ERR empty-input` 属协议层问题，与密文无关。
 */
export function classifyPsFailure(outcome: PsFailureOutcome, direction: 'wrap' | 'unwrap'): KeyringFailure {
  switch (outcome.code) {
    case 'spawn-error':
      return { ok: false, kind: 'spawn-failed', reason: 'no-powershell' };
    case 'timeout':
      return { ok: false, kind: 'timeout', reason: 'timeout' };
    case 'exit-error': {
      if (/empty-input/.test(outcome.message)) {
        return { ok: false, kind: 'protocol-error', reason: 'empty-input' };
      }
      const reason = `ps-error:${outcome.message.slice(0, 120) || 'exit'}`;
      const kind: KeyringFailureKind = direction === 'unwrap' ? 'decrypt-failed' : 'backend-unavailable';
      return { ok: false, kind, reason, detail: outcome.stderr };
    }
    case 'bad-response':
      return { ok: false, kind: 'protocol-error', reason: 'bad-response', detail: outcome.stderr };
  }
}

/** 总函数（probe / 单测用）：成功时返回 `{ ok: true, reason: '' }`。 */
export function classifyPsOutcome(
  outcome: PsOutcome,
  direction: 'wrap' | 'unwrap',
): { ok: true; reason: '' } | KeyringFailure {
  if (outcome.code === 'ok') return { ok: true, reason: '' };
  return classifyPsFailure(outcome, direction);
}

export class WinDpapiBackend implements KeyringBackend {
  readonly id = 'win-dpapi' as const;

  constructor(
    private readonly exec: (script: string, payloadB64: string, timeoutMs: number) => Promise<PsOutcome> = runPowerShell,
  ) {}

  async available(): Promise<boolean> {
    return process.platform === 'win32';
  }

  async probe(): Promise<{ ok: boolean; reason?: string }> {
    const probeB64 = Buffer.from(PROBE_PLAIN, 'utf8').toString('base64');
    const wrapOutcome = await this.exec(PS_PROTECT, probeB64, budgetMs(DEFAULT_PROBE_WRAP_TIMEOUT_MS));
    if (wrapOutcome.code !== 'ok') {
      const classified = classifyPsOutcome(wrapOutcome, 'wrap');
      return { ok: false, reason: classified.reason };
    }
    const unwrapOutcome = await this.exec(PS_UNPROTECT, wrapOutcome.value, budgetMs(DEFAULT_PROBE_UNWRAP_TIMEOUT_MS));
    if (unwrapOutcome.code !== 'ok') {
      const classified = classifyPsOutcome(unwrapOutcome, 'wrap');
      return { ok: false, reason: classified.reason };
    }
    if (unwrapOutcome.value !== probeB64) return { ok: false, reason: 'probe-mismatch' };
    return { ok: true };
  }

  async wrap(b64secret: string): Promise<{ ok: true; blob: string } | KeyringFailure> {
    const outcome = await this.exec(PS_PROTECT, b64secret, budgetMs(DEFAULT_WRAP_TIMEOUT_MS));
    if (outcome.code !== 'ok') return classifyPsFailure(outcome, 'wrap');
    return { ok: true, blob: outcome.value };
  }

  async unwrap(blob: string): Promise<{ ok: true; secret: string } | KeyringFailure> {
    const outcome = await this.exec(PS_UNPROTECT, blob, budgetMs(DEFAULT_UNWRAP_TIMEOUT_MS));
    if (outcome.code !== 'ok') return classifyPsFailure(outcome, 'unwrap');
    return { ok: true, secret: outcome.value };
  }

  async remove(): Promise<{ ok: boolean; reason?: string }> {
    // DPAPI 无撤销语义：CurrentUser 范围的数据删除即失去用途，无需主动撤销。
    return { ok: true };
  }
}

/** 供 keyring.ts 的 dev-only 失败冒烟引用（也可被测试直接构造）。 */
export function createWinDpapiBackend(): WinDpapiBackend {
  return new WinDpapiBackend();
}
