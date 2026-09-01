/**
 * oracleConsensusAspect.test.ts — oracle-triangulation for terrain aspect (Horn).
 *
 * Aspect is where implementations most often "disagree" for a trivial reason:
 * GDAL reports compass degrees clockwise from north, GRASS reports degrees
 * counter-clockwise from east, and OLV returns atan2(-dz/dy, -dz/dx) in the math
 * frame. This test converts all (plus analytic truth) to ONE canonical
 * convention — compass degrees clockwise from north, downslope — and shows they
 * agree, i.e. the agreement is real and not an artifact of matched conventions.
 *
 * Two cases run at opposite aspects: an east-facing plane (aspect due west, 270)
 * and a west-facing plane (aspect due east, 90). Both are axis-aligned, so the
 * conversion is exercised on the E-W axis without the raster row-orientation
 * (which row is north?) ambiguity a diagonal fixture would introduce; running
 * both bearings means a sign error in the x-gradient could not pass. CI
 * recomputes OLV's legs live; the external legs are committed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Oracle = { id: string; referenceClass: string; nativeValueDeg: number; nativeConvention: string };
type Case = {
  fixture: { cols: number; rows: number; cellMetres: number; gradientSign: number; model: string };
  expectedCompassDeg: number;
  oracles: Oracle[];
};
const record = JSON.parse(
  readFileSync(resolve(ROOT, 'validation/oracle-consensus/aspect-horn.consensus.json'), 'utf8'),
) as { contract: { absoluteToleranceDeg: number }; cases: Case[] };

/** Every native aspect convention → compass degrees clockwise from north. */
function toCompass(valueDeg: number, convention: string): number {
  if (convention === 'compass-cw-north') return ((valueDeg % 360) + 360) % 360;
  if (convention === 'ccw-from-east') return ((90 - valueDeg) % 360 + 360) % 360;
  throw new Error(`unknown aspect convention: ${convention}`);
}

/** Smallest absolute angular difference between two compass bearings, degrees. */
function angDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return Math.min(d, 360 - d);
}

/** OLV's mean interior aspect over a case's fixture, in compass degrees. */
function olvAspectCompass(c: Case): number {
  const { cols, rows, cellMetres, gradientSign } = c.fixture;
  const g = 0.3;
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let col = 0; col < cols; col++) z[r * cols + col] = g * (gradientSign > 0 ? col : cols - 1 - col);
  const { aspect } = hornSlopeAspect(z, cols, rows, cellMetres, cellMetres);
  let sx = 0;
  let sy = 0;
  for (let r = 1; r < rows - 1; r++) {
    for (let col = 1; col < cols - 1; col++) {
      const compass = toCompass((aspect[r * cols + col] * 180) / Math.PI, 'ccw-from-east');
      sx += Math.cos((compass * Math.PI) / 180);
      sy += Math.sin((compass * Math.PI) / 180);
    }
  }
  return ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
}

describe('oracle-consensus: terrain aspect (Horn)', () => {
  const tol = record.contract.absoluteToleranceDeg;

  for (const c of record.cases) {
    const label = `${c.expectedCompassDeg} deg`;
    const olv = olvAspectCompass(c);

    it(`every oracle, converted to the canonical convention, is at ${label}`, () => {
      for (const o of c.oracles) {
        expect(angDiff(toCompass(o.nativeValueDeg, o.nativeConvention), c.expectedCompassDeg), o.id).toBeLessThanOrEqual(tol);
      }
    });

    it(`OLV matches the oracles after conversion [${label}]`, () => {
      expect(angDiff(olv, c.expectedCompassDeg)).toBeLessThanOrEqual(tol);
      for (const o of c.oracles) {
        expect(angDiff(olv, toCompass(o.nativeValueDeg, o.nativeConvention)), o.id).toBeLessThanOrEqual(tol);
      }
    });
  }

  it('the two cases are opposite bearings 180 deg apart (a sign error could not pass both)', () => {
    const [a, b] = record.cases.map(olvAspectCompass);
    expect(angDiff(a, b)).toBeGreaterThan(179);
  });

  it('the matched implementations agree with each other after conversion (no REFERENCE_DISAGREEMENT)', () => {
    const refs = record.cases[0].oracles.filter((o) => o.referenceClass === 'matched-implementation');
    const compass = refs.map((o) => toCompass(o.nativeValueDeg, o.nativeConvention));
    expect(angDiff(compass[0], compass[1])).toBeLessThanOrEqual(tol);
  });

  it('NEGATIVE CONTROL: skipping the GRASS convention conversion would look like a 90 deg disagreement', () => {
    const grass = record.cases[0].oracles.find((o) => o.id === 'grass-horn-aspect')!;
    expect(angDiff(grass.nativeValueDeg, record.cases[0].expectedCompassDeg)).toBeGreaterThan(tol);
  });
});
