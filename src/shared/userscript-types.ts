// Shared types for the demo userscript runtime. Mirrors the planned
// src/main/modules/userscripts/userscript-types.ts so the port is mechanical.

export type RunAt = 'document-start' | 'document-body' | 'document-end' | 'document-idle';

export interface UserscriptResource {
  name: string;
  url: string;
}

export interface ParsedUserscriptMetadata {
  name: string;
  namespace: string;
  version: string;
  description: string;
  match: string[];
  include: string[];
  exclude: string[];
  excludeMatch: string[];
  runAt: RunAt;
  grant: string[];
  connect: string[];
  noframes: boolean;
  require: string[];
  resource: UserscriptResource[];
  rawHeader: string;
}

export interface InstalledUserscript {
  id: string;
  source: string;
  enabled: boolean;
  metadata: ParsedUserscriptMetadata;
  installedAt: number;
  updatedAt: number;
  revision: number;
  /** Set when the user saves an edit through the editor; built-in scripts
   *  with this flag are never overwritten by bundled version updates. */
  edited?: boolean;
}

export type GMSerializable =
  | string
  | number
  | boolean
  | null
  | GMSerializable[]
  | { [key: string]: GMSerializable };

// Everything the preload needs to run one script. Matched + filtered in main.
export interface SnapshotScript {
  id: string;
  runAt: RunAt;
  source: string;
  info?: {
    name: string;
    namespace: string;
    version: string;
    description: string;
    grant: string[];
    noframes: boolean;
    rawHeader: string;
  };
}

// Frame-scoped snapshot returned by the sync document-start query.
export interface FrameSnapshot {
  ok: boolean;
  mode?: 'ppapi' | 'ruffle';
  generation?: number;
  token?: string;
  scripts: SnapshotScript[];
  values: Record<string, Record<string, GMSerializable>>;
  resources?: Record<string, Record<string, { text: string; url: string }>>;
}

// Unique identity of one script run inside one document.
export interface UserscriptExecutionKey {
  scriptId: string;
  webContentsId: number;
  frameId: number;
  documentId: string;
}

export interface UserscriptReport {
  documentId: string;
  frameUrl: string;
  isMainFrame: boolean;
  mode?: 'ppapi' | 'ruffle';
  generation?: number;
  scriptId?: string;
  phase: string;
  ok?: boolean;
  detail?: unknown;
}

export interface ScriptCommand {
  commandId: string;
  scriptId: string;
  documentId: string;
  title: string;
  isMainFrame: boolean;
}
