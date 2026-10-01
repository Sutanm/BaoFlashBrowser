const sharp = require('sharp');
const path = require('path');
const { extractColorPointSignature, matchColorPointSignature } = require('./../../.cache/vision-benchmark/color-lib.cjs');

async function loadBgra(file, { width, height } = {}) {
  let img = sharp(file).ensureAlpha();
  if (width && height) img = img.resize({ width, height });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const bgra = Buffer.from(data);
  for (let i = 0; i < bgra.length; i += 4) { const r = bgra[i]; bgra[i] = bgra[i + 2]; bgra[i + 2] = r; }
  return { pixels: new Uint8Array(bgra), width: info.width, height: info.height };
}

async function main() {
  const base = path.join(process.env.USERPROFILE, 'Desktop', '钓鱼素材包');
  const fish = await loadBgra(path.join(base, '鱼-二次扣图.png'));
  console.log('鱼素材', fish.width + 'x' + fish.height);
  const sig = extractColorPointSignature(fish);
  console.log('签名特征点数:', sig.features.length, ' sourceSize', sig.sourceWidth + 'x' + sig.sourceHeight);

  const scene = await loadBgra(path.join(base, '钓鱼场景-日.png'), { width: 1280 });
  console.log('场景', scene.width + 'x' + scene.height);

  // multi-point color locate at several scales (fish likely larger than 48px in 1280-wide scene)
  for (const scale of [1, 1.5, 2, 2.5, 3]) {
    const matches = matchColorPointSignature(scene, sig, { threshold: 0, mirror: false, scales: [scale], maxCandidates: 5 });
    const top = matches[0];
    console.log(`scale=${scale}: ${matches.length} candidates, top=${top ? `score=${top.score.toFixed(3)} @(${Math.round(top.x)},${Math.round(top.y)}) size=${top.width}x${top.height}` : 'none'}`);
    if (matches.length > 1) console.log(`   次佳: ${matches.slice(1, 3).map((m) => `score=${m.score.toFixed(3)}@(${Math.round(m.x)},${Math.round(m.y)})`).join(' ')}`);
  }
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
