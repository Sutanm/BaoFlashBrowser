import crypto from 'crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { validateWorkflowDocument } from '../../../shared/automation/core/workflow-validator';
import { validateSurfaceSpec } from '../../../shared/automation/core/surface';
import { JAVASCRIPT_AUTOMATION_CAPABILITIES } from '../../../shared/automation/javascript-grants';
import type {
  AutomationPackageManifestV3,
  AutomationPackageV3,
  AutomationProfileV3,
  AutomationV3ScriptEntry,
} from '../../../shared/automation/package-v3';

export class AutomationPackageV3Error extends Error {
  constructor(readonly code: 'UNSUPPORTED_FORMAT' | 'PACKAGE_INVALID' | 'PATH_INVALID' | 'LIMIT_EXCEEDED' | 'INTEGRITY_MISMATCH', message: string) {
    super(message);
    this.name = 'AutomationPackageV3Error';
  }
}

export type AutomationPackageV3Limits = {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
};

export const DEFAULT_AUTOMATION_PACKAGE_V3_LIMITS: AutomationPackageV3Limits = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 2_000,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function safePath(value: string): boolean {
  return value.length > 0 && value.length <= 500 && !value.includes('\\') && !value.includes(':') && !value.startsWith('/')
    && value.split('/').every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}

