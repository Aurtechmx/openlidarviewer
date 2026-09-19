/**
 * frameQuality.ts
 *
 * Deterministic measurements over a rendered frame, for judging whether the
 * Continuity Field helped or only looked like it did.
 *
 * Each takes buffers rather than a canvas, so a case can build a frame by hand
 * and the answer is the same on every machine. Nothing here renders, times, or
 * touches a GPU: a metric that needed a device would be unrunnable in the place
 * it is most useful, which is a test that fails when reconstruction starts
 * reaching further than it should.
 *
 * The metrics are meant to be read together. Coverage rises whenever the
 * renderer fills more, and leakage rises when it fills across an edge, so
 * reading either alone rewards exactly the behaviour the other exists to catch.
 *
 * Validation only. These describe a picture, never the ground it was made from,
 * and no figure here may reach a measurement, an export or claim evidence.
 */
import { depthCompatible, DEFAULT_DEPTH_EPSILON } from '../../src/render/streaming/depthMerge';
import type { SupportKind } from '../../src/render/streaming/microGap';

/** One frame, as the buffers a renderer would hold. */
export interface Frame {
  readonly widthPx: number;
  readonly heightPx: number;
  /** Depth per pixel. Non-positive means nothing was drawn there. */
  readonly depth: Float32Array;
  /** Where each pixel's colour came from. */
  readonly support: readonly SupportKind[];
}

const at = (f: Frame, x: number, y: number): number => y * f.widthPx + x;
const inside = (f: Frame, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < f.widthPx && y < f.heightPx;

/** The four cardinal neighbours of a pixel that lie inside the frame. */
function cardinals(f: Frame, x: number, y: number): number[] {
  const out: number[] = [];
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    if (inside(f, x + dx, y + dy)) out.push(at(f, x + dx, y + dy));
  }
  return out;
}

/**
 * The share of drawn pixels that came from samples rather than from filling,
 * in `[0, 1]`, or null when nothing was drawn.
 *
 * Against drawn pixels rather than the frame, for the reason the support census
 * gives: measured against everything, the number improves by pointing the camera
 * at empty space.
 */
export function directCoverage(f: Frame): number | null {
  let drawn = 0;
  let direct = 0;
  for (const s of f.support) {
    if (s === 'none') continue;
    drawn += 1;
    if (s === 'direct' || s === 'accumulated') direct += 1;
  }
  return drawn === 0 ? null : direct / drawn;
}

/**
 * Reconstructed pixels sitting on a depth discontinuity, as a share of all
 * reconstructed pixels, or null when nothing was reconstructed.
 *
 * This is the failure the gap pass is built to avoid, measured rather than
 * argued. A filled pixel whose drawn neighbours disagree about depth is a patch
 * laid across an edge: a roof ridge, a wall against the ground behind it, the
 * boundary between a tree and the sky. Judged against the same depth rule the
 * renderer itself uses, so the metric and the pass cannot drift into disagreeing
 * about what one surface means.
 */
export function edgeLeakage(f: Frame, epsilon: number = DEFAULT_DEPTH_EPSILON): number | null {
  let reconstructed = 0;
  let leaked = 0;
  for (let y = 0; y < f.heightPx; y++) {
    for (let x = 0; x < f.widthPx; x++) {
      const i = at(f, x, y);
      if (f.support[i] !== 'reconstructed') continue;
      reconstructed += 1;
      const drawn = cardinals(f, x, y).filter((n) => f.support[n] !== 'none' && f.depth[n] > 0);
      let straddles = false;
      for (let a = 0; a < drawn.length && !straddles; a++) {
        for (let b = a + 1; b < drawn.length; b++) {
          if (!depthCompatible(f.depth[drawn[a]], f.depth[drawn[b]], epsilon)) {
            straddles = true;
            break;
          }
        }
      }
      if (straddles) leaked += 1;
    }
  }
  return reconstructed === 0 ? null : leaked / reconstructed;
}

/**
 * Reconstructed pixels without enough drawn neighbours to have been supported,
 * as a share of all reconstructed pixels, or null when nothing was
 * reconstructed.
 *
 * A pixel filled with fewer than two drawn cardinal neighbours had nothing
 * spanning it, so whatever it shows was invented outright rather than carried
 * across a seam.
 */
export function unsupportedReconstruction(f: Frame): number | null {
  let reconstructed = 0;
  let unsupported = 0;
  for (let y = 0; y < f.heightPx; y++) {
    for (let x = 0; x < f.widthPx; x++) {
      const i = at(f, x, y);
      if (f.support[i] !== 'reconstructed') continue;
      reconstructed += 1;
      const drawn = cardinals(f, x, y).filter((n) => f.support[n] !== 'none');
      if (drawn.length < 2) unsupported += 1;
    }
  }
  return reconstructed === 0 ? null : unsupported / reconstructed;
}

/**
 * How much two frames of a still camera differ, as the share of pixels whose
 * depth changed beyond the tolerance, in `[0, 1]`.
 *
 * A settled view should stop changing. Points moving between temporal phases,
 * or a history being discarded and rebuilt, show up here as pixels that keep
 * changing while nothing about the view does.
 */
export function temporalVariance(
  a: Frame,
  b: Frame,
  epsilon: number = DEFAULT_DEPTH_EPSILON,
): number {
  const n = Math.min(a.depth.length, b.depth.length);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const da = a.depth[i];
    const db = b.depth[i];
    const drawnA = da > 0;
    const drawnB = db > 0;
    if (drawnA !== drawnB) {
      changed += 1;
      continue;
    }
    if (drawnA && !depthCompatible(da, db, epsilon)) changed += 1;
  }
  return changed / n;
}
