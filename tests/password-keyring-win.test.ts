import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { WinDpapiBackend, runPowerShell, classifyPsOutcome, type PsOutcome } from '../src/main/modules/keyring-win-dpapi';

type Handler = (...args: unknown[]) => void;

function makeFakeChild(): {
  child: ChildProcess & {
    stdout: { on: (ev: string, cb: Handler) => void };
    stderr: { on: (ev: string, cb: Handler) => void };
    stdin: { on: (ev: string, cb: Handler) => void; end: (s?: string) => void };
    kill: () => void;
  };
  emit: (event: string, payload: unknown) => void;
  emitData: (stream: 'stdout' | 'stderr', text: string) => void;
} {
  const listeners = new Map<string, Handler[]>();
  const add = (event: string, cb: Handler) => {
    const list = listeners.get(event) ?? [];
    list.push(cb);
    listeners.set(event, list);
  };
  const child = {
    stdout: { on: (_ev: string, cb: Handler) => { add('stdout-data', cb); } },
    stderr: { on: (_ev: string, cb: Handler) => { add('stderr-data', cb); } },
    stdin: { on: () => undefined, end: vi.fn() },
    kill: vi.fn(),
    on: (event: string, cb: Handler) => { add(event, cb); },
    pid: 1,
  } as never;
  const api = child as ReturnType<typeof makeFakeChild>['child'];
  return {
    child: api,
    emit(event: string, payload: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
    emitData(stream: 'stdout' | 'stderr', text: string) {
      for (const cb of listeners.get(`${stream}-data`) ?? []) cb(Buffer.from(text, 'utf8'));
    },
  };
}

const PROBE_B64 = Buffer.from('keyring-probe-42', 'utf8').toString('base64');

describe('runPowerShell 解析契约', () => {
  let fake: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    fake = makeFakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fake.child);
  });

  it('stdout 首行 OK → ok(value)', async () => {
    const p = runPowerShell('script', 'b64', 10_000);
    fake.emitData('stdout', 'OK c2VjcmV0\n');
    fake.emit('close', 0);
    await expect(p).resolves.toEqual({ code: 'ok', value: 'c2VjcmV0', exitCode: 0 });
  });

  it('stdout ERR → exit-error，payload 经 stdin 传入', async () => {
    const p = runPowerShell('script', 'b64', 10_000);
    expect(fake.child.stdin.end).toHaveBeenCalledWith('b64\n');
    fake.emitData('stdout', 'ERR boom\n');
    fake.emit('close', 1);
    await expect(p).resolves.toMatchObject({ code: 'exit-error', message: 'boom', exitCode: 1 });
  });

  it('非契约输出 → bad-response', async () => {
    const p = runPowerShell('script', 'b64', 10_000);
    fake.emitData('stdout', 'garbage line\n');
    fake.emit('close', 0);
    await expect(p).resolves.toMatchObject({ code: 'bad-response', exitCode: 0 });
  });

  it('超时 → kill 并返回 timeout', async () => {
    vi.useFakeTimers();
    try {
      const p = runPowerShell('script', 'b64', 1000);
      await vi.advanceTimersByTimeAsync(1001);
      await expect(p).resolves.toEqual({ code: 'timeout' });
      expect(fake.child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawn error 事件 → spawn-error', async () => {
    const p = runPowerShell('script', 'b64', 10_000);
    fake.emit('error', new Error('spawn ENOENT'));
    await expect(p).resolves.toMatchObject({ code: 'spawn-error', message: 'spawn ENOENT' });
  });

  it('尊重 BFB_POWERSHELL_CMD 覆盖可执行路径（dev 失败冒烟 hook）', async () => {
    process.env.BFB_POWERSHELL_CMD = 'C:/nope/pwsh.exe';
    try {
      const p = runPowerShell('script', 'b64', 10_000);
      expect(spawnMock).toHaveBeenCalledWith(
        'C:/nope/pwsh.exe',
        expect.arrayContaining(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']),
        expect.objectContaining({ windowsHide: true }),
      );
      fake.emitData('stdout', 'OK x\n');
      fake.emit('close', 0);
      await p;
    } finally {
      delete process.env.BFB_POWERSHELL_CMD;
    }
  });
});

describe('classifyPsOutcome 失败分类（方向敏感）', () => {
  it('传输层失败映射到稳定 kind/reason', () => {
    expect(classifyPsOutcome({ code: 'spawn-error', message: 'x' }, 'unwrap'))
      .toEqual({ ok: false, kind: 'spawn-failed', reason: 'no-powershell' });
    expect(classifyPsOutcome({ code: 'timeout' }, 'unwrap'))
      .toEqual({ ok: false, kind: 'timeout', reason: 'timeout' });
    expect(classifyPsOutcome({ code: 'bad-response' }, 'unwrap'))
      .toEqual({ ok: false, kind: 'protocol-error', reason: 'bad-response' });
    expect(classifyPsOutcome({ code: 'ok', value: 'v' }, 'unwrap')).toEqual({ ok: true, reason: '' });
  });

  it('ps-error 在 unwrap 方向 = 后端明确拒绝解密（确定性失败）', () => {
    const r = classifyPsOutcome({ code: 'exit-error', message: 'boom' }, 'unwrap');
    expect(r).toMatchObject({ ok: false, kind: 'decrypt-failed', reason: 'ps-error:boom' });
  });

  it('ps-error 在 wrap 方向 = 密文未生成（环境/策略问题，可重试）', () => {
    const r = classifyPsOutcome({ code: 'exit-error', message: 'boom' }, 'wrap');
    expect(r).toMatchObject({ ok: false, kind: 'backend-unavailable', reason: 'ps-error:boom' });
  });

  it('ERR empty-input 属协议层问题，与密文无关', () => {
    const r = classifyPsOutcome({ code: 'exit-error', message: 'empty-input' }, 'unwrap');
    expect(r).toMatchObject({ ok: false, kind: 'protocol-error', reason: 'empty-input' });
  });
});

describe('WinDpapiBackend（注入 exec，不触真实 PowerShell）', () => {
  it('probe：protect→unprotect 往返一致 → ok', async () => {
    const calls: string[] = [];
    const backend = new WinDpapiBackend(async (script: string) => {
      calls.push(script);
      return calls.length === 1
        ? { code: 'ok', value: 'ENC' }
        : { code: 'ok', value: PROBE_B64 };
    });
    await expect(backend.probe()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('probe：往返值不一致 → probe-mismatch', async () => {
    let n = 0;
    const backend = new WinDpapiBackend(async () => {
      n += 1;
      return { code: 'ok', value: n === 1 ? 'ENC' : 'dGltaW5n' };
    });
    await expect(backend.probe()).resolves.toEqual({ ok: false, reason: 'probe-mismatch' });
  });

  it('probe：unwrap 超时 → timeout', async () => {
    let n = 0;
    const backend = new WinDpapiBackend(async () => {
      n += 1;
      return n === 1 ? { code: 'ok', value: 'ENC' } : { code: 'timeout' };
    });
    await expect(backend.probe()).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('wrap/unwrap 成功路径透传 blob/secret', async () => {
    const backend = new WinDpapiBackend(async () => ({ code: 'ok', value: 'W1' } as PsOutcome));
    await expect(backend.wrap('c2VjcmV0')).resolves.toEqual({ ok: true, blob: 'W1' });
    await expect(backend.unwrap('W1')).resolves.toEqual({ ok: true, secret: 'W1' });
  });

  it('wrap spawn 失败 → spawn-failed/no-powershell（可重试）', async () => {
    const backend = new WinDpapiBackend(async () => ({ code: 'spawn-error', message: 'ENOENT' }));
    await expect(backend.wrap('c2VjcmV0')).resolves.toEqual({ ok: false, kind: 'spawn-failed', reason: 'no-powershell' });
  });

  it('unwrap 退出错误 → decrypt-failed/ps-error 前缀（调用方保留文件）', async () => {
    const backend = new WinDpapiBackend(async () => ({ code: 'exit-error', message: 'Add-Type failed' }));
    const result = await backend.unwrap('W1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('decrypt-failed');
      expect(result.reason.startsWith('ps-error:')).toBe(true);
    }
  });

  it('BFB_KEYRING_TIMEOUT_MS 覆盖子进程预算（故障注入探针用）', async () => {
    process.env.BFB_KEYRING_TIMEOUT_MS = '1234';
    try {
      const seen: number[] = [];
      const backend = new WinDpapiBackend(async (_s: string, _p: string, timeoutMs: number) => {
        seen.push(timeoutMs);
        return { code: 'ok', value: 'X' } as PsOutcome;
      });
      await backend.wrap('c2VjcmV0');
      await backend.unwrap('X');
      expect(seen).toEqual([1234, 1234]);
    } finally {
      delete process.env.BFB_KEYRING_TIMEOUT_MS;
    }
  });

  it('remove 为空操作且 ok', async () => {
    const backend = new WinDpapiBackend();
    await expect(backend.remove('blob')).resolves.toEqual({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
