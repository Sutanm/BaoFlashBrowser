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

describe('classifyPsOutcome 失败分类', () => {
  it('映射到稳定 reason', () => {
    expect(classifyPsOutcome({ code: 'spawn-error', message: 'x' })).toEqual({ ok: false, reason: 'no-powershell' });
    expect(classifyPsOutcome({ code: 'timeout' })).toEqual({ ok: false, reason: 'timeout' });
    expect(classifyPsOutcome({ code: 'bad-response' })).toEqual({ ok: false, reason: 'bad-response' });
    expect(classifyPsOutcome({ code: 'exit-error', message: 'boom' })).toEqual({ ok: false, reason: 'ps-error:boom' });
    expect(classifyPsOutcome({ code: 'ok', value: 'v' })).toEqual({ ok: true, reason: '' });
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

  it('wrap spawn 失败 → no-powershell', async () => {
    const backend = new WinDpapiBackend(async () => ({ code: 'spawn-error', message: 'ENOENT' }));
    await expect(backend.wrap('c2VjcmV0')).resolves.toEqual({ ok: false, reason: 'no-powershell' });
  });

  it('unwrap 退出错误 → ps-error 前缀', async () => {
    const backend = new WinDpapiBackend(async () => ({ code: 'exit-error', message: 'Add-Type failed' }));
    const result = await backend.unwrap('W1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.startsWith('ps-error:')).toBe(true);
  });

  it('remove 为空操作且 ok', async () => {
    const backend = new WinDpapiBackend();
    await expect(backend.remove('blob')).resolves.toEqual({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
