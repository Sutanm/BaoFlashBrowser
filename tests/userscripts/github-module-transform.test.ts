import { describe, it, expect } from 'vitest';
import { parseGitHubImportMap, isGitHubModuleUrl, githubModuleUrl, decodeGitHubModuleUrl, transformGitHubModule } from '@main/modules/github-module-transform';

const id = '0123456789abcdef';
const base = 'https://github.githubassets.com/assets/entry-abcd.js';
const imports = { react: 'https://github.githubassets.com/assets/react-1234.js' };

describe('GitHub module compatibility', () => {
  it('accepts only bounded public GitHub asset maps', () => {
    expect(parseGitHubImportMap(JSON.stringify({ imports }))).toEqual(imports);
    for (const url of ['http://github.githubassets.com/assets/a.js', 'https://github.githubassets.com.evil.test/assets/a.js', 'https://github.githubassets.com/assets/a.js?token=x', 'https://127.0.0.1/a.js']) {
      expect(isGitHubModuleUrl(url)).toBe(false);
      expect(parseGitHubImportMap(JSON.stringify({ imports: { react: url } }))).toBeNull();
    }
  });
  it('keeps module URLs canonical and map-specific', () => {
    expect(decodeGitHubModuleUrl(githubModuleUrl(base, id))).toEqual({ source: base, mapId: id });
    expect(decodeGitHubModuleUrl(`bfb-github-module://module/${id}/x.js?src=https://evil.test`)).toBeNull();
  });
  it('resolves static imports, exports and dynamic imports without changing literal strings', async () => {
    const source = 'import {x} from "react"; export * from "./shared.js"; const name="./lazy.js"; import(name); const message="import react"; const asset=new URL("image.png",import.meta.url); class X { static { this.x=1; } }';
    const out = await transformGitHubModule(source, base, id, imports);
    expect(out).toContain(imports.react);
    expect(out).toContain('https://github.githubassets.com/assets/shared.js');
    expect(out).toContain(`import(__bfModuleURL_${id}(name))`);
    expect(out).toContain('"import react"');
    expect(out).toContain(JSON.stringify(base));
    expect(out).not.toContain('static {');
  });
});
