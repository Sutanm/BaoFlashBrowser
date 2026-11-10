import { useEffect } from 'react';

/**
 * 桥模式下的「跟随活动标签」。
 *
 * 桥的价值就是 URL 恒定：切标签时容器不重建，所以容器那个 effect（只认
 * url/nonce）不会重跑。跟随新 target 只能在这里做——让主进程把桥重新绑到
 * 新标签的 page target 上，桥会重放前端的域开关并发 `DOM.documentUpdated`，
 * 前端据此原地重建 Elements/Console，面板状态保留。
 *
 * 依赖里必须有 `activeTabUrl`：新建标签时 tab id 不变、只有它的 URL 变
 * （实测），只看 activeTabId 会漏掉这类切换。300ms 防抖吸收导航抖动。
 *
 * 新标签会先经历 about:blank（此时没有 page target，attach 必然失败）。这是
 * 过渡态，不能当成「断开」——前端一旦收到 detached 就会显示断开横幅并停止
 * 一切请求，所以热切换只静默重试，绝不主动发 detached。
 */
export function useDevToolsBridgeAttach(
  enabled: boolean,
  target: 'page' | 'shell',
  activeTabId: string | null,
  activeTabUrl: string | null,
): void {
  useEffect(() => {
    if (!enabled || !activeTabId) return;
    let cancelled = false;

    // 重试窗口要给得足够长：游戏站那种页面几十秒才建出可调试 target，
    // 早先只重试 4 次（~2.4s）就收手，后面的加载没人接——面板于是永远停在
    // 上一份文档上，用户只能按 F12 重开。这里退避到 ~20s，切标签即取消。
    const RETRY_DELAYS = [0, 400, 600, 800, 1200, 1600, 2000, 2500, 3000, 3000, 3000, 3000];

    const hotAttach = async (step: number): Promise<void> => {
      if (cancelled) return;
      // tabId 显式传：主进程的"活动标签"比渲染层晚一拍，靠它会绑到上一个页面。
      const result = await window.electronAPI.devtoolbox.bridge.attach(target, activeTabId).catch(() => null);
      if (cancelled || (result && result.ok)) return;
      // 这个标签根本没有自己的 BrowserView（about:newtab / 内置页面）：不存在
      // page target，退避重试只会把 20s 窗口变成一串空转 IPC 和日志。等它导航
      // 到真页面时 activeTabUrl 会变，本 effect 重跑，自然再试一次。
      const reason = (result as { error?: { message?: string } } | null)?.error?.message;
      if (reason === 'no-view') return;
      const next = RETRY_DELAYS[step + 1];
      if (next === undefined) return;
      setTimeout(() => { if (!cancelled) void hotAttach(step + 1); }, next);
    };

    // 首个 300ms 防抖吸收导航抖动
    const timer = setTimeout(() => { void hotAttach(0); }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, target, activeTabId, activeTabUrl]);
}
