// @vitest-environment jsdom
//
// 浮窗助手的历史浮层是构建期嵌入的用户脚本（纯文本资产），所以这里直接把源码
// eval 进 jsdom，用一个假的 `GM` 驱动真实 DOM 路径——目的是锁住"浮层里能整份
// 复制当前载入的运行记录"这条交互，它曾经只有分支没有按钮（面板里的复制按钮被
// 全屏遮罩盖住，`copyRunLogs` 的 archive 分支从 UI 上够不到）。
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'src', 'main', 'modules', 'userscripts', 'bundled-scripts', 'automation-frame-assistant.user.js'),
  'utf8',
);

/** 让已经排队的 promise 链（toggleArchive → loadArchiveFiles → openArchiveFile）跑完。 */
const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

type GmStub = Record<string, unknown> & { baoAutomation: Record<string, unknown> };

describe('floating assistant run-history copy', () => {
  afterEach(() => {
    for (const id of ['bao-automation-frame-assistant', 'bao-automation-history-layer', 'bao-automation-assistant-style']) {
      document.getElementById(id)?.remove();
    }
    delete (globalThis as { GM?: GmStub }).GM;
  });

  it('copies the whole loaded run log from the history layer instead of exporting it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    const readAutomationLogs = vi.fn().mockResolvedValue([
      { timestamp: 1762300000000, level: 'info', message: '开始运行脚本' },
      { timestamp: 1762300001000, level: 'success', message: '执行完成' },
    ]);
    (globalThis as { GM?: GmStub }).GM = {
      baoAutomation: {
        listPackages: vi.fn().mockResolvedValue([]),
        status: vi.fn().mockResolvedValue({ state: 'idle', executedSteps: 0, logs: [] }),
        toast: vi.fn().mockResolvedValue({ success: true }),
        listAutomationLogs: vi.fn().mockResolvedValue([
          { name: '261110-12-47-脚本A-记录1.json', sizeLabel: '1 KB', scriptName: '脚本A', startedAt: 1762300000000 },
        ]),
        readAutomationLogs,
        openAutomationLog: vi.fn().mockResolvedValue({ opened: true }),
      },
      getValue: (_key: string, fallback: unknown) => fallback,
      setValue: () => undefined,
      registerMenuCommand: () => undefined,
    };

    // 源码是裸 IIFE，从全局取 `GM`——与用户脚本运行时给它的形态一致。
    new Function(SOURCE)();
    await flush();

    const root = document.getElementById('bao-automation-frame-assistant');
    expect(root).not.toBeNull();
    const toggle = root?.querySelector<HTMLButtonElement>('.bao-archive-toggle');
    expect(toggle).toBeTruthy();
    toggle?.click();
    await flush();

    const layer = document.getElementById('bao-automation-history-layer');
    expect(layer?.classList.contains('bao-history-open')).toBe(true);
    // 打开浮层默认载入最新一份，右侧才看得到内容。
    expect(readAutomationLogs).toHaveBeenCalledWith('261110-12-47-脚本A-记录1.json');
    expect(layer?.textContent).toContain('开始运行脚本');

    // 决策：历史记录不再"导出 JSON"（走 blob 下载 → 下载目录），只提供整份复制。
    expect(layer?.querySelector('.bao-history-export')).toBeNull();
    const copy = layer?.querySelector<HTMLButtonElement>('.bao-history-copy');
    expect(copy).toBeTruthy();
    copy?.click();
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).toContain('开始运行脚本');
    expect(copied).toContain('执行完成');
    // 反馈必须落在浮层里那颗按钮上：面板里的复制按钮此刻被遮罩盖着。
    expect(copy?.textContent).toBe('已复制');
  });
});
