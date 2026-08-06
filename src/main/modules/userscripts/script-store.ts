// Userscript script store: persistent script list (source/metadata/enabled).
// Production backend is electron-store (same pattern as config.ts); the
// backend is injectable so CRUD logic is unit-testable without Electron.
// Script VALUES stay in the in-memory ValueStore for now (data management UI
// is a later column).

import Store from 'electron-store';
import type { InstalledUserscript } from '../../../shared/userscript-types';

interface ScriptStoreSchema {
  scripts: InstalledUserscript[];
}

export interface KeyValueBackend {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

const DEFAULT_MAX_SCRIPTS = 200;

export interface ScriptStoreOptions {
  cwd?: string;
  maxScripts?: number;
  backend?: KeyValueBackend;
}

export function scriptIdFor(name: string, namespace: string): string {
  const base = `${namespace || 'local'}:${name}`;
  return base.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120);
}

function electronStoreBackend(cwd?: string): KeyValueBackend {
  const store = new Store<ScriptStoreSchema>({
    name: 'userscripts',
    ...(cwd ? { cwd } : {}),
    defaults: { scripts: [] },
  });
  return {
    get: (key) => store.get(key as 'scripts'),
    set: (key, value) => store.set(key as 'scripts', value as InstalledUserscript[]),
  };
}

export class ScriptStore {
  private readonly backend: KeyValueBackend;
  private readonly maxScripts: number;

  constructor(options?: ScriptStoreOptions) {
    this.backend = options?.backend ?? electronStoreBackend(options?.cwd);
    this.maxScripts = options?.maxScripts ?? DEFAULT_MAX_SCRIPTS;
  }

  list(): InstalledUserscript[] {
    return (this.backend.get('scripts') as InstalledUserscript[] | undefined) ?? [];
  }

  get(id: string): InstalledUserscript | undefined {
    return this.list().find((script) => script.id === id);
  }

  // Inserts or replaces by id. Returns the stored script; throws when the
  // store is full.
  save(script: InstalledUserscript): InstalledUserscript {
    const scripts = this.list();
    const index = scripts.findIndex((existing) => existing.id === script.id);
    if (index >= 0) {
      const merged = [...scripts];
      merged[index] = script;
      this.backend.set('scripts', merged);
      return script;
    }
    if (scripts.length >= this.maxScripts) {
      throw new Error(`script store is full (${this.maxScripts} scripts)`);
    }
    this.backend.set('scripts', [...scripts, script]);
    return script;
  }

  remove(id: string): boolean {
    const scripts = this.list();
    const next = scripts.filter((script) => script.id !== id);
    if (next.length === scripts.length) return false;
    this.backend.set('scripts', next);
    return true;
  }

  clear(): void {
    this.backend.set('scripts', []);
  }
}
