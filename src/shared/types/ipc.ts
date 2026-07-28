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
  | 'clear-data';

export interface TabUpdatedPayload {
  tabId: string;
  changes: Partial<Tab>;
}

export interface DownloadProgressPayload {
  id: string;
  state: DownloadItem['state'];
  percent: number;
  speed: string;
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

export interface IPCMainToRenderer {
  shortcut: (action: ShortcutAction) => void;
  'tab:updated': (payload: TabUpdatedPayload) => void;
  'download:progress': (payload: DownloadProgressPayload) => void;
  'webview:context-menu': (payload: ContextMenuPayload) => void;
  'webview:new-window': (payload: NewWindowPayload) => void;
}

export type IPCMainToRendererChannel = keyof IPCMainToRenderer;

export type { Tab, TabCreateOptions } from './tab';
export type { BookmarkEntry } from './bookmarks';
export type { HistoryEntry } from './history';
export type { DownloadItem, DownloadState } from './downloads';
export type { Settings, LinkBehavior, FlashEngineMode, FlashEngineRule, SearchEngine } from './settings';
