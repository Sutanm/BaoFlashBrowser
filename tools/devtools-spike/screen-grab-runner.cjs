/**
 * 抓屏小工具（窗口模式）：用 desktopCapturer 抓「应用窗口」的合成结果，
 * 而不是全屏——更快，也直接包含原生视图（BrowserView）的画面。
 */
const { app, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', '..', 'artifacts', 'dragcap');
const DURATION_MS = Number(process.env.BFB_GRAB_MS || 4000);
const NAME_HINT = process.env.BFB_GRAB_NAME || '';

fs.mkdirSync(OUT, { recursive: true });

app.whenReady().then(async () => {
  const startedAt = Date.now();
  let n = 0;
  let listed = false;
  while (Date.now() - startedAt < DURATION_MS) {
    const t0 = Date.now();
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1280, height: 800 } });
      if (!listed) {
        listed = true;
        console.log('[grab] windows: ' + sources.map((s) => s.name).join(' | ').slice(0, 300));
      }
      const hit = sources.find((s) => NAME_HINT && s.name.includes(NAME_HINT)) || sources[0];
      if (hit && !hit.thumbnail.isEmpty()) {
        fs.writeFileSync(path.join(OUT, `cap-${t0}.png`), hit.thumbnail.toPNG());
        n += 1;
      }
    } catch (e) {
      console.log('[grab] err ' + e.message);
    }
    const spent = Date.now() - t0;
    if (spent < 40) await new Promise((r) => setTimeout(r, 40 - spent));
  }
  console.log('[grab] done frames=' + n);
  app.exit(0);
});
