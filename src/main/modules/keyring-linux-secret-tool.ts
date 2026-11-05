import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import type { KeyringBackend, KeyringFailure } from './keyring';

/**
 * keyring-linux-secret-tool.ts — Linux Secret Service 后端（`secret-tool`）。
 *
 * Electron 11 主进程（Node 12）没有 libsecret 绑定，故经 `secret-tool` 子进程
 * 走 D-Bus 找 org.freedesktop.secrets（GNOME Keyring / KWallet 的 KSecretsService 兼容层）。
 *
 * 与 DPAPI 后端的**根本差异**：Secret Service 是"条目库"，不是"就地加解密"。
 * 因此 wrap 不产出密文，而是产出**条目 id**：
 *   wrap(b64) → 随机 id → store(secret=b64) → blob = `ss1:<32 hex id>`
 *   unwrap(blob) → 解析 id → lookup → b64
 * 密文实体留在 OS 密钥库里，key 文件只存指针。这正是 A 档该有的形态：
 * 把 key 文件拷到另一台机器，拿到的只是一个找不到的 id。
 *
 * 安全约束：
 * - 秘密经 stdin 传入，绝不进入命令行参数（`/proc/<pid>/cmdline` 全局可读）。
 * - 强制超时（probe 15s / wrap 10s / unwrap 10s），超时 kill；`BFB_KEYRING_TIMEOUT_MS` 可覆盖。
 * - dev-only 覆盖：`BFB_SECRET_TOOL_CMD` 可替换可执行路径，用于 spawn 失败冒烟。
 *
 * 失败语义（**Linux 特有，依赖实测**，WSL Ubuntu 26.04 / libsecret 0.21.7 实测）：
 *   | 场景            | exit | stdout | stderr                              |
 *   | store 成功      | 0    | 空     | 空                                  |
 *   | lookup 命中     | 0    | 密文（**无尾换行**） | 空                     |
 *   | lookup 未命中   | 1    | 空     | **空** ← 关键                       |
 *   | 总线连不上      | 1    | 空     | `secret-tool: Could not connect: …` |
 * 即"条目不存在"与"后端不可达"**退出码相同**，只能靠 stderr 是否为空区分。
 * 若照搬 DPAPI 的"unwrap 失败即 decrypt-failed"，会把"这台机器连不上 keyring"
 * （瞬时、可重试）误判成"密文损坏"（确定性），正是 2026-09-20 事故的放大器。
 * 故本后端按 stderr 二分：空 stderr → 确定性；非空 stderr → 瞬时。
 *
 * 本模块**不依赖 electron-log**（与 DPAPI 后端一致）：出错结论由调用方记录，
 * 且便于在纯 Node / WSL 里直接跑真实往返验证（见 tools/probe/probes/21-*.cjs）。
 */

/** blob 前缀：`ss1:` + 32 位小写 hex。无前缀的历史裸 base64 视为"非本后端产出"。 */
const BLOB_PREFIX = 'ss1:';
const BLOB_ID_RE = /^[0-9a-f]{32}$/;

/** Secret Service 条目属性（lookup/clear 靠它定位，必须与 store 一致）。 */
const ATTR_SERVICE = 'service';
const ATTR_SERVICE_VALUE = 'baoflash-browser';
const ATTR_KEY = 'bfb-key';
const ITEM_LABEL = 'BaoFlashBrowser wrap key';

const PROBE_PLAIN = 'keyring-probe-42';

const DEFAULT_PROBE_STORE_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_LOOKUP_TIMEOUT_MS = 15_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 10_000;
const DEFAULT_STORE_TIMEOUT_MS = 10_000;
/**
 * 探针清理预算（远小于业务预算）。守护未运行时 clear 会和 store 一样挂住，
 * 若沿用 10s，一次失败的 probe 会变成 15s + 10s = 25s 的启动停顿。
 * 清理是 best-effort，不值得为它付这个代价。
 */
const DEFAULT_CLEAR_TIMEOUT_MS = 3_000;

