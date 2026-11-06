import React, { useEffect, useRef, useState } from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { useTabsStore } from '@renderer/store/useTabsStore';
import { useDevToolStore } from '@renderer/store/useDevToolStore';
import { useDevToolsBridgeAttach } from './useDevToolsBridgeAttach';
import { isDevtoolsDragging } from './dragState';

type Target = 'page' | 'shell';

interface Bounds { x: number; y: number; width: number; height: number }

/**
 * 侧边栏是否正在做开合动画。
 *
 * 侧边栏的 `.library-sidebar` 用 width/flex-basis 做 240ms 动画（styles.css 的
 * sidebar-panel-enter/exit），期间工作区宽度每帧都在变。直接问 DOM 的动画状态，
 * 比在 App 里传标志位可靠：关闭动画还挂着 `.library-sidebar-inner` 的第二段动画，
 * 组件随后才卸载，靠事件容易漏。
 */
function isSidebarAnimating(): boolean {
  const el = document.querySelector('.library-sidebar');
  if (!el) return false;
  try {
    const animations = el.getAnimations();
    return animations.some((item) => item.playState === 'running');
  } catch {
    return false;
  }
}

/**
 * 真 DevTools 宿主。
 *
 * 里面是官方前端（`assets/devtools-frontend`，取自 chii 的构建产物，经
 * `scripts/build-devtools-frontend.cjs` 降级到 Chromium 87）。
 *
 * 承载方式：**统一由主进程 BrowserView 承载**（这里是占位 div，只上报矩形）。
 *
 * - **桥模式（默认）**：URL 恒定，切标签只重绑桥的 session，前端不重载。
 *   传输是 preload 暴露的 `bfbBridge` → IPC → 主进程桥（B3 之前是 iframe +
 *   postMessage 中继，已删除）。
 * - **page-ws（`BAO_DEVTOOLS_PAGE_WS=1` 回退）**：URL 带 target id，切标签
 *   会重建容器，面板状态丢失。
 *
 * 前端只认 WebSocket 或桥；`?ws=` 是它的传输层参数，桥模式刻意不带。
 *
 * 已知降级：前端约 M97，后端是 Chromium 87，新版才有的可选 CDP 方法
 * （Overlay 的 flex/scroll-snap 高亮、Network.setAttachDebugStack 等）会 404，
 * Console/Elements/Network/Sources 主路径不受影响。
 */
