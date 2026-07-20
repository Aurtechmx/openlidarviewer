/**
 * The property the boundary normalisation exists to guarantee: one surface,
 * authored Y-up or Z-up, produces the SAME terrain result once the Y-up copy is
 * rotated into the canonical frame.
 *
 * These run the real hornSlopeAspect derivatives over both copies of an
 * analytic surface — not a mock — because the failure being prevented is not a
 * crash but a plausible wrong surface: before the rotation, a Y-up height field
 * was gridded over X/Y with a HORIZONTAL span standing in for elevation, and
 * everything derived from the grid (slope, aspect, contours, confidence)
 * inherited the corruption while still looking like terrain.
 */

import { describe, it, expect } from 'vitest';
import { yUpToCanonicalZUp } from '../src/terrain/canonicalFrame';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';

/**
 * An analytic hill on an N×N grid, emitted in either frame. The Y-up copy is
 * the SAME surface a glTF/OBJ export carries: east in X, elevation in Y, and
 * north in −Z (so the row index maps to −z).
 */
function hill(n: number, frame: 'z' | 'y'): Float32Array {
  const out = new Float32Array(n * n * 3);
  let k = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const east = c * 2;
      const north = r * 2;
      const elev = 10 * Math.exp(-(((c - n / 2) ** 2 + (r - n / 2) ** 2) / (n * 1.5)));
      if (frame === 'z') {
        out[k++] = east; out[k++] = north; out[k++] = elev;
      } else {
        out[k++] = east; out[k++] = elev; out[k++] = -north;
      }
    }
  }
  return out;
}

/** Grid the buffer's Z over X/Y — the read every terrain module performs. */
function gridZ(positions: Float32Array, n: number): Float32Array {
  const z = new Float32Array(n * n).fill(Number.NaN);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const c = Math.round(positions[i] / 2);
    const r = Math.round(positions[i + 1] / 2);
    if (c >= 0 && c < n && r >= 0 && r < n) z[r * n + c] = positions[i + 2];
  }
  return z;
}

const N = 24;

describe('a Y-up surface analyses identically to its Z-up twin', () => {
  it('grids to the same elevations', () => {
    const zUp = gridZ(hill(N, 'z'), N);
    const yUp = gridZ(yUpToCanonicalZUp(hill(N, 'y')), N);
    for (let i = 0; i < zUp.length; i++) {
      expect(yUp[i]).toBeCloseTo(zUp[i], 5);
    }
  });

  it('produces the same slope AND the same aspect', () => {
    // Aspect is the assertion that matters: a reflection instead of a rotation
    // grids the right elevations and hands every azimuth back mirrored.
    const a = hornSlopeAspect(gridZ(hill(N, 'z'), N), N, N, 2);
    const b = hornSlopeAspect(gridZ(yUpToCanonicalZUp(hill(N, 'y')), N), N, N, 2);
    for (let i = 0; i < a.slope.length; i++) {
      expect(b.slope[i]).toBeCloseTo(a.slope[i], 5);
      if (Number.isFinite(a.aspect[i]) && Number.isFinite(b.aspect[i])) {
        expect(b.aspect[i]).toBeCloseTo(a.aspect[i], 5);
      }
    }
  });

  it('an UNROTATED Y-up buffer does NOT grid to the same surface', () => {
    // The defect this file guards against, demonstrated: without the rotation,
    // most of the grid never even receives a sample, because the second
    // component being read as a northing is actually the elevation (0..10 m)
    // and every point collapses into a few rows.
    const raw = gridZ(hill(N, 'y'), N);
    let filled = 0;
    for (let i = 0; i < raw.length; i++) if (Number.isFinite(raw[i])) filled++;
    expect(filled).toBeLessThan((N * N) / 2);
  });
});
