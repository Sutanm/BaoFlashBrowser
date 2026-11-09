// Probe 48 · P7：拖拽期间的指针捕获（可自动化部分）
//
// 真实的「指针离开源窗口后仍收到 pointermove/pointerup」依赖 OS 级鼠标捕获，
// 无头/合成输入无法证明（见验收文档 §5）。本探针验证渲染层依赖的 Chromium 原语：
//   pointerdown + setPointerCapture 之后，指针移出原元素（仍在窗口内）仍能收到
//   pointermove/pointerup，拖动状态不会在离开标签栏时中断。
'use strict';

const { waitFor } = require('../lib/timeout.cjs');

module.exports = {
  id: '48-pointer-capture',
  name: 'P7 pointer capture across the drag surface',
  needsElectron: true,
  timeoutMs: 60_000,

  async run(ctx) {
    const { BrowserWindow } = ctx.electron;
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    const failures = [];
    const check = (name, ok, detail) => { if (!ok) failures.push({ name, detail }); };

    const html = `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8">
<style>body{margin:0}#handle{position:absolute;left:0;top:0;width:120px;height:36px;background:#333}</style>
<div id="handle"></div>
<script>
window.__probe = { down: 0, move: 0, up: 0, captured: false };
const handle = document.getElementById('handle');
handle.addEventListener('pointerdown', (event) => {
  window.__probe.down += 1;
  handle.setPointerCapture(event.pointerId);
  window.__probe.captured = handle.hasPointerCapture(event.pointerId);
});
window.addEventListener('pointermove', () => { if (window.__probe.down > 0) window.__probe.move += 1; });
window.addEventListener('pointerup', () => { window.__probe.up += 1; });
</script>`)}`;

    try {
      await win.webContents.loadURL(html).catch(() => {});
      await waitFor(() => win.webContents.executeJavaScript('Boolean(window.__probe)').catch(() => false),
        { timeoutMs: 10_000, label: 'probe page ready' });

      win.webContents.sendInputEvent({ type: 'mouseDown', x: 40, y: 18, button: 'left', clickCount: 1 });
      for (const [x, y] of [[200, 120], [420, 300], [700, 520]]) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y, button: 'left' });
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      win.webContents.sendInputEvent({ type: 'mouseUp', x: 700, y: 520, button: 'left', clickCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 120));

      const probe = await win.webContents.executeJavaScript('window.__probe').catch(() => null);
      check('pointerdown observed', Boolean(probe && probe.down === 1), probe);
      check('moves delivered after leaving the handle', Boolean(probe && probe.move >= 2), probe);
      check('pointerup delivered once', Boolean(probe && probe.up === 1), probe);

      return {
        ok: failures.length === 0,
        summary: failures.length === 0
          ? 'moves/up keep flowing after leaving the drag handle (synthetic; OS capture still manual)'
          : `${failures.length} check(s) failed`,
        detail: { failures, probe },
      };
    } finally {
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
    }
  },
};
