import type { DevToolEntry, DevToolIssue, DevToolLevel } from '@shared/types/devtoolbox';

/**
 * 工具箱的纯逻辑部分：条目截断、等级映射、分类、双队列缓冲。
 * 与 Electron 完全解耦，便于在 vitest（纯 Node）下直接验证。
 */

export const MAX_TEXT = 4000;

export function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function mapConsoleLevel(level: number): DevToolLevel {
  if (level >= 3) return 'error';
  if (level === 2) return 'warning';
  if (level === 1) return 'info';
  return 'verbose';
}

export function classifyMainLog(text: string): DevToolIssue {
  if (text.startsWith('[PasswordCapture]')) return 'capture';
  if (text.startsWith('[Keyring]') || text.startsWith('[ViewGate]') || text.startsWith('[PasswordStore]')) return 'capture';
  if (text.startsWith('[Flash]') || text.startsWith('[Ruffle]')) return 'flash';
  return 'log';
}

/**
 * 双队列：`items` 是供快照回放的完整历史（定长），`queue` 是待推送的增量。
 * 分离两者是因为 IPC 推送需要批量合并，而快照需要全量；只保留一份会让
 * “刚打开抽屉时补历史”和“持续推送”互相吃掉。
 */
export class EntryBuffer {
  private items: DevToolEntry[] = [];
  private queue: DevToolEntry[] = [];

  constructor(private readonly limit: number) {
    if (limit <= 0) throw new Error('EntryBuffer limit must be positive');
  }

  push(entry: DevToolEntry): void {
    this.items.push(entry);
    if (this.items.length > this.limit) this.items = this.items.slice(this.items.length - this.limit);
    this.queue.push(entry);
    if (this.queue.length > this.limit) this.queue = this.queue.slice(this.queue.length - this.limit);
  }

  takePending(max: number): DevToolEntry[] {
    if (this.queue.length === 0) return [];
    return this.queue.splice(0, Math.max(1, max));
  }

  get pending(): number {
    return this.queue.length;
  }

  snapshot(): DevToolEntry[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
    this.queue = [];
  }
}
