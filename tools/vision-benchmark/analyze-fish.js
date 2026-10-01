const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const dir = path.join(process.env.TEMP || '/tmp', 'fish-frames');
const PINK = (r, g, b) => r > 200 && g < 190 && b > 120 && b < 190;

async function pinkX(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    if (PINK(data[i], data[i + 1], data[i + 2])) { sx += x; sy += y; n++; }
  }
  return { x: n > 0 ? sx / n : -1, y: n > 0 ? sy / n : -1, n };
}

async function analyze(set, label) {
  const files = fs.readdirSync(path.join(dir, set)).filter((f) => f.endsWith('.png')).sort();
  const pts = [];
  for (const f of files) { pts.push(await pinkX(path.join(dir, set, f))); }
  console.log(`\n=== ${label}: pink centroid X over time (fps=24) ===`);
  const rows = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const bar = p.x >= 0 ? '#'.repeat(Math.max(1, Math.round(p.x / 3))) : '(none)';
    rows.push(`f${String(i).padStart(3)} t=${(i / 24).toFixed(2)} x=${p.x.toFixed(1).padStart(6)} y=${p.y.toFixed(1).padStart(6)} n=${String(p.n).padStart(4)} |${bar}`);
  }
  console.log(rows.join('\n'));
}

(async () => { await analyze('adult', 'ADULT'); await analyze('young', 'YOUNG'); })().catch((e) => { console.error('ERR', e.stack || e.message); process.exitCode = 1; });
