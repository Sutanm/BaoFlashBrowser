import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { areColorPointMatchesSameObject, extractColorPointSignature, matchColorPointSignature, type BgraImage } from '../../src/main/modules/automation/color-point-matcher';
import { selectStructureProposals, verifyColorPointStructure } from '../../src/main/modules/automation/color-structure-verifier';

const root = path.resolve(__dirname, '..', '..');
const corpus = process.env.BAO_VISION_REAL_CORPUS_DIR
  || path.join(process.env.USERPROFILE || '', 'Desktop', '钓鱼素材包');
const scales = [.5, .6, 2 / 3, .75, .8, 1, 1.25, 1.5, 1.75, 2] as const;

type Case = {
  readonly id: string;
  readonly scene: string;
  readonly template: string;
  readonly present: boolean;
  readonly expected?: { readonly x: number; readonly y: number; readonly radius: number };
};

const cases: readonly Case[] = [
  { id: 'hook-day', scene: '钓鱼场景-日.png', template: '鱼钩.png', present: true, expected: { x: 1410, y: 365, radius: 45 } },
  { id: 'hook-night', scene: '钓鱼场景-夜.png', template: '鱼钩.png', present: true, expected: { x: 1119, y: 527, radius: 55 } },
  { id: 'hook-night-negative', scene: '钓鱼场景-夜2.png', template: '鱼钩.png', present: false },
  { id: 'hook-day-hard-negative', scene: '钓鱼场景-日3.png', template: '鱼钩.png', present: false },
];

async function load(file: string): Promise<BgraImage> {
  const decoded = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    const red = decoded.data[offset]; decoded.data[offset] = decoded.data[offset + 2]; decoded.data[offset + 2] = red;
  }
  return { pixels: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

function isExpected(candidate: { x: number; y: number }, item: Case): boolean {
  return item.present && item.expected !== undefined
    && Math.hypot(candidate.x - item.expected.x, candidate.y - item.expected.y) <= item.expected.radius;
}

async function main() {
  const results = [];
  for (const item of cases) {
    const scenePath = path.join(corpus, item.scene); const templatePath = path.join(corpus, item.template);
    if (!fs.existsSync(scenePath)) { console.warn(`skip missing ${scenePath}`); continue; }
    const scene = await load(scenePath); const template = await load(templatePath);
    const proposalStarted = performance.now();
    const proposals = matchColorPointSignature(scene, extractColorPointSignature(template), {
      scales, tolerance: 70, threshold: .15, maxCandidates: 40, maxVerificationCandidates: 160,
      preserveScaleHypotheses: true,
    });
    const proposalMs = performance.now() - proposalStarted;
    const verified = selectStructureProposals(proposals).map((proposal) => ({
      proposal,
      expected: isExpected(proposal, item),
      verification: verifyColorPointStructure(scene, template, proposal),
    })).sort((left, right) => right.verification.structureScore - left.verification.structureScore);
    const distinct = verified.filter((candidate, index) => !verified.slice(0, index)
      .some((stronger) => areColorPointMatchesSameObject(stronger.proposal, candidate.proposal)));
    const margin = (distinct[0]?.verification.structureScore ?? 0) - (distinct[1]?.verification.structureScore ?? 0);
    const accepted = (distinct[0]?.verification.structureScore ?? 0) >= .30 && margin >= .05 ? distinct[0] : undefined;
    const correct = item.present ? accepted?.expected === true : accepted === undefined;
    results.push({ ...item, proposalMs, accepted, margin, correct, distinct, verified });
    console.log(`\n${item.id}: proposals=${proposals.length}, proposal=${proposalMs.toFixed(1)}ms`);
    for (const [index, result] of verified.entries()) {
      const v = result.verification; const p = result.proposal;
      console.log(`${index + 1}. ${result.expected ? 'TARGET' : 'other '} (${p.x},${p.y}) scale=${p.scale.toFixed(3)} color=${p.score.toFixed(3)} structure=${v.structureScore.toFixed(3)} coverage=${v.colorCoverage.toFixed(3)} precision=${v.silhouettePrecision.toFixed(3)} iou=${v.silhouetteIou.toFixed(3)} chroma=${v.chromaCorrelation.toFixed(3)} edge=${v.edgeSimilarity.toFixed(3)} ${v.verifyMs.toFixed(2)}ms`);
    }
    console.log(`decision=${accepted ? `${accepted.proposal.x},${accepted.proposal.y}` : 'reject'} margin=${margin.toFixed(3)} ${correct ? 'OK' : 'BAD'}`);
  }
  const output = path.join(root, '.cache', 'vision-benchmark', `structure-poc-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  fs.writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, corpus, scales, results }, null, 2)}\n`);
  console.log(`\nDetailed result: ${output}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
