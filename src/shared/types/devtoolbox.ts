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

export interface DevToolPageProbe {
  swf: Array<{ url: string; kind: 'embed' | 'object' | 'param' | 'resource'; width?: number; height?: number }>;
  frames: Array<{ url: string; sameOrigin: boolean }>;
  ua: string;
  viewport: { width: number; height: number };
  frameCount: number;
}
