/**
 * oracleConsensusAspect.test.ts — oracle-triangulation for terrain aspect (Horn).
 *
 * Aspect is where implementations most often "disagree" for a trivial reason:
 * GDAL reports compass degrees clockwise from north, GRASS reports degrees
 * counter-clockwise from east, and OLV returns atan2(-dz/dy, -dz/dx) in the math
 * frame. This test converts all three (plus analytic truth) to ONE canonical
 * convention — compass degrees clockwise from north, downslope — and shows they
 * agree, i.e. the agreement is real and not an artifact of matched conventions.
 *
 * The fixture is a pure east-gradient plane, so aspect is due west everywhere.
 * That exercises the conversion on the E-W axis without the raster
 * row-orientation (which row is north?) ambiguity, which a diagonal fixture would
 * introduce. CI recomputes OLV's leg live; the external legs are committed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const record = JSON.parse(
  readFileSync(resolve(ROOT, 'validation/oracle-consensus/aspect-horn.consensus.json'), 'utf8'),
) as {
  contract: { absoluteToleranceDeg: number };
  fixture: { cols: number; rows: number; cellMetres: number };
  oracles: { id: string; referenceClass: string; nativeValueDeg: number; nativeConvention: string }[];
};

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

/** OLV's mean interior aspect over the fixture, in compass degrees. */
function olvAspectCompass(): number {
  const { cols, rows, cellMetres } = record.fixture;
  const g = 0.3;
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = g * c;
  const { aspect } = hornSlopeAspect(z, cols, rows, cellMetres, cellMetres);
  let sx = 0;
  let sy = 0;
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      // OLV aspect is radians in the math frame (ccw from +x=east).
      const compass = toCompass((aspect[r * cols + c] * 180) / Math.PI, 'ccw-from-east');
      sx += Math.cos((compass * Math.PI) / 180);
      sy += Math.sin((compass * Math.PI) / 180);
    }
  }
  return ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
}

describe('oracle-consensus: terrain aspect (Horn)', () => {
  const tol = record.contract.absoluteToleranceDeg;
  const olv = olvAspectCompass();
  const truth = record.oracles.find((o) => o.referenceClass === 'analytic-truth')!;
  const truthCompass = toCompass(truth.nativeValueDeg, truth.nativeConvention);

  it('every oracle, converted to the canonical convention, is due west (270 deg)', () => {
    for (const o of record.oracles) {
      expect(angDiff(toCompass(o.nativeValueDeg, o.nativeConvention), 270), o.id).toBeLessThanOrEqual(tol);
    }
  });

  it('OLV matches analytic truth and both matched implementations after conversion', () => {
    expect(angDiff(olv, truthCompass)).toBeLessThanOrEqual(tol);
    for (const o of record.oracles.filter((x) => x.referenceClass === 'matched-implementation')) {
      expect(angDiff(olv, toCompass(o.nativeValueDeg, o.nativeConvention)), o.id).toBeLessThanOrEqual(tol);
    }
  });

  it('the two matched implementations agree with each other after conversion (no REFERENCE_DISAGREEMENT)', () => {
    const refs = record.oracles.filter((o) => o.referenceClass === 'matched-implementation');
    const compass = refs.map((o) => toCompass(o.nativeValueDeg, o.nativeConvention));
    expect(angDiff(compass[0], compass[1])).toBeLessThanOrEqual(tol);
  });

  it('NEGATIVE CONTROL: skipping the GRASS convention conversion would look like a 90 deg disagreement', () => {
    // GRASS native 180 read as if it were already compass would be 90 deg off —
    // exactly the false "disagreement" this contract exists to prevent.
    const grass = record.oracles.find((o) => o.id === 'grass-horn-aspect')!;
    expect(angDiff(grass.nativeValueDeg, 270)).toBeGreaterThan(tol);
  });
});
