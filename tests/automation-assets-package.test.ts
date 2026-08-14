import fs from 'fs';
import os from 'os';
import path from 'path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { scanAutomationAssets } from '../src/main/modules/automation/assets';
import { createAutomationPackage, inferAutomationCapabilities, loadAutomationPackage, serializeAutomationPackage } from '../src/main/modules/automation/package';

const temporaryRoots: string[] = [];

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoauto-test-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'assets', 'buttons'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'buttons', 'start.png'), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(root, 'assets', 'pages', 'home.webp'), Buffer.from([82, 73, 70, 70]));
  fs.writeFileSync(path.join(root, 'assets', 'ignore.txt'), 'not an image');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    format: 'baoauto', formatVersion: 1, id: 'demo', name: 'Demo',
    workflow: 'workflow.json', assets: 'assets/', createdBy: 'M1 test',
  }));
  fs.writeFileSync(path.join(root, 'workflow.json'), JSON.stringify({
    formatVersion: 1, id: 'demo', name: 'Demo',
    readyWhen: { type: 'image-visible', asset: 'pages/home.webp' },
    root: { type: 'sequence', steps: [{ type: 'click-image', asset: 'buttons/start.png' }] },
  }));
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('automation assets and .baoauto package', () => {
  it('scans nested image assets in stable order', () => {
    const root = makeProject();
    expect(scanAutomationAssets(path.join(root, 'assets')).map((asset) => asset.id)).toEqual([
      'buttons/start.png',
      'pages/home.webp',
    ]);
  });

  it('round-trips manifest, workflow and assets', () => {
    const bytes = createAutomationPackage(makeProject());
    const loaded = loadAutomationPackage(bytes);
    expect(loaded.manifest.id).toBe('demo');
    expect(loaded.workflow.readyWhen?.asset).toBe('pages/home.webp');
    expect([...loaded.assets.keys()].sort()).toEqual(['buttons/start.png', 'pages/home.webp']);
  });

  it('updates workflow metadata while preserving imported assets', () => {
    const loaded = loadAutomationPackage(createAutomationPackage(makeProject()));
    const bytes = serializeAutomationPackage(loaded, { ...loaded.workflow, name: 'Edited Demo' });
    const edited = loadAutomationPackage(bytes);
    expect(edited.workflow.name).toBe('Edited Demo');
    expect(edited.manifest.name).toBe('Edited Demo');
    expect([...edited.assets.keys()].sort()).toEqual(['buttons/start.png', 'pages/home.webp']);
  });

  it('rejects archive path traversal before reading package contents', () => {
    const bytes = zipSync({ '../outside.txt': new Uint8Array([1]) });
    expect(() => loadAutomationPackage(bytes)).toThrow(/unsafe package path/);
  });

  it('rejects workflows that reference a missing asset', () => {
    const root = makeProject();
    fs.rmSync(path.join(root, 'assets', 'buttons', 'start.png'));
    expect(() => createAutomationPackage(root)).toThrow(/missing assets/);
  });

  it('infers package capabilities while loading an older version-1 manifest', () => {
    const workflow = {
      formatVersion: 1 as const, id: 'capabilities', name: 'Capabilities',
      readyWhen: { type: 'all' as const, conditions: [
        { type: 'image-visible' as const, asset: 'a.png', scales: [.75, 1] },
        { type: 'image-visible' as const, asset: 'b.png', mask: 'alpha' as const },
      ] },
      root: { type: 'sequence' as const, steps: [{ type: 'click-image' as const, asset: 'a.png' }, { type: 'navigate' as const, url: 'https://example.com/' }] },
    };
    const expected = ['alpha-mask', 'combined-conditions', 'multi-scale', 'navigation', 'trusted-input', 'vision'];
    expect(inferAutomationCapabilities(workflow)).toEqual(expected);
    const loaded = loadAutomationPackage(zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'baoauto', formatVersion: 1, id: workflow.id, name: workflow.name, workflow: 'workflow.json', assets: 'assets/' })),
      'workflow.json': strToU8(JSON.stringify(workflow)),
      'assets/a.png': new Uint8Array([1]),
      'assets/b.png': new Uint8Array([2]),
    }));
    expect(loaded.manifest.capabilities).toEqual(expected);
  });
});
