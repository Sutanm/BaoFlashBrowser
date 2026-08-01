export type LinkBehavior = 'new-tab' | 'current-page';
export type FlashEngineMode = 'auto' | 'prefer-ruffle' | 'ppapi-only';
export type SearchEngine = 'bing' | 'google' | 'baidu';
export type RuffleSource = 'bundled' | 'cdn';
export type ThemeMode = 'light' | 'dark' | 'system';

export interface FlashEngineRule {
  domain: string;
  mode: FlashEngineMode;
}

export interface Settings {
  homepage: string;
  searchEngine: SearchEngine;
  linkBehavior: LinkBehavior;
  flashEngineMode: FlashEngineMode;
  flashEngineRules: FlashEngineRule[];
  ruffleSource: RuffleSource;
  themeMode: ThemeMode;
  language: string;
}
