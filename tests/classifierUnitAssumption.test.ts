/**
 * classifierUnitAssumption.test.ts
 *
 * An unknown linear unit used to become 1 m/unit silently: metre-calibrated
 * thresholds ran in source units and nothing in the run said so. The frame
 * now records the substitution and the run names it in a warning and a cue.
 * No class code moves; the record says what was assumed.
 */

import { describe, it, expect } from 'vitest';
import { classifierParamsForFrame } from '../src/render/class/classifierFrame';
import { deriveClassification } from '../src/render/class/deriveClassification';

/** A 30 × 30 m plane at z = 0 with a 6 m box on it, half a metre spacing. */
function scene(): { positions: Float32Array; n: number } {
  const pts: number[] = [];
  for (let x = 0; x <= 30; x += 0.5) for (let y = 0; y <= 30; y += 0.5) {
    const onBox = x >= 12 && x <= 18 && y >= 12 && y <= 18;
    pts.push(x, y, onBox ? 6 : 0);
  }
  return { positions: new Float32Array(pts), n: pts.length / 3 };
}

describe('classifierParamsForFrame names an assumed unit', () => {
  it('flags a frame with no positive linear unit', () => {
    expect(classifierParamsForFrame({ linearUnitToMetres: null }).linearUnitAssumed).toBe(true);
    expect(classifierParamsForFrame({ linearUnitToMetres: 0 }).linearUnitAssumed).toBe(true);
  });
  it('does not flag a known unit', () => {
    expect(classifierParamsForFrame({ linearUnitToMetres: 1 }).linearUnitAssumed).toBe(false);
    expect(classifierParamsForFrame({ linearUnitToMetres: 0.3048 }).linearUnitAssumed).toBe(false);
  });
});

describe('deriveClassification with an assumed unit', () => {
  it('carries the warning and the cue, and moves no class code', () => {
    const { positions, n } = scene();
    const plain = deriveClassification(positions, n, {});
    const assumed = deriveClassification(positions, n, { linearUnitAssumed: true });
    expect(assumed.warnings.some((w) => /linear unit unconfirmed/i.test(w))).toBe(true);
    expect(assumed.classifier.cues).toContain('linear-unit-assumed');
    expect(plain.classifier.cues).not.toContain('linear-unit-assumed');
    expect(Array.from(assumed.codes)).toEqual(Array.from(plain.codes));
  });
});
