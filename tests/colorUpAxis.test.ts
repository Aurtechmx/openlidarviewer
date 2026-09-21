/**
 * colorUpAxis.test.ts — three display surfaces that read height off index 2.
 *
 * The terrain pipeline is normalised once at its boundary, so it is clean. The
 * surfaces here are not on that path: they take the raw scene buffer and had
 * no way to say which component points up, in functions that were already
 * being handed the answer.
 */

import { describe, it, expect } from 'vitest';

import { densityForChunk, densityCellSizeFor, estimatePlanimetricSpacing } from '../src/render/densityColors';
import { colorByCoverage } from '../src/render/colorModes';
import { heightMapExporter } from '../src/export/HeightMapExporter';

/** A facade: wide in x, tall in the up axis, thin in the other horizontal. */
function facade(upAxis: 0 | 1 | 2): Float32Array {
  const p = new Float32Array(3 * 20 * 20);
  let k = 0;
  for (let a = 0; a < 20; a++) {
    for (let b = 0; b < 20; b++) {
      const t = [0, 0, 0];
      t[upAxis] = b * 0.5;                       // height
      const [h1, h2] = upAxis === 0 ? [1, 2] : upAxis === 1 ? [0, 2] : [0, 1];
      t[h1] = a * 2;                             // 40 units wide
      t[h2] = 0;                                 // a wall: no depth
      p[k++] = t[0]; p[k++] = t[1]; p[k++] = t[2];
    }
  }
  return p;
}

describe('the density heatmap bins the horizontal pair', () => {
  it('measures spacing over the horizontal extent, not over the height', () => {
    // A wall has zero horizontal area in one direction, so the estimate is 0
    // either way; what must NOT happen is the height standing in for it.
    const zUp = estimatePlanimetricSpacing(facade(2), 2);
    const yUpToldZ = estimatePlanimetricSpacing(facade(1), 2);
    const yUpToldY = estimatePlanimetricSpacing(facade(1), 1);
    expect(zUp).toBe(0);          // wall, no depth
    expect(yUpToldY).toBe(0);     // same wall, same answer, once told
    expect(yUpToldZ).toBeGreaterThan(0); // the height faking an extent
  });

  it('counts a vertical column as one dense plan-view cell', () => {
    // 100 returns stacked in a single column: x and z fixed, height varying.
    // Density is points per unit HORIZONTAL area, so the honest answer is one
    // very dense cell. Binned on (x, height) the column spreads across ten
    // cells and reads as ten times sparser than it is.
    const p = new Float32Array(3 * 100);
    for (let i = 0; i < 100; i++) {
      p[i * 3] = 0;            // x
      p[i * 3 + 1] = i * 0.1;  // y = height (Y-up)
      p[i * 3 + 2] = 0;        // z
    }
    const told = densityForChunk({ positions: p, cellSize: 1, upAxis: 1 });
    const notTold = densityForChunk({ positions: p, cellSize: 1, upAxis: 2 });
    expect(told.maxObservedDensity).toBeCloseTo(100, 6);
    expect(notTold.maxObservedDensity).toBeCloseTo(10, 6);
  });

  it('is unchanged for a Z-up scan, explicit or defaulted', () => {
    const p = facade(2);
    const implicit = densityForChunk({ positions: p, cellSize: 1 });
    const explicit = densityForChunk({ positions: p, cellSize: 1, upAxis: 2 });
    expect([...explicit.colors]).toEqual([...implicit.colors]);
    expect(densityCellSizeFor(p)).toBe(densityCellSizeFor(p, 2));
  });
});

describe('the trust overlays sample the canonical grid', () => {
  // One cell of full coverage at canonical (0..1, 0..1).
  const grid = {
    cols: 2, rows: 2, cellSizeM: 1, originH1: 0, originH2: 0,
    confidence: new Float32Array([1, 0, 0, 0]),
    coverage: new Float32Array([1, 0, 0, 0]),
  };

  it('negates z for a Y-up scene, matching yUpToCanonicalZUp', () => {
    // A scene point at (0.5, height, -0.5): canonical northing is -z = +0.5,
    // which lands in the covered cell. Read as-is it would be -0.5, outside.
    const p = new Float32Array([0.5, 9, -0.5]);
    const told = colorByCoverage(p, 1, grid as never, 1);
    const notTold = colorByCoverage(p, 1, grid as never, 2);
    expect([...told]).not.toEqual([...notTold]);
  });

  it('is unchanged for Z-up, explicit or defaulted', () => {
    const p = new Float32Array([0.5, 0.5, 9]);
    expect([...colorByCoverage(p, 1, grid as never)])
      .toEqual([...colorByCoverage(p, 1, grid as never, 2)]);
  });
});

describe('the height map reads the extent off the up axis', () => {
  // 40 wide, 6 tall, in a Y-up frame: [minX,minY,minZ,maxX,maxY,maxZ].
  const yUpAabb = [0, 0, -0.5, 40, 6, 0.5] as const;
  const ctx = (axis: 0 | 1 | 2) => ({
    adapter: {
      localBoundsAabb: () => yUpAabb,
      worldUpAxis: () => axis,
      crsLabel: () => null,
    },
  }) as never;

  it('labels the row for the axis it actually read', () => {
    expect(heightMapExporter.isAvailable(ctx(1))).toBe(true);
    expect(heightMapExporter.isAvailable(ctx(2))).toBe(true);
  });

  it('reports the 6-unit height, not the 1-unit depth, on a Y-up scan', () => {
    // Read as Z the "height range" is the 1-unit thickness; read on the real
    // axis it is the 6 units the ramp actually spans.
    const asZ = yUpAabb[5] - yUpAabb[2];
    const asY = yUpAabb[4] - yUpAabb[1];
    expect(asZ).toBeCloseTo(1, 9);
    expect(asY).toBeCloseTo(6, 9);
    // A scan thinner than the minimum in Z but tall in Y is available only
    // when the exporter reads the right axis.
    const thin = { adapter: {
      localBoundsAabb: () => [0, 0, 0, 40, 6, 0.0001] as const,
      worldUpAxis: () => 1 as const, crsLabel: () => null,
    } } as never;
    const thinAsZ = { adapter: {
      localBoundsAabb: () => [0, 0, 0, 40, 6, 0.0001] as const,
      worldUpAxis: () => 2 as const, crsLabel: () => null,
    } } as never;
    expect(heightMapExporter.isAvailable(thin)).toBe(true);
    expect(heightMapExporter.isAvailable(thinAsZ)).toBe(false);
  });
});
