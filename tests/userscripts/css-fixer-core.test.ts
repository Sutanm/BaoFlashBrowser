import { describe, expect, it } from 'vitest';
import { needsRewrite, patchModernJs, rewriteCssText } from '@main/modules/userscripts/bundled-scripts/css-fixer-core';

describe('css-fixer-core needsRewrite', () => {
  it('detects :where selectors', () => {
    expect(needsRewrite('.a:where([data-x]) { color: red }')).toBe(true);
  });

  it('detects :is selectors', () => {
    expect(needsRewrite(':is(.a, .b) { color: red }')).toBe(true);
  });

  it('detects dvh units', () => {
    expect(needsRewrite('height: 100dvh')).toBe(true);
  });

  it('ignores plain css', () => {
    expect(needsRewrite('.a { color: red }')).toBe(false);
  });

  it('may over-trigger on string literals (heuristic gate; rewrite stays precise)', () => {
    expect(needsRewrite('content: ":where()"')).toBe(true);
    expect(rewriteCssText('content: ":where()"')).toBe('content: ":where()"');
  });
});

describe('css-fixer-core rewriteCssText', () => {
  it('unwraps a single :where in compound position', () => {
    const css = '.m_7485cace:where([data-strategy=block]){max-width:100px;margin:0 auto}';
    expect(rewriteCssText(css)).toBe('.m_7485cace[data-strategy=block]{max-width:100px;margin:0 auto}');
  });

  it('unwraps :where at the start and middle of a complex selector', () => {
    const css = ':where([data-mantine-color-scheme=light]) .m_d08caa0 :where(pre){background-color:#eee}';
    expect(rewriteCssText(css)).toBe('[data-mantine-color-scheme=light] .m_d08caa0 pre{background-color:#eee}');
  });

  it('unwraps a whole-selector :is list into a selector list', () => {
    const css = ':is(a, .b) { color: red }';
    expect(rewriteCssText(css)).toBe('a, .b { color: red }');
  });

  it('unwraps nested :where(:is(...)) when the inner list is a single selector', () => {
    const css = ':where(:is(.a)) { color: red }';
    expect(rewriteCssText(css)).toBe('.a { color: red }');
  });

  it('unwraps nested single-inner where over a multi-inner is inside', () => {
    // outer unwrap exposes :is as whole selector, which then expands to a list
    const css = ':where(:is(.a, .b)) { color: red }';
    expect(rewriteCssText(css)).toBe('.a, .b { color: red }');
  });

  it('leaves attribute-string occurrences of :where untouched', () => {
    const css = '[data-x="a:where(b)"] { color: red }';
    expect(rewriteCssText(css)).toBe('[data-x="a:where(b)"] { color: red }');
  });

  it('preserves comments that mention :where', () => {
    const css = '/* :where(legacy) kept */ .a { color: red }';
    expect(rewriteCssText(css)).toContain('/* :where(legacy) kept */');
    expect(rewriteCssText(css)).toContain('.a { color: red }');
  });

  it('converts :has() into a csstools-has marker attribute rule', () => {
    const css = '.m_88b62a41:has([data-mantine-scrollbar]) { max-width: 10px }';
    const out = rewriteCssText(css);
    expect(out).not.toContain(':has(');
    expect(out).toContain('[csstools-has-');
    expect(out).toContain(':not(.does-not-exist)');
    expect(out).toContain('max-width: 10px');
  });

  it('needsRewrite detects :has(', () => {
    expect(needsRewrite('.a:has(.b) { color: red }')).toBe(true);
  });

  it('unwraps :is before :has conversion so the encoded selector is C87-queryable', () => {
    const css = ':is(.a .b):has(.c) { color: red }';
    const out = rewriteCssText(css);
    expect(out).not.toContain(':has(');
    expect(out).not.toContain(':is(');
    expect(out).toContain('[csstools-has-');
    // decode the encoded selector and assert no :is remains
    const enc = (out.match(/csstools-has-[a-z0-9-]+/) || [''])[0];
    const decoded = enc.slice(13).split('-').map((x) => String.fromCharCode(parseInt(x, 36))).join('');
    expect(decoded).not.toContain(':is(');
    expect(decoded).toContain('.a .b');
  });

  it('keeps plain selectors without :has untouched', () => {
    const css = '.a .b { color: red }';
    expect(rewriteCssText(css)).toBe(css);
  });

  it('skips multi-selector :where in compound position (documented limitation)', () => {
    const css = '.x:where(.a, .b) { color: red }';
    expect(rewriteCssText(css)).toBe(css);
  });

  it('rewrites inside @media while preserving the at-rule', () => {
    const css = '@media (min-width: 600px){ .a:where(.b){color:red} }';
    expect(rewriteCssText(css)).toBe('@media (min-width: 600px){ .a.b{color:red} }');
  });

  it('does not touch @keyframes selectors and does not crash', () => {
    const css = '@keyframes spin { 0% { transform: rotate(0deg) } to { transform: rotate(360deg) } }';
    expect(rewriteCssText(css)).toBe(css);
  });

  it('converts dvh units to vh in declarations', () => {
    const css = '.page { height: 100dvh; width: 100vw; min-height: 50.5dvh }';
    expect(rewriteCssText(css)).toBe('.page { height: 100vh; width: 100vw; min-height: 50.5vh }');
  });

  it('does not convert dvh inside string declarations', () => {
    const css = '.a { content: "100dvh" }';
    expect(rewriteCssText(css)).toBe('.a { content: "100dvh" }');
  });

  it('returns the input unchanged when nothing needs rewriting', () => {
    const css = '.a { color: red }\n@media (min-width: 1px) { .b { margin: 0 } }';
    expect(rewriteCssText(css)).toBe(css);
  });

  it('handles multiple independent rules in one sheet', () => {
    const css = [
      ':where([data-dark]) body { background: #000 }',
      '.m_1:where([data-x]) { color: red }',
      'h1 { font-size: 1rem }',
      '.box { height: 100dvh }',
    ].join('\n');
    expect(rewriteCssText(css)).toBe([
      '[data-dark] body { background: #000 }',
      '.m_1[data-x] { color: red }',
      'h1 { font-size: 1rem }',
      '.box { height: 100vh }',
    ].join('\n'));
  });
});

