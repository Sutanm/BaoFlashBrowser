import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import log from 'electron-log';
import type { DevToolsTargetResult } from '@shared/types/devtoolbox';
import { fetchTargets, resolveDebugPort, type DebugTarget } from './devtoolbox-targets';
import { ensureFrontendServer, getDevToolsFrontendDir, useBridge, useLegacyHttp } from './devtoolbox-frontend-server';
import { tabManager, getTabManagerForWindow } from './tabs';

/** 指定窗口的实例；没有 winId 的旧调用点退回全局 facade（聚焦窗口语义）。 */
function managerFor(winId?: number | null) {
  return winId === undefined || winId === null ? tabManager : (getTabManagerForWindow(winId) ?? tabManager);
}

/**
 * tabId → CDP page targetId 绑定表。
 *
 * Chromium 的 page target id 在同一 WebContents 生命周期内**恒定**（跨导航不变），
 * 所以绑一次就能一直用：切标签换 targetId（iframe 重连）、同标签内导航 targetId
 * 不变（iframe 不重载，前端经 CDP 事件自动跟随新页面，面板状态保留——与真
 * Chrome DevTools 行为一致）。
 *
 * 绑定只能在 tab 创建/首次需要时按 URL 匹配建立（Electron 11 没有暴露
 * webContents ↔ targetId 的映射 API，`webContents.debugger.attach` 又会抢
 * password-fill 的 CDP 租约）。读绑定时校验 targetId 仍在 /json/list 里，
 * 失效（tab 关闭、webContents 崩溃重建）就重新绑定——绑定表完全自愈。
 */
const tabTargetBindings = new Map<string, string>();

/** 外壳 renderer 在 CDP 里也是 page target（file://…/dist/renderer/index.html）。 */
function isShell(item: DebugTarget): boolean {
  return /\/dist\/renderer\/index\.html$/.test(item.url);
}

/**
 * DevTools 前端自身在 CDP 里也是 page target，绑定/选择时必须排除。
 *
 * 桥模式的 URL 是 `file://…/devtools_app.html?can_dock=true`，**没有 ws 参数**。
 * 早先只认 `?ws=`，于是前端自己被当成可绑定目标：切标签时新标签还是
 * about:blank，绑定走 fallback 就把前端容器掳了过来，热切换随后因 targetId
 * 相同早退，面板永远停在错误文档上。
 */
function isFrontendTarget(item: DebugTarget): boolean {
  return /\/devtools-frontend\//.test(item.url)
    || /\/(devtools_app|inspector|chii_app)\.html(\?|$)/.test(item.url);
}

function isBindableTarget(item: DebugTarget): boolean {
  return item.type === 'page' && !isShell(item) && !isFrontendTarget(item);
}

export async function pickTargetForTab(tabId: string, port: number, winId?: number | null): Promise<string | null> {
  const wc = managerFor(winId).getWebContents(tabId);
  const bound = tabTargetBindings.get(tabId);
  const targets = (await fetchTargets(port)).filter(isBindableTarget);

  // 1) 已绑定且还活着 → 直接用
  if (bound && targets.some((item) => item.id === bound)) return bound;
  if (bound) tabTargetBindings.delete(tabId);

  // 2) 现场绑定：URL 精确匹配 + 不占用别的 tab 已绑定的 target
  const currentUrl = wc ? wc.getURL() : '';
  const taken = new Set(tabTargetBindings.values());
  const candidate =
    (currentUrl ? targets.find((item) => item.url === currentUrl && !taken.has(item.id)) : undefined)
    // 新标签还没导航（getURL() 为空）时，只接受 about: 的无人占用 target。
    // 早先这里退回"任意未占用"，实测会把别的页面甚至前端容器掳过来；一旦绑错，
    // 热切换看到 targetId 相同就早退，面板永远停在那份文档上。宁可返回 null
    // 让调用方等下一次（导航完成后 URL 就能精确匹配），也不要猜。
    ?? targets.find((item) => !taken.has(item.id) && /^about:/.test(item.url));
  if (!candidate) return null;
  tabTargetBindings.set(tabId, candidate.id);
  return candidate.id;
}

