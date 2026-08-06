// css-fixer-core: pure CSS text rewrite for Chromium 87.
// Chromium 87 drops entire rules whose selector uses :where() / :is()
// (shipped in Chrome 88). Rewriting unwraps those pseudo-classes back to
// their inner selectors and converts dvh length units to vh, so Mantine-
// style modern stylesheets render with their intended layout again.
// No DOM access: this module is unit-tested and bundled into the
// "BaoFlash Modern CSS Fixer" built-in userscript.

import postcss from 'postcss';
import selectorParser, { type Selector } from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import { convertColorValue, needsColorRewrite } from './css-fixer-color';

const PSEUDOS_TO_UNWRAP = new Set([':where', ':is']);
const DVH_RE = /(?:\d+\.?\d*)dvh\b/;
const DVH_REPLACE_RE = /(\d+(?:\.\d+)?)dvh\b/g;
const CQ_DUMMY = 'container-query-polyfill';

export function needsRewrite(css: string): boolean {
  return (
    css.includes(':where(') ||
    css.includes(':is(') ||
    css.includes('@layer') ||
    css.includes('@container') ||
    css.includes('&') ||
    DVH_RE.test(css) ||
    needsColorRewrite(css)
  );
}

// Chromium 87 does not support cascade layers: the whole @layer block (and
// its statement form) is dropped. Flatten blocks to top level — rules apply,
// layer ordering is lost (documented degradation).
function flattenLayers(root: postcss.Root): void {
  const layers: postcss.AtRule[] = [];
  root.walkAtRules('layer', (atRule) => {
    layers.push(atRule);
  });
  for (const atRule of layers) {
    if (atRule.nodes && atRule.nodes.length > 0) {
      const nodes = atRule.nodes.slice();
      const first = nodes[0];
      if (first.raws) {
        // inherit the layer block's own leading whitespace so hoisted
        // content does not gain an extra indent
        first.raws.before = atRule.raws.before ?? first.raws.before;
      }
      atRule.replaceWith(...nodes);
    } else {
      atRule.remove();
    }
  }
}

// Splits a selector list on top-level commas (paren/bracket/quote aware).
function splitSelectorList(selectorText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

// Expands a nested selector against its parent: `&` occurrences are replaced
// by the parent selector (cartesian across selector lists); without `&` the
// child becomes a descendant of the parent.
function expandNestedSelector(parentSelector: string, childSelector: string): string {
  const parents = splitSelectorList(parentSelector);
  const children = splitSelectorList(childSelector);
  const out: string[] = [];
  const hasAmp = childSelector.includes('&');
  for (const parent of parents) {
    for (const child of children) {
      out.push(hasAmp ? child.split('&').join(parent) : `${parent} ${child}`);
    }
  }
  return out.join(', ');
}

// Chromium 87 does not support native CSS nesting. Flattens `&` and implicit
// nested rules into plain selectors (iteratively, so arbitrary depth works).
// At-rules nested inside rules (e.g. nested @media) are left as-is: Chromium
// 87 drops them either way (documented limitation).
function flattenNesting(root: postcss.Root): void {
  let changed = true;
  while (changed) {
    changed = false;
    const parents: postcss.Rule[] = [];
    root.walkRules((rule) => {
      if (rule.nodes && rule.nodes.some((n) => n.type === 'rule')) parents.push(rule);
    });
    for (const parent of parents) {
      if (!parent.nodes) continue;
      const children = parent.nodes.filter((n): n is postcss.Rule => n.type === 'rule');
      if (children.length === 0) continue;
      changed = true;
      const hoisted = children.map((child) => {
        const clone = child.clone();
        clone.selector = expandNestedSelector(parent.selector, clone.selector);
        return clone;
      });
      for (const child of children) child.remove();
      const first = hoisted[0];
      if (first.raws) {
        // inherit the parent rule's own leading whitespace so hoisted
        // content does not gain the inner indentation
        first.raws.before = parent.raws.before ?? first.raws.before;
      }
      if (parent.nodes.length === 0) {
        parent.replaceWith(...(hoisted as postcss.Node[]));
      } else {
        parent.after(hoisted as postcss.Node[]);
      }
    }
  }
}

// The container-query-polyfill (bundled into the fixer) requires the dummy
// `:not(.container-query-polyfill)` on the originating element of every
// selector under @container on browsers without :where() (Chromium 87).
function appendDummyToSelector(selectorText: string): string {
  const root = selectorParser().astSync(selectorText);
  const makeDummy = () => {
    const inner = selectorParser.selector({ value: '' });
    inner.append(selectorParser.className({ value: CQ_DUMMY }));
    const pseudo = selectorParser.pseudo({ value: ':not' });
    pseudo.append(inner);
    return pseudo;
  };
  for (const selNode of root.nodes) {
    const nodes = selNode.nodes;
    const first = nodes[0];
    const firstSpaces = (first as unknown as { spaces?: Record<string, string> }).spaces;
    if (firstSpaces) {
      // list-separator whitespace must not double up against the ', ' join
      firstSpaces.before = '';
      firstSpaces.after = '';
    }
    const last = nodes[nodes.length - 1];
    if (last.type === 'pseudo' && last.value.startsWith('::')) {
      selNode.insertBefore(last, makeDummy());
    } else {
      selNode.append(makeDummy());
    }
  }
  return root.toString();
}

function addContainerDummies(root: postcss.Root): void {
  root.walkAtRules('container', (atRule) => {
    atRule.walkRules((rule) => {
      const parent = rule.parent;
      if (parent && parent.type === 'atrule' && /keyframes/i.test(parent.name)) return;
      if (rule.selector.includes(`:not(.${CQ_DUMMY})`)) return;
      try {
        rule.selector = appendDummyToSelector(rule.selector);
      } catch { /* keep the original selector */ }
    });
  });
}

function unwrapClone<T extends selectorParser.Node>(node: T): T {
  const clone = node.clone() as T;
  // v7 stores list-separator whitespace on `spaces.before/after` (descendant
  // spacing uses combinator nodes); it must not leak into the unwrapped rule.
  const spaces = (clone as unknown as { spaces?: Record<string, string> }).spaces;
  if (spaces) {
    spaces.before = '';
    spaces.after = '';
  }
  return clone;
}

// Unwraps :where/:is inside one comma-separated selector branch, returning
// the (possibly expanded) list of selector branches. Single-inner pseudos
// are flattened in place anywhere; a whole-selector multi-inner pseudo
// expands to one branch per inner selector; multi-inner in compound
// position is left untouched (documented limitation).
function processSelectorNode(selNode: Selector): Selector[] {
  const children = selNode.nodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type !== 'pseudo') continue;
    if (!PSEUDOS_TO_UNWRAP.has(child.value)) continue;
    const inner = child.nodes;
    if (!inner || inner.length === 0) continue;

    if (inner.length === 1) {
      const replacement = inner[0].nodes.map((node) => unwrapClone(node));
      for (const node of replacement) selNode.insertBefore(child, node);
      selNode.removeChild(child);
      return processSelectorNode(selNode);
    }

    if (children.length === 1) {
      const branches: Selector[] = [];
      for (const branch of inner) {
        const copy = selectorParser.selector({ value: '' });
        branch.nodes.forEach((node, idx) => {
          if (idx === 0) {
            copy.append(unwrapClone(node));
            return;
          }
          copy.append(node.clone());
        });
        branches.push(...processSelectorNode(copy));
      }
      return branches;
    }

    // multi-inner in compound position: cannot unwrap without changing
    // semantics; leave the rule as-is (it stays dropped by Chromium 87).
    return [selNode];
  }
  return [selNode];
}

