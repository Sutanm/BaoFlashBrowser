import type { Tab } from './tab';
import type { DownloadItem } from './downloads';

export type ShortcutAction =
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'switch-tab-1'
  | 'switch-tab-2'
  | 'switch-tab-3'
  | 'switch-tab-4'
  | 'switch-tab-5'
  | 'switch-tab-6'
  | 'switch-tab-7'
  | 'switch-tab-8'
  | 'reload'
  | 'stop-or-dismiss'
  | 'focus-address'
  | 'fullscreen'
  | 'devtools'
  | 'devtoolbox'
  | 'bookmark'
  | 'history-panel'
  | 'find-in-page'
  | 'save-page'
  | 'print-page'
  | 'view-source'
  | 'new-window'
  | 'close-window'
  | 'clear-data'
  | 'go-back'
  | 'go-forward'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

/**
 * P7：一个窗口内标签的权威快照条目。
 *
 * 标签列表在渲染层是事件驱动的（created/updated/detached/adopted），任何一条事件
 * 丢失都会留下幽灵标签或空壳窗口。tear-off / 跨窗移动之后主进程随事件推一份全量
 * 快照，渲染层以它为基线重建——这是唯一能自愈的路径。
 */
export interface TabSnapshotEntry {
  tabId: string;
  url: string;
  title: string;
  /**
   * 主进程记住的 favicon。`page-favicon-updated` 只在页面加载时触发一次，
   * 迁移后不会再发，快照里不带它的话重建出来的标签就永久没有图标。
   */
  favicon?: string;
  active: boolean;
}

export interface TabUpdatedPayload {
  tabId: string;
  changes?: Partial<Tab>;
  title?: string;
  url?: string;
  favicon?: string;
  isLoading?: boolean;
  isAudible?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  crashed?: boolean;
}

export interface DownloadProgressPayload {
  id: string;
  url?: string;
  filename?: string;
  state: DownloadItem['state'];
  progress: number;
  speed: number;
  receivedBytes?: number;
  totalBytes?: number;
  savePath?: string;
  engine?: DownloadItem['engine'];
  updatedAt?: number;
}

export interface ContextMenuPayload {
  type: 'page' | 'link' | 'image' | 'selection';
  url?: string;
  x: number;
  y: number;
  tabId: string;
}

export interface NewWindowPayload {
  url: string;
  disposition?: 'default' | 'foreground-tab' | 'background-tab' | 'new-window' | 'save-to-disk';
}

export interface TabFoundPayload {
  tabId: string;
  activeMatchOrdinal: number;
  matches: number;
}

export interface TabLoadErrorPayload {
  tabId: string;
  errorCode: number;
  validatedURL?: string;
}

export interface TabCrashedPayload {
  tabId: string;
  reason: string;
}

export interface Aria2StatusPayload {
  ready: boolean;
  port: number;
  dir: string;
}

export interface PasswordCapturedPayload {
  captureId: string;
  host: string;
  username: string;
}

export interface PasswordChangedPayload {
  ts: number;
}

export interface PasswordFilledPayload {  tabId: string;
  username: string;
  count: number;
  automatic: boolean;
}

export interface RuffleDiagnosticPayload {
  tabId: string;
  source: 'bundled' | 'cdn';
  phase: 'config' | 'bundled-eval-ok' | 'bundled-eval-error' | 'cdn-loading' | 'cdn-loaded' | 'cdn-error' | 'runtime-ready' | 'runtime-error' | 'component-error';
  detail?: string;
}

export interface WindowContextPayload {
  windowKey: string;
  index: number;
  isPrimary: boolean;
  isMaximized: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  /** 新窗口待打开的 URL（由 P6 的新窗口首标签消费）。 */
  initialUrl?: string;
}

export interface IPCMainToRenderer {
  shortcut: (action: ShortcutAction) => void;
  'tab:updated': (payload: TabUpdatedPayload) => void;
  'tab:found': (payload: TabFoundPayload) => void;
  'tab:load-error': (payload: TabLoadErrorPayload) => void;
  'tab:crashed': (payload: TabCrashedPayload) => void;
  'tab:newwindow': (payload: NewWindowPayload) => void;
  'tab:detached': (payload: { tabId: string }) => void;
  'tab:adopted': (payload: { tabId: string }) => void;
  'download:progress': (payload: DownloadProgressPayload) => void;
  'aria2:status': (payload: Aria2StatusPayload) => void;
  'navigate-url': (url: string) => void;
  'password:captured': (payload: PasswordCapturedPayload) => void;
  'password:changed': (payload: PasswordChangedPayload) => void;
  'password:filled': (payload: PasswordFilledPayload) => void;
  'ruffle:diagnostic': (payload: RuffleDiagnosticPayload) => void;
  'webview:context-menu': (payload: ContextMenuPayload) => void;
  'webview:new-window': (payload: NewWindowPayload) => void;
}

export type IPCMainToRendererChannel = keyof IPCMainToRenderer;

export type { Tab, TabCreateOptions } from './tab';
export type { BookmarkEntry } from './bookmarks';
export type { HistoryEntry } from './history';
export type { DownloadItem, DownloadState, DownloadEngine } from './downloads';
export type { Settings, LinkBehavior, FlashEngineMode, FlashEngineRule, SearchEngine } from './settings';

