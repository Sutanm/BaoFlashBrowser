/**
 * 变化门控：把"画面没变"这件事变成可判定的状态，并据此退避轮询。
 *
 * 等待循环的典型形态是"每 100–200 ms 抓一次、识别一次"。
 * 但绝大多数轮询里屏幕是静止的——识别结果必然和上一次相同，算它是纯浪费。
 *
 * 这个模块只管两件事：
 *   1. 记录每个查询上一次看到的帧指纹，回答"变了没有"、连续没变多少次；
 *   2. 连续没变时给出更长的下一次轮询间隔（指数退避、有上限），画面一变立刻回到基础间隔。
 *
 * 它**不**负责缓存识别结果——那是 ObservationCache 的事。
 * 两者配合：门控决定"要不要算"，缓存决定"算过的能不能复用"。
 */

export type ChangeGateOptions = {
  /** 连续多少次未变化后开始退避。默认 3。 */
  readonly after?: number;
  /** 每次额外未变化的间隔倍数，必须 > 1。默认 2。 */
  readonly factor?: number;
  /** 退避上限（毫秒）。默认 2000。 */
  readonly maxMs?: number;
};

export type ChangeObservation = {
  /** 与上一次观察相比画面是否变化。第一次观察恒为 true。 */
  readonly changed: boolean;
  /** 连续未变化的次数。变化后归零。 */
  readonly streak: number;
  /** 该查询累计因画面未变而被跳过的次数。 */
  readonly skipped: number;
};

type GateState = {
  fingerprint: number;
  streak: number;
  skipped: number;
};

export class ChangeGate {
  private readonly states = new Map<string, GateState>();
  private readonly after: number;
  private readonly factor: number;
  private readonly maxMs: number;

  constructor(options: ChangeGateOptions = {}) {
    const after = options.after ?? 3;
    const factor = options.factor ?? 2;
    const maxMs = options.maxMs ?? 2000;
    if (!Number.isSafeInteger(after) || after < 1) {
      throw new Error('change gate "after" must be a positive integer');
    }
    if (!Number.isFinite(factor) || factor <= 1) {
      throw new Error('change gate "factor" must be greater than 1');
    }
    if (!Number.isFinite(maxMs) || maxMs <= 0) {
      throw new Error('change gate "maxMs" must be a positive number');
    }
    this.after = after;
    this.factor = factor;
    this.maxMs = maxMs;
  }

  observe(key: string, fingerprint: number): ChangeObservation {
    const state = this.states.get(key);
    if (!state) {
      this.states.set(key, { fingerprint, streak: 0, skipped: 0 });
      return { changed: true, streak: 0, skipped: 0 };
    }
    if (state.fingerprint !== fingerprint) {
      state.fingerprint = fingerprint;
      state.streak = 0;
      return { changed: true, streak: 0, skipped: state.skipped };
    }
    state.streak += 1;
    state.skipped += 1;
    return { changed: false, streak: state.streak, skipped: state.skipped };
  }

  /**
   * 下一次轮询前应该等多久。
   * 未到退避阈值、或 key 未知时返回基础间隔；到阈值后按 factor 指数放大并受 maxMs 封顶。
   */
  nextPollDelayMs(key: string, baseMs: number): number {
    if (!Number.isFinite(baseMs) || baseMs < 0) {
      throw new Error('change gate base poll interval must be a non-negative number');
    }
    const state = this.states.get(key);
    if (!state || state.streak < this.after) return baseMs;
    const extra = state.streak - this.after + 1;
    const delay = baseMs * this.factor ** extra;
    return Math.min(this.maxMs, delay);
  }

  reset(key?: string): void {
    if (key === undefined) this.states.clear();
    else this.states.delete(key);
  }

  stats(): { keys: number; skipped: number } {
    let skipped = 0;
    for (const state of this.states.values()) skipped += state.skipped;
    return { keys: this.states.size, skipped };
  }
}