function sha256(bytes: Uint8Array): string { return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'); }

function json(bytes: Uint8Array, label: string): unknown {
  try { return JSON.parse(strFromU8(bytes)); }
  catch { throw new AutomationPackageV3Error('PACKAGE_INVALID', `${label} is not valid JSON`); }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationPackageV3Error('PACKAGE_INVALID', `${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseScript(value: unknown): AutomationV3ScriptEntry {
  const entry = object(value, 'script entry');
  if (!ID.test(String(entry.id)) || typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.path !== 'string'
    || !entry.path.startsWith('scripts/') || !/\.(?:js|ts)$/u.test(entry.path) || !safePath(entry.path)) throw new AutomationPackageV3Error('PACKAGE_INVALID', 'script entry is invalid');
  if (!Array.isArray(entry.permissions) || entry.permissions.some((permission) => !JAVASCRIPT_AUTOMATION_CAPABILITIES.includes(permission as never))) throw new AutomationPackageV3Error('PACKAGE_INVALID', `script permissions are invalid: ${entry.id}`);
  const language = entry.language === 'typescript' || entry.path.endsWith('.ts') ? 'typescript' : 'javascript';
  return { id: String(entry.id), name: entry.name, path: entry.path as AutomationV3ScriptEntry['path'], language, permissions: [...new Set(entry.permissions)] as AutomationV3ScriptEntry['permissions'] };
}

export function parseAutomationPackageManifestV3(value: unknown): AutomationPackageManifestV3 {
  const manifest = object(value, 'manifest');
  if (manifest.format !== 'baoauto' || manifest.formatVersion !== 3) throw new AutomationPackageV3Error('UNSUPPORTED_FORMAT', 'only .baoauto formatVersion 3 is supported');
  if (!ID.test(String(manifest.id)) || typeof manifest.name !== 'string' || !manifest.name.trim()) throw new AutomationPackageV3Error('PACKAGE_INVALID', 'manifest id/name is invalid');
  const frontends = object(manifest.frontends, 'manifest frontends');
  if (frontends.workflow !== undefined && frontends.workflow !== 'workflow.json') throw new AutomationPackageV3Error('PACKAGE_INVALID', 'workflow entry must be workflow.json');
  if (!Array.isArray(frontends.scripts)) throw new AutomationPackageV3Error('PACKAGE_INVALID', 'manifest scripts must be an array');
  const scripts = frontends.scripts.map(parseScript);
  if (new Set(scripts.map((entry) => entry.id)).size !== scripts.length || new Set(scripts.map((entry) => entry.path)).size !== scripts.length) throw new AutomationPackageV3Error('PACKAGE_INVALID', 'script ids and paths must be unique');
  if (!frontends.workflow && scripts.length === 0) throw new AutomationPackageV3Error('PACKAGE_INVALID', 'package requires a workflow or JavaScript entry');
  const mainEntryId = typeof frontends.mainEntryId === 'string' ? frontends.mainEntryId : frontends.workflow ? 'workflow' : scripts[0]?.id;
  if (!mainEntryId || (mainEntryId !== 'workflow' && !scripts.some((entry) => entry.id === mainEntryId)) || (mainEntryId === 'workflow' && !frontends.workflow)) throw new AutomationPackageV3Error('PACKAGE_INVALID', 'manifest main entry is invalid');
  if (!Array.isArray(manifest.features) || manifest.features.some((feature) => !['workflow', 'javascript', 'assets', 'profiles'].includes(String(feature)))) throw new AutomationPackageV3Error('PACKAGE_INVALID', 'manifest features are invalid');
  const integrity = object(manifest.integrity, 'manifest integrity');
  for (const [entryPath, digest] of Object.entries(integrity)) if (!safePath(entryPath) || typeof digest !== 'string' || !HASH.test(digest)) throw new AutomationPackageV3Error('PACKAGE_INVALID', `invalid integrity entry: ${entryPath}`);
  return {
    format: 'baoauto', formatVersion: 3, id: String(manifest.id), name: manifest.name,
    description: typeof manifest.description === 'string' ? manifest.description : undefined,
    frontends: { workflow: frontends.workflow as 'workflow.json' | undefined, scripts, mainEntryId },
    features: [...new Set(manifest.features)] as AutomationPackageManifestV3['features'], integrity: integrity as Record<string, string>,
  };
}

function parseProfile(value: unknown, path: string): AutomationProfileV3 {
  const profile = object(value, path);
  if (!ID.test(String(profile.id)) || typeof profile.name !== 'string' || !profile.name.trim() || typeof profile.entryId !== 'string') throw new AutomationPackageV3Error('PACKAGE_INVALID', `profile is invalid: ${path}`);
  if (profile.variables !== undefined) {
    const variables = object(profile.variables, `${path} variables`);
    for (const [name, variable] of Object.entries(variables)) {
      if (!ID.test(name) || (variable !== null && !['boolean', 'number', 'string'].includes(typeof variable))) throw new AutomationPackageV3Error('PACKAGE_INVALID', `profile variable is invalid: ${path}#${name}`);
    }
  }
  if (profile.surfaces !== undefined) {
    const surfaces = object(profile.surfaces, `${path} surfaces`);
    for (const [name, surface] of Object.entries(surfaces)) {
      if (!ID.test(name)) throw new AutomationPackageV3Error('PACKAGE_INVALID', `profile surface name is invalid: ${path}#${name}`);
      try { validateSurfaceSpec(surface as never, { allowUnresolvedNamed: true }); }
      catch (error) { throw new AutomationPackageV3Error('PACKAGE_INVALID', `profile surface is invalid: ${path}#${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  return {
    id: String(profile.id),
    name: profile.name,
    entryId: profile.entryId,
    variables: profile.variables as AutomationProfileV3['variables'],
    surfaces: profile.surfaces as AutomationProfileV3['surfaces'],
  };
}

function featureSet(source: { workflow?: unknown; scripts: ReadonlyMap<string, string>; assets: ReadonlyMap<string, Uint8Array>; profiles: ReadonlyMap<string, AutomationProfileV3> }): AutomationPackageManifestV3['features'] {
  return [
    ...(source.workflow ? ['workflow' as const] : []),
    ...(source.scripts.size ? ['javascript' as const] : []),
    ...(source.assets.size ? ['assets' as const] : []),
    ...(source.profiles.size ? ['profiles' as const] : []),
  ];
}

function assertFeatures(actual: readonly string[], expected: readonly string[]): void {
  if (actual.length !== expected.length || actual.some((feature) => !expected.includes(feature))) {
    throw new AutomationPackageV3Error('PACKAGE_INVALID', `manifest features do not match package content; expected: ${expected.join(', ')}`);
  }
}

function archiveEntries(source: AutomationPackageV3): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  if (source.workflow) { validateWorkflowDocument(source.workflow); entries['workflow.json'] = strToU8(JSON.stringify(source.workflow, null, 2)); }
  for (const script of source.manifest.frontends.scripts) {
    const code = source.scripts.get(script.path);
    if (code === undefined) throw new AutomationPackageV3Error('PACKAGE_INVALID', `script content is missing: ${script.path}`);
    entries[script.path] = strToU8(code);
  }
  for (const [entryPath, bytes] of source.assets) {
    if (!entryPath.startsWith('assets/') || !safePath(entryPath)) throw new AutomationPackageV3Error('PATH_INVALID', `invalid asset path: ${entryPath}`);
    entries[entryPath] = bytes;
  }
  for (const [entryPath, profile] of source.profiles) {
    if (!entryPath.startsWith('profiles/') || !entryPath.endsWith('.json') || !safePath(entryPath)) throw new AutomationPackageV3Error('PATH_INVALID', `invalid profile path: ${entryPath}`);
    entries[entryPath] = strToU8(JSON.stringify(profile, null, 2));
  }
  return entries;
}

export function serializeAutomationPackageV3(source: AutomationPackageV3): Uint8Array {
  const content = archiveEntries(source);
  const integrity = Object.fromEntries(Object.entries(content).map(([entryPath, bytes]) => [entryPath, sha256(bytes)]));
  const manifest = parseAutomationPackageManifestV3({ ...source.manifest, features: featureSet(source), integrity });
  content['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(content, { level: 6 });
}

export function loadAutomationPackageV3(bytes: Uint8Array, customLimits: Partial<AutomationPackageV3Limits> = {}): AutomationPackageV3 {
  const limits = { ...DEFAULT_AUTOMATION_PACKAGE_V3_LIMITS, ...customLimits };
  if (bytes.byteLength > limits.maxArchiveBytes) throw new AutomationPackageV3Error('LIMIT_EXCEEDED', 'automation archive byte limit exceeded');
  let archive: Record<string, Uint8Array>;
  try { archive = unzipSync(bytes); } catch { throw new AutomationPackageV3Error('PACKAGE_INVALID', 'automation package is not a valid ZIP archive'); }
  const entries = Object.entries(archive);
  if (entries.length > limits.maxEntries) throw new AutomationPackageV3Error('LIMIT_EXCEEDED', 'automation package entry limit exceeded');
  let total = 0;
  for (const [entryPath, content] of entries) {
    if (!safePath(entryPath)) throw new AutomationPackageV3Error('PATH_INVALID', `unsafe package path: ${entryPath}`);
    if (content.byteLength > limits.maxEntryBytes) throw new AutomationPackageV3Error('LIMIT_EXCEEDED', `package entry is too large: ${entryPath}`);
    total += content.byteLength;
  }
  if (total > limits.maxTotalBytes) throw new AutomationPackageV3Error('LIMIT_EXCEEDED', 'automation package expanded byte limit exceeded');
  const manifestBytes = archive['manifest.json'];
  if (!manifestBytes) throw new AutomationPackageV3Error('PACKAGE_INVALID', 'package is missing manifest.json');
  const manifest = parseAutomationPackageManifestV3(json(manifestBytes, 'manifest.json'));
  for (const [entryPath, digest] of Object.entries(manifest.integrity)) {
    const content = archive[entryPath];
    if (!content || sha256(content) !== digest) throw new AutomationPackageV3Error('INTEGRITY_MISMATCH', `integrity mismatch: ${entryPath}`);
  }
  const contentPaths = entries.map(([entryPath]) => entryPath).filter((entryPath) => entryPath !== 'manifest.json');
  if (contentPaths.some((entryPath) => !(entryPath in manifest.integrity)) || Object.keys(manifest.integrity).some((entryPath) => !archive[entryPath])) throw new AutomationPackageV3Error('INTEGRITY_MISMATCH', 'manifest integrity must cover every package content entry');

  let workflow;
  if (manifest.frontends.workflow) {
    const workflowBytes = archive[manifest.frontends.workflow];
    if (!workflowBytes) throw new AutomationPackageV3Error('PACKAGE_INVALID', 'workflow entry is missing');
    workflow = json(workflowBytes, 'workflow.json') as AutomationPackageV3['workflow'];
    validateWorkflowDocument(workflow!);
  }
  const scripts = new Map<string, string>();
  for (const entry of manifest.frontends.scripts) {
    const content = archive[entry.path];
    if (!content) throw new AutomationPackageV3Error('PACKAGE_INVALID', `script entry is missing: ${entry.path}`);
    scripts.set(entry.path, strFromU8(content));
  }
  const assets = new Map(entries.filter(([entryPath]) => entryPath.startsWith('assets/')));
  const profiles = new Map<string, AutomationProfileV3>();
  for (const [entryPath, content] of entries) if (entryPath.startsWith('profiles/')) profiles.set(entryPath, parseProfile(json(content, entryPath), entryPath));
  for (const profile of profiles.values()) {
    const validEntries = new Set(['workflow', ...manifest.frontends.scripts.map((entry) => entry.id)]);
    if (!validEntries.has(profile.entryId)) throw new AutomationPackageV3Error('PACKAGE_INVALID', `profile references an unknown frontend: ${profile.entryId}`);
  }
  const declaredPaths = new Set([
    'manifest.json',
    ...(manifest.frontends.workflow ? [manifest.frontends.workflow] : []),
    ...manifest.frontends.scripts.map((entry) => entry.path),
    ...assets.keys(),
    ...profiles.keys(),
  ]);
  const unknownPath = entries.find(([entryPath]) => !declaredPaths.has(entryPath))?.[0];
  if (unknownPath) throw new AutomationPackageV3Error('PACKAGE_INVALID', `package contains an undeclared entry: ${unknownPath}`);
  assertFeatures(manifest.features, featureSet({ workflow, scripts, assets, profiles }));
  return Object.freeze({ manifest, workflow, scripts, assets, profiles });
}
