/**
 * microGapPass.ts — the screen-space pass that applies the gap rules to a
 * whole frame.
 *
 * `microGap` decides one pixel: whether a background pixel sits inside a
 * surface its neighbours agree on, or beside an edge. `normalAgreement` adds
 * the orientation test where a source carries normals. `supportProvenance`
 * says which writes are allowed. None of them walks a raster, and walking it
 * is where the two rules that matter live: how wide a gap may be, and whether
 * a fill can become evidence for the next one.
 *
 * ── HOW WIDE A GAP MAY BE ───────────────────────────────────────────────────
 * The pass reads the four immediate cardinal neighbours and nothing further,
 * so what it can close is a gap ONE PIXEL THICK along at least one axis. The
 * radius is a named constant rather than a loop bound, so widening it is a
 * decision somebody makes rather than a number that drifts.
 *
 * One pixel thick is not the same as one pixel in total, and the difference is
 * worth stating because it is easy to assume the stronger bound. A slit one
 * pixel tall and twenty long fills: every pixel in it is bracketed above and
 * below by samples that agree on a depth, which is a row of sampling gaps and
 * not a hole. A region two pixels thick in both directions does not fill at
 * all: each of its pixels has background on two sides, so no opposite pair
 * supports it and fewer than three cardinals do, and the rule refuses before
 * depth is ever consulted.
 *
 * That is what keeps a large unsupported region unsupported. The bound is on
 * thickness, so no amount of length gets a surface across an area where the
 * scan recorded nothing on both axes.
 *
 * ── A FILL IS NEVER EVIDENCE ────────────────────────────────────────────────
 * The pass reads one raster and writes another. Every decision is taken
 * against the support the frame arrived with, so a pixel filled early in the
 * walk cannot support the pixel beside it later in the same walk, whatever
 * order the walk happens to take. `microGap` refuses reconstructed neighbours
 * as evidence, which stops it across frames; reading the input raster is what
 * stops it within one.
 *
 * Writing in place would make the guarantee depend on iteration order, which
 * is the kind of correctness nobody can see in a screenshot: a left-to-right
 * walk would close a two-pixel gap one pixel at a time and call the result
 * supported.
 *
 * ── WHAT IT CANNOT TOUCH ────────────────────────────────────────────────────
 * Support and depth, and optionally normals. No position, no point buffer, no
 * pick target and no measurement appears in the signature, so this cannot
 * modify source data or what a click resolves to, rather than being trusted
 * not to. Reconstructed pixels stay unpickable because picking goes to the
 * source points and never to this raster.
 *
 * Pure: no GPU, no DOM, no three.js. The caller owns both rasters. Display
 * only, and nothing derived from a filled pixel may reach picking,
 * measurement, terrain, export or claim evidence.
 */
import type { Lens } from './evidenceLens';
import { mayReconstructAt } from './lensPresentation';
import { shouldFill, type Cardinals, type Neighbour, type RefusedReason } from './microGap';
import { normalsAllowFill, type Normal } from './normalAgreement';
import { censusOfPacked, type SupportCensus } from './supportCensus';
import {
  nextSupport,
  packSupport,
  unpackSampleCount,
  unpackSupportKind,
} from './supportProvenance';

/**
 * How far the pass looks for support, in pixels.
 *
 * One, and the programme says to start there: two only once a benchmark says
 * the wider gap is a sampling gap rather than a hole. Widening it means more
 * than raising this number, because the opposite-pair rule reads cardinals at
 * exactly this distance; the constant is here so the reasoning has somewhere
 * to be attached.
 */
export const GAP_RADIUS_PX = 1;

/** One frame's support and depth, as the renderer holds them. */
export interface SupportRaster {
  readonly widthPx: number;
  readonly heightPx: number;
  /** One packed byte per pixel: provenance and sample count. */
  readonly support: Uint8Array;
  /** Eye-space depth per pixel. Zero or non-finite means nothing is there. */
  readonly depth: Float32Array;
}

/** What the pass did, for a diagnostics surface. */
export interface MicroGapPassResult {
  /** Pixels filled this pass. */
  readonly filled: number;
  /** Why the rest were left alone. */
  readonly refused: Readonly<Record<RefusedReason, number>>;
  /** Pixels refused because their neighbours' normals disagreed. */
  readonly refusedByNormals: number;
  /** Pixels refused because the evidence lens was over them. */
  readonly refusedByLens: number;
  /** The support census of the raster the pass produced. */
  readonly census: SupportCensus;
}

