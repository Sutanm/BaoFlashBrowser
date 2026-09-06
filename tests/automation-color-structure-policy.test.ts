import { describe, expect, it } from 'vitest';
import { evaluateStructuredColorMatch } from '../src/main/modules/automation/color-structure-policy';

describe('structured colour acceptance policy', () => {
  it('keeps the displayed decision score below the threshold when raw evidence rejects a calibrated 100%', () => {
    const decision = evaluateStructuredColorMatch({
      score: 1,
      colorRawScore: .36,
      structureScore: .95,
      structureMargin: .2,
    }, .9);
    expect(decision).toMatchObject({ accepted: false, reason: 'color-evidence' });
    expect(decision.decisionScore).toBeCloseTo(.36 / .45);
  });

  it('accepts a strong and unique structured colour match', () => {
    expect(evaluateStructuredColorMatch({
      score: .96,
      colorRawScore: .9,
      structureScore: .74,
      structureMargin: .3,
    }, .9)).toEqual({ accepted: true, decisionScore: .96 });
  });

  it('accepts a resampled transparent sprite without reopening weak-colour impostors', () => {
    const liveFish = evaluateStructuredColorMatch({
      score: .908,
      colorRawScore: .568,
      structureScore: .270,
      structureMargin: .044,
    }, .9);
    const absentHookImpostor = evaluateStructuredColorMatch({
      score: .908,
      colorRawScore: .491,
      structureScore: .478,
      structureMargin: .044,
    }, .9);

    expect(liveFish).toEqual({ accepted: true, decisionScore: .908 });
    expect(absentHookImpostor).toMatchObject({ accepted: false, reason: 'color-evidence' });
  });

  it('reports structural ambiguity separately from the threshold', () => {
    expect(evaluateStructuredColorMatch({
      score: 1,
      colorRawScore: .9,
      structureScore: .8,
      structureMargin: .03,
    }, .9)).toMatchObject({ accepted: false, reason: 'ambiguous', decisionScore: .8 });
  });
});
