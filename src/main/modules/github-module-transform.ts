import { parse } from 'acorn';
import { getJsCompiler } from './js-compiler';

export const GITHUB_MODULE_SCHEME = 'bfb-github-module';
export const GITHUB_ASSET_ORIGIN = 'https://github.githubassets.com';
export type GitHubImportMap = Record<string, string>;

export function isGitHubModuleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === GITHUB_ASSET_ORIGIN && !url.username && !url.password
      && /^\/assets\/[\w.-]+\.js$/.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}

export function parseGitHubImportMap(text: string): GitHubImportMap | null {
  if (text.length > 16384) return null;
  try {
    const imports = JSON.parse(text)?.imports;
    if (!imports || typeof imports !== 'object' || Array.isArray(imports)) return null;
    const entries = Object.entries(imports);
    if (!entries.length || entries.length > 32) return null;
    const result: GitHubImportMap = Object.create(null);
    for (const [name, url] of entries) {
      if (!/^[\w@][\w@./-]{0,100}$/.test(name) || name.startsWith('.') || name.includes('..')
        || typeof url !== 'string' || !isGitHubModuleUrl(url)) return null;
      result[name] = url;
    }
    return result;
  } catch { return null; }
}

export function githubModuleUrl(source: string, mapId: string): string {
  if (!isGitHubModuleUrl(source) || !/^[a-f0-9]{16}$/.test(mapId)) throw new Error('Invalid GitHub module');
  return `${GITHUB_MODULE_SCHEME}://module/${mapId}/${new URL(source).pathname.slice('/assets/'.length)}`;
}

export function decodeGitHubModuleUrl(value: string): { source: string; mapId: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== `${GITHUB_MODULE_SCHEME}:` || url.hostname !== 'module' || url.search || url.hash || url.username || url.password || url.port) return null;
    const match = url.pathname.match(/^\/([a-f0-9]{16})\/([\w.-]+\.js)$/);
    if (!match) return null;
    const source = `${GITHUB_ASSET_ORIGIN}/assets/${match[2]}`;
    return isGitHubModuleUrl(source) ? { source, mapId: match[1] } : null;
  } catch { return null; }
}

// Preserve each document's module identity while lowering newer JS syntax.
// Parsing source ranges avoids rewriting strings/comments that mention import.
export async function transformGitHubModule(text: string, source: string, mapId: string, imports: GitHubImportMap): Promise<string> {
  const resolve = (specifier: string): string => {
    const mapped = Object.prototype.hasOwnProperty.call(imports, specifier) ? imports[specifier] : specifier;
    let url: string;
    try { url = new URL(mapped, source).href; } catch { return specifier; }
    // Keep the original network URL as the browser's module-map key. Using
    // the protocol URL here duplicates an entry that was redirected from
    // HTTPS, breaking self imports and React/runtime singleton identity.
    return isGitHubModuleUrl(url) ? url : specifier;
  };
  const lowered = await getJsCompiler().transform(text, { target: 'chrome87', format: 'esm', loader: 'js',
    define: { 'import.meta.url': JSON.stringify(source) } });
  const ast = parse(lowered.code, { ecmaVersion: 'latest', sourceType: 'module' });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const helper = `__bfModuleURL_${mapId}`;
  let dynamic = false;
  const replaceSource = (node: { start: number; end: number; value?: unknown }): void => {
    if (typeof node.value === 'string') edits.push({ start: node.start, end: node.end, text: JSON.stringify(resolve(node.value)) });
  };
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const n = node as { type?: string; source?: { start: number; end: number; value?: unknown } };
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source) replaceSource(n.source);
    if (n.type === 'ImportExpression' && n.source) {
      if (typeof n.source.value === 'string') replaceSource(n.source);
      else {
        dynamic = true;
        edits.push({ start: n.source.start, end: n.source.start, text: `${helper}(` },
          { start: n.source.end, end: n.source.end, text: ')' });
      }
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(ast);
  let output = lowered.code;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  if (dynamic) output += `\nfunction ${helper}(specifier) {
    const imports = ${JSON.stringify(imports)};
    const mapped = Object.prototype.hasOwnProperty.call(imports, specifier) ? imports[specifier] : specifier;
    try {
      const url = new URL(mapped, ${JSON.stringify(source)});
      if (url.origin === ${JSON.stringify(GITHUB_ASSET_ORIGIN)} && !url.search && !url.hash && /^\\/assets\\/[\\w.-]+\\.js$/.test(url.pathname)) return url.href;
    } catch {}
    return specifier;
  }\n`;
  return output;
}
