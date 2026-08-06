// URL matcher: compiles @match/@include/@exclude/@exclude-match rules into
// regular expressions. Pure module, no Electron imports.
// Mirrors the planned src/main/modules/userscripts/userscript-matcher.ts.
//
// Semantics (documented in docs/userscript-platform-plan.md §9):
// - @match follows Chrome match-pattern semantics (scheme://host/path, * wildcards).
//   A pattern without an explicit port matches any port.
// - @include/@exclude are glob patterns; without a scheme they match any scheme.
// - @exclude/@exclude-match always win over @match/@include.
// - No patterns at all => match every URL (subject to excludes).

import type { ParsedUserscriptMetadata } from '../../../shared/userscript-types';

export interface CompiledRules {
  match: RegExp[];
  include: RegExp[];
  exclude: RegExp[];
  excludeMatch: RegExp[];
  matchAll: boolean;
}

interface RuleSource {
  match?: string[];
  include?: string[];
  exclude?: string[];
  excludeMatch?: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  if (glob.startsWith('http://')) {
    source += '^http://';
  } else if (glob.startsWith('https://')) {
    source += '^https://';
  } else if (glob.startsWith('//')) {
    source += '^[a-z][a-z0-9+.-]*://';
  } else {
    source += '^[a-z][a-z0-9+.-]*://';
  }
  const rest = glob.replace(/^https?:\/\//, '').replace(/^\/\//, '');
  const parts = rest.split('/');
  parts.forEach((part, index) => {
    if (index === 0) {
      source += escapeRegExp(part).replace(/\\\*/g, '.*');
    } else {
      source += '/' + escapeRegExp(part).replace(/\\\*/g, '.*');
    }
  });
  source += '.*$';
  return new RegExp(source);
}

function matchPatternToRegExp(pattern: string): RegExp {
  const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|(?:\*\.)?[^*]+?)(?::(\*|\d+))?(\/.*)?$/.exec(pattern);
  if (!match) return /$^/; // never matches: invalid pattern
  const [, scheme, host, port, path] = match;

  let source = '^';
  source += scheme === '*' ? '[a-z][a-z0-9+.-]*' : escapeRegExp(scheme);
  source += '://';
  if (host === '*') {
    source += '[^/]+';
  } else {
    const hostSource = host.startsWith('*.')
      ? '(?:[^/]*\\.)?' + escapeRegExp(host.slice(2))
      : escapeRegExp(host);
    source += hostSource;
  }
  if (port) {
    source += ':' + (port === '*' ? '[0-9]+' : escapeRegExp(port));
  } else {
    source += '(?::[0-9]+)?';
  }
  const pathSource = path && path !== '/' ? path : '/';
  source += escapeRegExp(pathSource).replace(/\\\*/g, '.*');
  source += '$';
  return new RegExp(source);
}

export function compileRules(meta: RuleSource | ParsedUserscriptMetadata): CompiledRules {
  const match = (meta.match ?? []).map(matchPatternToRegExp);
  const include = (meta.include ?? []).map(globToRegExp);
  const exclude = (meta.exclude ?? []).map(globToRegExp);
  const excludeMatch = (meta.excludeMatch ?? []).map(matchPatternToRegExp);
  const matchAll = match.length === 0 && include.length === 0;
  return { match, include, exclude, excludeMatch, matchAll };
}

export function matchesUrl(rules: CompiledRules, url: string): boolean {
  const normalized = String(url || '').split('#')[0];
  if (rules.exclude.some((rule) => rule.test(normalized))) return false;
  if (rules.excludeMatch.some((rule) => rule.test(normalized))) return false;
  if (rules.matchAll) return true;
  if (rules.match.some((rule) => rule.test(normalized))) return true;
  return rules.include.some((rule) => rule.test(normalized));
}
