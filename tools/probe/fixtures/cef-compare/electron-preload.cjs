'use strict';

const { ipcRenderer } = require('electron');

ipcRenderer.on('cef-frame', (_event, bgra) => {
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = new Uint8ClampedArray(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = 255;
  }
  ctx.putImageData(new ImageData(rgba, canvas.width, canvas.height), 0, 0);
  const [r, g, b] = ctx.getImageData(250, 210, 1, 1).data;
  ipcRenderer.send('cef-drawn', (r << 16) | (g << 8) | b);
});