function rewriteSelector(selectorText: string): string {
  const root = selectorParser().astSync(selectorText);
  const branches = root.nodes.flatMap((selNode) => processSelectorNode(selNode));
  const rewritten = branches.map((branch) => branch.toString()).join(', ');
  return rewritten === selectorText ? selectorText : rewritten;
}

function rewriteDvh(value: string): string {
  if (!DVH_RE.test(value)) return value;
  const parsed = valueParser(value);
  parsed.walk((node) => {
    if (node.type === 'word') {
      node.value = node.value.replace(DVH_REPLACE_RE, '$1vh');
    }
  });
  return parsed.toString();
}

// ES2022 class static blocks (static{...}) are not parseable by V8 8.7; a
// whole chunk throws and never runs (Next.js App Router does this). Safe
// single-assignment blocks become static getters at the TEXT layer. Shared
// by the main-process js-patch-service (URL-layer interception) — see
// src/main/modules/js-patch-service.ts.
const STATIC_BLOCK_RE = /static\{this\.([A-Za-z_$][\w$]*)=((?:[A-Za-z0-9_$]|\.|\[|\]|"|'|\\|\d|\s)+)\}/g;

export function patchModernJs(text: string): string | null {
  if (!text.includes('static{')) return null;
  const out = text.replace(STATIC_BLOCK_RE, (match, name: string, ref: string) => `static get ${name}(){return ${ref}}`);
  return out === text ? null : out;
}

export function rewriteCssText(css: string): string {
  if (!needsRewrite(css)) return css;
  const root = postcss.parse(css);

  flattenLayers(root);
  flattenNesting(root);
  addContainerDummies(root);

  root.walkRules((rule) => {
    // keyframes selectors (0%, from, to) are not CSS selectors; skip them
    const parent = rule.parent;
    if (parent && parent.type === 'atrule' && /keyframes/i.test((parent as postcss.AtRule).name)) return;
    try {
      const rewritten = rewriteSelector(rule.selector);
      if (rewritten !== rule.selector) rule.selector = rewritten;
    } catch {
      // keep the original selector on any parse edge case
    }
  });

  root.walkDecls((decl) => {
    let out = decl.value;
    const dvh = rewriteDvh(out);
    if (dvh !== out) out = dvh;
    if (needsColorRewrite(out)) {
      const colors = convertColorValue(out);
      if (colors !== null && colors !== out) out = colors;
    }
    if (out !== decl.value) decl.value = out;
  });

  return root.toString();
}
