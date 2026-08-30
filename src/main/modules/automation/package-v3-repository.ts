import fs from 'fs';
import path from 'path';
import type { AutomationPackageV3 } from '../../../shared/automation/package-v3';
import { loadAutomationPackageV3, serializeAutomationPackageV3 } from './package-v3';

export type AutomationPackageV3Summary = {
  readonly packageId: string;
  readonly name: string;
  readonly mainEntryId: string;
  readonly frontends: readonly { readonly id: string; readonly kind: 'blockly' | 'javascript'; readonly name: string }[];
  readonly assets: readonly string[];
  readonly profiles: readonly string[];
};

type RepositoryEntry = { readonly filePath: string; source: AutomationPackageV3 };

function safeId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) throw new Error('automation package id is invalid');
  return id;
}

function summary(source: AutomationPackageV3): AutomationPackageV3Summary {
  return {
    packageId: source.manifest.id,
    name: source.manifest.name,
    mainEntryId: source.manifest.frontends.mainEntryId ?? (source.workflow ? 'workflow' : source.manifest.frontends.scripts[0]?.id ?? ''),
    frontends: [
      ...(source.workflow ? [{ id: 'workflow', kind: 'blockly' as const, name: source.workflow.name }] : []),
      ...source.manifest.frontends.scripts.map((entry) => ({ id: entry.id, kind: 'javascript' as const, name: entry.name })),
    ],
    assets: [...source.assets.keys()].sort(),
    profiles: [...source.profiles.keys()].sort(),
  };
}

/** Durable v3-only repository. Existing pre-v3 files are never migrated or rewritten. */
export class AutomationPackageV3Repository {
  private readonly entries = new Map<string, RepositoryEntry>();

  constructor(
    private readonly storageDir: string,
    private readonly onRejectedFile: (filePath: string, error: Error) => void = () => undefined,
  ) {}

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.storageDir, { recursive: true });
    const names = await fs.promises.readdir(this.storageDir);
    for (const name of names.filter((item) => item.endsWith('.baoauto')).sort()) {
      const filePath = path.join(this.storageDir, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) continue;
        const source = loadAutomationPackageV3(new Uint8Array(await fs.promises.readFile(filePath)));
        if (this.entries.has(source.manifest.id)) throw new Error(`duplicate automation package id: ${source.manifest.id}`);
        this.entries.set(source.manifest.id, { filePath, source });
      } catch (error) {
        this.onRejectedFile(filePath, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  list(): readonly AutomationPackageV3Summary[] { return [...this.entries.values()].map((entry) => summary(entry.source)); }

  get(packageId: string): AutomationPackageV3 {
    const entry = this.entries.get(packageId);
    if (!entry) throw new Error(`automation package is not installed: ${packageId}`);
    return entry.source;
  }

  export(packageId: string): Uint8Array { return serializeAutomationPackageV3(this.get(packageId)); }

  async install(bytes: Uint8Array, replace = false): Promise<AutomationPackageV3Summary> {
    const source = loadAutomationPackageV3(bytes);
    const packageId = safeId(source.manifest.id);
    const existing = this.entries.get(packageId);
    if (existing && !replace) throw new Error(`automation package already exists: ${packageId}`);
    const filePath = path.join(this.storageDir, `${packageId}.baoauto`);
    await this.atomicWrite(filePath, serializeAutomationPackageV3(source));
    this.entries.set(packageId, { filePath, source });
    return summary(source);
  }

  async save(source: AutomationPackageV3): Promise<AutomationPackageV3Summary> {
    const packageId = safeId(source.manifest.id);
    const existing = this.entries.get(packageId);
    if (!existing) throw new Error(`automation package is not installed: ${packageId}`);
    const bytes = serializeAutomationPackageV3(source);
    await this.atomicWrite(existing.filePath, bytes);
    existing.source = loadAutomationPackageV3(bytes);
    return summary(existing.source);
  }

  async remove(packageId: string): Promise<void> {
    const entry = this.entries.get(packageId);
    if (!entry) return;
    await fs.promises.unlink(entry.filePath);
    this.entries.delete(packageId);
  }

  private async atomicWrite(filePath: string, bytes: Uint8Array): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(tempPath, Buffer.from(bytes), { flag: 'wx' });
      await fs.promises.rename(tempPath, filePath);
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}
