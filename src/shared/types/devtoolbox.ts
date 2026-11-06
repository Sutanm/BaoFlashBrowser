/**
 * 开发者工具箱（内置调试抽屉）的共享类型。
 *
 * 设计约束：本工具箱**不占用 CDP**，因此它只能观察 Electron 自己暴露的东西
 * （console-message 事件、electron-log 钩子、executeJavaScript），拿不到网络
 * 响应体与断点调试 —— 那两件事仍然只有 Chromium DevTools 能做。
 */

export type DevToolSource = 'page' | 'shell' | 'main';

export type DevToolLevel = 'verbose' | 'info' | 'warning' | 'error';

export type DevToolIssue = 'console' | 'log' | 'capture' | 'flash';

export interface DevToolEntry {
  /** 单调递增，渲染层用它做 key 与去重 */
  id: number;
  ts: number;
  source: DevToolSource;
  level: DevToolLevel;
  /** 展示文本（已截断到 4000 字符） */
  text: string;
  /** 来源位置：页面脚本 URL:行 或 主进程模块名 */
  origin?: string;
  /** 页面事件对应的 tab */
  tabId?: string;
  /** 仅供过滤的分类：页面 console / 主进程日志 / 密码捕获 / Flash */
  issue?: DevToolIssue;
}

export interface DevToolTargetInfo {
  id: number;
  kind: 'page' | 'shell';
  tabId?: string;
  url: string;
  title: string;
}

export interface DevToolFlashInfo {
  pluginPath: string | null;
  version: string | null;
  channel: string | null;
  source: string | null;
  fallbackReason: string | null;
  mmsCfg: string;
  ua: string;
}

export interface DevToolSnapshot {
  entries: DevToolEntry[];
  targets: DevToolTargetInfo[];
  flash: DevToolFlashInfo;
  /** 当前占用 CDP 的模块（密码捕获 / 自动化），无则 null */
  cdpOwner: string | null;
  activeTabId: string | null;
}

export interface DevToolDevToolsUrlRequest {
  /** page = 当前标签的 BrowserView；shell = 外壳界面进程 */
  target: 'page' | 'shell';
}

/**
 * `devtoolbox:devtools-url` 的返回。带 reason 是为了让渲染层区分三种状态：
 * - `ok`：url 可用
 * - `no-port`：调试端口或前端静态服务不可用（可重试）
 * - `no-target`：通道正常但当前标签没有可调试的 page target（about:newtab 等
 *   页面不创建 BrowserView）——正常语义，不该重试到超时
 */
export interface DevToolsTargetResult {
  url: string | null;
  reason: 'ok' | 'no-port' | 'no-target';
  /**
   * 传输模式：
   * - `bridge`：前端走 CDP 桥（默认，URL 稳定，切标签只需重新 attach，容器不重载）
   * - `ws`：前端直连 CDP 端口（回退路径，URL 带 ws 参数，切标签会重载容器）
   */
  mode?: 'ws' | 'bridge';
  /**
   * 桥模式解析出的 page target id。
   *
   * 主进程要在 `loadURL` 之前把桥挂到这个 target 上，否则前端一起来就发命令
   * 会撞到「桥还没 session」。渲染层不消费这个字段，只是随结果一起带出来。
   */
  targetId?: string;
}

export interface DevToolPageProbe {
  swf: Array<{
    url: string;
    /** `frame`：SWF 本身就是某个 iframe 的地址（很多站直接把 .swf 当 frame URL）。 */
    kind: 'embed' | 'object' | 'param' | 'resource' | 'frame';
    width?: number;
    height?: number;
  }>;
  /**
   * frame 列表。CDP 深探能用时，`depth`/`readable` 才有值：
   * `readable` 表示真的在这个 frame 里跑过探测（跨域、OOPIF 也能跑）。
   */
  frames: Array<{ url: string; sameOrigin: boolean; depth?: number; readable?: boolean }>;
  /**
   * 找到的 Flash 插件实例数（`<embed type="application/x-shockwave-flash">` 之类），
   * 不看 URL。有的站点把 SWF 地址藏进 JS 或相对路径解析不出来，但插件是真的在跑；
   * 这个数比"有没有 .swf 字符串"更接近"这页到底有没有 Flash"。
   */
  flashPlugins?: number;
  /** 能读到 DOM 的同源 frame 数（跨域 frame 只能靠 CDP 深探）。 */
  sameOriginFrames?: number;
  /** 是否走了 CDP 深探（跨域 / OOPIF / 无 JS 上下文的 frame 都能扫）。 */
  deep?: boolean;
  ua: string;
  viewport: { width: number; height: number };
  frameCount: number;
}
