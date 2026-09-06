import { describe, expect, it } from 'vitest';
import { evaluateColorGate } from '../src/main/modules/automation/color-point-tracker';
import type { ColorPointMatch } from '../src/main/modules/automation/color-point-matcher';

function match(score: number, scale: number, x = 0, y = 0): ColorPointMatch {
  return { x, y, width: 12, height: 10, scale, mirrored: false, score, featureCount: 20, matchedFeatures: 15, matchMs: 1 };
}

/**
 * Reproduces the reported "任何颜色匹配都显示100%" problem: the calibrated
 * confidence is saturated to 1.0 by uniqueness (margin/0.08) regardless of the
 * absolute raw colour quality. A genuinely weak candidate (e.g. 上钩 button
 * rawScore=0.218) still saturates to 1.0 and is accepted, even though its raw
 * colour composition is far too poor to be the true target. The gate must add
 * an absolute rawScore floor so a low-quality colour match cannot be promoted to
 * a full-confidence target purely by having a favourable runner-up margin.
 */
describe('evaluateColorGate adds an absolute rawScore floor', () => {
  it('rejects a low-quality candidate (rawScore 0.218) even when margin boosts confidence to saturation', () => {
    // 上钩 button matched at rawScore 0.218 with a 0.106 margin; confidence
    // currently saturates to 1.0. The rawScore floor must reject it.
    const matches = [match(0.218, 0.5714285714285714, 160, 469), match(0.112, 0.5714285714285714, 198, 98)];
    const decision = evaluateColorGate(matches, 0.9);
    // Without the fix confidence === 1 and margin 0.106 >= .08 -> accepted.
    expect(decision.confidence).toBe(1);
    expect(decision.accepted).toBe(false);
  });

  it('still accepts a genuine target (rawScore 0.567) that saturates through uniqueness', () => {
    // Fish hook on a downsampled pass: rawScore 0.567, margin 0.061.
    const matches = [match(0.567, 0.6666666666666666, 1431, 373), match(0.506, 0.6666666666666666, 2120, 765)];
    const decision = evaluateColorGate(matches, 0.9);
    expect(decision.accepted).toBe(true);
  });

  it('accepts a strong rawScore candidate even without a second candidate', () => {
    const matches = [match(0.714, 1.25, 750, 351), match(0.459, 0.8, 117, 145)];
    const decision = evaluateColorGate(matches, 0.9);
    expect(decision.accepted).toBe(true);
  });

  it('rejects a marginal rawScore candidate below the floor', () => {
    const matches = [match(0.35, 0.75, 100, 100), match(0.30, 0.75, 200, 200)];
    const decision = evaluateColorGate(matches, 0.9);
    expect(decision.accepted).toBe(false);
  });
});
