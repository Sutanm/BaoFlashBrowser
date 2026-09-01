import fs from 'fs';
import path from 'path';
import { JAVASCRIPT_AUTOMATION_CAPABILITIES } from '../../../shared/automation/javascript-grants';
import type { JavaScriptAutomationCapability } from '../../../shared/automation/javascript-api';

type StoredGrants = Record<string, Record<string, JavaScriptAutomationCapability[]>>;

export class JavaScriptAutomationGrantStore {
  private grants: StoredGrants = {};
  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8')) as StoredGrants;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('grant store root is invalid');
      this.grants = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.grants = {};
    }
  }

  get(packageId: string, entryId: string): readonly JavaScriptAutomationCapability[] {
    const values = this.grants[packageId]?.[entryId] ?? [];
    return values.filter((value) => JAVASCRIPT_AUTOMATION_CAPABILITIES.includes(value));
  }

  async approve(packageId: string, entryId: string, requested: readonly JavaScriptAutomationCapability[], approved: readonly JavaScriptAutomationCapability[]): Promise<void> {
    const requestSet = new Set(requested);
    if (approved.some((value) => !requestSet.has(value))) throw new Error(`install grant exceeds requested permissions: ${entryId}`);
    this.grants = { ...this.grants, [packageId]: { ...(this.grants[packageId] ?? {}), [entryId]: [...new Set(approved)] } };
    await this.persist();
  }

  async remove(packageId: string): Promise<void> {
    const next = { ...this.grants };
    delete next[packageId];
    this.grants = next;
    await this.persist();
  }

  async removeEntry(packageId: string, entryId: string): Promise<void> {
    const packageGrants = this.grants[packageId];
    if (!packageGrants || !(entryId in packageGrants)) return;
    const nextPackageGrants = { ...packageGrants };
    delete nextPackageGrants[entryId];
    const next = { ...this.grants };
    if (Object.keys(nextPackageGrants).length) next[packageId] = nextPackageGrants;
    else delete next[packageId];
    this.grants = next;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(this.filePath, JSON.stringify(this.grants, null, 2));
  }
}