/**
 * 解析失败原因。`bridge-attach` 会把它原样回给渲染层，渲染层据此决定还要不要
 * 重试（见 `useDevToolsBridgeAttach`）。
 *
 * - `no-port`：调试端口/前端还没就绪，等一会儿就有了；
 * - `no-target`：标签是真页面，但 page target 还没注册（刚导航），值得重试；
 * - `no-view`：这个标签根本没有 BrowserView（about:newtab / 内置页），
 *   不可能有 page target，重试纯属空转。
 */
export type PageTargetFailure = 'no-port' | 'no-target' | 'no-view';

export interface PageTargetResolution {
  targetId: string | null;
  reason: 'ok' | PageTargetFailure;
}

/**
 * 上一次解析结论（每标签一条）。
 *
 * 桥的热切换在目标没准备好时会退避重试十来次，每次都写一行"resolve … target=null"
 * 会把主日志刷满（用户实测：切到无视图的标签后 20s 内十几行）。解析结论没变就
 * 不再重复记，只在 状态/target/URL 真正变化时记一行。
 */
const lastResolveSignature = new Map<string, string>();

function logResolve(wanted: string, url: string, targetId: string | null, reason: 'ok' | PageTargetFailure): void {
  const signature = `${reason}|${targetId ?? 'null'}|${url}`;
  if (lastResolveSignature.get(wanted) === signature) return;
  // 标签会一直新建，给这张表一个上限，避免长会话里无界增长。
  if (lastResolveSignature.size > 256) lastResolveSignature.clear();
  lastResolveSignature.set(wanted, signature);
  // electron-log v4 **不支持 printf 占位符**：`log.info('…%s', x)` 只会把 x 追加到
  // 末尾（日志里出现字面量 `%s`）。这里一律用模板字符串。
  log.info(`[DevToolsBridge] resolve tab=${wanted.slice(-6)} url=${url || '-'} → target=${targetId ? targetId.slice(0, 6) : 'null'} (${reason})`);
}

/**
 * 解析指定目标的 CDP target id。
 *
 * 桥的热切换要用它：切 page 时跟随活动标签（走绑定表），切 shell 时按 URL
 * 唯一匹配。放在这里而不是让 IPC 层自己拼，是为了和 `getDevToolsTargetUrl`
 * 共用同一套解析（两套逻辑漂移过一次，about:blank 中间态会静默撞旧 target）。
 */
export async function resolveTargetId(target: 'page' | 'shell', tabId?: string | null, winId?: number | null): Promise<string | null> {
  if (target === 'shell') {
    const port = resolveDebugPort();
    if (!port) return null;
    return (await fetchTargets(port)).find(isShell)?.id ?? null;
  }
  return resolveActivePageTargetId(tabId, winId);
}

/**
 * 解析标签的 page target，并把"为什么没解出来"一起带出来。
 *
 * 绑定表逻辑与 `getDevToolsTargetUrl` 共用（`pickTargetForTab`），避免两套
 * 解析漂移。
 */
export async function resolvePageTarget(tabId?: string | null, winId?: number | null): Promise<PageTargetResolution> {
  const port = resolveDebugPort();
  if (!port) return { targetId: null, reason: 'no-port' };
  const manager = managerFor(winId);
  const wanted = tabId ?? manager.getActiveId();
  if (!wanted) return { targetId: null, reason: 'no-target' };
  const wc = manager.getWebContents(wanted);
  if (!wc) {
    // 没有 BrowserView 的标签（about:newtab、用户脚本页…）不会有 page target。
    // 之前这里和"正在加载"混为一谈，渲染层于是按 no-target 退避重试到底。
    logResolve(wanted, '', null, 'no-view');
    return { targetId: null, reason: 'no-view' };
  }
  const url = wc.getURL();
  const targetId = await pickTargetForTab(wanted, port, winId);
  logResolve(wanted, url, targetId, targetId ? 'ok' : 'no-target');
  return { targetId, reason: targetId ? 'ok' : 'no-target' };
}

