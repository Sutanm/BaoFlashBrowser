import { app, BrowserView, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { AutomationRunner } from '../../src/main/modules/automation/runtime';
import {
  BrowserViewAutomationDriver,
  type AutomationWebContentsLike,
} from '../../src/main/modules/automation/browserview-driver';
import {
  CachingAutomationTemplateProvider,
  OpenCvWorkerMatcher,
  type AutomationTemplateProvider,
} from '../../src/main/modules/automation/vision-worker-matcher';
import type { AutomationWorkflow } from '../../src/shared/automation/types';

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'tools', 'automation-probe', 'fixtures', 'input-target.html');
const OUTPUT_DIR = path.join(ROOT, 'release', 'automation-probe');
const VIEWPORT = { width: 900, height: 560 };
const timeout = setTimeout(() => { console.error('[automation-m2-visual] FAIL: timed out'); app.exit(1); }, 60_000);

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 960, height: 640,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, plugins: false,
      partition: 'persist:automation-m2-visual', backgroundThrottling: false,
    },
  });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  const fixtureUrl = pathToFileURL(FIXTURE).href;

  await wc.loadURL(`${fixtureUrl}?x=420&y=245`);
  await delay(200);
  const baselineState = await wc.executeJavaScript('window.__automationProbe.snapshot()');
  wc.incrementCapturerCount();
  const baseline = await wc.capturePage();
  wc.decrementCapturerCount();
  const baselineSize = baseline.getSize();
  const scaleX = baselineSize.width / VIEWPORT.width;
  const scaleY = baselineSize.height / VIEWPORT.height;
  const rect = baselineState.targetRect as { x: number; y: number; width: number; height: number };
  const template = baseline.crop({
    x: Math.round(rect.x * scaleX), y: Math.round(rect.y * scaleY),
    width: Math.round(rect.width * scaleX), height: Math.round(rect.height * scaleY),
  });
  const templateSize = template.getSize();
  const source: AutomationTemplateProvider = {
    async load() {
      return {
        cacheKey: 'm2-target@1', width: templateSize.width, height: templateSize.height,
        bgra: Uint8Array.from(template.toBitmap()),
      };
    },
  };
  const matcher = new OpenCvWorkerMatcher(new CachingAutomationTemplateProvider(source), {
    workerPath: path.join(__dirname, 'vision-worker.cjs'), requestTimeoutMs: 20_000,
  });
  const driver = new BrowserViewAutomationDriver(
    wc as unknown as AutomationWebContentsLike,
    matcher,
    { getCssViewport: () => VIEWPORT },
  );
  const workflow: AutomationWorkflow = {
    formatVersion: 2, id: 'm2-visual', name: 'M2 visual loop',
    root: { type: 'sequence', steps: [{
      type: 'click-image', asset: 'target.png', threshold: 0.9,
      region: { x: 50, y: 300, width: 400, height: 220 }, scales: [1], mask: 'none',
    }] },
  };

  await wc.loadURL(`${fixtureUrl}?x=105&y=365`);
  await delay(200);
  win.minimize();
  await delay(600);
  const matches: Array<{ score: number; x: number; y: number; matchMs?: number }> = [];
  const runner = new AutomationRunner(workflow, driver, {
    onEvent: (event) => {
      if (event.type === 'image-match') matches.push({
        score: event.match.score, x: event.match.x, y: event.match.y, matchMs: event.match.matchMs,
      });
    },
  });
  await runner.run();
  await delay(150);
  const after = await wc.executeJavaScript('window.__automationProbe.snapshot()');
  if (after.clicks !== 1 || after.targetTrusted !== 'true') throw new Error(`visual driver click failed: ${JSON.stringify(after)}`);
  if (wc.debugger.isAttached()) throw new Error('debugger remained attached');

  wc.incrementCapturerCount();
  const evidence = await wc.capturePage();
  wc.decrementCapturerCount();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'm2-visual-after.png'), evidence.toPNG());
  const result = {
    minimized: win.isMinimized(), matches, clicked: after.clicks === 1,
    trusted: after.targetTrusted, debuggerDetached: !wc.debugger.isAttached(),
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'm2-visual-result.json'), JSON.stringify(result, null, 2));
  console.log('[automation-m2-visual] PASS', JSON.stringify(result));
  await matcher.close();
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('[automation-m2-visual] FAIL:', error instanceof Error ? error.stack : String(error));
  app.exit(1);
});
