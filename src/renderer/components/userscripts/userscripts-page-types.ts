import type { ParsedUserscriptMetadata } from '@shared/userscript-types';

export type Section = 'installed' | 'editor' | 'install';
export type Filter = 'all' | 'enabled' | 'disabled';

export interface EditorState {
  scriptId: string;
  source: string;
  initialSource: string;
  error: string | null;
}

export interface InstallPreview {
  source: string;
  from: string;
  error: string | null;
  metadata: ParsedUserscriptMetadata | null;
}

export interface ValuesPanelState {
  scriptId: string;
  values: Record<string, unknown>;
  dirty: string | null;   // 正在编辑的 key
  draft: string;          // 编辑草稿(JSON)
  error: string | null;
}

export interface BackgroundScriptStatus {
  scriptId: string;
  running: boolean;
  crashedCount: number;
  stopped: boolean;
}

export interface BackgroundStatus {
  scripts: BackgroundScriptStatus[];
  stopped: boolean;
}