/** 只要 target id 时的薄封装（探针/快照等内部调用点）。 */
export async function resolveActivePageTargetId(tabId?: string | null, winId?: number | null): Promise<string | null> {
  return (await resolvePageTarget(tabId, winId)).targetId;
}

/**
 * 给前端一个可以直接连的 target 的 ws 地址。
 *
 * 页面目标走 tabId → targetId 绑定表（见 pickTargetForTab），不再按 URL
 * 实时匹配——URL 匹配在 about:blank 中间态会静默撞回旧标签的 target，
 * 且同标签内导航永远触发不了重连。外壳目标按 URL 匹配（外壳 target 唯一，
 * 无歧义；匹配不到就返回 no-target）。
 */
export async function getDevToolsTargetUrl(target: 'page' | 'shell', tabId?: string | null, winId?: number | null): Promise<DevToolsTargetResult> {
  const port = resolveDebugPort();
  if (!port) return { url: null, reason: 'no-port' };

  // 前端入口：默认走 file://（无静态服务端口，origin 恒定 → DevTools 设置能持久）；
  // 回退开关打开时走旧的 http 静态服务。
  const entry = path.join(getDevToolsFrontendDir(), 'devtools_app.html');
  let entryUrl: string | null = null;
  if (useLegacyHttp()) {
    const frontend = await ensureFrontendServer();
    if (frontend) entryUrl = `http://127.0.0.1:${frontend}/devtools_app.html`;
  } else if (fs.existsSync(entry)) {
    entryUrl = pathToFileURL(entry).toString();
  }
  if (!entryUrl) return { url: null, reason: 'no-port' };

  const targets = await fetchTargets(port);
  // 端口在但列表为空：多半是刚启动还没注册 target，按可重试处理。
  if (targets.length === 0) return { url: null, reason: 'no-port' };

  let pickedId: string | null = null;
  if (target === 'shell') {
    // 外壳 target 按 URL 匹配（唯一），匹配不到就明示失败，不静默撞别的 target。
    pickedId = targets.find(isShell)?.id ?? null;
  } else {
    // tabId 由渲染层传入：它就是"用户现在看到的是哪个标签"的权威。
    // 不传时退回该窗口的活动标签（容器首次挂载等场景）。
    const wanted = tabId ?? managerFor(winId).getActiveId();
    pickedId = wanted ? await pickTargetForTab(wanted, port, winId) : null;
  }
  if (!pickedId) {
    return { url: null, reason: 'no-target' };
  }
  // 桥模式（B3 起为默认）：URL 不带 ws，前端用 preload 暴露的 `bfbBridge`
  //   → IPC → 主进程桥 → browser ws + flatten session。
  // **URL 里刻意不带 target id**：切标签时容器不重载，面板状态（Elements 选中、
  // Console 历史）得以保留；跟随新标签由渲染层重新调 bridge.attach() 完成
  // （桥重放域状态 + 发 DOM.documentUpdated）。
  if (useBridge()) {
    return {
      url: `${entryUrl}?can_dock=true`,
      reason: 'ok',
      mode: 'bridge',
      // 主进程要在 loadURL 之前拿它挂桥，见 attachDevToolsView。
      targetId: pickedId,
    };
  }
  // 默认（page-ws 直连）。入口用 devtools_app.html（只挂 AdvancedApp 停靠壳），
  // can_dock=true 是它的启用条件；showBoth → hideMain 的占位修正见
  // scripts/build-devtools-frontend.cjs 的 SOURCE_PATCHES 与文档 §8.1。
  return {
    url: `${entryUrl}?ws=127.0.0.1:${port}/devtools/page/${pickedId}&can_dock=true`,
    reason: 'ok',
    mode: 'ws',
  };
}
