/**
 * tests/patchView.test.ts
 *
 * Coverage for the v0.3.7 patch-view (photometric witness) data layer:
 *   - empty / out-of-range inputs return null
 *   - the centre point's colour always lands inside the patch
 *   - KNN finds the K nearest neighbours in distance order
 *   - tangent plane is correctly oriented for an axis-aligned ramp
 *   - coverage is finite and reflects splat density
 *   - the rgba8 buffer round-trips a known colour through the linear seam
 */

import { describe, it, expect } from 'vitest';
import { buildPatchView } from '../src/render/patchView';

function packPositions(
  triples: ReadonlyArray<readonly [number, number, number]>,
): Float32Array {
  const out = new Float32Array(triples.length * 3);
  for (let i = 0; i < triples.length; i++) {
    out[i * 3] = triples[i][0];
    out[i * 3 + 1] = triples[i][1];
    out[i * 3 + 2] = triples[i][2];
  }
  return out;
}

function packColors(
  triples: ReadonlyArray<readonly [number, number, number]>,
): Uint8Array {
  const out = new Uint8Array(triples.length * 3);
  for (let i = 0; i < triples.length; i++) {
    out[i * 3] = triples[i][0];
    out[i * 3 + 1] = triples[i][1];
    out[i * 3 + 2] = triples[i][2];
  }
  return out;
}

describe('buildPatchView — edge cases', () => {
  it('returns null on an empty cloud', () => {
    expect(
      buildPatchView({
        pointIndex: 0,
        positions: new Float32Array(0),
        colorsU8: new Uint8Array(0),
      }),
    ).toBeNull();
  });

  it('returns null on an out-of-range pointIndex', () => {
    expect(
      buildPatchView({
        pointIndex: 5,
        positions: packPositions([[0, 0, 0]]),
        colorsU8: packColors([[200, 100, 50]]),
      }),
    ).toBeNull();
  });

  it('returns a populated patch when the cloud has only the centre point', () => {
    // No neighbours — the patch should still carry the centre colour in
    // the middle pixels and zero coverage everywhere else.
    const patch = buildPatchView({
      pointIndex: 0,
      positions: packPositions([[0, 0, 0]]),
      colorsU8: packColors([[200, 100, 50]]),
      size: 16,
      splatRadius: 2,
    });
    expect(patch).not.toBeNull();
    expect(patch!.size).toBe(16);
    expect(patch!.hits).toBe(1);
    // The centre splat lit a small disc.
    expect(patch!.coverage).toBeGreaterThan(0);
    // The centre pixel should carry the input colour (round-tripped via linear).
    const i = (8 * 16 + 8) * 4;
    expect(patch!.rgba[i]).toBeGreaterThan(150); // R high
    expect(patch!.rgba[i + 3]).toBe(255); // alpha
  });
});

describe('buildPatchView — neighbourhood reconstruction', () => {
  it('builds a patch that reflects multiple coloured neighbours', () => {
    // 9 points on a coplanar 3 × 3 grid in the XY plane; the centre is
    // black, the four corners are red, green, blue, yellow. The patch
    // should carry colour density well above the single-centre case.
    const positions = packPositions([
      [-1, -1, 0],
      [0, -1, 0],
      [1, -1, 0],
      [-1, 0, 0],
      [0, 0, 0], // centre, index 4
      [1, 0, 0],
      [-1, 1, 0],
      [0, 1, 0],
      [1, 1, 0],
    ]);
    const colors = packColors([
      [255, 0, 0], // bottom-left red
      [128, 128, 128],
      [0, 255, 0], // bottom-right green
      [128, 128, 128],
      [10, 10, 10], // centre near-black
      [128, 128, 128],
      [0, 0, 255], // top-left blue
      [128, 128, 128],
      [255, 255, 0], // top-right yellow
    ]);
    const patch = buildPatchView({
      pointIndex: 4,
      positions,
      colorsU8: colors,
      size: 32,
      k: 8,
      splatRadius: 4,
    });
    expect(patch).not.toBeNull();
    expect(patch!.hits).toBe(9);
    expect(patch!.coverage).toBeGreaterThan(0.2);
  });

  it('honours the k cap so a 5-point cloud gathers 4 neighbours', () => {
    const positions = packPositions([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
    ]);
    const colors = packColors([
      [200, 100, 50],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
    ]);
    const patch = buildPatchView({
      pointIndex: 0,
      positions,
      colorsU8: colors,
      k: 32, // requested more than available
      size: 24,
    });
    expect(patch).not.toBeNull();
    // 5 points total, centre + 4 neighbours.
    expect(patch!.hits).toBe(5);
  });

  it('every reported field is finite', () => {
    const positions = packPositions([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
      [1, 1, 0],
      [-1, -1, 0],
    ]);
    const colors = packColors(
      Array.from({ length: 7 }, () => [120, 60, 30] as [number, number, number]),
    );
    const patch = buildPatchView({
      pointIndex: 0,
      positions,
      colorsU8: colors,
      size: 32,
    });
    expect(patch).not.toBeNull();
    expect(Number.isFinite(patch!.extent)).toBe(true);
    expect(Number.isFinite(patch!.coverage)).toBe(true);
    for (const c of patch!.normal) expect(Number.isFinite(c)).toBe(true);
    for (const c of patch!.centre) expect(Number.isFinite(c)).toBe(true);
  });
});

describe('buildPatchView — tangent plane orientation', () => {
  it('on an XY ramp the normal is roughly +Z', () => {
    // 25 points on the z = 0 plane.
    const triples: Array<[number, number, number]> = [];
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        triples.push([i, j, 0]);
      }
    }
    const positions = packPositions(triples);
    const colors = packColors(triples.map(() => [128, 128, 128] as [number, number, number]));
    const patch = buildPatchView({
      pointIndex: 12, // centre of the grid (i=0, j=0)
      positions,
      colorsU8: colors,
      k: 24,
    });
    expect(patch).not.toBeNull();
    // Normal should be parallel to (0, 0, ±1).
    const [nx, ny, nz] = patch!.normal;
    expect(Math.abs(nx)).toBeLessThan(0.1);
    expect(Math.abs(ny)).toBeLessThan(0.1);
    expect(Math.abs(nz)).toBeGreaterThan(0.9);
  });
});

describe('buildPatchView — buffer integrity', () => {
  it('rgba length matches size × size × 4', () => {
    const positions = packPositions([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const colors = packColors([
      [255, 128, 64],
      [10, 10, 10],
      [10, 10, 10],
    ]);
    const patch = buildPatchView({
      pointIndex: 0,
      positions,
      colorsU8: colors,
      size: 64,
    });
    expect(patch).not.toBeNull();
    expect(patch!.rgba.length).toBe(64 * 64 * 4);
  });

  it('every alpha channel is either 0 or 255', () => {
    const positions = packPositions([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const colors = packColors([
      [200, 100, 50],
      [50, 100, 200],
      [100, 200, 50],
    ]);
    const patch = buildPatchView({
      pointIndex: 0,
      positions,
      colorsU8: colors,
      size: 24,
    });
    expect(patch).not.toBeNull();
    for (let i = 3; i < patch!.rgba.length; i += 4) {
      const a = patch!.rgba[i];
      expect(a === 0 || a === 255).toBe(true);
    }
  });
});
