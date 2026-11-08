import type { AutomationPackageV3 } from '../../../shared/automation/package-v3';
import { loadConfig } from '../config';
import { registerAutomationAssetSource, sharedAutomaticVisionMatcher, sharedAutomationColorMatcher, sharedAutomationVisionMatcher, shutdownAutomationVision } from './automation-warm-start';
import type { OpenCvWorkerMatcher } from './vision-worker-matcher';

export type AuthoringVisionSession = {
  readonly matcher: OpenCvWorkerMatcher;
  readonly colorMatcher: ReturnType<typeof sharedAutomationColorMatcher>;
  readonly automaticMatcher: ReturnType<typeof sharedAutomaticVisionMatcher>;
  queue: Promise<void>;
  closeTimer: NodeJS.Timeout;
};

const AUTHORING_VISION_IDLE_MS = 30_000;
/** 常驻 Worker 模式下只做 LRU 缓存，避免按打开过的包无界增长。 */
const AUTHORING_VISION_MAX_SESSIONS = 8;

/**
 * 作者态识别会话池。
 *
 * 常驻 Worker 归预热模块所有，这里只缓存“包 → matcher 组合”的引用；
 * 关闭缓存不等于关闭 Worker（是否 shutdown 由 automationVisionWarmStart 决定）。
 */
export class AuthoringVisionPool {
  private readonly sessions = new Map<string, AuthoringVisionSession>();

  get(packageId: string, source: AutomationPackageV3): AuthoringVisionSession {
    // 素材源交给常驻 Worker 的注册表解析,模板按内容 SHA-256 缓存,跨包共享。
    registerAutomationAssetSource(packageId, source);
    const existing = this.sessions.get(packageId);
    if (existing) {
      // 刷新 LRU 顺序：最近使用的包移到队尾，淘汰时优先丢最久未用的。
      this.sessions.delete(packageId);
      this.sessions.set(packageId, existing);
      return existing;
    }
    const cached: AuthoringVisionSession = {
      matcher: sharedAutomationVisionMatcher(),
      colorMatcher: sharedAutomationColorMatcher(),
      automaticMatcher: sharedAutomaticVisionMatcher(),
      queue: Promise.resolve(),
      closeTimer: setTimeout(() => undefined, 0),
    };
    clearTimeout(cached.closeTimer);
    cached.closeTimer = this.scheduleClose(packageId, cached);
    this.sessions.set(packageId, cached);
    this.evict();
    return cached;
  }

  /** 使用结束后重新开始空闲计时（常驻模式下是空定时器）。 */
  rearm(packageId: string, session: AuthoringVisionSession): void {
    clearTimeout(session.closeTimer);
    session.closeTimer = this.scheduleClose(packageId, session);
  }

  async close(packageId: string): Promise<void> {
    const cached = this.sessions.get(packageId);
    if (!cached) return;
    this.sessions.delete(packageId);
    clearTimeout(cached.closeTimer);
    await cached.queue;
    // 常驻开启时保留 Worker;非常驻时释放,恢复"用完即回收"的旧行为。
    if (!(loadConfig().automationVisionWarmStart ?? true)) await shutdownAutomationVision();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((packageId) => this.close(packageId)));
  }

  private scheduleClose(packageId: string, cached: AuthoringVisionSession): NodeJS.Timeout {
    // 常驻开启时 Worker 归预热模块所有。这里关闭它等于把下次识别打回冷启动,
    // 因此只保留记录、不做实际回收。
    if (loadConfig().automationVisionWarmStart ?? true) {
      const idle = setTimeout(() => undefined, 0);
      idle.unref();
      return idle;
    }
    const timer = setTimeout(() => {
      if (this.sessions.get(packageId) !== cached) return;
      this.sessions.delete(packageId);
      void cached.queue.then(() => shutdownAutomationVision());
    }, AUTHORING_VISION_IDLE_MS);
    timer.unref();
    return timer;
  }

  /**
   * 常驻 Worker 下条目不会自行过期，必须设上限。淘汰只清缓存引用，
   * 不 shutdown Worker —— 预热模块仍持有它，重新打开包只是重新建条目。
   */
  private evict(): void {
    while (this.sessions.size > AUTHORING_VISION_MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      const evicted = this.sessions.get(oldest);
      this.sessions.delete(oldest);
      if (evicted) clearTimeout(evicted.closeTimer);
    }
  }
}
