const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { extractColorPointSignature, matchColorPointSignature } = require(path.join(__dirname, '..', '..', '.cache', 'vision-benchmark', 'color-lib.cjs'));

const dir = path.join(process.env.TEMP || '/tmp', 'fish-frames');
const base = path.join(process.env.USERPROFILE, 'Desktop', '钓鱼素材包');
const FPS = 24;

async function loadBgra(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = Buffer.from(data); for (let i = 0; i < b.length; i += 4) { const r = b[i]; b[i] = b[i + 2]; b[i + 2] = r; }
  return { pixels: new Uint8Array(b), width: info.width, height: info.height };
}
async function locateFish(file, fishSig) {
  const img = await loadBgra(file);
  const m = matchColorPointSignature(img, fishSig, { threshold: 0, mirror: false, scales: [1, 1.5, 2], maxCandidates: 1 })[0];
  return m && m.score > 0.3 ? { x: m.x, y: m.y, score: m.score } : null;
}

async function analyze(set, hookX, label, fishSig) {
  const files = fs.readdirSync(path.join(dir, set)).filter((f) => f.endsWith('.png')).sort();
  const pts = [];
  for (const f of files) { pts.push(await locateFish(path.join(dir, set, f), fishSig)); }
  // reliable fish trajectory (only strong frames)
  const reliable = pts.map((p, i) => ({ t: i / FPS, ...p })).filter((p) => p.x != null);
  // Determine the actual travel range from reliable points in the first 3s (free swim period)
  const early = reliable.filter((p) => p.t < 3.5);
  const minX = Math.min(...early.map((p) => p.x)); const maxX = Math.max(...early.map((p) => p.x));
  // Crossings of hookX (any direction), from reliable frames, recording direction
  const crossing = [];
  for (let i = 1; i < reliable.length; i++) {
    const a = reliable[i - 1], b = reliable[i];
    if ((a.x - hookX) * (b.x - hookX) <= 0) crossing.push({ t: b.t, dir: b.x > a.x ? 'R' : 'L' });
  }
  console.log(`\n=== ${label}: 鱼钩x=${hookX} ===`);
  console.log(`可靠往返范围(前3.5s): x [${minX.toFixed(0)}, ${maxX.toFixed(0)}]  范围宽=${(maxX - minX).toFixed(0)}px`);
  console.log(`穿越鱼钩x的时刻(${crossing.length}次):`);
  const times = [];
  for (const c of crossing) { if (c.t > 5.5) break; times.push({ t: c.t, dir: c.dir }); }
  console.log(times.map((c) => `t=${c.t.toFixed(2)} ${c.dir}`).join('  '));
  // half-period = gap between consecutive crossings; full period = gap between same-direction crossings
  const gaps = []; for (let i = 1; i < times.length; i++) gaps.push(times[i].t - times[i - 1].t);
  const sameDir = []; for (let i = 2; i < times.length; i++) if (times[i].dir === times[i - 2].dir) sameDir.push(times[i].t - times[i - 2].t);
  const avg = (a) => a.length ? (a.reduce((s, v) => s + v, 0) / a.length) : 0;
  console.log(`相邻穿越间隔(半周期): ${gaps.filter((g) => g > 0.2).map((g) => g.toFixed(2) + 's').join(', ')}  avg=${avg(gaps.filter((g) => g > 0.2)).toFixed(2)}s`);
  console.log(`同方向穿越间隔(完整周期): ${sameDir.map((g) => g.toFixed(2) + 's').join(', ')}  avg=${avg(sameDir).toFixed(2)}s`);
}

(async () => {
  const img = await loadBgra(path.join(base, '鱼-二次扣图.png'));
  const fishSig = extractColorPointSignature(img);
  await analyze('adult', 105, 'ADULT 成年鱼', fishSig);
  await analyze('young', 93, 'YOUNG 幼年鱼', fishSig);
})().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
