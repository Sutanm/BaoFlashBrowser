import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import {
  LinuxSecretToolBackend,
  parseSecretBlob,
  classifySecretToolFailure,
  runSecretTool,
  type SecretToolExec,
  type SecretToolOutcome,
} from '../src/main/modules/keyring-linux-secret-tool';

const HEX_ID = 'a'.repeat(32);

type Handler = (...args: unknown[]) => void;

function makeFakeChild(): {
  child: ChildProcess;
  emit: (event: string, payload: unknown) => void;
  emitData: (stream: 'stdout' | 'stderr', text: string) => void;
  stdinEnd: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, Handler[]>();
  const add = (event: string, cb: Handler) => {
    const list = listeners.get(event) ?? [];
    list.push(cb);
    listeners.set(event, list);
  };
  const stdinEnd = vi.fn();
  const kill = vi.fn();
  const child = {
    stdout: { on: (_ev: string, cb: Handler) => { add('stdout-data', cb); } },
    stderr: { on: (_ev: string, cb: Handler) => { add('stderr-data', cb); } },
    stdin: { on: () => undefined, end: stdinEnd },
    kill,
    on: (event: string, cb: Handler) => { add(event, cb); },
    pid: 1,
  } as unknown as ChildProcess;
  return {
    child,
    emit(event: string, payload: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
    emitData(stream: 'stdout' | 'stderr', text: string) {
      for (const cb of listeners.get(`${stream}-data`) ?? []) cb(Buffer.from(text, 'utf8'));
    },
    stdinEnd,
    kill,
  };
}

/** 记录调用并按剧本回放 exec（顺序 = 调用顺序）。 */
function scripted(script: SecretToolOutcome[]): {
  exec: SecretToolExec;
  calls: { args: string[]; stdin: string }[];
} {
  const calls: { args: string[]; stdin: string }[] = [];
  const exec: SecretToolExec = async (args, stdin) => {
    calls.push({ args, stdin });
    return script[Math.min(calls.length - 1, script.length - 1)];
  };
  return { exec, calls };
}

const ok = (stdout = ''): SecretToolOutcome => ({ code: 'ok', stdout, stderr: '' });
const missing: SecretToolOutcome = { code: 'exit-error', exitCode: 1, stderr: '' };
const busDown: SecretToolOutcome = {
  code: 'exit-error',
  exitCode: 1,
  stderr: 'secret-tool: Could not connect: No such file or directory',
};

describe('parseSecretBlob', () => {
  it('接受 ss1: + 32 位小写 hex', () => {
    expect(parseSecretBlob(`ss1:${HEX_ID}`)).toBe(HEX_ID);
  });

  it('拒绝非本后端格式（含历史裸 base64 / 大写 hex / 长度不符）', () => {
    expect(parseSecretBlob('')).toBeNull();
    expect(parseSecretBlob('a'.repeat(32))).toBeNull();
    expect(parseSecretBlob(`ss1:${'A'.repeat(32)}`)).toBeNull();
    expect(parseSecretBlob(`ss1:${'a'.repeat(31)}`)).toBeNull();
    expect(parseSecretBlob('ss1:')).toBeNull();
    expect(parseSecretBlob('AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA')).toBeNull();
  });
});

describe('classifySecretToolFailure（Linux 特有：靠 stderr 二分）', () => {
  it('spawn 失败 → spawn-failed/no-secret-tool', () => {
    expect(classifySecretToolFailure({ code: 'spawn-error', message: 'ENOENT' }, 'unwrap'))
      .toEqual({ ok: false, kind: 'spawn-failed', reason: 'no-secret-tool' });
  });

  it('超时 → timeout', () => {
    expect(classifySecretToolFailure({ code: 'timeout' }, 'wrap'))
      .toEqual({ ok: false, kind: 'timeout', reason: 'timeout' });
  });

  it('exit≠0 且 stderr 为空 → 确定性（条目不存在）', () => {
    expect(classifySecretToolFailure(missing, 'unwrap'))
      .toMatchObject({ ok: false, kind: 'decrypt-failed', reason: 'secret-not-found' });
  });

  it('exit≠0 且 stderr 非空 → 瞬时（后端不可达），即便方向是 unwrap', () => {
    const result = classifySecretToolFailure(busDown, 'unwrap');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('backend-unavailable');
      expect(result.reason.startsWith('secret-tool:')).toBe(true);
      // stderr 自带 secret-tool: 前缀，不得在 reason 里叠成双前缀。
      expect(result.reason).not.toContain('secret-tool:secret-tool:');
      expect(result.reason).toContain('Could not connect');
    }
  });

  it('stderr 显式说 not found → 仍归确定性', () => {
    const outcome: SecretToolOutcome = {
      code: 'exit-error',
      exitCode: 1,
      stderr: 'secret-tool: No such secret',
    };
    expect(classifySecretToolFailure(outcome, 'unwrap'))
      .toMatchObject({ ok: false, kind: 'decrypt-failed', reason: 'secret-not-found' });
  });

  it('wrap 方向 exit≠0 且 stderr 为空 → 可重试（密文未生成）', () => {
    expect(classifySecretToolFailure(missing, 'wrap'))
      .toMatchObject({ ok: false, kind: 'backend-unavailable', reason: 'store-exit-nonzero' });
  });
});

