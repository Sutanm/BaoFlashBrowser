// Metadata parser for `==UserScript==` headers. Pure module, no Electron imports.
// Mirrors the planned src/main/modules/userscripts/userscript-parser.ts.

import type { ParsedUserscriptMetadata, RunAt } from '../../../shared/userscript-types';

const HEADER_START = '==UserScript==';
const HEADER_END = '==/UserScript==';

const SCALAR_KEYS = new Set(['name', 'namespace', 'version', 'description', 'run-at']);
const LIST_KEYS = new Set(['match', 'include', 'exclude', 'exclude-match', 'grant', 'connect', 'require']);
const FLAG_KEYS = new Set(['noframes']);
const VALID_RUN_AT: ReadonlySet<string> = new Set(['document-start', 'document-body', 'document-end', 'document-idle']);

function trimLine(line: string): string {
  return line.replace(/^\s*\/\/\s*/, '').replace(/\s+$/, '');
}

function primaryKey(key: string): string {
  const colon = key.indexOf(':');
  return colon >= 0 ? key.slice(0, colon) : key;
}

export function parseUserscriptMetadata(source: string): ParsedUserscriptMetadata | null {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  const start = lines.findIndex((line) => trimLine(line) === HEADER_START);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && trimLine(line) === HEADER_END);
  if (end < 0) return null;

  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const resources: Array<{ name: string; url: string }> = [];
  let noframes = false;

  for (let i = start + 1; i < end; i++) {
    const line = trimLine(lines[i]);
    if (!line.startsWith('@')) continue;
    const rest = line.slice(1);
    const spaceIndex = rest.indexOf(' ');
    const key = primaryKey(spaceIndex >= 0 ? rest.slice(0, spaceIndex) : rest);
    const rawValue = spaceIndex >= 0 ? rest.slice(spaceIndex + 1).trim() : '';
    if (SCALAR_KEYS.has(key)) {
      if (!scalars.has(key)) scalars.set(key, rawValue);
    } else if (LIST_KEYS.has(key)) {
      if (rawValue) {
        const bucket = lists.get(key) ?? [];
        bucket.push(rawValue);
        lists.set(key, bucket);
      }
    } else if (key === 'resource') {
      const value = rawValue.replace(/^\s+/, '');
      const separator = value.search(/\s/);
      if (separator > 0) {
        resources.push({ name: value.slice(0, separator), url: value.slice(separator + 1).trim() });
      }
    } else if (key === 'noframes') {
      noframes = true;
    }
  }

  const runAtRaw = scalars.get('run-at') ?? '';
  const runAt: RunAt = VALID_RUN_AT.has(runAtRaw) ? (runAtRaw as RunAt) : 'document-end';

  const grant = (lists.get('grant') ?? []).filter((name) => name !== 'none');

  return {
    name: scalars.get('name') ?? '',
    namespace: scalars.get('namespace') ?? '',
    version: scalars.get('version') ?? '',
    description: scalars.get('description') ?? '',
    match: lists.get('match') ?? [],
    include: lists.get('include') ?? [],
    exclude: lists.get('exclude') ?? [],
    excludeMatch: lists.get('exclude-match') ?? [],
    runAt,
    grant,
    connect: lists.get('connect') ?? [],
    noframes,
    require: lists.get('require') ?? [],
    resource: resources,
    rawHeader: lines.slice(start, end + 1).join('\n'),
  };
}
