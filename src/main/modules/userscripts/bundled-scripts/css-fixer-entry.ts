// css-fixer-entry: userscript body of the "BaoFlash Modern CSS Fixer"
// built-in script. Bundled by scripts/build-css-fixer.mjs with the
// ==UserScript== metadata prepended; runs at document-start and rewrites
// :where()/:is()/dvh CSS that Chromium 87 would otherwise drop.
//
// Interception is at the CSS TEXT layer on purpose: Chromium 87 drops
// whole rules whose selector uses :where()/:is() at parse time, so the
// CSSOM never contains them. Style elements are rewritten in place via a
// MutationObserver (world-local prototype patching cannot see page-world
// writes); external <link rel=stylesheet> sheets are disabled, fetched,
// rewritten and replaced with a <style> element.
/// <reference lib="dom" />

import { needsRewrite, rewriteCssText } from './css-fixer-core';
// GoogleChromeLabs container-query-polyfill, vendored with ONE patch: its
// <style> processor only transpiles sheets containing container-query signals
// (@container / container-type / cq units), so plain modern sheets (nesting,
// colors) are left for the fixer's text-layer rewrite alone. The fixer adds
// the dummy :not(.container-query-polyfill) markers the polyfill expects on
// Chromium 87; the fixer's MutationObserver re-verifies marked styles after
// the polyfill's async innerHTML writeback (which would otherwise clobber
// the fixer's rewrite, since insertRule'd rules die on text replacement).
import './vendor/container-query-polyfill.js';
import './vendor/css-has-pseudo.js';

const MARKER = 'data-bf-css-fixed';
// React apps (github.com) re-insert shared stylesheet <link>s many times
// (primer-react-css appears 6+ times per page); the cap must survive the
// static sheets PLUS all dynamic insertions or late sheets stay unstyled.
const MAX_SHEETS = 150;
// css-has-pseudo browser runtime queries the FULL encoded selector via
// querySelectorAll — on Chromium 87 that throws for complex selectors
// (compound + attribute + :has), so GitHub's real rules never get marked.
// Our own marker pass handles the common form: single :has(...) whose inner
// is a plain (combinator-free) selector — query inner, climb to the host
// with closest(E). Multi-:has / combinator / complex inner stay degraded
// (the vendored runtime still covers trivial selectors).
const HAS_ATTR_RE = /\[(csstools-has-[a-z0-9-]+)\]/;
const HAS_INNER_RE = /:has\(([^()]*)\)/;

function decodeHasAttr(encoded: string): string {
  if (!encoded.startsWith('csstools-has-')) return '';
  return encoded
    .slice(13)
    .split('-')
    .map((x) => String.fromCharCode(parseInt(x, 36)))
    .join('');
}

function markHasInSheets(): void {
  try {
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (let i = 0; i < rules.length; i++) {
        const text = String(rules[i].cssText);
        if (!text.includes('csstools-has-')) continue;
        const am = text.match(HAS_ATTR_RE);
        if (!am) continue;
        const attr = am[1];
        const F = decodeHasAttr(attr);
        if (!F) continue;
        const hasMatches = F.match(/:has\(/g) || [];
        if (hasMatches.length !== 1) continue; // multi :has degraded
        const innerMatch = F.match(HAS_INNER_RE);
        if (!innerMatch) continue;
        const inner = innerMatch[1].trim();
        if (/^[>+~]/.test(inner)) continue; // combinator inner degraded
        const hostSel = F.replace(HAS_INNER_RE, '').trim();
        if (!hostSel) continue;
        let els: NodeListOf<Element>;
        try { els = document.querySelectorAll(inner); } catch { continue; }
        for (let j = 0; j < els.length; j++) {
          let host: Element | null = null;
          try { host = els[j].closest(hostSel); } catch { break; }
          if (host && host !== els[j]) host.setAttribute(attr, '');
        }
      }
    }
  } catch { /* never break the page */ }
}

let markHasTimer: number | null = null;
function scheduleMarkHas(): void {
  if (markHasTimer !== null) return;
  markHasTimer = window.setTimeout(() => {
    markHasTimer = null;
    markHasInSheets();
  }, 500);
}