describe('LinuxSecretToolBackend.probe', () => {
  it('store → lookup → clear 往返一致 → ok，且探针条目被清理', async () => {
    const probeB64 = Buffer.from('keyring-probe-42', 'utf8').toString('base64');
    const { exec, calls } = scripted([ok(), ok(probeB64), ok()]);
    const backend = new LinuxSecretToolBackend(exec);

    await expect(backend.probe()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(calls[0].args[0]).toBe('store');
    expect(calls[0].args).toContain('--label=BaoFlashBrowser wrap key');
    expect(calls[0].stdin).toBe(probeB64);
    expect(calls[1].args[0]).toBe('lookup');
    expect(calls[2].args[0]).toBe('clear');
    // 三处必须用同一个条目 id，否则 clear 清不掉。
    const idFromStore = calls[0].args[calls[0].args.length - 1];
    expect(calls[1].args[calls[1].args.length - 1]).toBe(idFromStore);
    expect(calls[2].args[calls[2].args.length - 1]).toBe(idFromStore);
  });

  it('往返值不一致 → probe-mismatch，仍清理', async () => {
    const { exec, calls } = scripted([ok(), ok('dGltaW5n'), ok()]);
    const backend = new LinuxSecretToolBackend(exec);
    await expect(backend.probe()).resolves.toEqual({ ok: false, reason: 'probe-mismatch' });
    expect(calls.map((c) => c.args[0])).toEqual(['store', 'lookup', 'clear']);
  });

  it('store 失败（无总线）→ 透传瞬时原因，仍清理', async () => {
    const { exec, calls } = scripted([busDown, ok(), ok()]);
    const backend = new LinuxSecretToolBackend(exec);
    const result = await backend.probe();
    expect(result.ok).toBe(false);
    expect(result.reason?.startsWith('secret-tool:')).toBe(true);
    expect(calls[calls.length - 1].args[0]).toBe('clear');
  });

  it('清理预算显著小于业务预算（守护未运行时避免 probe 变成 25s 停顿）', async () => {
    const seen: { op: string; timeoutMs: number }[] = [];
    const probeB64 = Buffer.from('keyring-probe-42', 'utf8').toString('base64');
    const backend = new LinuxSecretToolBackend(async (args, _stdin, timeoutMs) => {
      seen.push({ op: args[0], timeoutMs });
      return args[0] === 'lookup' ? ok(probeB64) : ok();
    });
    await backend.probe();
    const byOp = Object.fromEntries(seen.map((s) => [s.op, s.timeoutMs]));
    expect(byOp.clear).toBeLessThan(byOp.store);
    expect(byOp.clear).toBeLessThanOrEqual(3000);
  });

  it('lookup 超时 → timeout', async () => {
    const { exec } = scripted([ok(), { code: 'timeout' }, ok()]);
    const backend = new LinuxSecretToolBackend(exec);
    await expect(backend.probe()).resolves.toEqual({ ok: false, reason: 'timeout' });
  });
});

describe('LinuxSecretToolBackend.wrap / unwrap', () => {
  it('wrap 返回 ss1: + 32 hex，密文只经 stdin 不进 argv', async () => {
    const { exec, calls } = scripted([ok()]);
    const backend = new LinuxSecretToolBackend(exec);
    const result = await backend.wrap('c2VjcmV0');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blob).toMatch(/^ss1:[0-9a-f]{32}$/);
    expect(calls[0].stdin).toBe('c2VjcmV0');
    expect(calls[0].args.join(' ')).not.toContain('c2VjcmV0');
  });

  it('两次 wrap 生成不同 id（同一机器上多条库不互相覆盖）', async () => {
    const { exec } = scripted([ok()]);
    const backend = new LinuxSecretToolBackend(exec);
    const a = await backend.wrap('x');
    const b = await backend.wrap('x');
    expect(a.ok && b.ok && a.blob !== b.blob).toBe(true);
  });

  it('unwrap 合法 blob → 透传 secret', async () => {
    const { exec, calls } = scripted([ok('c2VjcmV0')]);
    const backend = new LinuxSecretToolBackend(exec);
    await expect(backend.unwrap(`ss1:${HEX_ID}`)).resolves.toEqual({ ok: true, secret: 'c2VjcmV0' });
    expect(calls[0].args).toEqual(['lookup', 'service', 'baoflash-browser', 'bfb-key', HEX_ID]);
  });

  it('lookup 带尾换行也能剥掉（其他 libsecret 版本兼容）', async () => {
    const { exec } = scripted([ok('c2VjcmV0\r\n')]);
    const backend = new LinuxSecretToolBackend(exec);
    await expect(backend.unwrap(`ss1:${HEX_ID}`)).resolves.toEqual({ ok: true, secret: 'c2VjcmV0' });
  });

  it('非法 blob → decrypt-failed/unsupported-blob，且不 spawn', async () => {
    const { exec, calls } = scripted([ok()]);
    const backend = new LinuxSecretToolBackend(exec);
    await expect(backend.unwrap('AQAAANCMnd8BFdERjHoAwE')).resolves
      .toEqual({ ok: false, kind: 'decrypt-failed', reason: 'unsupported-blob' });
    expect(calls).toHaveLength(0);
  });

  it('条目不存在 → decrypt-failed/secret-not-found（确定性，调用方保留文件）', async () => {
    const { exec } = scripted([missing]);
    const backend = new LinuxSecretToolBackend(exec);
    await expect(backend.unwrap(`ss1:${HEX_ID}`)).resolves
      .toMatchObject({ ok: false, kind: 'decrypt-failed', reason: 'secret-not-found' });
  });

  it('总线连不上 → backend-unavailable（瞬时，不能判成密文损坏）', async () => {
    const { exec } = scripted([busDown]);
    const backend = new LinuxSecretToolBackend(exec);
    const result = await backend.unwrap(`ss1:${HEX_ID}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('backend-unavailable');
  });

  it('spawn 失败 → spawn-failed/no-secret-tool', async () => {
    const { exec } = scripted([{ code: 'spawn-error', message: 'ENOENT' }]);
    const backend = new LinuxSecretToolBackend(exec);
    await expect(backend.unwrap(`ss1:${HEX_ID}`)).resolves
      .toEqual({ ok: false, kind: 'spawn-failed', reason: 'no-secret-tool' });
  });

  it('exit 0 但 stdout 为空 → decrypt-failed/empty-secret', async () => {
    const { exec } = scripted([ok('')]);
    const backend = new LinuxSecretToolBackend(exec);
    await expect(backend.unwrap(`ss1:${HEX_ID}`)).resolves
      .toEqual({ ok: false, kind: 'decrypt-failed', reason: 'empty-secret' });
  });

  it('BFB_KEYRING_TIMEOUT_MS 覆盖子进程预算', async () => {
    process.env.BFB_KEYRING_TIMEOUT_MS = '4321';
    try {
      const seen: number[] = [];
      const backend = new LinuxSecretToolBackend(async (_a, _s, timeoutMs) => {
        seen.push(timeoutMs);
        return ok();
      });
      await backend.wrap('x');
      await backend.unwrap(`ss1:${HEX_ID}`);
      expect(seen).toEqual([4321, 4321]);
    } finally {
      delete process.env.BFB_KEYRING_TIMEOUT_MS;
    }
  });
});

describe('LinuxSecretToolBackend.remove', () => {
  it('clear 成功 → ok', async () => {
    const { exec, calls } = scripted([ok()]);
    const backend = new LinuxSecretToolBackend(exec);
    await expect(backend.remove(`ss1:${HEX_ID}`)).resolves.toEqual({ ok: true });
    expect(calls[0].args).toEqual(['clear', 'service', 'baoflash-browser', 'bfb-key', HEX_ID]);
  });

  it('条目本就不在 → 视为成功（目标状态已达成）', async () => {
    const { exec } = scripted([missing]);
    const backend = new LinuxSecretToolBackend(exec);
    await expect(backend.remove(`ss1:${HEX_ID}`)).resolves.toEqual({ ok: true });
  });

  it('后端不可达 → 报失败并带原因', async () => {
    const { exec } = scripted([busDown]);
    const backend = new LinuxSecretToolBackend(exec);
    const result = await backend.remove(`ss1:${HEX_ID}`);
    expect(result.ok).toBe(false);
    expect(result.reason?.startsWith('secret-tool:')).toBe(true);
  });

  it('非法 blob → ok:false/unsupported-blob，且不 spawn', async () => {
    const { exec, calls } = scripted([ok()]);
    const backend = new LinuxSecretToolBackend(exec);
    await expect(backend.remove('nope')).resolves.toEqual({ ok: false, reason: 'unsupported-blob' });
    expect(calls).toHaveLength(0);
  });
});

describe('runSecretTool 子进程契约', () => {
  let fake: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    fake = makeFakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fake.child);
  });

  afterEach(() => {
    delete process.env.BFB_SECRET_TOOL_CMD;
  });

  it('args 原样透传、秘密经 stdin、退出码 0 → ok', async () => {
    const p = runSecretTool(['lookup', 'service', 'baoflash-browser', 'bfb-key', HEX_ID], '', 5000);
    expect(spawnMock).toHaveBeenCalledWith(
      'secret-tool',
      ['lookup', 'service', 'baoflash-browser', 'bfb-key', HEX_ID],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(fake.stdinEnd).toHaveBeenCalledWith('');
    fake.emitData('stdout', 'c2VjcmV0');
    fake.emit('close', 0);
    await expect(p).resolves.toMatchObject({ code: 'ok', stdout: 'c2VjcmV0' });
  });

  it('退出码非 0 且 stderr 为空 → exit-error.stderr 空串（供二分判定）', async () => {
    const p = runSecretTool(['lookup'], '', 5000);
    fake.emit('close', 1);
    await expect(p).resolves.toEqual({ code: 'exit-error', exitCode: 1, stderr: '' });
  });

  it('退出码非 0 且 stderr 有内容 → 保留 stderr 供诊断', async () => {
    const p = runSecretTool(['lookup'], '', 5000);
    fake.emitData('stderr', 'secret-tool: Could not connect: No such file or directory\n');
    fake.emit('close', 1);
    const outcome = await p;
    expect(outcome).toMatchObject({ code: 'exit-error', exitCode: 1 });
    if (outcome.code === 'exit-error') {
      expect(outcome.stderr).toContain('Could not connect');
    }
  });

  it('超时 → kill 并返回 timeout', async () => {
    vi.useFakeTimers();
    try {
      const p = runSecretTool(['store'], 'x', 1000);
      await vi.advanceTimersByTimeAsync(1001);
      await expect(p).resolves.toEqual({ code: 'timeout' });
      expect(fake.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawn error 事件 → spawn-error', async () => {
    const p = runSecretTool(['store'], 'x', 5000);
    fake.emit('error', new Error('spawn ENOENT'));
    await expect(p).resolves.toMatchObject({ code: 'spawn-error', message: 'spawn ENOENT' });
  });

  it('BFB_SECRET_TOOL_CMD 覆盖可执行路径（dev 失败冒烟 hook）', async () => {
    process.env.BFB_SECRET_TOOL_CMD = '/opt/nope/secret-tool';
    const p = runSecretTool(['lookup'], '', 5000);
    expect(spawnMock.mock.calls[0][0]).toBe('/opt/nope/secret-tool');
    fake.emit('close', 0);
    await p;
  });
});
