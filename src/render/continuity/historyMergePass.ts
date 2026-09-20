/**
 * historyMergePass.ts — merging one frame's samples into the history.
 *
 * `depthMerge` decides one pixel: whether a new sample is in front of what the
 * history holds, on the same surface as it, or behind it. `supportProvenance`
 * says what that does to the pixel's record. Neither walks a frame, and the
 * rules that only appear when you do are the ones this file holds.
 *
 * ── THIS IS NOT TEMPORAL ANTI-ALIASING ──────────────────────────────────────
 * The usual temporal accumulation reprojects the previous frame through the
 * new camera and blends, which is why it ghosts: a pixel that used to see a
 * wall and now sees the floor behind it keeps some of the wall. Depth is what
 * stops that here, and the four rules are the whole of it. An empty pixel
 * takes the sample. A sample clearly in front replaces what was there, because
 * the surface it belongs to is the one now facing the camera. A sample on the
 * same surface within the depth tolerance is added to it. A sample clearly
 * behind is dropped, because the history is already showing what occludes it.
 *
 * Nothing is reprojected. The history is only ever merged into while the
 * display epoch stands still, so every contribution was drawn through the same
 * camera as every other, and a pixel's samples are all of one view. Camera
 * motion moves the epoch, which clears the history rather than transforming
 * it. That is the conservative first version the programme asks for, and it is
 * why a merge needs no motion vectors and no history rejection heuristic.
 *
 * ── THE PASS REFUSES A FRAME IT CANNOT TRUST ────────────────────────────────
 * A merge into a history from another epoch would combine two pictures, so
 * this takes the epoch of both and does nothing at all when they differ. The
 * caller is expected to have cleared the history already; refusing here as
 * well is the cheaper half of a rule whose other half is a clear that somebody
 * has to remember to do.
 *
 * ── WHAT A MERGE DOES TO THE RECORD ─────────────────────────────────────────
 * A pixel taking a sample for the first time, or replacing what it held, is
 * `direct`: a source sample was rasterised there this frame. A pixel adding a
 * sample to the surface it already holds is `accumulated`, which is the only
 * write that can produce that state. A pixel that keeps what it had keeps its
 * provenance too, including `reconstructed`, because dropping a sample behind
 * the surface is not evidence about the pixel in front.
 *
 * Pure: no GPU, no DOM, no three.js. The caller owns both sets of buffers.
 * Display only, and nothing merged here may reach picking, measurement,
 * terrain, export or claim evidence.
 */
import {
  mergeDecision,
  type ColorSemantics,
  type MergeDecision,
} from './depthMerge';
import {
  nextSupport,
  packSupport,
  unpackSampleCount,
  unpackSupportKind,
} from './supportProvenance';

/** One frame of samples, or the history they merge into. */
export interface MergeRaster {
  readonly widthPx: number;
  readonly heightPx: number;
  /** Eye-space depth per pixel. Zero or non-finite means nothing is there. */
  readonly depth: Float32Array;
  /** One packed byte per pixel: provenance and sample count. */
  readonly support: Uint8Array;
}

/** What the merge did, per outcome, for a diagnostics surface. */
export interface HistoryMergeResult {
  /** Pixels by what was decided for them. */
  readonly decisions: Readonly<Record<MergeDecision, number>>;
  /**
   * Pixels the frame drew no sample into.
   *
   * Counted apart from `keep`, which means the sample lost to what the history
   * held. Folding the two together would report a frame that drew nothing as a
   * frame whose every sample was occluded.
   */
  readonly skipped: number;
  /** Pixels whose stored provenance changed. */
  readonly provenanceChanged: number;
  /** True when the pass declined the whole frame. */
  readonly refused: boolean;
}

/** What the caller knows about the frame and the history. */
export interface HistoryMergeOptions {
  /** The epoch the incoming samples were drawn under. */
  readonly sampleEpoch: number;
  /** The epoch the history was built under. */
  readonly historyEpoch: number;
  /** Depth tolerance, passed through to the per-pixel rule. */
  readonly epsilon?: number;
  /** Whether an intermediate colour means anything for this colour mode. */
  readonly semantics?: ColorSemantics;
}

const NOTHING: Readonly<Record<MergeDecision, number>> = Object.freeze({
  accept: 0, replace: 0, blend: 0, keep: 0,
});

/**
 * Merge one frame's samples into the history.
 *
 * `samples` is read and never written. `history` is updated in place, which is
 * the difference from the gap pass: a merge reads and writes the same pixel of
 * the same buffer and no pixel reads its neighbour, so there is nothing an
 * iteration order could change.
 *
 * Returns what was decided, or a refusal when the two epochs disagree or the
 * rasters do not describe the same frame.
 */
export function runHistoryMergePass(
  samples: MergeRaster,
  history: MergeRaster,
  options: HistoryMergeOptions,
): HistoryMergeResult {
  const { widthPx: w, heightPx: h } = samples;
  const decisions = { accept: 0, replace: 0, blend: 0, keep: 0 };
  const sized = w > 0 && h > 0
    && history.widthPx === w && history.heightPx === h
    && samples.depth.length >= w * h && samples.support.length >= w * h
    && history.depth.length >= w * h && history.support.length >= w * h;
  if (!sized || options.sampleEpoch !== options.historyEpoch) {
    return { decisions: NOTHING, skipped: 0, provenanceChanged: 0, refused: true };
  }

  let provenanceChanged = 0;
  let skipped = 0;
  for (let i = 0; i < w * h; i++) {
    const sampleZ = samples.depth[i];
    const sampleKind = unpackSupportKind(samples.support[i]);
    // A pixel the frame drew nothing into has nothing to contribute, and a
    // reconstructed one must not be merged: a fill is not a sample, and
    // merging it would be the laundering step the provenance rules forbid.
    if (sampleKind !== 'direct' && sampleKind !== 'accumulated') {
      skipped += 1;
      continue;
    }
    const historyKind = unpackSupportKind(history.support[i]);
    const held = unpackSampleCount(history.support[i]);
    // Weight is the count of samples already merged. A pixel holding a fill
    // holds no samples, so it weighs nothing and the first real sample takes
    // it rather than losing to a depth that came from a neighbour.
    const weight = historyKind === 'direct' || historyKind === 'accumulated' ? held : 0;
    const decision = mergeDecision(
      sampleZ, history.depth[i], weight, options.epsilon, options.semantics,
    );
    decisions[decision] += 1;
    if (decision === 'keep') continue;

    const write = decision === 'blend' ? 'accumulate' : 'sample';
    // `blend` on an empty pixel cannot happen: mergeDecision answers `accept`
    // whenever the weight is zero, so an accumulate always has something to
    // accumulate into and `nextSupport` never has to refuse one here.
    const before = decision === 'blend' ? historyKind : 'none';
    const written = nextSupport(before, write);
    const count = decision === 'blend' ? held + 1 : 1;
    history.support[i] = packSupport(written, count);
    // The nearer of the two on a blend, for the reason the gap pass takes the
    // nearest supporting neighbour: the two agree to within the tolerance, so
    // the choice barely moves the value, and keeping the nearer one stops a
    // merged pixel drifting behind the surface it belongs to.
    history.depth[i] = decision === 'blend' ? Math.min(sampleZ, history.depth[i]) : sampleZ;
    if (written !== historyKind) provenanceChanged += 1;
  }

  return { decisions, skipped, provenanceChanged, refused: false };
}
