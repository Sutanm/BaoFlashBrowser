'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..', '..');
const output = path.join(root, '.cache', 'vision-benchmark', 'corpus');
fs.mkdirSync(output, { recursive: true });

function patterned(width, height, seed) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const hash = (Math.imul(x + seed, 1103515245) ^ Math.imul(y + seed * 3, 12345)) >>> 0;
      pixels[index] = hash & 255;
      pixels[index + 1] = (hash >>> 8) & 255;
      pixels[index + 2] = (hash >>> 16) & 255;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

async function writeRaw(name, pixels, width, height) {
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(path.join(output, name));
}

async function compositeScene(name, width, height, inputs, seed = 1) {
  const base = sharp(patterned(width, height, seed), { raw: { width, height, channels: 4 } });
  await base.composite(inputs).png().toFile(path.join(output, name));
}

async function main() {
  const samples = [];
  const repoScene = path.join(root, 'assets', 'readme', 'automation-workbench.png');
  await sharp(repoScene).extract({ left: 250, top: 115, width: 180, height: 64 }).toFile(path.join(output, 'web-ui-template.png'));
  fs.copyFileSync(repoScene, path.join(output, 'web-ui-scene.png'));
  samples.push({ id: 'web-ui-exact', suite: 'web-ui', scene: 'web-ui-scene.png', templates: ['web-ui-template.png'], threshold: .99, scales: [1], mask: 'none', expected: [{ asset: 'web-ui-template.png', x: 250, y: 115, width: 180, height: 64 }], tolerance: 1 });

  const spriteWidth = 30; const spriteHeight = 24; const sprite = Buffer.alloc(spriteWidth * spriteHeight * 4);
  for (let y = 0; y < spriteHeight; y += 1) for (let x = 0; x < spriteWidth; x += 1) {
    const index = (y * spriteWidth + x) * 4;
    const visible = (x - 14) ** 2 + (y - 11) ** 2 < 90 || (x > 4 && x < 25 && y > 8 && y < 15);
    sprite[index] = 35 + x * 5; sprite[index + 1] = 210 - y * 4; sprite[index + 2] = 70 + y * 6; sprite[index + 3] = visible ? 255 : 0;
  }
  await writeRaw('transparent-sprite.png', sprite, spriteWidth, spriteHeight);
  await compositeScene('transparent-scene.png', 320, 180, [{ input: path.join(output, 'transparent-sprite.png'), left: 213, top: 97 }], 19);
  samples.push({ id: 'transparent-alpha', suite: 'transparent-sprite', scene: 'transparent-scene.png', templates: ['transparent-sprite.png'], threshold: .98, scales: [1], mask: 'auto', expected: [{ asset: 'transparent-sprite.png', x: 213, y: 97, width: spriteWidth, height: spriteHeight }], tolerance: 1 });

  const solid = Buffer.alloc(28 * 18 * 4);
  for (let index = 0; index < solid.length; index += 4) { solid[index] = 88; solid[index + 1] = 88; solid[index + 2] = 88; solid[index + 3] = 255; }
  await writeRaw('low-variance.png', solid, 28, 18);
  await compositeScene('low-variance-scene.png', 300, 170, [{ input: path.join(output, 'low-variance.png'), left: 141, top: 62 }], 33);
  samples.push({ id: 'low-variance', suite: 'low-variance', scene: 'low-variance-scene.png', templates: ['low-variance.png'], threshold: .99, scales: [1], mask: 'none', expected: [{ asset: 'low-variance.png', x: 141, y: 62, width: 28, height: 18 }], tolerance: 1 });

  const repeated = patterned(22, 16, 811);
  await writeRaw('repeated.png', repeated, 22, 16);
  const repeatedPositions = [{ x: 18, y: 22 }, { x: 207, y: 24 }, { x: 119, y: 121 }];
  await compositeScene('repeated-scene.png', 360, 210, repeatedPositions.map((position) => ({ input: path.join(output, 'repeated.png'), left: position.x, top: position.y })), 54);
  samples.push({ id: 'multi-instance', suite: 'multi-instance', scene: 'repeated-scene.png', templates: ['repeated.png'], threshold: .99, scales: [1], mask: 'none', maxCandidates: 10, expected: repeatedPositions.map((position) => ({ asset: 'repeated.png', ...position, width: 22, height: 16 })), tolerance: 1 });
  samples.push({ id: 'roi-multi-instance', suite: 'roi', scene: 'repeated-scene.png', templates: ['repeated.png'], threshold: .99, scales: [1], mask: 'none', region: { x: 180, y: 0, width: 100, height: 80 }, expected: [{ asset: 'repeated.png', x: 207, y: 24, width: 22, height: 16 }], tolerance: 1 });

  const scaleTemplate = patterned(32, 24, 977);
  await writeRaw('scale-template.png', scaleTemplate, 32, 24);
  await sharp(path.join(output, 'scale-template.png')).resize(40, 30, { kernel: 'nearest' }).toFile(path.join(output, 'scale-template-125.png'));
  await sharp({ create: { width: 360, height: 210, channels: 4, background: { r: 28, g: 43, b: 67, alpha: 1 } } })
    .composite([{ input: path.join(output, 'scale-template-125.png'), left: 174, top: 103 }])
    .png().toFile(path.join(output, 'scale-scene.png'));
  samples.push({ id: 'scale-125', suite: 'scale', scene: 'scale-scene.png', templates: ['scale-template.png'], threshold: .75, scales: [.75, 1, 1.25], mask: 'none', expected: [{ asset: 'scale-template.png', x: 174, y: 103, width: 40, height: 30 }], tolerance: 1 });

  await sharp(path.join(output, 'web-ui-template.png')).resize(225, 80, { kernel: 'linear' }).toFile(path.join(output, 'web-ui-template-linear-125.png'));
  await sharp({ create: { width: 460, height: 250, channels: 4, background: { r: 242, g: 245, b: 249, alpha: 1 } } })
    .composite([{ input: path.join(output, 'web-ui-template-linear-125.png'), left: 117, top: 84 }])
    .png().toFile(path.join(output, 'web-ui-scale-linear-scene.png'));
  samples.push({ id: 'web-ui-scale-linear-125', suite: 'scale', scene: 'web-ui-scale-linear-scene.png', templates: ['web-ui-template.png'], threshold: .75, scales: [.75, 1, 1.25], mask: 'none', expected: [{ asset: 'web-ui-template.png', x: 117, y: 84, width: 225, height: 80 }], tolerance: 1 });

  const externalRoot = process.env.BAO_VISION_REAL_CORPUS_DIR || path.join(process.env.USERPROFILE || '', 'Desktop', '钓鱼素材包');
  const fishingScene = path.join(externalRoot, 'PixPin_2026-08-29_14-22-25.png');
  const fishingTemplates = ['收线.png', '上钩.png', '拉杆.png', '赶走.png'];
  if (fs.existsSync(fishingScene) && fishingTemplates.every((name) => fs.existsSync(path.join(externalRoot, name)))) {
    fs.copyFileSync(fishingScene, path.join(output, 'fishing-negative-scene.png'));
    for (const name of fishingTemplates) fs.copyFileSync(path.join(externalRoot, name), path.join(output, `fishing-${name}`));
    samples.push({ id: 'fishing-real-negative', suite: 'real-game-negative', scene: 'fishing-negative-scene.png', templates: fishingTemplates.map((name) => `fishing-${name}`), threshold: .9, scales: [.75, 1, 1.25], mask: 'auto', expected: [], tolerance: 1, source: 'user-fishing-corpus' });
    samples.push({ id: 'fishing-surface-reference-negative', suite: 'surface-reference', scene: 'fishing-negative-scene.png', templates: fishingTemplates.map((name) => `fishing-${name}`), threshold: .9, scales: [1], mask: 'auto', expected: [], tolerance: 1, source: 'user-fishing-corpus' });
    const realTemplate = path.join(output, 'fishing-收线.png');
    await compositeScene('fishing-composite-scene.png', 640, 360, [{ input: realTemplate, left: 417, top: 208 }], 137);
    const metadata = await sharp(realTemplate).metadata();
    samples.push({ id: 'fishing-real-positive', suite: 'real-game-positive', scene: 'fishing-composite-scene.png', templates: ['fishing-收线.png'], threshold: .9, scales: [.75, 1, 1.25], mask: 'auto', expected: [{ asset: 'fishing-收线.png', x: 417, y: 208, width: metadata.width, height: metadata.height }], tolerance: 1, source: 'user-fishing-corpus' });
  }
  const dinosaurScene = path.join(externalRoot, 'PixPin_2026-08-30_18-42-48.png');
  const dinosaurTemplate = path.join(externalRoot, 'PixPin_2026-08-30_18-42-18.png');
  if (fs.existsSync(dinosaurScene) && fs.existsSync(dinosaurTemplate)) {
    fs.copyFileSync(dinosaurScene, path.join(output, 'dinosaur-real-scene.png'));
    fs.copyFileSync(dinosaurTemplate, path.join(output, 'dinosaur-real-template.png'));
    samples.push({ id: 'dinosaur-real-exact', suite: 'real-game-positive', scene: 'dinosaur-real-scene.png', templates: ['dinosaur-real-template.png'], threshold: .9, scales: [.75, 1, 1.25], mask: 'auto', expected: [{ asset: 'dinosaur-real-template.png', x: 123, y: 129, width: 54, height: 46 }], tolerance: 1, source: 'user-fishing-corpus' });
  }

  const referencedFiles = [...new Set(samples.flatMap((sample) => [sample.scene, ...sample.templates]))];
  const rawDirectory = path.join(output, 'raw');
  fs.mkdirSync(rawDirectory, { recursive: true });
  const rawFrames = {};
  for (let index = 0; index < referencedFiles.length; index += 1) {
    const file = referencedFiles[index];
    const decoded = await sharp(path.join(output, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let offset = 0; offset < decoded.data.length; offset += 4) {
      const red = decoded.data[offset]; decoded.data[offset] = decoded.data[offset + 2]; decoded.data[offset + 2] = red;
    }
    const rawFile = `raw/${String(index).padStart(3, '0')}.bgra`;
    fs.writeFileSync(path.join(output, rawFile), decoded.data);
    rawFrames[file] = { file: rawFile, width: decoded.info.width, height: decoded.info.height };
  }
  const manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), rawFrames, samples };
  fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[vision-corpus] ${samples.length} samples -> ${output}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
