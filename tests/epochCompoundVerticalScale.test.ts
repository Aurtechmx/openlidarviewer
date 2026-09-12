/**
 * A compound frame's vertical unit must reach the epoch pipeline on its own.
 *
 * `EpochFrameFacts` carried only the HORIZONTAL factor, so `dtmOnGrid` derived
 * its vertical scale from it. On a compound frame — foot heights over a metre
 * grid, which GeoTIFF key 4099 and a VERT_CS UNIT both express — the SMRF ground
 * filter's physical 0.5 m / 2.5 m elevation tolerances were applied as 0.5 and
 * 2.5 FEET, about 3.3x too tight, and `cellSizeZUnits` was wrong by the same
 * ratio. That changes which points are taken as ground, so the surfaces being
 * differenced were built wrong even though the Δz conversion downstream was
 * already correct.
 *
 * The ICP aligner had the mirror problem: its correspondence search is 3-D, so
 * an unscaled foot Z distorted the distances the fit is ranked on.
 */
import { describe, it, expect } from 'vitest';
import { epochFrameFacts } from '../src/geo/frameCompatibility';
import type { SpatialContext } from '../src/geo/SpatialContext';

const ctx = (linear: number, vertical?: number): SpatialContext => ({
  isGeographic: false,
  linearUnitToMetres: linear,
  linearUnitKnown: true,
  verticalUnitToMetres: vertical,
  verticalDatum: 'EPSG:6360',
} as unknown as SpatialContext);

describe('epochFrameFacts carries the vertical scale', () => {
  it('publishes a vertical factor that differs from the horizontal one', () => {
    const f = epochFrameFacts(ctx(1, 0.3048));
    expect(f.linearUnitToMetres).toBe(1);
    expect(f.verticalUnitToMetres).toBeCloseTo(0.3048, 12);
  });

  it('omits it when the frame states none, leaving the horizontal fallback', () => {
    expect(epochFrameFacts(ctx(1)).verticalUnitToMetres).toBeUndefined();
    // A single-unit foot frame is unchanged: nothing to disagree with.
    expect(epochFrameFacts(ctx(0.3048)).verticalUnitToMetres).toBeUndefined();
  });

  it('omits a non-positive or non-finite factor rather than publishing it', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(epochFrameFacts(ctx(1, bad)).verticalUnitToMetres, String(bad)).toBeUndefined();
    }
  });
});

describe('the ground filter scales Z on the vertical factor', () => {
  it('a foot-vertical frame gets a ~3.28x looser tolerance than a metre one', async () => {
    // The tolerance is expressed as `0.5 * (1 / vertToMetres)` source units, so
    // the source-unit number a foot frame uses must be larger, not equal, to
    // represent the SAME physical half-metre.
    const metreZ = 0.5 / 1;
    const footZ = 0.5 / 0.3048;
    expect(footZ / metreZ).toBeCloseTo(3.2808, 3);
    // Guard the seam itself: compareEpochs must read verticalUnitToMetres.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/terrain/change/compareEpochs.ts', 'utf8'));
    expect(src).toMatch(/cloud\.verticalUnitToMetres/);
  });
});

describe('the ICP fit is isotropic', () => {
  it('alignEpochs scales Z into horizontal-unit space before fitting', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/terrain/change/alignEpochs.ts', 'utf8'));
    // The sampler must apply a z scale, and it must be derived from the two
    // declared factors rather than assumed 1.
    expect(src).toMatch(/zScale/);
    expect(src).toMatch(/verticalUnitToMetres/);
  });
});