describe('css-fixer-core @layer support', () => {
  it('flattens a @layer block to top level', () => {
    const css = '@layer base { .a { color: red } }';
    expect(rewriteCssText(css)).toBe('.a { color: red }');
  });

  it('removes @layer statement rules and keeps blocks', () => {
    const css = '@layer a, b; @layer a { .x { color: red } }';
    expect(rewriteCssText(css)).toBe('.x { color: red }');
  });

  it('hoists rules out of a @layer inside @media and keeps the media wrapper', () => {
    const css = '@layer x { @media (min-width: 1px) { .y { color: red } } }';
    expect(rewriteCssText(css)).toBe('@media (min-width: 1px) { .y { color: red } }');
  });

  it('flattens nested @layer blocks', () => {
    const css = '@layer a { @layer b { .z { color: red } } }';
    expect(rewriteCssText(css)).toBe('.z { color: red }');
  });

  it('combines @layer flattening with :where unwrapping', () => {
    const css = '@layer base { .m_x:where([data-y]) { color: red } }';
    expect(rewriteCssText(css)).toBe('.m_x[data-y] { color: red }');
  });
});

describe('css-fixer-core CSS nesting', () => {
  it('flattens & nesting', () => {
    const css = '.a { & .b { color: red } }';
    expect(rewriteCssText(css)).toBe('.a .b { color: red }');
  });

  it('flattens pseudo-element & nesting', () => {
    const css = '.a { &:hover { color: red } }';
    expect(rewriteCssText(css)).toBe('.a:hover { color: red }');
  });

  it('flattens implicit native nesting without & (when another trigger opens the sheet)', () => {
    const css = '.x:where(.y) { .b { color: red } }';
    expect(rewriteCssText(css)).toBe('.x.y .b { color: red }');
  });

  it('unwraps :where inside nested rules after flattening', () => {
    const css = '.a { & :where(.b) { color: red } }';
    expect(rewriteCssText(css)).toBe('.a .b { color: red }');
  });
});

describe('css-fixer-core @container dummy markers', () => {
  it('appends the dummy :not to container-query rules', () => {
    const css = '@container (min-width: 200px) { #foo { color: red } }';
    expect(rewriteCssText(css)).toBe('@container (min-width: 200px) { #foo:not(.container-query-polyfill) { color: red } }');
  });

  it('appends to the originating element of complex selectors', () => {
    const css = '@container (min-width: 200px) { ul > li { color: red } }';
    expect(rewriteCssText(css)).toBe('@container (min-width: 200px) { ul > li:not(.container-query-polyfill) { color: red } }');
  });

  it('appends to every selector in a list', () => {
    const css = '@container (min-width: 200px) { #foo, .bar { color: red } }';
    expect(rewriteCssText(css)).toBe('@container (min-width: 200px) { #foo:not(.container-query-polyfill), .bar:not(.container-query-polyfill) { color: red } }');
  });

  it('prepends the dummy before pseudo-elements', () => {
    const css = '@container (min-width: 200px) { ::before { content: "x" } }';
    expect(rewriteCssText(css)).toBe('@container (min-width: 200px) { :not(.container-query-polyfill)::before { content: "x" } }');
  });

  it('does not double-append when the dummy already exists', () => {
    const css = '@container (min-width: 200px) { #foo:not(.container-query-polyfill) { color: red } }';
    expect(rewriteCssText(css)).toBe(css);
  });

  it('combines with :where unwrapping inside @container', () => {
    const css = '@container (min-width: 200px) { .a:where(.b) { color: red } }';
    expect(rewriteCssText(css)).toBe('@container (min-width: 200px) { .a.b:not(.container-query-polyfill) { color: red } }');
  });

  it('does not touch rules outside @container', () => {
    const css = '.plain { color: red }';
    expect(rewriteCssText(css)).toBe(css);
  });
});

describe('css-fixer-core patchModernJs (ES2022 static blocks)', () => {
  it('rewrites a safe single-assignment static block to a static getter', () => {
    expect(patchModernJs('class y{static{this.contextType=x.context}run(){}}')).toBe('class y{static get contextType(){return x.context}run(){}}');
  });

  it('rewrites member-expression references', () => {
    expect(patchModernJs('static{this.a=d.AppRouterContext}')).toBe('static get a(){return d.AppRouterContext}');
  });

  it('leaves scripts without static blocks untouched', () => {
    expect(patchModernJs('var a=1;window.b=2')).toBeNull();
  });

  it('leaves unsafe static blocks (calls, statements) untouched', () => {
    const src = 'class y{static{this.x=fn()}}';
    expect(patchModernJs(src)).toBeNull();
  });
});