/** Optional per-pixel normals, in the same layout as the rasters. */
export interface MicroGapPassOptions {
  /**
   * Surface orientation per pixel, or null where unknown.
   *
   * Absent for a source that carries no normals, which is most of them, and a
   * caller that never has them behaves as though the test were not here.
   */
  readonly normals?: readonly (Normal | null | undefined)[] | null;
  /** Depth tolerance, passed through to the per-pixel rule. */
  readonly epsilon?: number;
  /** Maximum angle between neighbour normals, in degrees. */
  readonly maxNormalAngleDeg?: number;
  /**
   * The evidence lens, where one is open.
   *
   * Under it nothing is substituted, so the pass refuses every fill it covers.
   * The whole feather counts, and the test is a boolean: a pixel part way
   * through the fade is still one the viewer is looking through the lens at,
   * and filling it four-tenths of the way would be a reconstruction the lens
   * was supposed to have refused.
   */
  readonly lens?: Lens | null;
}

const OUT_OF_FRAME: Neighbour = { depth: 0, support: 'none' };

/**
 * Apply the gap rules across a frame.
 *
 * `input` is read and never written; `output` receives a copy of the input
 * with the permitted fills applied. Both rasters must describe the same
 * dimensions, and a mismatch fills nothing rather than writing past an end.
 */
export function runMicroGapPass(
  input: SupportRaster,
  output: SupportRaster,
  options: MicroGapPassOptions = {},
): MicroGapPassResult {
  const { widthPx: w, heightPx: h } = input;
  const refused = { occupied: 0, unsupported: 0, discontinuity: 0 };
  let filled = 0;
  let refusedByNormals = 0;
  let refusedByLens = 0;

  const sized = w > 0 && h > 0
    && output.widthPx === w && output.heightPx === h
    && input.support.length >= w * h && input.depth.length >= w * h
    && output.support.length >= w * h && output.depth.length >= w * h;
  if (!sized) {
    return {
      filled: 0, refused, refusedByNormals: 0, refusedByLens: 0, census: censusOfPacked([]),
    };
  }

  // The output starts as the frame that arrived. Every decision below reads
  // `input`, so the copy is what the fills are written into rather than what
  // they are judged against.
  output.support.set(input.support.subarray(0, w * h));
  output.depth.set(input.depth.subarray(0, w * h));

  const at = (x: number, y: number): Neighbour => {
    if (x < 0 || y < 0 || x >= w || y >= h) return OUT_OF_FRAME;
    const i = y * w + x;
    return { depth: input.depth[i], support: unpackSupportKind(input.support[i]) };
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const centre = unpackSupportKind(input.support[i]);
      const cardinals: Cardinals = {
        left: at(x - GAP_RADIUS_PX, y),
        right: at(x + GAP_RADIUS_PX, y),
        up: at(x, y - GAP_RADIUS_PX),
        down: at(x, y + GAP_RADIUS_PX),
      };
      const decision = shouldFill(centre, cardinals, options.epsilon);
      if (!decision.fill) {
        refused[decision.reason] += 1;
        continue;
      }
      if (options.lens && !mayReconstructAt(x, y, options.lens)) {
        refusedByLens += 1;
        continue;
      }
      if (options.normals) {
        // Indexed through the same bounds `at` uses. Reading the flat array at
        // `i - 1` would take the previous row's last pixel as the left
        // neighbour of a pixel at x = 0, so a fill at the frame's edge would
        // be admitted or refused on the orientation of an unrelated surface.
        const normalAt = (nx: number, ny: number): Normal | null | undefined =>
          (nx < 0 || ny < 0 || nx >= w || ny >= h ? null : options.normals?.[ny * w + nx]);
        const around = [
          normalAt(x - 1, y), normalAt(x + 1, y),
          normalAt(x, y - 1), normalAt(x, y + 1),
        ];
        if (!normalsAllowFill(around, options.maxNormalAngleDeg)) {
          refusedByNormals += 1;
          continue;
        }
      }
      // The provenance rule has the last word, so a pass that was handed a
      // centre it should not fill cannot write one anyway.
      const written = nextSupport(centre, 'reconstruct');
      if (written === centre) {
        refused.unsupported += 1;
        continue;
      }
      output.support[i] = packSupport(written, unpackSampleCount(input.support[i]));
      output.depth[i] = decision.depth;
      filled += 1;
    }
  }

  return {
    filled,
    refused,
    refusedByNormals,
    refusedByLens,
    census: censusOfPacked(output.support.subarray(0, w * h)),
  };
}
