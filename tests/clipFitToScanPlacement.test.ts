/**
 * "Fit to scan" must enclose the active scan in the frame the clip works in.
 *
 * The clip box and its kept-count run on positions folded into the project
 * frame (`copyPlacedPositions` with the layer's placement). A scan placed away
 * from the project origin therefore sits at its source bounds plus that offset;
 * fitting to the unplaced bounds kept none of its points.
 */
import { describe, expect, it } from 'vitest';
import { fitBoundsInProject } from '../src/render/clip/fitBoundsInProject';
import { countKept, type ClipBox } from '../src/render/clip/clipBox';

type V3 = [number, number, number];

/** A 4 x 4 grid of points on a 10 m square, source-local. */
function gridPoints(): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out.push(i * 10, j * 10, 5);
  return new Float32Array(out);
}

const sourceBounds = { min: [0, 0, 5] as V3, max: [30, 30, 5] as V3 };

function placed(points: Float32Array, off: V3): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    out[i] = points[i] + off[0];
    out[i + 1] = points[i + 1] + off[1];
    out[i + 2] = points[i + 2] + off[2];
  }
  return out;
}

const clipOf = (b: { min: V3; max: V3 }): ClipBox => ({ box: { min: [...b.min], max: [...b.max] }, mode: 'keep-inside', enabled: true });

describe('fitBoundsInProject', () => {
  it('returns null with no bounds, and the bounds unchanged when the layer is unplaced', () => {
    expect(fitBoundsInProject(null, [5, 5, 5])).toBeNull();
    expect(fitBoundsInProject(sourceBounds, null)).toBe(sourceBounds);
    expect(fitBoundsInProject(sourceBounds, [0, 0, 0])).toBe(sourceBounds);
  });

  it('widens a placed scan by well under a millimetre at a 2 km offset', () => {
    const fit = fitBoundsInProject(sourceBounds, [2000, 0, 0])!;
    expect(2000 - fit.min[0]).toBeGreaterThan(0);
    expect(2000 - fit.min[0]).toBeLessThan(0.001);
  });

  it.each<[string, V3]>([
    ['a scan 2 km east', [2000, 0, 0]],
    ['a scan 2 km west and south', [-2000, -1500, 0]],
    ['a scan placed above the origin', [0, 0, 120]],
    ['a scan with a small fractional offset', [0.0004, -0.0004, 0]],
  ])('encloses every point of %s', (_name, off) => {
    const points = placed(gridPoints(), off);
    const fit = fitBoundsInProject(sourceBounds, off)!;
    expect(countKept(clipOf(fit), points)).toBe(16);
  });

  it('shows why the unplaced bounds were wrong: they keep none of a placed scan', () => {
    const points = placed(gridPoints(), [2000, 0, 0]);
    expect(countKept(clipOf(sourceBounds), points)).toBe(0);
  });

  it('fits two scans independently', () => {
    const a = placed(gridPoints(), [0, 0, 0]);
    const b = placed(gridPoints(), [2000, 0, 0]);
    const fitA = clipOf(fitBoundsInProject(sourceBounds, [0, 0, 0])!);
    const fitB = clipOf(fitBoundsInProject(sourceBounds, [2000, 0, 0])!);
    expect([countKept(fitA, a), countKept(fitA, b)]).toEqual([16, 0]);
    expect([countKept(fitB, a), countKept(fitB, b)]).toEqual([0, 16]);
  });
});
