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
  /** @background: script runs in the persistent hidden background window,
   *  never URL-matched into tab frames. */
  background: boolean;
  require: string[];
  resource: UserscriptResource[];
  /** Content hash written by build-css-fixer.mjs; used by
   *  ensureBundledScripts to detect built-in updates without a manual
   *  @version bump. Empty when the source has no @updateHash field. */
  updateHash?: string;
  /** @updateURL: manual update check source (JSON manifest or script body). */
  updateUrl?: string;
  /** @downloadURL: direct install source (advertised only, not fetched). */
  downloadUrl?: string;
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
  /** Set when the command comes from the @background runtime. */
  background?: boolean;
}

/** One pending @updateURL update reported by checkUpdates. */
export interface UserscriptUpdateInfo {
  id: string;
  name: string;
  currentVersion: string;
  latestVersion: string;
  updateUrl: string;
}

/** Read-only cookie view exposed via GM_cookie (list/get only, no set/delete). */
export interface GmCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  session: boolean;
}

/** Observation-only webRequest event (GM_webRequest never intercepts). */
export interface GmWebRequestEvent {
  phase: 'before-request' | 'completed' | 'error-occurred';
  /** Redacted URL (query string stripped, per diagnostic-redaction). */
  url: string;
  method: string;
  statusCode?: number;
  error?: string;
}
