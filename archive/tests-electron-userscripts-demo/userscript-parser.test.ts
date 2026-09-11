import { describe, expect, it } from 'vitest';
import { parseUserscriptMetadata } from './userscript-parser';

const HEADER_START = '==UserScript==';
const HEADER_END = '==/UserScript==';

describe('userscript-parser', () => {
  it('parses scalar metadata fields', () => {
    const source = [
      '// ==UserScript==',
      '// @name        Demo Script',
      '// @namespace   https://demo.local/ns',
      '// @version     1.2.3',
      '// @description  Fixes old game page',
      '// @run-at      document-idle',
      '// ==/UserScript==',
      'console.log("body");',
    ].join('\n');
    const meta = parseUserscriptMetadata(source);
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe('Demo Script');
    expect(meta!.namespace).toBe('https://demo.local/ns');
    expect(meta!.version).toBe('1.2.3');
    expect(meta!.description).toBe('Fixes old game page');
    expect(meta!.runAt).toBe('document-idle');
  });

  it('parses @updateHash and leaves it empty when absent', () => {
    const withHash = parseUserscriptMetadata([
      '// ==UserScript==',
      '// @name  Fixer',
      '// @version 0.5.7',
      '// @updateHash dbec8f180460',
      '// ==/UserScript==',
    ].join('\n'));
    expect(withHash!.updateHash).toBe('dbec8f180460');

    const without = parseUserscriptMetadata('// ==UserScript==\n// @name  Plain\n// ==/UserScript==\n');
    expect(without!.updateHash).toBeUndefined();
  });

  it('accumulates repeated list keys', () => {
    const source = [
      `// ${HEADER_START}`,
      '// @name  Listy',
      '// @match https://a.example/*',
      '// @match https://b.example/*',
      '// @grant GM_getValue',
      '// @grant GM_setValue',
      '// @connect api.a.example',
      '// @connect api.b.example',
      `// ${HEADER_END}`,
    ].join('\n');
    const meta = parseUserscriptMetadata(source);
    expect(meta!.match).toEqual(['https://a.example/*', 'https://b.example/*']);
    expect(meta!.grant).toEqual(['GM_getValue', 'GM_setValue']);
    expect(meta!.connect).toEqual(['api.a.example', 'api.b.example']);
  });

  it('parses @resource into name and url pairs', () => {
    const source = [
      `// ${HEADER_START}`,
      '// @name  Res',
      '// @resource icons https://cdn.example/icons.zip',
      `// ${HEADER_END}`,
    ].join('\n');
    const meta = parseUserscriptMetadata(source);
    expect(meta!.resource).toEqual([{ name: 'icons', url: 'https://cdn.example/icons.zip' }]);
  });

  it('keeps the primary name when localized names are present', () => {
    const source = [
      `// ${HEADER_START}`,
      '// @name        Game Helper',
      '// @name:zh-CN  游戏助手',
      '// @description English desc',
      '// @description:zh-CN 中文描述',
      `// ${HEADER_END}`,
    ].join('\n');
    const meta = parseUserscriptMetadata(source);
    expect(meta!.name).toBe('Game Helper');
    expect(meta!.description).toBe('English desc');
  });

  it('defaults run-at to document-end and handles @noframes', () => {
    const withFlag = parseUserscriptMetadata(`// ==UserScript==\n// @name  NoFrames\n// @noframes\n// ==/UserScript==\n`);
    expect(withFlag!.runAt).toBe('document-end');
    expect(withFlag!.noframes).toBe(true);
    const without = parseUserscriptMetadata(`// ==UserScript==\n// @name  Plain\n// ==/UserScript==\n`);
    expect(without!.noframes).toBe(false);
  });

  it('separates @exclude and @exclude-match', () => {
    const meta = parseUserscriptMetadata([
      `// ${HEADER_START}`,
      '// @name  Ex',
      '// @exclude http://no.example/*',
      '// @exclude-match https://skip.example/private/*',
      `// ${HEADER_END}`,
    ].join('\n'));
    expect(meta!.exclude).toEqual(['http://no.example/*']);
    expect(meta!.excludeMatch).toEqual(['https://skip.example/private/*']);
  });

  it('tolerates CRLF, leading whitespace and BOM', () => {
    const source = '\uFEFF\r\n  // ==UserScript==\r\n  // @name  Crlf\r\n  // ==/UserScript==\r\nbody();';
    const meta = parseUserscriptMetadata(source);
    expect(meta!.name).toBe('Crlf');
  });

  it('ignores @grant none tokens', () => {
    const meta = parseUserscriptMetadata([
      `// ${HEADER_START}`,
      '// @name  NoneGrant',
      '// @grant none',
      '// @grant GM_addStyle',
      `// ${HEADER_END}`,
    ].join('\n'));
    expect(meta!.grant).toEqual(['GM_addStyle']);
  });

  it('parses @require as a list', () => {
    const meta = parseUserscriptMetadata([
      `// ${HEADER_START}`,
      '// @name  Req',
      '// @require https://cdn.example/lib-a.js',
      '// @require https://cdn.example/lib-b.js',
      `// ${HEADER_END}`,
    ].join('\n'));
    expect(meta!.require).toEqual([
      'https://cdn.example/lib-a.js',
      'https://cdn.example/lib-b.js',
    ]);
  });

  it('returns null when the header is missing', () => {
    expect(parseUserscriptMetadata('console.log("no header");')).toBeNull();
  });

  it('keeps the raw header text', () => {
    const header = ['// ==UserScript==', '// @name  Raw', '// ==/UserScript=='].join('\n');
    const meta = parseUserscriptMetadata(header + '\ncode();');
    expect(meta!.rawHeader).toContain('// @name  Raw');
  });
});