const DevToolsTab: React.FC = () => {
  const { LL } = useI18nContext();
  const activeTabId = useTabsStore((s) => s.activeTabId);
  // 活动标签的 URL 只用于触发重新解析（比如绑定时标签还停在 about:newtab，
  // 导航完成后需要再试一次）；page target 的 id 跨导航恒定，同标签内导航
  // 拿回的是同一个 URL，视图不会重载，面板状态照常保留。
  const activeTabUrl = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.url ?? null);
  // 选择跟标签走：面板只有一份，但"看哪个 target"是每个标签各自的偏好。
  // 之前这里是组件内的 useState，等于全局——在游戏页选了「当前页面」，
  // 切到新标签页再切回来就变回「外壳」了。
  const tabTarget = useDevToolStore((s) => (activeTabId ? s.tabTarget[activeTabId] : undefined));
  const target: Target = tabTarget ?? 'page';
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [noTarget, setNoTarget] = useState(false);
  // 「刷新」按钮在抽屉顶栏（与页签同一行），所以计数器放在 store。
  const nonce = useDevToolStore((s) => s.devtoolsReloadToken);
  // 停靠位置：右侧→左侧这种切换**尺寸不变、只有 x 变**，ResizeObserver 不会触发，
  // 必须显式再报一次 bounds（见下面 reportLayout）。
  const dock = useDevToolStore((s) => s.dock);
  /** 容器 effect 里注册的"重新上报矩形"，供停靠切换时调用。 */
  const reportLayoutRef = useRef<(() => void) | null>(null);
  /** 桥模式下 URL 恒定（不含 target id），切标签只换绑定、不换 URL → iframe 不重载。 */
  const [mode, setMode] = useState<'ws' | 'bridge'>('ws');
  const hostRef = useRef<HTMLDivElement>(null);
  /** 容器挂载时用的目标。不进 effect 依赖，理由见下面容器 effect 的注释。 */
  const targetRef = useRef<Target>(target);
  targetRef.current = target;
  /** 同上：挂载那一刻的标签，只用于"给哪个标签解析 target"，不进依赖。 */
  const tabIdRef = useRef<string | null>(activeTabId);
  tabIdRef.current = activeTabId;

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let portAttempts = 0;
    let targetAttempts = 0;
    setMissing(false);
    setNoTarget(false);
    const resolveUrl = () => {
      // tabId 必须显式传：切标签时渲染层先变、主进程的"活动标签"后跟上，
      // 不传就会在这段窗口里解析到上一个页面（表现为切到新标签页后仍显示旧页面）。
      window.electronAPI.devtoolbox.devtoolsUrl(target, activeTabId).then((result) => {
        if (!alive) return;
        // 迟到的响应：期间用户又切了标签，丢弃它，别把旧页面的 URL 写回来。
        if (useTabsStore.getState().activeTabId !== activeTabId) return;
        if (result && result.url) {
          setUrl(result.url);
          setMode(result.mode === 'bridge' ? 'bridge' : 'ws');
          setMissing(false);
          setNoTarget(false);
          return;
        }
        // no-target：当前标签根本没有 page target（about:newtab / 用户脚本页不创建
        // BrowserView）。**这类页面不可能有 target，立刻给占位**——原来一律重试 3 次
        // × 500ms，用户在新标签页里要等 3 秒才看到"没有可调试的页面"。
        // 真实页面（可能正在导航）才值得重试一次。
        if (result && result.reason === 'no-target') {
          const expectTarget = Boolean(activeTabUrl) && !/^(about|chrome|userscript)/i.test(activeTabUrl ?? '');
          targetAttempts += 1;
          if (expectTarget && targetAttempts <= 1) {
            retryTimer = setTimeout(resolveUrl, 400);
          } else {
            // **不要清 url**：清了容器 effect 就会跑清理，把已经挂好的原生视图销毁，
            // 切回来时又得重建前端——新实例会丢掉选中节点，Styles 空白/转圈
            // （用户实测：从新标签页切回正常页面后样式不出来，得手动切一次 target）。
            // 保留容器，只把视图藏起来（占位矩形为 0 → report() 会挪走原生视图）。
            setNoTarget(true);
          }
          return;
        }
        // no-port：端口/前端服务还没就绪，长一点的重试窗口。
        portAttempts += 1;
        if (portAttempts <= 12) {
          retryTimer = setTimeout(resolveUrl, 750);
        } else {
          setUrl(null);
          setMissing(true);
        }
      }).catch(() => {
        if (!alive) return;
        setUrl(null);
        setMissing(true);
      });
    };
    resolveUrl();
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [target, activeTabId, activeTabUrl, nonce]);

  // 容器挂载：把前端挂成独立 WebContents，并持续把占位 div 的矩形同步给主进程。
  // 切换停靠 / 拖拽抽屉 / 窗口缩放都会让矩形变化，ResizeObserver 会逐帧上报。
  //
  // 依赖里**故意没有 target**：
  // - ws 模式切 target 时 URL 会跟着变（带 target id），靠 url 触发重建；
  // - 桥模式切 target 时 URL 恒定，容器不该重建——重绑由 useDevToolsBridgeAttach
  //   完成。首挂目标从 ref 取，避免把 target 写进依赖而破坏这条语义。
  useEffect(() => {
    if (!url) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;

    let alive = true;
    let observer: ResizeObserver | null = null;
    let settleTimer = 0;
    /** 上一次真正发给主进程的矩形（侧边栏动画期间要沿用它，见下面的注释）。 */
    let applied: Bounds | null = null;

    const push = (rect: Bounds, sync: boolean): void => {
      applied = rect;
      if (sync) {
        try {
          window.electronAPI.devtoolbox.setDevToolsBoundsSync(rect);
          return;
        } catch {
          // 同步通道不可用（旧 preload / 主进程没注册 handler）→ 退回异步，
          // 否则一次 TypeError 就让 ResizeObserver 回调整个失效，表现为拖拽完全不动。
        }
      }
      void window.electronAPI.devtoolbox.setDevToolsBounds(rect);
    };

    const hostRect = (): Bounds => {
      const rect = host.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };

    /**
     * 侧边栏动画结束后按真实矩形重排一次。
     *
     * 动画期间只让视图"让位"（改 x）、不改尺寸，所以收尾必须补这一下；
     * 轮询而不是监听 animationend，是因为关闭动画挂在 `.library-sidebar-inner`
     * 上、且组件随后卸载，事件会漏。
     */
    const settleAfterSidebar = (): void => {
      if (settleTimer) return;
      settleTimer = window.setInterval(() => {
        if (isSidebarAnimating()) return;
        window.clearInterval(settleTimer);
        settleTimer = 0;
        push(hostRect(), false);
      }, 40);
    };

    const report = (): void => {
      const rect = hostRect();
      // 抽屉切到别的页签时容器是 display:none（组件不卸载，前端继续活着），
      // 这时占位矩形是 0——必须把原生视图挪出可视区，否则它作为原生层会一直
      // 盖在「捕获 / Flash / 主进程」的内容上面。
      if (rect.width < 2 || rect.height < 2) {
        push({ x: -8, y: -8, width: 1, height: 1 }, false);
        return;
      }
      // 拖拽期间走同步 IPC：异步通道会让原生视图的更新落到下一帧，快速拖拽时
      // 每帧位移几十像素，视觉上就是"内容慢半拍、松手再跳一下"。
      if (isDevtoolsDragging()) {
        push(rect, true);
        return;
      }
      // 侧边栏开合（width/flex-basis 240ms 动画）期间：**只移动、不改尺寸**。
      // 实测每帧改宽度会让 DevTools 前端整页重排，240ms 内只跟得上 13/18 个台阶，
      // 中间一跳 206px（关闭时 48 个台阶只跟 10 个，最大跳 154px）——就是"直接跳变"。
      // 保持旧尺寸 + 跟着右移，视觉上等同于页面那边既有的"向右扩展、由窗口裁剪"，
      // 动画结束后再一次性重排到最终宽度。
      if (applied && isSidebarAnimating()) {
        // x 只增不减：开的时候跟着侧边栏让位，关的时候原地不动（否则会盖住滑出的侧边栏）。
        push({ x: Math.max(applied.x, rect.x), y: rect.y, width: applied.width, height: applied.height }, false);
        settleAfterSidebar();
        return;
      }
      push(rect, false);
    };

    void window.electronAPI.devtoolbox.attachDevToolsView(targetRef.current, tabIdRef.current).then((result) => {
      if (!alive || !result.ok) return;
      report();
      reportLayoutRef.current = report;
      observer = new ResizeObserver(report);
      observer.observe(host);
      window.addEventListener('resize', report);
    }).catch(() => {
      // 失败由 missing/noTarget 占位兜底，这里不额外弹错
    });

    return () => {
      alive = false;
      reportLayoutRef.current = null;
      observer?.disconnect();
      if (settleTimer) window.clearInterval(settleTimer);
      window.removeEventListener('resize', report);
      void window.electronAPI.devtoolbox.detachDevToolsView();
    };
  }, [mode, url, nonce]);

  // 停靠切换（右→左、下→右…）时抽屉换了位置：**尺寸常常一模一样，只有 x/y 变**，
  // ResizeObserver 不会触发，原生视图就会留在原处（现象：抽屉在右、画面还在左）。
  // 同理，切到没有 target 的标签页 / 切回来时占位 div 的显隐也会让它变 0 或变回来。
  // 只用两帧不够稳：切停靠常常伴随侧边栏/抽屉的过渡，布局可能晚一两拍才最终定格，
  // 所以补三次（下一帧、+120ms、+350ms），每次都取当下的真实矩形。
  useEffect(() => {
    let frame = 0;
    const timers: number[] = [];
    const fire = (): void => { reportLayoutRef.current?.(); };
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(fire);
    });
    timers.push(window.setTimeout(fire, 120));
    timers.push(window.setTimeout(fire, 350));
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [dock, noTarget]);

  // 桥模式下 URL 恒定，切标签只重绑 session：前端不重载，面板状态保留。
  useDevToolsBridgeAttach(mode === 'bridge', target, activeTabId, activeTabUrl);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/*
       * 占位 div **始终挂载**（只要解析出过 url）：切到没有 page target 的标签页时
       * 只是把它藏起来，绝不卸载——卸载会触发容器 effect 的清理，把原生视图销毁，
       * 切回来重建的前端实例没有选中节点（Styles 就是空的）。
       */}
      {url ? (
        <div
          ref={hostRef}
          data-devtools-host=""
          className="flex-1 min-h-0 w-full"
          style={{ background: 'var(--bg-panel)', display: noTarget ? 'none' : 'block' }}
        />
      ) : null}

      {noTarget ? (
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{LL.devtools.noTarget()}</div>
        </div>
      ) : missing ? (
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{LL.devtools.noDebugPort()}</div>
        </div>
      ) : url ? null : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>…</div>
        </div>
      )}
    </div>
  );
};

export default DevToolsTab;