function startHasReMarkLoop(): void {
  // Components render asynchronously after their styles land (React); the
  // one-shot pass at start() sees an empty DOM. Re-mark periodically for the
  // first 60s, then stay interaction-driven (menus/dialogs open on click).
  let rounds = 0;
  const timer = window.setInterval(() => {
    rounds += 1;
    markHasInSheets();
    if (rounds >= 20) window.clearInterval(timer);
  }, 3000);
  for (const ev of ['click', 'mouseenter'] as const) {
    document.addEventListener(ev, () => scheduleMarkHas(), { capture: true, passive: true });
  }
}
// React apps insert stylesheet <link>s while the page is still busy loading
// (github.com: primer-react-css is 292KB, brand 694KB, inserted ~2s in).
// 3s timed out on those during network peaks; 10s covers slow links while
// still bounding the total stall.
const FETCH_TIMEOUT_MS = 10000;
const MAX_FETCH_ATTEMPTS = 2;

function toArray<T>(list: { item(i: number): T; length: number }): T[] {
  const out: T[] = [];
  for (let i = 0; i < list.length; i++) out.push(list.item(i));
  return out;
}

// Next.js Image renders <img width="0" height="N"> with CSS width:100%.
// Modern browsers size the image from the HTML height (N) and the SVG
// intrinsic ratio; Chromium 87 instead uses the SVG intrinsic WIDTH, so
// store badges like ruffle.rs's chrome.svg balloon to 661px (vs 218px).
// A rendered width beyond 2.5x the HTML height is the gross-oversize
// signature of that bug. Fixing aligns the layout with modern browsers.
function shouldFixNextImage(width: number, htmlHeight: number): boolean {
  return htmlHeight > 0 && width > htmlHeight * 2.5;
}

function fixNextImage(img: HTMLImageElement): void {
  try {
    if (img.getAttribute('width') !== '0') return;
    const h = parseInt(img.getAttribute('height') || '', 10);
    if (!Number.isFinite(h) || h <= 0) return;
    const apply = (): void => {
      const w = parseFloat(getComputedStyle(img).width);
      if (Number.isFinite(w) && shouldFixNextImage(w, h)) {
        img.style.width = 'auto';
        img.style.height = h + 'px';
      }
    };
    apply();
    if (!img.complete) {
      img.addEventListener('load', apply, { once: true });
    }
    // The SVG intrinsic size can settle after complete=true (async decode);
    // re-check after layout settles so a race never leaves an image unpatched
    // (observed: two of three store badges patched, the third stuck).
    window.setTimeout(apply, 300);
    window.setTimeout(apply, 1500);
  } catch { /* never break the page */ }
}

function fixNextImages(root: ParentNode): void {
  for (const img of toArray(root.querySelectorAll('img[width="0"][height]'))) {
    fixNextImage(img as HTMLImageElement);
  }
}

function processStyle(el: HTMLStyleElement): void {
  try {
    const lastWrite = (el as unknown as { __bfLastWrite?: string }).__bfLastWrite;
    if (el.hasAttribute(MARKER)) {
      // The container-query-polyfill rewrites <style> text after us (its
      // innerHTML writeback is its durable application mechanism). Re-process
      // only when the text changed since our last write, so the two coexist.
      if (lastWrite === el.textContent) return;
      el.removeAttribute(MARKER);
    }
    const text = el.textContent || '';
    if (!needsRewrite(text)) {
      (el as unknown as { __bfLastWrite?: string }).__bfLastWrite = text;
      return;
    }
    const out = rewriteCssText(text);
    if (out !== text) {
      el.setAttribute(MARKER, '1');
      (el as unknown as { __bfLastWrite?: string }).__bfLastWrite = out;
      el.textContent = out;
      scheduleMarkHas();
    } else {
      (el as unknown as { __bfLastWrite?: string }).__bfLastWrite = text;
    }
  } catch { /* a rewrite failure must never break the page */ }
}

