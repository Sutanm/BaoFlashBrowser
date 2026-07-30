export type LinkBehavior = 'new-tab' | 'current-page';
export type FlashEngineMode = 'auto' | 'prefer-ruffle' | 'ppapi-only';
export type SearchEngine = 'bing' | 'google' | 'baidu';
export type RuffleSource = 'bundled' | 'cdn';
export type DownloadEngine = 'chromium' | 'aria2';

export interface FlashEngineRule {
  domain: string;
  mode: FlashEngineMode;
}

export interface Settings {
  homepage: string;
  searchEngine: SearchEngine;
  linkBehavior: LinkBehavior;
  flashVersion: string;
  flashEngineMode: FlashEngineMode;
  flashEngineRules: FlashEngineRule[];
  lowEndMode: boolean;
  ruffleSource: RuffleSource;
  downloadEngine: DownloadEngine;
}
