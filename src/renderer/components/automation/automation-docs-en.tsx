import React from 'react';
import type { DocSection } from './automation-docs-data';

export const englishDocSections: DocSection[] = [
  { id: 'quick-start', title: 'Quick start', content: <>
    <h2>Quick start</h2><p>Create an automation package, add a JavaScript or TypeScript script, grant the required capabilities, and run its main entry. A package can also contain a Blockly workflow and shared image assets.</p>
    <ol><li>Create a package in the workbench.</li><li>Add a script and select its language. Use the <code>bao</code> API; direct Node.js and page DOM access are unavailable.</li><li>Enable the capabilities used by your script.</li><li>Run the main entry. Use Stop to cancel it, and inspect the run log for results.</li></ol>
    <pre>{`await bao.time.sleep(1000);
const target = await bao.ocr.findText({ kind: 'text', text: 'Start game', match: 'contains', minConfidence: 0.7 });
if (target) {
  await bao.input.click(target);
  await bao.log.info('Clicked Start game');
}`}</pre>
    <p>Test images and OCR regions before running actions. A returned target carries the frame geometry used to locate it.</p>
  </> },
  { id: 'permissions', title: 'Permissions & sandbox', content: <>
    <h2>Permissions & sandbox</h2><p>Scripts run in a hidden, isolated BrowserWindow with Node.js disabled. Network requests and navigation from the sandbox are blocked. Scripts cannot directly access browser cookies, local storage, IPC or local files.</p>
    <table><thead><tr><th>Capability</th><th>API</th></tr></thead><tbody>
      {['input', 'vision', 'ocr', 'page.read', 'page.navigate', 'log', 'notify'].map((capability) => <tr key={capability}><td><code>{capability}</code></td><td>{capability === 'page.read' ? 'bao.page.url' : capability === 'page.navigate' ? 'bao.page.navigate / reload' : `bao.${capability}.*`}</td></tr>)}
    </tbody></table><p>Permissions are checked at declaration, approval and runtime. Calling an ungranted API produces <code>PERMISSION_DENIED</code>. Time APIs need no capability but still consume the run budget. Long or cancelled runs are terminated.</p>
  </> },
  { id: 'coordinates', title: 'Coordinates', content: <>
    <h2>Coordinates</h2><p>The origin is the top-left corner. X increases to the right and Y downwards. <code>logical</code> coordinates use logical pixels; <code>ratio</code> coordinates express relative positions. Blockly displays relative coordinates on a 0–10000 scale and converts them for the runtime.</p>
    <p>Without a selected game area, coordinates refer to the BrowserView viewport and can move when the window or zoom changes. A bound game area maps coordinates into the selected Flash, Ruffle or Canvas surface and compensates for its position, size and DPR.</p>
    <p>Select the game area in the floating assistant, copy its feature string and import it into the game entry block. Recheck the target after resizing. Keep page coordinates separate from game coordinates.</p>
    <h3>PersistedRegion</h3><p>A region contains <code>unit, x, y, width, height</code>. It bounds image recognition, OCR and color monitoring.</p><pre>{`const region = { unit: 'logical', x: 100, y: 50, width: 200, height: 40 };
const text = await bao.ocr.readText(region);`}</pre>
  </> },
  { id: 'TargetRef', title: 'TargetRef', content: <>
    <h2>TargetRef</h2><p>Input actions accept a target reference that wraps a locator. Optional anchor, offset and selection fields refine the click location. A target found by OCR or image matching also carries frame geometry; pass it directly to input actions.</p>
    <pre>{`await bao.input.click({ locator: { kind: 'coordinate', point: { unit: 'logical', x: 120, y: 80 } } });
const target = await bao.vision.find({ kind: 'image', asset: 'assets/start.png', threshold: 0.85 });
if (target) await bao.input.click(target);`}</pre>
    <p>Do not reuse stale coordinates after navigation or a game-area change. Locate the target again when necessary.</p>
  </> },
  { id: 'Locator', title: 'Locator types', content: <>
    <h2>Locator types</h2><p><code>coordinate</code> specifies a point; <code>image</code> matches an asset or image group; <code>text</code> uses offline OCR; composite locators combine alternatives.</p>
    <pre>{`{ kind: 'coordinate', point: { unit: 'ratio', x: 0.5, y: 0.5 } }
{ kind: 'image', asset: 'assets/button.png', threshold: 0.85 }
{ kind: 'text', text: 'Confirm', match: 'contains', minConfidence: 0.7 }`}</pre>
    <p>Image thresholds and OCR confidence range from 0 to 1. Text supports exact and contains matching. Image assets must belong to the current package. Transparent image masks can exclude background pixels. A language hint does not install a different OCR model.</p>
  </> },
  { id: 'bao.input', title: 'bao.input', content: <>
    <h2>bao.input</h2><p>Requires <code>input</code>. All calls return promises and must be awaited.</p><pre>{`await bao.input.click(target, { button: 'primary', count: 1 });
await bao.input.move(target, { durationMs: 200 });
await bao.input.drag({ from: source, to: destination, durationMs: 500 });
await bao.input.keyPress('A', ['control']);
await bao.input.typeText('Hello', 30);
await bao.input.scroll(0, 300);`}</pre>
    <p>Buttons are primary, middle or secondary. Click count is 1–10. Modifiers include alt, control, meta and shift. Move, click and drag support locator timeouts and polling options. Text input does not submit a form automatically.</p>
  </> },
  { id: 'bao.vision', title: 'bao.vision', content: <>
    <h2>bao.vision</h2><p>Requires <code>vision</code>. <code>find(locator)</code> returns a located target or null; <code>exists(locator)</code> returns a boolean.</p>
    <pre>{`const target = await bao.vision.find({ kind: 'image', asset: 'assets/start.png' });
const visible = await bao.vision.exists({ kind: 'image', asset: 'assets/loading.png' });
await bao.vision.waitForRegionChange(region, { timeoutMs: 10000 });
await bao.vision.waitForColor(region, ['#FBEC00'], { tolerance: 10, timeoutMs: 10000 });`}</pre>
    <p>Region change compares successive captures. Color monitoring tests a region against one or more colors. Configure tolerance, timeout, polling and consecutive frames to avoid reacting to transient changes. Results include timings and matching statistics; successful color matches can include relative match bounds.</p>
  </> },
  { id: 'bao.ocr', title: 'bao.ocr', content: <>
    <h2>bao.ocr</h2><p>Requires <code>ocr</code>. Official packages include offline OCR: Paddle on Windows x64/Linux x64 and Tesseract on Windows ia32. Win32 Tesseract is intended for clear text and numbers; outlined pixel text can fail.</p>
    <pre>{`const target = await bao.ocr.findText({ kind: 'text', text: 'Confirm', match: 'contains', minConfidence: 0.7 });
const text = await bao.ocr.readText(region, 0.5);
const amount = await bao.ocr.readNumber(region);`}</pre>
    <p><code>findText</code> returns a target or null. <code>readText</code> combines recognized text. <code>readNumber</code> parses a numeric value and throws when none is found. Use a tight, clear region and validate the result before performing actions.</p>
  </> },
  { id: 'bao.page', title: 'bao.page', content: <>
    <h2>bao.page</h2><pre>{`const url = await bao.page.url();
await bao.page.navigate('https://example.com/');
await bao.page.reload();`}</pre><p>Reading the URL requires <code>page.read</code>; navigation and reload require <code>page.navigate</code>. Navigation accepts HTTP/HTTPS URLs. Wait for the new page or a known visual condition before interacting.</p>
  </> },
  { id: 'bao.time', title: 'bao.time', content: <>
    <h2>bao.time</h2><pre>{`const started = await bao.time.now();
await bao.time.sleep(1000);`}</pre><p>These APIs require no permission but obey cancellation and budgets. <code>now()</code> returns an epoch timestamp in milliseconds, not a fixed local timezone. Sleep accepts a duration in milliseconds. Prefer waiting for visual conditions when load time varies.</p>
  </> },
  { id: 'bao.log', title: 'bao.log', content: <>
    <h2>bao.log</h2><p>Requires <code>log</code>. Messages appear in the run log; user-authored text is preserved when switching the interface language.</p><pre>{`await bao.log.debug('Debug details');
await bao.log.info('Step completed');
await bao.log.warn('Check the result');
await bao.log.error('Action failed');`}</pre>
  </> },
  { id: 'bao.notify', title: 'bao.notify', content: <>
    <h2>bao.notify</h2><p>Requires <code>notify</code>. The body is optional.</p><pre>{`await bao.notify.show('Automation finished', 'The workflow completed.');`}</pre>
  </> },
  { id: 'budgets', title: 'Budgets & limits', content: <>
    <h2>Budgets & limits</h2><table><thead><tr><th>Limit</th><th>Default</th></tr></thead><tbody>
      {[['maxCalls','10,000'],['maxConcurrentCalls','8'],['deadlineMs','30,000 ms per call'],['timeoutMs','1,800,000 ms per run'],['maxSourceBytes','512 KiB'],['maxRequestBytes','64 KiB'],['maxResultBytes','256 KiB'],['maxStringLength','10,000'],['maxValueDepth','32']].map(([key,value])=><tr key={key}><td><code>{key}</code></td><td>{value}</td></tr>)}
    </tbody></table><p>The table above lists defaults. Long-running packages (for example an unattended 24-hour run) can raise the call and wall-clock budgets in the package manifest: <code>limits: maxCalls 2000000, maxWallTimeMs 86400000</code>. <code>maxExecutedNodes</code> and <code>maxLoopIterations</code> cover Blockly workflows. Declared values are capped at 20,000,000 calls, 7 days and 20,000,000 nodes/iterations; a package exceeding the ceiling, or using an unknown field name, is rejected on import. Fields you omit keep the defaults.</p><p>Click count: 1–10; thresholds: 0–1; colorDelta: 1–255; tolerance: 0–255; consecutive frames: 1–20; color lists: 1–16 entries. Duration options are measured in milliseconds and are also constrained by call and run deadlines. Insert waits in loops.</p>
  </> },
  { id: 'errors', title: 'Error codes', content: <>
    <h2>Error codes</h2><table><thead><tr><th>Code</th><th>Meaning</th></tr></thead><tbody>
      {[['TOKEN_INVALID','The run token is invalid or the run has ended.'],['METHOD_INVALID','The method is unknown or unavailable.'],['PERMISSION_DENIED','Grant the required capability.'],['PAYLOAD_INVALID','Check required fields, types and ranges.'],['BUDGET_EXCEEDED','The call or run exceeded a configured budget.'],['CANCELLED','The run was stopped.'],['BROKER_CLOSED','The run has ended or its broker was closed.'],['CALL_FAILED','The host call failed or exceeded its deadline.']].map(([code,meaning])=><tr key={code}><td><code>{code}</code></td><td>{meaning}</td></tr>)}
    </tbody></table><p>Technical details from the runtime or the script are retained to help diagnose failures. Handle expected errors with try/catch, and avoid repeating actions when their result is uncertain.</p>
  </> },
  { id: 'examples', title: 'Complete examples', content: <>
    <h2>Complete examples</h2><h3>Locate and click, then read a value</h3><pre>{`await bao.time.sleep(500);
const button = await bao.vision.find({ kind: 'image', asset: 'assets/confirm.png', threshold: 0.85 });
if (!button) throw new Error('Confirm button not found');
await bao.input.click(button);
const region = { unit: 'logical', x: 100, y: 50, width: 200, height: 40 };
const count = await bao.ocr.readNumber(region);
await bao.log.info('Count: ' + count);`}</pre><h3>Wait for a color before continuing</h3><pre>{`const region = { unit: 'logical', x: 20, y: 20, width: 200, height: 80 };
await bao.vision.waitForColor(region, ['#FBEC00'], { tolerance: 10, timeoutMs: 30000 });
await bao.notify.show('Ready', 'The expected color was detected.');`}</pre><p>Grant input, vision, OCR, log or notification permissions as used by each example. Adjust assets, text and regions for your page, test recognition first, and use Stop to cancel.</p>
  </> },
];
