import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  AutomationPackageV3Error,
  loadAutomationPackageV3,
  serializeAutomationPackageV3,
} from '../src/main/modules/automation/package-v3';
import { listAutomationFrontendEntries, type AutomationPackageV3 } from '../src/shared/automation/package-v3';

const source = (): AutomationPackageV3 => ({
  manifest: {
    format: 'baoauto',
    formatVersion: 3,
    id: 'commerce-demo',
    name: 'Commerce demo',
    frontends: {
      mainEntryId: 'trade',
      workflow: 'workflow.json',
      scripts: [{ id: 'trade', name: 'Trade', path: 'scripts/trade.ts', language: 'typescript', permissions: ['vision', 'ocr', 'input'] }],
    },
    features: [],
    integrity: {},
  },
  workflow: {
    formatVersion: 3,
    id: 'commerce-workflow',
    name: 'Commerce workflow',
    root: {
      id: 'root',
      kind: 'action',
      action: { kind: 'click', target: { locator: { kind: 'coordinate', point: { unit: 'ratio', x: 0.5, y: 0.5 } } } },
    },
  },
  scripts: new Map([['scripts/trade.ts', 'await bao.log.info("trade");']]),
  assets: new Map([['assets/buy.png', new Uint8Array([1, 2, 3])]]),
  profiles: new Map([['profiles/default.json', { id: 'default', name: 'Default', entryId: 'trade', variables: { threshold: 100 } }]]),
});

function expectCode(operation: () => unknown, code: AutomationPackageV3Error['code']): void {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(AutomationPackageV3Error);
    expect((error as AutomationPackageV3Error).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('.baoauto v3 package', () => {
  it('round-trips coexisting workflow, JavaScript, assets and profiles', () => {
    const loaded = loadAutomationPackageV3(serializeAutomationPackageV3(source()));
    expect(loaded.manifest.features).toEqual(['workflow', 'javascript', 'assets', 'profiles']);
    expect(loaded.workflow?.id).toBe('commerce-workflow');
    expect(loaded.manifest.frontends.mainEntryId).toBe('trade');
    expect(loaded.manifest.frontends.scripts[0].language).toBe('typescript');
    expect(loaded.scripts.get('scripts/trade.ts')).toContain('bao.log.info');
    expect([...loaded.assets.get('assets/buy.png') ?? []]).toEqual([1, 2, 3]);
    expect(loaded.profiles.get('profiles/default.json')?.entryId).toBe('trade');
    expect(listAutomationFrontendEntries(loaded).map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 'workflow', kind: 'blockly' },
      { id: 'trade', kind: 'javascript' },
    ]);
  });

  it('rejects every pre-v3 archive without migration', () => {
    const archive = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'baoauto', formatVersion: 2, id: 'old', name: 'Old' })),
    });
    expectCode(() => loadAutomationPackageV3(archive), 'UNSUPPORTED_FORMAT');
  });

  it('detects integrity tampering', () => {
    const archive = unzipSync(serializeAutomationPackageV3(source()));
    archive['scripts/trade.ts'] = strToU8('tampered');
    expectCode(() => loadAutomationPackageV3(zipSync(archive)), 'INTEGRITY_MISMATCH');
  });

  it('rejects undeclared content and inconsistent feature declarations', () => {
    const archive = unzipSync(serializeAutomationPackageV3(source()));
    const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json'])) as Record<string, unknown>;
    archive['unknown.bin'] = new Uint8Array([9]);
    const integrity = manifest.integrity as Record<string, string>;
    integrity['unknown.bin'] = '2b4c342f5433ebe591a1da77e013d1b72475562d48578dca8b84bac6651c3cb9';
    archive['manifest.json'] = strToU8(JSON.stringify(manifest));
    expectCode(() => loadAutomationPackageV3(zipSync(archive)), 'PACKAGE_INVALID');

    const clean = unzipSync(serializeAutomationPackageV3(source()));
    const cleanManifest = JSON.parse(new TextDecoder().decode(clean['manifest.json'])) as { features: string[] };
    cleanManifest.features = ['workflow'];
    clean['manifest.json'] = strToU8(JSON.stringify(cleanManifest));
    expectCode(() => loadAutomationPackageV3(zipSync(clean)), 'PACKAGE_INVALID');
  });

  it('enforces archive and expanded entry limits', () => {
    const bytes = serializeAutomationPackageV3(source());
    expectCode(() => loadAutomationPackageV3(bytes, { maxArchiveBytes: bytes.byteLength - 1 }), 'LIMIT_EXCEEDED');
    expectCode(() => loadAutomationPackageV3(bytes, { maxEntryBytes: 1 }), 'LIMIT_EXCEEDED');
  });

  it('validates profile Surface bindings during package loading', () => {
    const invalid = source();
    invalid.profiles.set('profiles/bad.json', { id: 'bad', name: 'Bad', entryId: 'workflow', surfaces: { game: { kind: 'region', parent: { kind: 'viewport' }, region: { unit: 'ratio', x: 0, y: 0, width: 2, height: 1 } } } });
    expectCode(() => loadAutomationPackageV3(serializeAutomationPackageV3(invalid)), 'PACKAGE_INVALID');
  });
});