function budgetMs(fallback: number): number {
  const raw = Number(process.env.BFB_KEYRING_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export type SecretToolOutcome =
  | { code: 'ok'; stdout: string; stderr: string }
  | { code: 'timeout' }
  | { code: 'spawn-error'; message: string }
  | { code: 'exit-error'; exitCode?: number; stderr: string };

/** 子进程执行器签名（单测注入用；默认 runSecretTool）。 */
export type SecretToolExec = (
  args: string[],
  stdin: string,
  timeoutMs: number,
) => Promise<SecretToolOutcome>;

/** 解析 blob → 条目 id；非本后端产出返回 null（不 spawn，直接判确定性失败）。 */
export function parseSecretBlob(blob: string): string | null {
  if (!blob.startsWith(BLOB_PREFIX)) return null;
  const id = blob.slice(BLOB_PREFIX.length);
  return BLOB_ID_RE.test(id) ? id : null;
}

/** 当前后端的条目属性参数（store / lookup / clear 共用，防三处写歪）。 */
function attrArgs(id: string): string[] {
  return [ATTR_SERVICE, ATTR_SERVICE_VALUE, ATTR_KEY, id];
}

export function runSecretTool(
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<SecretToolOutcome> {
  return new Promise((resolve) => {
    const exe = process.env.BFB_SECRET_TOOL_CMD || 'secret-tool';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: 'spawn-error', message: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (outcome: SecretToolOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already dead */ }
      finish({ code: 'timeout' });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on('error', (error: Error) => {
      finish({ code: 'spawn-error', message: error.message });
    });
    child.on('close', (code: number | null) => {
      const exitCode = code ?? undefined;
      if (exitCode === 0) {
        finish({ code: 'ok', stdout, stderr });
        return;
      }
      finish({ code: 'exit-error', exitCode, stderr: stderr.trim() });
    });

    child.stdin?.on('error', () => { /* EPIPE after exit */ });
    child.stdin?.end(stdin);
  });
}

/** secret-tool 的 stderr 首行（诊断用；空 stderr 返回空串）。 */
function firstStderrLine(stderr: string): string {
  const line = stderr.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  return line ?? '';
}

/**
 * 失败 → 语义分类（规格 D2），**方向敏感 + stderr 敏感**。
 *
 * - `spawn-error` / `timeout`：环境层瞬时故障，保留材料、可重试。
 * - `exit-error` + 空 stderr：后端正常应答"没有这个条目" → 确定性失败。
 * - `exit-error` + 非空 stderr：D-Bus 连不上 / 被策略拒绝 / 缺 --label → 瞬时
 *   （即便方向是 unwrap 也不能判定密文损坏）。
 */
export function classifySecretToolFailure(
  outcome: Exclude<SecretToolOutcome, { code: 'ok' }>,
  direction: 'wrap' | 'unwrap',
): KeyringFailure {
  switch (outcome.code) {
    case 'spawn-error':
      return { ok: false, kind: 'spawn-failed', reason: 'no-secret-tool' };
    case 'timeout':
      return { ok: false, kind: 'timeout', reason: 'timeout' };
    case 'exit-error': {
      const line = firstStderrLine(outcome.stderr);
      if (!line) {
        // 后端正常应答"没有这个条目"：只有 unwrap 方向才有确定性含义。
        if (direction === 'unwrap') {
          return { ok: false, kind: 'decrypt-failed', reason: 'secret-not-found' };
        }
        return { ok: false, kind: 'backend-unavailable', reason: 'store-exit-nonzero' };
      }
      if (/not found|no such secret/i.test(line)) {
        return { ok: false, kind: 'decrypt-failed', reason: 'secret-not-found', detail: line.slice(0, 200) };
      }
      // stderr 自带 `secret-tool: ` 前缀，剥掉再拼，避免日志里出现双前缀。
      const detail = line.replace(/^secret-tool:\s*/i, '');
      return {
        ok: false,
        kind: 'backend-unavailable',
        reason: `secret-tool:${detail.slice(0, 120)}`,
        detail: outcome.stderr.slice(0, 500),
      };
    }
  }
}

export class LinuxSecretToolBackend implements KeyringBackend {
  readonly id = 'linux-secret-service' as const;

  constructor(private readonly exec: SecretToolExec = runSecretTool) {}

  async available(): Promise<boolean> {
    return process.platform === 'linux';
  }

  /** 往返探针：store → lookup → clear，识别"装了但守护没跑/无 D-Bus/集合已锁"。 */
  async probe(): Promise<{ ok: boolean; reason?: string }> {
    const id = randomBytes(16).toString('hex');
    const probeB64 = Buffer.from(PROBE_PLAIN, 'utf8').toString('base64');
    try {
      const stored = await this.store(id, probeB64, budgetMs(DEFAULT_PROBE_STORE_TIMEOUT_MS));
      if (!stored.ok) return { ok: false, reason: stored.reason };
      const found = await this.lookup(id, budgetMs(DEFAULT_PROBE_LOOKUP_TIMEOUT_MS));
      if (!found.ok) return { ok: false, reason: found.reason };
      if (found.secret !== probeB64) return { ok: false, reason: 'probe-mismatch' };
      return { ok: true };
    } finally {
      // 探针条目不留痕：即便上面失败也清一次（清理失败不影响结论）。
      await this.clearQuietly(id);
    }
  }

  async wrap(b64secret: string): Promise<{ ok: true; blob: string } | KeyringFailure> {
    const id = randomBytes(16).toString('hex');
    const stored = await this.store(id, b64secret, budgetMs(DEFAULT_STORE_TIMEOUT_MS));
    if (!stored.ok) return stored;
    return { ok: true, blob: `${BLOB_PREFIX}${id}` };
  }

  async unwrap(blob: string): Promise<{ ok: true; secret: string } | KeyringFailure> {
    const id = parseSecretBlob(blob);
    if (!id) {
      // 非本后端产出（历史裸 base64 / 从 Windows 拷来的 DPAPI 密文）：确定性失败，不 spawn。
      return { ok: false, kind: 'decrypt-failed', reason: 'unsupported-blob' };
    }
    return this.lookup(id, budgetMs(DEFAULT_LOOKUP_TIMEOUT_MS));
  }

  async remove(blob: string): Promise<{ ok: boolean; reason?: string }> {
    const id = parseSecretBlob(blob);
    if (!id) return { ok: false, reason: 'unsupported-blob' };
    const outcome = await this.exec(['clear', ...attrArgs(id)], '', budgetMs(DEFAULT_LOOKUP_TIMEOUT_MS));
    if (outcome.code === 'ok') return { ok: true };
    const classified = classifySecretToolFailure(outcome, 'unwrap');
    // 条目本就不在 = 目标状态已达成，不算失败。
    if (classified.reason === 'secret-not-found') return { ok: true };
    return { ok: false, reason: classified.reason };
  }

  private async store(
    id: string,
    secretB64: string,
    timeoutMs: number,
  ): Promise<{ ok: true } | KeyringFailure> {
    const outcome = await this.exec(
      ['store', `--label=${ITEM_LABEL}`, ...attrArgs(id)],
      secretB64,
      timeoutMs,
    );
    if (outcome.code === 'ok') return { ok: true };
    return classifySecretToolFailure(outcome, 'wrap');
  }

  private async lookup(
    id: string,
    timeoutMs: number,
  ): Promise<{ ok: true; secret: string } | KeyringFailure> {
    const outcome = await this.exec(['lookup', ...attrArgs(id)], '', timeoutMs);
    if (outcome.code !== 'ok') return classifySecretToolFailure(outcome, 'unwrap');
    // 实测 lookup 不追加换行；仍只剥一层，防御其他 libsecret 版本。
    const secret = outcome.stdout.replace(/\r?\n$/, '');
    if (!secret) return { ok: false, kind: 'decrypt-failed', reason: 'empty-secret' };
    return { ok: true, secret };
  }

  private async clearQuietly(id: string): Promise<void> {
    try {
      await this.exec(['clear', ...attrArgs(id)], '', budgetMs(DEFAULT_CLEAR_TIMEOUT_MS));
    } catch { /* 清理是 best-effort */ }
  }
}

/** 供 keyring.ts 平台链引用（与 createWinDpapiBackend 对称）。 */
export function createLinuxSecretToolBackend(): LinuxSecretToolBackend {
  return new LinuxSecretToolBackend();
}
