/**
 * 最小探针：只回答一个问题——抓帧成本跟面积走吗？
 *
 * 用 incrementCapturerCount(size, stayHidden) 的尺寸提示，比较 capturePage 返回的
 * 图像尺寸与耗时。如果三种尺寸耗时接近，说明抓帧成本是"固定开销"，缩略抓帧没有意义。
 *
 * 跑法：npx electron tools/automation-probe/thumbnail-gate.cjs
 * 前置：清掉 ELECTRON_RUN_AS_NODE（否则 Electron 会退化成纯 Node）。
 */
const { app, BrowserView, BrowserWindow } = require('electron');
require('../../tests/electron/isolate-user-data.cjs')(app, 'thumbnail-gate-probe');
const path = require('path');
const { pathToFileURL } = require('url');

app.commandLine.appendSwitch('disable-renderer-backgrounding');

const FIXTURE = path.join(__dirname, 'fixtures', 'thumbnail-gate.html');
const VIEWPORT = { width: 960, height: 600 };
const SAMPLES = 5;

const say = (text) => { process.stdout.write(`${text}\n`); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const watchdog = setTimeout(() => {
  say('FAIL: 超时');
  app.exit(1);
}, 60000);

async function captureOnce(wc, hint) {
  const startedAt = process.hrtime.bigint();
  wc.incrementCapturerCount(hint || undefined, hint ? true : false);
  try {
    const image = await wc.capturePage();
    return {
      elapsed: Number(process.hrtime.bigint() - startedAt) / 1e6,
      size: image.getSize(),
    };
  } finally {
    wc.decrementCapturerCount(hint ? true : false);
  }
}

app.whenReady().then(async () => {
  say('ready');
  const win = new BrowserWindow({ show: true, width: 980, height: 660 });
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, plugins: false,
      partition: 'persist:thumbnail-gate', backgroundThrottling: false,
    },
  });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  await wc.loadURL(pathToFileURL(FIXTURE).href);
  say('loaded');
  await delay(1200);

  const modes = [
    { label: 'full   ', hint: null },
    { label: 'half   ', hint: { width: VIEWPORT.width / 2, height: VIEWPORT.height / 2 } },
    { label: 'quarter', hint: { width: VIEWPORT.width / 4, height: VIEWPORT.height / 4 } },
  ];

  say('\n模式      返回尺寸      中位耗时   最小   最大');
  for (const mode of modes) {
    await captureOnce(wc, mode.hint); // 预热
    const times = [];
    let size = { width: 0, height: 0 };
    for (let index = 0; index < SAMPLES; index += 1) {
      const shot = await captureOnce(wc, mode.hint);
      times.push(shot.elapsed);
      size = shot.size;
    }
    say(`${mode.label}  ${String(size.width).padStart(5)}x${String(size.height).padStart(4)}   ${median(times).toFixed(2).padStart(7)} ms  ${Math.min(...times).toFixed(2).padStart(6)}  ${Math.max(...times).toFixed(2).padStart(6)}`);
  }

  clearTimeout(watchdog);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  say(`FAIL: ${error && error.stack ? error.stack : error}`);
  app.exit(1);
});
