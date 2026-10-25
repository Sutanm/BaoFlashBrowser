// CSS Fixer smoke: verifies the "BaoFlash Modern CSS Fixer" built-in script
// end to end.
//   1. initUserscriptManager auto-installs the bundled fixer (ruffle.rs match).
//   2. The smoke re-targets @match to the local fixture server.
//   3. A fixture page with Mantine-style :where() CSS (inline <style> AND
//      external <link rel=stylesheet>) is loaded with the production preload.
//   4. Computed styles prove the dropped rules are restored on both paths,
//      and that plain (modern-selector-free) links stay untouched.
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});

const failures = [];
function check(name, ok, detail) {
  console.log(`[css-fixer-smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'css-fixer-'));
app.setPath('userData', USER_DATA);

const FIXTURE_HTML = `<!doctype html>
<html data-mantine-color-scheme="light">
<head>
  <meta charset="utf-8">
  <title>css-fixer fixture</title>
  <link rel="stylesheet" href="/ext.css">
  <link rel="stylesheet" href="/plain.css">
  <style id="inline-css">
    .m_container:where([data-strategy=block]){max-width:640px;margin-inline:auto;padding-inline:12px}
    :where([data-mantine-color-scheme=light]) .m_code :where(pre){background-color:#f0f0f0;color:#111}
    .cq-wrap { container-type: inline-size }
    @container (min-width: 200px) { .cq-inner { color: rgb(10, 20, 30) } }
    #nextimg { width: 100% }
  </style>
  <style id="nest-css">
    .nest-base { & .nest-child { color: rgb(7, 8, 9) } }
    .color-hwb { color: hwb(0 0% 0%) }
    .color-oklch { background-color: oklch(1 0 0) }
  </style>
  <style id="has-css">
    .m_has:has(.m_has-child) { color: rgb(1, 2, 3) }
    .m_has-wrap:has(.m_has-child) { background-color: rgb(4, 5, 6) }
  </style>
  <style>
    .lp-SectionIntro-content h2 { opacity: 0; transform: translateY(24px); transition: opacity .1s, transform .1s }
    .lp-SectionIntro-content.is-visible h2 { opacity: 1; transform: none }
    .inactive-slide { opacity: 0 }
    .lp-SectionHero-visual-frame { aspect-ratio: 4 / 1 }
    .range-nav { padding-top: 68px; width: 100% }
    @media (width>=800px) { .range-nav { padding-top: 0; width: auto } }
    @media (width<=799.98px) { .range-nav { padding-top: 40px } }
  </style>
</head>
<body>
  <div class="lp-Home"><div class="lp-SectionIntro-content"><h2 id="fallback-heading">Below-fold content</h2></div><div class="inactive-slide">Inactive carousel slide</div><div id="ratio-frame" class="lp-SectionHero-visual-frame" style="width:200px"></div></div>
  <react-partial partial-name="marketing-global-banner"><div data-target="react-partial.reactRoot" style="position:absolute;top:0;height:30px">Banner</div></react-partial>
  <header data-marketing-header="true" style="position:fixed;top:var(--marketing-header-fixed-top,0px)">Header</header>
  <nav id="range-nav" class="range-nav">GitHub desktop navigation</nav>
  <div id="container" class="m_container" data-strategy="block">
    <div class="m_code"><pre>code block</pre></div>
    <div id="ext" class="m_ext" data-x>external</div>
    <div id="plain" class="plain">plain</div>
  </div>
  <div id="hasbox" class="m_has"><span class="m_has-child">has-child</span></div>
  <div id="hasbox2" class="m_has-wrap"><span class="m_has-child">has-child2</span></div>
  <div id="nest" class="nest-base"><span class="nest-child">nested</span></div>
  <div id="chwb" class="color-hwb">hwb</div>
  <div id="coklch" class="color-oklch">oklch</div>
  <div id="cqwrap" class="cq-wrap" style="width: 400px"><span id="cqinner" class="cq-inner">cq</span></div>
  <div id="imgwrap"><img id="nextimg" width="0" height="66" decoding="async" data-nimg="1" src="/badge.svg"></div>
  <script>
    // Polyfills land via document-start webFrame.executeJavaScript; the 100KB+
    // core-js payload can lose a race against the HTML parser, so the preload
    // re-verifies and re-injects a few times. Real sites only use these APIs
    // in late async bundles, so the probe runs at 1s (after retries settle)
    // instead of inline.
    setTimeout(function () {
      try {
        window.__uuidPolyfill = (typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : 'missing';
        window.__atPolyfill = ([1,2,3].at(-1) === 3 && 'abc'.at(-1) === 'c' && new Uint8Array([9,8]).at(0) === 9) ? 'ok' : 'broken';
        window.__corePolyfills = {
          hasOwn: Object.hasOwn({a: 1}, 'a'),
          findLast: [1,2,3,4].findLast(function (x) { return x % 2 === 0; }),
          toSorted: JSON.stringify([3,1,2].toSorted()),
          structuredClone: structuredClone({a: 1}).a,
          withResolvers: typeof Promise.withResolvers === 'function',
          groupBy: JSON.stringify(Object.groupBy([1,2,3], function (n) { return n % 2 ? 'odd' : 'even'; })),
        };
      } catch (e) { window.__uuidPolyfill = 'err:' + e.message; window.__atPolyfill = 'err:' + e.message; window.__corePolyfills = 'err:' + e.message; }
    }, 1000);
  </script>
</body>
</html>`;

const EXT_CSS = '.m_ext:where([data-x]){color:rgb(255,0,0)}@media (width>=800px){.range-nav{margin-top:13px}}';
const PLAIN_CSS = '.plain{color:rgb(0,128,0)}';
// chrome-style store badge: SVG intrinsic 661x200, HTML height=66.
// Modern browsers render 66*661/200=218px wide; Chromium 87 renders the
// intrinsic 661px unless the fixer's Next-Image patch kicks in.
const BADGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="661" height="200" viewBox="0 0 661 200"><rect width="661" height="200" fill="#fff"/><circle cx="80" cy="100" r="60" fill="#4285f4"/></svg>';

const ASSERT_SCRIPT = `(() => {
  const cs = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { maxWidth: s.maxWidth, marginLeft: s.marginLeft, marginRight: s.marginRight, backgroundColor: s.backgroundColor, color: s.color };
  };
  const links = [];
  for (let i = 0; i < document.querySelectorAll('link').length; i++) {
    const l = document.querySelectorAll('link')[i];
    links.push({ href: l.getAttribute('href'), disabled: l.disabled, fixed: l.getAttribute('data-bf-css-fixed') });
  }
  const styles = [];
  for (let i = 0; i < document.querySelectorAll('style').length; i++) {
    const s = document.querySelectorAll('style')[i];
    styles.push({ id: s.id, fixed: s.getAttribute('data-bf-css-fixed'), len: (s.textContent || '').length });
  }
  return {
    rangePadding: getComputedStyle(document.getElementById('range-nav')).paddingTop,
    rangeMargin: getComputedStyle(document.getElementById('range-nav')).marginTop,
    headerTop: getComputedStyle(document.querySelector('[data-marketing-header]')).top,
    fallbackOpacity: getComputedStyle(document.getElementById('fallback-heading')).opacity,
    container: cs('#container'),
    pre: cs('.m_code pre'),
    ext: cs('#ext'),
    plain: cs('#plain'),
    nest: cs('.nest-child'),
    hwb: cs('#chwb'),
    oklch: cs('#coklch'),
    cq: cs('#cqinner'),
    nextImg: (() => {
      const el = document.getElementById('nextimg');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), naturalW: el.naturalWidth, complete: el.complete, styleW: el.style.width, styleH: el.style.height };
    })(),
    modernJs: null,
    uuidPolyfill: window.__uuidPolyfill || null,
    atPolyfill: window.__atPolyfill || null,
    corePolyfills: window.__corePolyfills || null,
    hasMarker: (() => {
      const el = document.getElementById('hasbox');
      if (!el) return null;
      const attrs = [];
      for (let i = 0; i < el.attributes.length; i++) attrs.push(el.attributes[i].name);
      return attrs.some((a) => a.startsWith('csstools-has-')) ? 'marked' : attrs.join(',');
    })(),
    hasColor: (() => {
      const el = document.getElementById('hasbox');
      return el ? getComputedStyle(el).color : 'no-el';
    })(),
    hasBox2Bg: (() => {
      const el = document.getElementById('hasbox2');
      return el ? getComputedStyle(el).backgroundColor : 'no-el';
    })(),
    hasRuleInCssom: (() => {
      for (const s of document.styleSheets) {
        try { for (const r of s.cssRules) if (String(r.cssText).includes('csstools-has-')) return true; } catch { /* ignore */ }
      }
      return false;
    })(),
    inlineMarked: (document.getElementById('inline-css') || {}).getAttribute ? document.getElementById('inline-css').getAttribute('data-bf-css-fixed') : null,
    inlineHead: (document.getElementById('inline-css') || {}).textContent ? (document.getElementById('inline-css').textContent || '').slice(0, 400) : null,
    links,
    styles,
  };
})()`;

app.whenReady().then(async () => {
  ipcMain.handle('userscript:automation-v3-list', async () => []);
  ipcMain.handle('userscript:automation-v3-status', async () => ({ enabled: true, state: 'idle', executedSteps: 0, logs: [] }));
  ipcMain.on('get-ruffle-mode', (event) => { event.returnValue = { enabled: false }; });
  ipcMain.on('userscript:get-config', (event, payload) => {
    event.returnValue = mod.getUserscriptManager()
      ? mod.getUserscriptManager().snapshotFor(event.sender.id, payload?.url ?? '', Boolean(payload?.isMainFrame))
      : { ok: false, scripts: [], values: {} };
  });
  ipcMain.on('userscript:report', (event, payload) => {
    mod.getUserscriptManager()?.acceptReport(event.sender.id, payload);
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();

  // 1. The built-in fixer must be auto-installed on manager init.
  const listed = mod.listUserscripts();
  const builtIn = listed.find((s) => s.metadata.name === 'BaoFlash Modern CSS Fixer');
  check('auto-install on init', Boolean(builtIn), builtIn ? { id: builtIn.id, enabled: builtIn.enabled } : null);
  check('auto-install enabled', builtIn?.enabled === true);

  // 2. Built-in update semantics: version bumps update non-edited installs,
  //    user-edited scripts are never overwritten.
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'main', 'modules', 'userscripts', 'bundled-scripts', 'css-fixer.user.js'),
    'utf8',
  );
  const bundledVersion = source.match(/@version\s+(\S+)/)?.[1];
  check('bundled version present', Boolean(bundledVersion), bundledVersion);
  const stagedOld = source.replace(/@version\s+\S+/, '@version      0.1.0');
  mod.installUserscript(stagedOld, { id: builtIn.id, enabled: false });
  check('old version staged', mod.listUserscripts().find((s) => s.id === builtIn.id)?.metadata.version === '0.1.0');
  mod.ensureBundledScripts();
  const afterUpdate = mod.listUserscripts().find((s) => s.id === builtIn.id);
  check('built-in auto-updates on version bump', afterUpdate?.metadata.version === bundledVersion, { version: afterUpdate?.metadata.version, expected: bundledVersion });
  check('update preserves enabled state', afterUpdate?.enabled === false);

  // An OLD build must never downgrade a newer stored version (stale dist).
  const stagedNewer = source.replace(/@version\s+\S+/, '@version      99.0.0');
  mod.installUserscript(stagedNewer, { id: builtIn.id });
  mod.ensureBundledScripts();
  const afterDowngradeAttempt = mod.listUserscripts().find((s) => s.id === builtIn.id);
  check('old build does not downgrade newer store', afterDowngradeAttempt?.metadata.version === '99.0.0', { version: afterDowngradeAttempt?.metadata.version });

  const editedSource = source.replace('*://*.ruffle.rs/*', '*://example.org/*');
  mod.updateUserscriptSource(builtIn.id, editedSource);
  mod.ensureBundledScripts();
  const stillEdited = mod.listUserscripts().find((s) => s.id === builtIn.id);
  check('user-edited built-in not overwritten', stillEdited?.edited === true && stillEdited?.metadata.match?.[0] === '*://example.org/*', { edited: stillEdited?.edited, match: stillEdited?.metadata.match });

  // 3. Re-target @match to the local fixture server (keeps runtime identical).
  const localSource = source.replace('*://*.ruffle.rs/*', '*://127.0.0.1:*/*');
  check('@match retarget found', localSource !== source);
  const updated = mod.updateUserscriptSource(builtIn.id, localSource);
  check('retarget update', updated.ok === true, updated.ok ? null : updated.error);
  check('re-enable after update semantics', mod.setUserscriptEnabled(builtIn.id, true) === true);

  const srv = http.createServer((req, res) => {
    if (req.url === '/seed') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>cache seed</title>');
      return;
    }
    if (req.url === '/late.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('@media (width>=800px){.range-nav{color:rgb(17,18,19)}}');
      return;
    }
    if (req.url === '/ext.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(EXT_CSS);
      return;
    }
    if (req.url === '/plain.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(PLAIN_CSS);
      return;
    }
    if (req.url === '/badge.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(BADGE_SVG);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const preloadPath = path.join(__dirname, '..', '..', 'release', 'tests', 'userscript-runtime-preload.cjs');
  const host = new BrowserWindow({ show: true, focusable: false, width: 900, height: 700, webPreferences: { nodeIntegration: false, contextIsolation: true, spellcheck: false } });
  const view = new BrowserView({
    webPreferences: {
      preload: preloadPath,
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      spellcheck: false,
      partition: 'persist:css-fixer-smoke',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  mod.getUserscriptManager().registerView(view.webContents.id, { mode: 'ppapi', generation: 1, token: 'css-fixer-smoke' });

  await view.webContents.loadURL(url + 'seed');
  // Simulate a persisted rewrite produced before range-query support.
  await view.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const request = indexedDB.open('bf-css-fixer', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sheets', { keyPath: 'url' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('sheets', 'readwrite');
      tx.objectStore('sheets').put({ url: ${JSON.stringify(url + 'ext.css')}, text: '.m_ext{color:rgb(0,0,255)}', ts: Date.now(), bytes: 36 });
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
  })`);
  await view.webContents.loadURL(url);

  // 3. Poll until the fixer has applied (link path + container queries are async).
  const deadline = Date.now() + 25000;
  let result = null;
  while (Date.now() < deadline) {
    result = await view.webContents.executeJavaScript(ASSERT_SCRIPT);
    const done = result?.container?.maxWidth === '640px'
      && result?.ext?.color === 'rgb(255, 0, 0)'
      && result?.plain?.color === 'rgb(0, 128, 0)'
      && result?.nest?.color === 'rgb(7, 8, 9)'
      && result?.hwb?.color === 'rgb(255, 0, 0)'
      && result?.oklch?.backgroundColor === 'rgb(255, 255, 255)'
      && result?.cq?.color === 'rgb(10, 20, 30)'
      && result?.nextImg?.w === 218 && result?.nextImg?.h === 66
      && (result?.uuidPolyfill ?? null) !== null
      && (result?.atPolyfill ?? null) !== null
      && result?.hasColor === 'rgb(1, 2, 3)'
      && result?.hasBox2Bg === 'rgb(4, 5, 6)';
    const fallbackDone = result?.fallbackOpacity === '1';
    if (done && fallbackDone) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  // 4. Assertions.
  check('GitHub range media query restores desktop navigation', result?.rangePadding === '0px', result?.rangePadding);
  check('GitHub section reveals when native modules cannot hydrate', result?.fallbackOpacity === '1', result?.fallbackOpacity);
  const frameHeight = await view.webContents.executeJavaScript(`document.getElementById('ratio-frame').getBoundingClientRect().height`);
  check('GitHub media frame retains its aspect ratio', frameHeight === 50, frameHeight);
  await view.webContents.executeJavaScript(`document.getElementById('ratio-frame').style.width = '320px'`);
  let resizedHeight;
  for (let i = 0; i < 20; i++) {
    resizedHeight = await view.webContents.executeJavaScript(`document.getElementById('ratio-frame').getBoundingClientRect().height`);
    if (resizedHeight === 80) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  check('GitHub media frame responds to resizing', resizedHeight === 80, resizedHeight);
  const inactiveOpacity = await view.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.inactive-slide')).opacity`);
  check('inactive slides stay hidden', inactiveOpacity === '0', inactiveOpacity);
  check('fixed GitHub header clears the visible global banner', result?.headerTop === '30px', result?.headerTop);
  check('range queries rewritten in external sheets despite old cache', result?.rangeMargin === '13px', result?.rangeMargin);
  check('container max-width restored (inline path)', result?.container?.maxWidth === '640px', result?.container);
  const autoCentered = result?.container?.marginLeft === result?.container?.marginRight && result?.container?.marginLeft !== '0px';
  check('container centered by auto margins (inline path)', autoCentered, result?.container);
  check('code block background restored (inline path)', result?.pre?.backgroundColor === 'rgb(240, 240, 240)', result?.pre);
  check('external link sheet rewritten (link path)', result?.ext?.color === 'rgb(255, 0, 0)', result?.ext);
  check('plain link left untouched and applied', result?.plain?.color === 'rgb(0, 128, 0)', { plain: result?.plain, links: result?.links, styles: result?.styles });
  // FOUC guarantee: external stylesheet <link>s must NOT be disabled and must
  // still exist (the fixer keeps links applying immediately and inserts an
  // override <style> after each rewritten one). A disabled/removed link would
  // flash the page unstyled during the async fetch+rewrite.
  const nonInlineLinks = (result?.links || []).filter((l) => l.href && !String(l.href).startsWith('(inline)'));
  check('external stylesheet links kept and not disabled (no FOUC)', nonInlineLinks.length >= 2 && nonInlineLinks.every((l) => l.disabled === false), { nonInlineLinks });
  check('css nesting flattened', result?.nest?.color === 'rgb(7, 8, 9)', result?.nest);
  check('hwb color converted', result?.hwb?.color === 'rgb(255, 0, 0)', result?.hwb);
  check('oklch color converted', result?.oklch?.backgroundColor === 'rgb(255, 255, 255)', result?.oklch);
  check('container query applied via polyfill', result?.cq?.color === 'rgb(10, 20, 30)', result?.cq);
  check('next-image width=0 badge rendered at html-height-derived size', result?.nextImg?.w === 218 && result?.nextImg?.h === 66, result?.nextImg);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  check('crypto.randomUUID polyfilled in page world (uuid v4)', typeof result?.uuidPolyfill === 'string' && uuidRe.test(result?.uuidPolyfill), result?.uuidPolyfill);
  check('Array/String/TypedArray .at polyfilled in page world', result?.atPolyfill === 'ok', result?.atPolyfill);
  check('core-js polyfills (hasOwn/findLast/toSorted/structuredClone/withResolvers/groupBy)',
    result?.corePolyfills?.hasOwn === true
      && result?.corePolyfills?.findLast === 4
      && result?.corePolyfills?.toSorted === '[1,2,3]'
      && result?.corePolyfills?.structuredClone === 1
      && result?.corePolyfills?.withResolvers === true
      && result?.corePolyfills?.groupBy === '{"odd":[1,3],"even":[2]}',
    result?.corePolyfills);
  check('inline style fully fixed (no :where remains after polyfill cooperation)', !(result?.inlineHead || '').includes(':where('), result?.inlineHead);
  check('has polyfill marker applied', result?.hasMarker === 'marked', result?.hasMarker);
  check('has polyfill rule in cssom', result?.hasRuleInCssom === true, result?.hasRuleInCssom);
  check('has polyfill style applied', result?.hasColor === 'rgb(1, 2, 3)', result?.hasColor);
  check('has polyfill second rule applied', result?.hasBox2Bg === 'rgb(4, 5, 6)', result?.hasBox2Bg);

  await view.webContents.executeJavaScript(`(async () => {
    const style = document.createElement('style'); document.head.appendChild(style);
    for (let i = 0; i < 180; i++) style.textContent = '.churn{z-index:' + i + '}';
    await new Promise(resolve => setTimeout(resolve, 0));
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/late.css'; document.head.appendChild(link);
  })()`);
  let lateColor;
  for (let i = 0; i < 50; i++) {
    lateColor = await view.webContents.executeJavaScript(`getComputedStyle(document.getElementById('range-nav')).color`);
    if (lateColor === 'rgb(17, 18, 19)') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  check('late GitHub stylesheet survives 180 mutations to an existing sheet', lateColor === 'rgb(17, 18, 19)', lateColor);
  const lateOverrides = await view.webContents.executeJavaScript(`document.querySelectorAll('style[data-bf-css-fix-source$="/late.css"]').length`);
  check('external sheet gets exactly one override', lateOverrides === 1, lateOverrides);
  await view.webContents.executeJavaScript(`document.querySelector('react-partial[partial-name="marketing-global-banner"]').remove()`);
  let headerAfterDismiss;
  for (let i = 0; i < 25; i++) {
    headerAfterDismiss = await view.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-marketing-header]')).top`);
    if (headerAfterDismiss === '0px') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  check('dismissing the banner resets the header offset', headerAfterDismiss === '0px', headerAfterDismiss);
  view.setBounds({ x: 0, y: 0, width: 700, height: 700 });
  const mobilePadding = await view.webContents.executeJavaScript(`getComputedStyle(document.getElementById('range-nav')).paddingTop`);
  check('range media query responds to mobile resize', mobilePadding === '40px', mobilePadding);
  host.destroy();
  srv.close();
  console.log(`[css-fixer-smoke] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
