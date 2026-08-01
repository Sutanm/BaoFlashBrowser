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
  | 'bookmark'
  | 'history-panel'
  | 'find-in-page'
  | 'save-page'
  | 'print-page'
  | 'view-source'
  | 'new-window'
  | 'clear-data'
  | 'go-back'
  | 'go-forward'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

export interface TabUpdatedPayload {
  tabId: string;
  changes: Partial<Tab>;
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
  disposition: 'default' | 'foreground-tab' | 'background-tab' | 'new-window' | 'save-to-disk';
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

export interface IPCMainToRenderer {
  shortcut: (action: ShortcutAction) => void;
  'tab:updated': (payload: TabUpdatedPayload) => void;
  'tab:found': (payload: TabFoundPayload) => void;
  'tab:load-error': (payload: TabLoadErrorPayload) => void;
  'tab:crashed': (payload: TabCrashedPayload) => void;
  'tab:newwindow': (payload: NewWindowPayload) => void;
  'download:progress': (payload: DownloadProgressPayload) => void;
  'aria2:status': (payload: Aria2StatusPayload) => void;
  'navigate-url': (url: string) => void;
  'password:captured': (payload: PasswordCapturedPayload) => void;
  'password:changed': (payload: PasswordChangedPayload) => void;
  'webview:context-menu': (payload: ContextMenuPayload) => void;
  'webview:new-window': (payload: NewWindowPayload) => void;
}

export type IPCMainToRendererChannel = keyof IPCMainToRenderer;

export type { Tab, TabCreateOptions } from './tab';
export type { BookmarkEntry } from './bookmarks';
export type { HistoryEntry } from './history';
export type { DownloadItem, DownloadState, DownloadEngine } from './downloads';
export type { Settings, LinkBehavior, FlashEngineMode, FlashEngineRule, SearchEngine, DownloadEngine } from './settings';