async function processLink(link: HTMLLinkElement, attempt = 0): Promise<void> {
  try {
    if (link.hasAttribute(MARKER)) return;
    if (link.disabled) return;
    const rel = (link.rel || '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) return;
    const href = link.href;
    if (!href || /^data:/i.test(href)) return;

    link.disabled = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let text: string;
    try {
      const res = await fetch(href, { credentials: 'same-origin', cache: 'force-cache', signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    // Replacing the <link> with a <style> (rewritten or verbatim) is more
    // reliable than re-enabling the link: Chromium 87 does not guarantee a
    // reload after disabled true->false. On fetch failure the original link
    // is restored instead.
    const style = document.createElement('style');
    style.setAttribute(MARKER, '1');
    style.setAttribute('data-bf-css-fix-source', href);
    style.textContent = rewriteCssText(text);
    link.parentNode?.insertBefore(style, link.nextSibling);
    link.remove();
    scheduleMarkHas();
  } catch {
    try { link.disabled = false; } catch { /* element gone */ }
    // A fetch that aborted during the page's network peak (React-inserted
    // sheets) is retried once the page settles; the link may have been
    // removed or re-inserted by React in the meantime.
    if (attempt < MAX_FETCH_ATTEMPTS && link.isConnected) {
      setTimeout(() => { void processLink(link, attempt + 1); }, 1500 * (attempt + 1));
    }
  }
}

function main(): void {
  try {
    if (typeof CSS === 'undefined' || !CSS.supports || CSS.supports('selector(:where(*))')) return;
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;

    let processed = 0;
    const handleStyle = (el: HTMLStyleElement): void => {
      if (processed >= MAX_SHEETS) return;
      processed += 1;
      processStyle(el);
    };
    const handleLink = (link: HTMLLinkElement): void => {
      if (processed >= MAX_SHEETS) return;
      processed += 1;
      void processLink(link);
    };

    // Style text changes invalidate :has markers (a rewritten <style> may
    // gain/lose csstools-has- rules); re-run the marker pass debounced.
    const scheduleReMark = (): void => scheduleMarkHas();

    const observer = new MutationObserver((mutations) => {
      if (processed >= MAX_SHEETS) {
        observer.disconnect();
        return;
      }
      for (const mutation of mutations) {
        // The container-query-polyfill replaces a <style> text node (childList
        // mutation on the STYLE element). processStyle's re-verify path needs
        // to see that, or its rewrite would be silently clobbered.
        const target = mutation.target;
        if (target && target.nodeType === 1 && (target as HTMLElement).tagName === 'STYLE') {
          handleStyle(target as HTMLStyleElement);
          scheduleReMark();
        }
        const added = mutation.addedNodes;
        for (let i = 0; i < added.length; i++) {
          const node = added.item(i);
          if (!node || node.nodeType !== 1) continue;
          const el = node as HTMLElement;
          if (el.tagName === 'STYLE') {
            handleStyle(el as HTMLStyleElement);
            scheduleReMark();
          } else if (el.tagName === 'LINK') {
            handleLink(el as HTMLLinkElement);
            scheduleReMark();
          } else if (el.tagName === 'IMG') {
            fixNextImage(el as HTMLImageElement);
          } else {
            for (const style of toArray(el.querySelectorAll('style'))) handleStyle(style as HTMLStyleElement);
            for (const link of toArray(el.querySelectorAll('link[rel~="stylesheet"]'))) handleLink(link as HTMLLinkElement);
            if (el.querySelector('style, link[rel~="stylesheet"]')) scheduleReMark();
            fixNextImages(el);
          }
        }
      }
    });

    const start = (): void => {
      for (const style of toArray(document.querySelectorAll('style'))) handleStyle(style as HTMLStyleElement);
      for (const link of toArray(document.querySelectorAll('link[rel~="stylesheet"]'))) handleLink(link as HTMLLinkElement);
      fixNextImages(document);
      // Our own marker pass handles the :has forms the vendored runtime
      // cannot query reliably on Chromium 87 (complex selectors); the
      // vendored cssHasPseudo() transform is intentionally NOT started — its
      // node-tracking pass would re-run later and strip our markers.
      markHasInSheets();
      startHasReMarkLoop();
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };

    if (document.documentElement) {
      start();
    } else {
      // document-start: the root element may not exist yet; wait for it
      const watcher = new MutationObserver(() => {
        if (!document.documentElement) return;
        watcher.disconnect();
        start();
      });
      watcher.observe(document, { childList: true });
    }
  } catch { /* the fixer must never break the page */ }
}

main();

