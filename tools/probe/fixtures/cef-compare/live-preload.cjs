'use strict';

const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.querySelector('canvas');
  const ime = document.querySelector('textarea');
  const ctx = canvas.getContext('2d');
  let image;

  for (const [eventName, type] of [['mousemove', 'move'], ['mousedown', 'down'], ['mouseup', 'up']]) {
    canvas.addEventListener(eventName, (event) => {
      if (type === 'down') canvas.focus();
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor((event.clientX - rect.x) * canvas.width / rect.width);
      const y = Math.floor((event.clientY - rect.y) * canvas.height / rect.height);
      ipcRenderer.send('cef-live-input', 'mouse', type, x, y);
    });
  }
  for (const [eventName, type] of [['keydown', 'down'], ['keyup', 'up']]) {
    canvas.addEventListener(eventName, (event) => {
      event.preventDefault();
      ipcRenderer.send('cef-live-input', 'key', type, event.keyCode);
    });
  }
  for (const [eventName, type] of [['compositionupdate', 'update'], ['compositionend', 'commit']]) {
    ime.addEventListener(eventName, (event) => {
      const units = event.data.split('').map((character) => character.charCodeAt(0).toString(16));
      ipcRenderer.send('cef-live-input', 'ime', type, ...units);
    });
  }

  ipcRenderer.on('cef-live-frame', (_event, sequence, width, height, bgra) => {
    const start = performance.now();
    if (!image || image.width !== width || image.height !== height) {
      canvas.width = width;
      canvas.height = height;
      image = ctx.createImageData(width, height);
    }
    const rgba = image.data;
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i + 2];
      rgba[i + 1] = bgra[i + 1];
      rgba[i + 2] = bgra[i];
      rgba[i + 3] = 255;
    }
    const converted = performance.now();
    ctx.putImageData(image, 0, 0);
    const drawn = performance.now();
    const p = (210 * canvas.width + 250) * 4;
    const color = (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
    let hash = 0;
    for (let y = 12; y < 360; y += 13) {
      for (let x = 12; x < canvas.width; x += 17) {
        const i = (y * canvas.width + x) * 4;
        hash = Math.imul(hash ^ ((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]), 16777619);
      }
    }
    let shipX = null;
    if (width === 640 && height === 480) {
      let longest = 9;
      // FlxInvaders' player is the white 24x16 sprite in this band.
      for (let y = 464; y < 472; y++) {
        let run = 0;
        for (let x = 0; x <= width; x++) {
          const i = (y * width + x) * 4;
          if (x < width && Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) > 240) {
            run++;
            continue;
          }
          if (run > longest && run <= 26) {
            longest = run;
            shipX = x - (run + 1) / 2;
          }
          run = 0;
        }
      }
    }
    ipcRenderer.send('cef-live-drawn', sequence, color, hash, shipX, {
      convertMs: converted - start,
      drawMs: drawn - converted,
      rendererMs: performance.now() - start,
    });
  });
});
