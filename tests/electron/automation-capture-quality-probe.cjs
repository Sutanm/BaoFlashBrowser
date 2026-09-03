/**
 * Capture-quality probe: quantify where authoring screenshots lose pixels.
 *
 * The authoring pipeline uses a FIXED 1280x720 logical canvas while the page
 * actually renders at innerWidth x innerHeight on a DPR-scaled display. This
 * probe reproduces the exact capture calls BrowserViewCaptureService makes and
 * prints every intermediate size so we can see which step shrinks the image:
 *
 *   1) raw wc.capturePage()                         -> native output
 *   2) incrementCapturerCount(1280x720) then capture -> does the requested
 *      size make the compositor render at a lower resolution?
 *   3) requested inner-CSS size (what a window-following fix would ask for)
 *
 * Run: npx electron tests/electron/automation-capture-quality-probe.cjs
 * Optional: BAO_PROBE_DPR=1.5 to force a device scale factor.
 */
const { app, BrowserView, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
const forcedDpr = process.env.BAO_PROBE_DPR;
if (forcedDpr) app.commandLine.appendSwitch('force-device-scale-factor', forcedDpr);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});

const ROOT = process.env.BAO_PROBE_ROOT
  ? path.resolve(process.env.BAO_PROBE_ROOT)
  : path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT, 'release', 'automation-probe');
const HOST_CSS = { width: 1536, height: 864 };
const timeout = setTimeout(() => { console.error('[capture-quality] FAIL: timed out'); app.exit(1); }, 60_000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageUrl() {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#10233d}
    canvas{display:block}
  </style><canvas></canvas><script>
    const cv=document.querySelector('canvas');const ctx=cv.getContext('2d');
    function resize(){cv.width=innerWidth;cv.height=innerHeight;draw();}
    function draw(){
      ctx.fillStyle='#10233d';ctx.fillRect(0,0,cv.width,cv.height);
      ctx.fillStyle='#ffffff';
      ctx.font='16px monospace';
      ctx.fillText(innerWidth+'x'+innerHeight+' dpr='+devicePixelRatio, 12, 22);
      ctx.strokeStyle='#ffd23e';ctx.lineWidth=1;
      for(let x=0;x<=cv.width;x+=1)ctx.beginPath(),ctx.moveTo(x+0.5,0),ctx.lineTo(x+0.5,cv.height),ctx.stroke();
      for(let y=0;y<=cv.height;y+=1)ctx.beginPath(),ctx.moveTo(0,y+0.5),ctx.lineTo(cv.width,y+0.5),ctx.stroke();
      ctx.fillStyle='#20e080';ctx.fillRect(600,400,260,180);
      ctx.fillStyle='#e85d75';ctx.fillRect(700,500,80,80);
    }
    addEventListener('resize',resize);resize();
  <\/script>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function capture(wc, opts = {}) {
  const { countSize, rect } = opts;
  if (countSize) wc.incrementCapturerCount(countSize);
  try {
    const t0 = Date.now();
    const image = await wc.capturePage(rect);
    return { image, ms: Date.now() - t0 };
  } finally {
    if (countSize) wc.decrementCapturerCount();
  }
}

function stats(image) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  // 统计非背景像素数作为"信息量"代理
  let detail = 0;
  for (let i = 0; i < bitmap.length; i += 16) {
    const b = bitmap[i]; const g = bitmap[i + 1]; const r = bitmap[i + 2];
    if (!(b > 45 && b < 75 && g > 20 && g < 50 && r < 30)) detail += 1;
  }
  return { size, detail };
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const host = new BrowserWindow({ show: true, width: HOST_CSS.width + 80, height: HOST_CSS.height + 120, backgroundColor: '#080b12' });
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true, plugins: false, backgroundThrottling: false } });
  host.addBrowserView(view);
  const wc = view.webContents;
  view.setBounds({ x: 0, y: 0, ...HOST_CSS });
  await wc.loadURL(pageUrl());
  await delay(400);

  const metrics = await wc.executeJavaScript(`({innerWidth,innerHeight,devicePixelRatio,zoom:${'document'}.documentElement.clientWidth})`);

  const out = { metrics: { ...metrics, hostContent: host.getContentSize() }, captures: {} };

  // A: 原生直采(系统截图软件的等效路径)
  {
    const { image } = await capture(wc);
    out.captures.native = { ...stats(image), saved: 'native.png' };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'capture-native.png'), image.toPNG());
  }

  // B: 模拟 CaptureService 现状 —— incrementCapturerCount({1280x720})
  {
    const { image } = await capture(wc, { countSize: { width: 1280, height: 720 } });
    out.captures.requested1280 = { ...stats(image), saved: 'requested1280.png' };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'capture-requested1280.png'), image.toPNG());
  }

  // C: 请求 inner-CSS 尺寸(窗口跟随方案的等效路径)
  {
    const { image } = await capture(wc, { countSize: { width: metrics.innerWidth, height: metrics.innerHeight } });
    out.captures.requestedCss = { ...stats(image), saved: 'requestedCss.png' };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'capture-requestedCss.png'), image.toPNG());
  }

  // D: region 截取对比 —— 直接 rect 物理 vs CaptureService 归一化(缩到 css region)
  const region = { x: 580, y: 380, width: 320, height: 220 };
  {
    const { image } = await capture(wc, { rect: region });
    out.captures.regionNative = { ...stats(image), saved: 'region-native.png' };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'capture-region-native.png'), image.toPNG());
  }

  // 理论缩放损失:若产物被 resize 到固定 1280x720
  const native = out.captures.native.size;
  out.resizedTo1280LossPct = +(1 - (1280 * 720) / (native.width * native.height) * 100).toFixed(1);

  fs.writeFileSync(path.join(OUTPUT_DIR, 'capture-quality-result.json'), JSON.stringify(out, null, 2));
  console.log('[capture-quality] RESULT', JSON.stringify(out));
  clearTimeout(timeout);
  host.destroy();
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('[capture-quality] FAIL:', error && error.stack ? error.stack : String(error));
  app.exit(1);
});
