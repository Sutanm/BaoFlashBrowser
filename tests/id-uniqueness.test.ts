// 多窗口 P3（SDD: docs/specs/multi-window-plan.md §6.5 / §7 P3）
//
// tabId 由每个渲染进程各自生成；多窗口下两个进程的 counter 都从 0 开始，
// 同毫秒创建就会撞 id，而 P3 的全局 tabId→manager 索引会被撞坏的 id 骗到
// 错误实例。这里要求生成时带进程级随机前缀。
import { describe, expect, it, vi } from 'vitest';

const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

describe('tab id uniqueness across renderer processes (P3)', () => {
  it('keeps the persisted-id charset and adds a process scoped prefix', async () => {
    vi.resetModules();
    const first = await import('../src/renderer/services/id.service');

    vi.resetModules();
    const second = await import('../src/renderer/services/id.service');

    const firstIds = new Set<string>();
    const secondIds = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      firstIds.add(first.generateId());
      secondIds.add(second.generateId());
    }

    for (const id of [...firstIds, ...secondIds]) {
      expect(id).toMatch(TAB_ID_PATTERN);
    }
    const overlap = [...firstIds].filter((id) => secondIds.has(id));
    expect(overlap).toEqual([]);

    // 同一个模块实例内也不能重复。
    expect(firstIds.size).toBe(50);
  });

  it('does not rely on a process-wide counter for uniqueness', async () => {
    vi.resetModules();
    const first = await import('../src/renderer/services/id.service');
    vi.resetModules();
    const second = await import('../src/renderer/services/id.service');

    // 同一毫秒、同一 counter 序号，唯一差异必须来自进程前缀。
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      expect(first.generateId()).not.toBe(second.generateId());
    } finally {
      vi.restoreAllMocks();
    }
  });
});
