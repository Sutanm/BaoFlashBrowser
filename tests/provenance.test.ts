import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { PROJECT_PROVENANCE, PROVENANCE_SHORT_ID } from '../src/shared/provenance';

describe('project provenance', () => {
  it('has a reproducible origin fingerprint', () => {
    const basis = [
      PROJECT_PROVENANCE.project,
      PROJECT_PROVENANCE.author,
      PROJECT_PROVENANCE.origin,
      String(PROJECT_PROVENANCE.year),
    ].join('\0');
    const digest = crypto.createHash('sha256').update(basis).digest('hex');

    expect(PROJECT_PROVENANCE.fingerprint).toBe(`sha256:${digest}`);
    expect(PROVENANCE_SHORT_ID).toBe(`bfb:${digest.slice(0, 16)}`);
  });

  it('keeps the browser document and package metadata linked to the same origin', () => {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      author?: string;
      homepage?: string;
      repository?: { url?: string };
    };

    expect(html).toContain(`content="${PROVENANCE_SHORT_ID}"`);
    expect(html).toContain(`data-origin="${PROVENANCE_SHORT_ID}"`);
    expect(pkg.author).toBe(PROJECT_PROVENANCE.author);
    expect(pkg.homepage).toBe(PROJECT_PROVENANCE.origin);
    expect(pkg.repository?.url).toBe(`${PROJECT_PROVENANCE.origin}.git`);
  });

  it('travels with independently copied built-in userscripts', () => {
    const root = path.resolve(__dirname, '..');
    const scripts = [path.join(root, 'scripts', 'build-css-fixer.mjs')];

    for (const file of scripts) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).toContain(`// @author       ${PROJECT_PROVENANCE.author}`);
      expect(source).toContain(`// @homepageURL  ${PROJECT_PROVENANCE.origin}`);
      expect(source).toContain(`// @bao-origin   ${PROVENANCE_SHORT_ID}`);
    }
  });
});
