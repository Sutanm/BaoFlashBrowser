import fs from 'fs';
import path from 'path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  collectWorkflowAssetIds,
  parseAutomationPackageManifest,
  parseAutomationWorkflow,
} from '../../../shared/automation/schema';
import type {
  AutomationCapability,
  AutomationPackageManifest,
  AutomationWorkflow,
} from '../../../shared/automation/types';
import { scanAutomationAssets } from './assets';

const MAX_PACKAGE_FILES = 1200;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const IMAGE_ASSET_PATTERN = /\.(?:png|jpe?g|webp)$/i;

export type LoadedAutomationPackage = {
  manifest: AutomationPackageManifest;
  workflow: AutomationWorkflow;
  assets: Map<string, Uint8Array>;
};

export function inferAutomationCapabilities(workflow: AutomationWorkflow): AutomationCapability[] {
  const result = new Set<AutomationCapability>();
  const visitCondition = (condition: import('../../../shared/automation/types').AutomationCondition): void => {
    if (condition.type === 'image-visible') {
      result.add('vision');
      if (condition.alternatives?.length) result.add('image-groups');
      if (condition.mask === 'alpha' || condition.mask === 'auto') result.add('alpha-mask');
      if (condition.scales && condition.scales.length > 1) result.add('multi-scale');
    } else if (condition.type === 'not') { result.add('combined-conditions'); visitCondition(condition.condition); }
    else { result.add('combined-conditions'); condition.conditions.forEach(visitCondition); }
  };
  const visit = (step: import('../../../shared/automation/types').AutomationStep): void => {
    if ('asset' in step && typeof step.asset === 'string') result.add('vision');
    if ('alternatives' in step && step.alternatives?.length) result.add('image-groups');
    if ('mask' in step && (step.mask === 'alpha' || step.mask === 'auto')) result.add('alpha-mask');
    if ('scales' in step && step.scales && step.scales.length > 1) result.add('multi-scale');
    if (['click-image', 'move-to-image', 'key-press', 'key-hold-until-image', 'text-input', 'scroll'].includes(step.type)) result.add('trusted-input');
    if (step.type === 'navigate' || step.type === 'reload') result.add('navigation');
    if (step.type === 'sequence') step.steps.forEach(visit);
    else if (step.type === 'if-image' || step.type === 'if-condition') { visitCondition(step.condition); visit(step.then); if (step.else) visit(step.else); }
    else if (step.type === 'wait-condition') visitCondition(step.condition);
    else if (step.type === 'repeat' || step.type === 'repeat-until-image' || step.type === 'repeat-until-condition') {
      if ('condition' in step) visitCondition(step.condition); visit(step.body);
    }
  };
  if (workflow.readyWhen) visitCondition(workflow.readyWhen);
  visit(workflow.root);
  return [...result].sort();
}

function migratePackageDocuments(manifestValue: unknown, workflowValue: unknown): { manifest: AutomationPackageManifest; workflow: AutomationWorkflow } {
  const manifestRecord = manifestValue as { formatVersion?: unknown } | null;
  const workflowRecord = workflowValue as { formatVersion?: unknown } | null;
  if (manifestRecord?.formatVersion !== 1 || workflowRecord?.formatVersion !== 1) throw new Error('unsupported automation package format version');
  const workflow = parseAutomationWorkflow(workflowValue);
  const manifest = parseAutomationPackageManifest(manifestValue);
  return { manifest: { ...manifest, capabilities: manifest.capabilities ?? inferAutomationCapabilities(workflow) }, workflow };
}

export function serializeAutomationPackage(
  source: LoadedAutomationPackage,
  workflow: AutomationWorkflow = source.workflow,
): Uint8Array {
  const parsedWorkflow = parseAutomationWorkflow(workflow);
  if (source.manifest.id !== parsedWorkflow.id) throw new Error('manifest and workflow ids do not match');
  assertReferencedAssetsExist(parsedWorkflow, source.assets);
  const archive: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify({ ...source.manifest, name: parsedWorkflow.name, capabilities: inferAutomationCapabilities(parsedWorkflow) }, null, 2)),
    'workflow.json': strToU8(JSON.stringify(parsedWorkflow, null, 2)),
  };
  for (const [asset, content] of source.assets) archive[`${source.manifest.assets}${asset}`] = content;
  return zipSync(archive, { level: 6 });
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSafeArchivePath(value: string): void {
  if (!value || value.includes('\\') || value.startsWith('/') || value.includes('\0')) {
    throw new Error(`unsafe package path: ${value}`);
  }
  if (value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`unsafe package path: ${value}`);
  }
}

function assertReferencedAssetsExist(workflow: AutomationWorkflow, assets: Map<string, Uint8Array>): void {
  const missing = [...collectWorkflowAssetIds(workflow)].filter((id) => !assets.has(id));
  if (missing.length > 0) throw new Error(`workflow references missing assets: ${missing.join(', ')}`);
}

export function loadAutomationPackage(bytes: Uint8Array): LoadedAutomationPackage {
  let fileCount = 0;
  let totalBytes = 0;
  const archive = unzipSync(bytes, { filter: (file) => {
    assertSafeArchivePath(file.name);
    fileCount += 1;
    totalBytes += file.originalSize;
    if (fileCount > MAX_PACKAGE_FILES) throw new Error(`package has more than ${MAX_PACKAGE_FILES} files`);
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('package uncompressed size exceeds 64MB');
    return true;
  } });
  const entries = Object.entries(archive);

  const manifestBytes = archive['manifest.json'];
  const workflowBytes = archive['workflow.json'];
  if (!manifestBytes || !workflowBytes) throw new Error('package must contain manifest.json and workflow.json');
  const { manifest, workflow } = migratePackageDocuments(parseJson(manifestBytes, 'manifest.json'), parseJson(workflowBytes, 'workflow.json'));
  if (manifest.id !== workflow.id) throw new Error('manifest and workflow ids do not match');

  const assets = new Map<string, Uint8Array>();
  for (const [name, content] of entries) {
    if (!name.startsWith(manifest.assets)) continue;
    const id = name.slice(manifest.assets.length);
    if (!id) continue;
    assertSafeArchivePath(id);
    if (!IMAGE_ASSET_PATTERN.test(id)) throw new Error(`unsupported automation asset type: ${id}`);
    assets.set(id, content);
  }
  assertReferencedAssetsExist(workflow, assets);
  return { manifest, workflow, assets };
}

export function createAutomationPackage(projectRoot: string): Uint8Array {
  const resolvedRoot = path.resolve(projectRoot);
  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  const workflowPath = path.join(resolvedRoot, 'workflow.json');
  const { manifest, workflow } = migratePackageDocuments(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    JSON.parse(fs.readFileSync(workflowPath, 'utf8')),
  );
  if (manifest.id !== workflow.id) throw new Error('manifest and workflow ids do not match');

  const assets = scanAutomationAssets(path.join(resolvedRoot, manifest.assets));
  const assetMap = new Map<string, Uint8Array>();
  const archive: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify({ ...manifest, capabilities: inferAutomationCapabilities(workflow) }, null, 2)),
    'workflow.json': strToU8(JSON.stringify(workflow, null, 2)),
  };
  for (const asset of assets) {
    const content = new Uint8Array(fs.readFileSync(asset.absolutePath));
    archive[`${manifest.assets}${asset.id}`] = content;
    assetMap.set(asset.id, content);
  }
  assertReferencedAssetsExist(workflow, assetMap);
  return zipSync(archive, { level: 6 });
}
