/**
 * supportProvenance.ts — where each drawn pixel's colour came from, and the
 * only ways it may change.
 *
 * Four states, which `microGap` already names: nothing drawn, a source sample
 * rasterised here, built up from source samples across a sweep, or borrowed
 * from neighbours to close a gap. This module does not redefine them. What it
 * adds is the part a renderer cannot be trusted to remember: which writes are
 * allowed to move a pixel from one to another, and how the answer is stored.
 *
 * ── THE NAME ────────────────────────────────────────────────────────────────
 * Display-support provenance. It is not confidence and it is not completeness,
 * and the difference is not pedantry. Confidence would be a claim about how
 * likely the picture is to be right; completeness would be a claim about how
 * much of the scene was captured. This is neither: it says which pixels a
 * sample was rasterised into and which the renderer filled in, for one frame,
 * at one camera. A dense scan drawn from far away and a sparse one drawn close
 * up can produce the same tallies, so nothing here measures the data.
 *
 * ── THE TRANSITIONS, AND THE ONE THAT MUST NOT EXIST ────────────────────────
 * A source sample is authoritative: it may overwrite any state, including a
 * pixel that was reconstructed a moment ago, because a sample landing there is
 * exactly what reconstruction was standing in for.
 *
 * Accumulation may only carry forward what came from samples. A pixel that was
 * reconstructed cannot become accumulated, and a pixel with nothing under it
 * cannot become anything: there is nothing to retain.
 *
 * Reconstruction may only fill a pixel with nothing in it. It never overwrites
 * a sample, and it never overwrites another reconstruction, which is what would
 * turn a one-pixel seam into a growing patch over the course of a sweep.
 *
 * The transition this forbids is reconstructed becoming direct or accumulated
 * without a sample. That is the laundering step: once a filled pixel is
 * indistinguishable from a measured one, it becomes evidence for filling its
 * neighbour, and the renderer walks a surface across ground nothing was
 * recorded on. `microGap` refuses reconstructed neighbours as evidence for the
 * same reason, from the other end.
 *
 * ── THE REPRESENTATION ──────────────────────────────────────────────────────
 * One byte per pixel, which is the surface the history layout already
 * allocates: two bits of provenance and six bits of a saturating sample count.
 * Both fit in `SUPPORT_R8` with nothing added to the budget, and keeping them
 * in one surface means a pixel's provenance and the count behind it cannot be
 * read from different frames.
 *
 * The count saturates at 63. It is there to answer how much a pixel rests on,
 * not how many samples exist: `SAMPLES_FOR_FULL_SUPPORT` is four, so the range
 * is an order of magnitude past anything the support scalar reads, and past
 * that the distinction has no consumer.
 *
 * Pure: no GPU, no DOM, no framebuffer. The caller owns the surface and
 * performs the write. Display only, and nothing derived from a provenance
 * tally may reach picking, measurement, terrain, export or claim evidence.
 */
import type { SupportKind } from './microGap';

/** What a pass is trying to write into a pixel. */
export type SupportWrite =
  /** A source sample was rasterised into this pixel. */
  | 'sample'
  /** A sweep is carrying this pixel's existing support forward. */
  | 'accumulate'
  /** A gap pass wants to fill this pixel from its neighbours. */
  | 'reconstruct';

/** The two-bit code each state is stored as. */
export const SUPPORT_CODE: Readonly<Record<SupportKind, number>> = Object.freeze({
  none: 0,
  direct: 1,
  accumulated: 2,
  reconstructed: 3,
});

/** The state each code decodes to, indexed by the code itself. */
const KIND_BY_CODE: readonly SupportKind[] = ['none', 'direct', 'accumulated', 'reconstructed'];

/** Bits of provenance, and bits of sample count, in the one byte. */
export const PROVENANCE_BITS = 2;
export const COUNT_BITS = 6;

/** The largest sample count the byte can hold. Counts above it saturate. */
export const MAX_PACKED_SAMPLES = (1 << COUNT_BITS) - 1;

/**
 * Pack a pixel's provenance and sample count into one byte.
 *
 * Provenance takes the low bits so a reader that wants only the state can mask
 * with 3 and stop. A negative or non-finite count is stored as zero, because a
 * count nobody could produce is not evidence of any samples.
 */
export function packSupport(kind: SupportKind, samples = 0): number {
  const n = Number.isFinite(samples) ? Math.max(0, Math.floor(samples)) : 0;
  const capped = Math.min(MAX_PACKED_SAMPLES, n);
  return SUPPORT_CODE[kind] | (capped << PROVENANCE_BITS);
}

/** The provenance stored in a packed byte. */
export function unpackSupportKind(byte: number): SupportKind {
  if (!Number.isFinite(byte)) return 'none';
  const code = Math.max(0, Math.floor(byte)) & ((1 << PROVENANCE_BITS) - 1);
  return KIND_BY_CODE[code] ?? 'none';
}

/** The sample count stored in a packed byte. */
export function unpackSampleCount(byte: number): number {
  if (!Number.isFinite(byte)) return 0;
  return (Math.max(0, Math.floor(byte)) >> PROVENANCE_BITS) & MAX_PACKED_SAMPLES;
}

/**
 * The byte a normalised texel holds, and the texel a byte becomes.
 *
 * `SUPPORT_R8` is `r8unorm`, so a shader reads 0 to 1 rather than 0 to 255. A
 * bit field only survives that trip if both ends agree on the scale and the
 * rounding, so both directions live here rather than being written out at each
 * sampling site, where one of them would eventually round differently.
 */
export function byteFromUnorm(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value * 255)));
}

/** The normalised texel value for a packed byte. */
export function unormFromByte(byte: number): number {
  if (!Number.isFinite(byte)) return 0;
  return Math.min(255, Math.max(0, Math.floor(byte))) / 255;
}

/**
 * The provenance a pixel takes after one write, or the one it already had when
 * the write is not allowed to move it.
 *
 * Refusing by returning the current state rather than by throwing is
 * deliberate: this runs per pixel in a pass that must not be able to lose a
 * frame, and a write that is not permitted is an ordinary outcome rather than
 * an error. What it must never do is quietly permit one.
 */
export function nextSupport(current: SupportKind, write: SupportWrite): SupportKind {
  switch (write) {
    case 'sample':
      // Authoritative from every state, including reconstructed: a sample
      // landing here is what the fill was standing in for.
      return 'direct';
    case 'accumulate':
      // Only what came from samples may be carried forward. A reconstructed
      // pixel stays reconstructed, which is the transition that would launder
      // a filled pixel into a measured one.
      return current === 'direct' || current === 'accumulated' ? 'accumulated' : current;
    case 'reconstruct':
      // Only into a pixel with nothing in it. Never over a sample, and never
      // over another fill, which is how a seam becomes a patch.
      return current === 'none' ? 'reconstructed' : current;
  }
}

/**
 * Whether a write would change a pixel's provenance.
 *
 * For a pass that wants to skip the surface write when nothing moves, and for
 * a test that wants to state a refusal rather than infer one from equality.
 */
export function writeIsPermitted(current: SupportKind, write: SupportWrite): boolean {
  return nextSupport(current, write) !== current;
}

/**
 * Whether a pixel may be counted as evidence for reconstructing its neighbour.
 *
 * Samples only, whether rasterised this frame or carried forward from ones
 * that were. `microGap` enforces the same rule where it reads its cardinals;
 * this states it in the provenance vocabulary so a future pass with its own
 * neighbourhood does not have to rediscover it.
 */
export function maySupportReconstruction(kind: SupportKind): boolean {
  return kind === 'direct' || kind === 'accumulated';
}
