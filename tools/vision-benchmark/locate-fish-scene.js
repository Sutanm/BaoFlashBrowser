const sharp = require('sharp');
const path = require('path');

function nccBest(frame, fw, fh, tpl, tw, th) {
  let best = { x: 0, y: 0, score: -Infinity };
  let tSum = 0; for (let i = 0; i < tpl.length; i++) tSum += tpl[i];
  const tMean = tSum / tpl.length;
  let tVar = 0; for (let i = 0; i < tpl.length; i++) tVar += (tpl[i] - tMean) ** 2;
  const step = 2;
  for (let y = 0; y <= fh - th; y += step) for (let x = 0; x <= fw - tw; x += step) {
    let s = 0, s2 = 0, s4 = 0;
    for (let j = 0; j < th; j++) { const row = (y + j) * fw + x; for (let i = 0; i < tw; i++) { const fv = frame[row + i], tv = tpl[j * tw + i]; s += fv * tv; s2 += fv; s4 += fv * fv; } }
    const n = tw * th;
    const denom = Math.sqrt((s4 - s2 * s2 / n) * tVar);
    const sc = denom > 1e-6 ? (s - s2 * tMean) / denom : 0;
    if (sc > best.score) best = { x, y, score: sc };
  }
  return best;
}

async function gray(file) {
  const { data, info } = await sharp(file).greyscale().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { buf: data, w: info.width, h: info.height };
}

async function main() {
  const scene = path.join(process.env.USERPROFILE, 'Desktop', '钓鱼素材包', '钓鱼场景-夜.png');
  const fish = path.join(process.env.USERPROFILE, 'Desktop', '钓鱼素材包', '鱼-二次扣图.png');
  // Downscale scene to ~640 wide for a fast coarse pass.
  const coarseW = 640;
  const sceneM = await sharp(scene).greyscale().resize({ width: coarseW }).raw().toBuffer({ resolveWithObject: true });
  const fw = sceneM.info.width, fh = sceneM.info.height;
  const sceneScale = fw / (await sharp(scene).metadata()).width;
  // fish template: try a few scales (fish in scene is larger than 48px asset). Coarse scene 640 wide.
  const scans = [];
  const tplScale = [2.5, 3.0, 3.5].map((x) => x * sceneScale);
  for (const ts of tplScale) {
    const fshW = Math.max(8, Math.round(48 * ts)), fshH = Math.max(6, Math.round(36 * ts));
    const t = await sharp(fish).greyscale().removeAlpha().resize({ width: fshW, height: fshH }).raw().toBuffer({ resolveWithObject: true });
    const r = nccBest(sceneM.data, fw, fh, t.data, t.info.width, t.info.height);
    scans.push({ ts, w: t.info.width, h: t.info.height, x: r.x, y: r.y, score: r.score });
    console.log(`coarse tplScale=${ts.toFixed(2)} (${t.info.width}x${t.info.height}) best @(${r.x},${r.y}) score=${r.score.toFixed(3)}`);
  }
  const best = scans.sort((a, b) => b.score - a.score)[0];
  console.log('\n最佳粗匹配:', JSON.stringify({ ts: best.ts, score: best.score, coarseXY: [best.x, best.y] }));
  // map back to full-res
  const fullX = Math.round(best.x / sceneScale), fullY = Math.round(best.y / sceneScale);
  const fullW = Math.round(48 * best.ts / sceneScale);
  console.log('映射回全分辨率: 鱼左上≈(' + fullX + ',' + fullY + ') 尺寸≈' + fullW + 'x' + Math.round(36 * best.ts / sceneScale));
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
