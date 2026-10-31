/**
 * classShareBasis.ts
 *
 * Which points a class SHARE is stated over, and in what words.
 *
 * A large scan opened as a display sample is first strided at decode, then
 * voxel-reduced to the point budget. The voxel pass keeps one centroid per
 * occupied voxel, so dense classes (ground, grass) collapse much more than
 * sparse ones (canopy), and shares counted on the held centroids are biased.
 * The loader therefore counts the classes of the decoded records BEFORE the
 * voxel pass ({@link ClassSample}); an even stride of the file is an unbiased
 * basis for a share.
 *
 * That histogram describes the SOURCE classes only. Once the user edits the
 * classes (clear, auto-classify, lasso, swap), it no longer describes the
 * codes on screen, and there is no honest way to carry the edit back onto
 * records that are not held. So the histogram is used only while the held
 * codes are still the ones the load produced: the provenance is 'source', and
 * the held per-class counts and the digest of the held codes equal the ones
 * taken at load. The digest catches an edit that keeps every count, such as
 * two classes swapped. Restore earlier
 * classes puts those codes back, and the histogram applies again. Otherwise
 * the shares are counted on the held points and say so.
 *
 * Per-class COUNTS (the Classes page, Solo, hide) always describe the held
 * points; this module is only about shares.
 *
 * Pure data: no DOM, no three.js.
 */

import type { ClassSample } from './PointCloud';
import type { PointCloud } from './PointCloud';

export type { ClassSample };

/** The counts a share is taken over, and the plain words for them. */
export interface ClassShareBasis {
  /** Per-code counts the shares are taken over. */
  readonly counts: ReadonlyMap<number, number>;
  /** Sum of {@link counts}. */
  readonly total: number;
  /**
   * What the shares are of, e.g. "an even sample of 8,786,971 points" or
   * "the loaded display sample"; null when the held points are the whole file.
   */
  readonly phrase: string | null;
  /** True when the shares come from the pre-reduction histogram. */
  readonly fromSample: boolean;
}

/** Wording for the loaded points when they are a sample of the file. */
export const LOADED_SAMPLE_PHRASE = 'the loaded display sample';

/** Per-code counts of a classification buffer, as a byte histogram. */
export function heldClassCounts(classification: ArrayLike<number>): Map<number, number> {
  const bins = new Float64Array(256);
  for (let i = 0; i < classification.length; i++) bins[classification[i] & 0xff]++;
  const out = new Map<number, number>();
  for (let c = 0; c < 256; c++) if (bins[c] > 0) out.set(c, bins[c]);
  return out;
}

/** FNV-1a over a classification buffer, so two buffers with equal counts can still be told apart. */
export function classDigest(classification: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < classification.length; i++) {
    h ^= classification[i] & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The histogram of `source` (the decoded records) to keep on `reduced` (its
 * voxel-reduced cloud), or undefined when there is nothing to count or no
 * reduction happened.
 */
export function classSampleOf(source: PointCloud, reduced: PointCloud): ClassSample | undefined {
  if (reduced === source || !source.classification || !reduced.classification) return undefined;
  const counts = heldClassCounts(source.classification);
  return {
    counts,
    total: source.pointCount,
    stride: Math.max(1, Math.floor(source.loadStride ?? 1)),
    heldAtLoad: heldClassCounts(reduced.classification),
    heldDigest: classDigest(reduced.classification),
  };
}

function sameCounts(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
  let na = 0;
  for (const [code, n] of a) {
    if (n === 0) continue;
    na++;
    if (b.get(code) !== n) return false;
  }
  let nb = 0;
  for (const n of b.values()) if (n !== 0) nb++;
  return na === nb;
}

/** Plain words for the records a {@link ClassSample} counted. */
export function classSamplePhrase(sample: ClassSample): string {
  const n = sample.total.toLocaleString('en-US');
  return sample.stride > 1 ? `an even sample of ${n} points` : `all ${n} points read`;
}

/**
 * The share basis from the held per-class counts. `sample` is used only while
 * `held` still equals the counts taken at load and `heldDigest` (the
 * {@link classDigest} of the held codes) equals the one taken at load (see the
 * module comment); `sampled` says whether the held points are a sample of the
 * file.
 */
export function classShareBasis(
  held: ReadonlyMap<number, number>,
  sampled: boolean,
  sample?: ClassSample | null,
  heldDigest?: number,
): ClassShareBasis {
  const sameCodes = sample?.heldDigest === undefined || sample.heldDigest === heldDigest;
  if (sample && sample.total > 0 && sameCounts(held, sample.heldAtLoad) && sameCodes) {
    return { counts: sample.counts, total: sample.total, phrase: classSamplePhrase(sample), fromSample: true };
  }
  let total = 0;
  for (const n of held.values()) total += n;
  return { counts: held, total, phrase: sampled ? LOADED_SAMPLE_PHRASE : null, fromSample: false };
}

/** The share basis for a cloud's live classes, or null when it has none. */
export function cloudClassShareBasis(cloud: {
  readonly classification?: ArrayLike<number> | null;
  readonly classSample?: ClassSample;
  readonly classificationProvenance?: string;
  readonly pointCount: number;
  readonly declaredPointCount?: number;
}): ClassShareBasis | null {
  const cls = cloud.classification;
  if (!cls || cls.length === 0) return null;
  const sampled = cloud.declaredPointCount !== undefined && cloud.declaredPointCount > cloud.pointCount;
  // A cleared or derived classification is not the source the histogram counted.
  const sample = cloud.classificationProvenance === undefined || cloud.classificationProvenance === 'source'
    ? cloud.classSample
    : undefined;
  return classShareBasis(heldClassCounts(cls), sampled, sample, sample ? classDigest(cls) : undefined);
}

/** Share of codes 0 and 1 (Created, Unclassified) in a basis, 0 to 1. */
export function unclassifiedShare(b: ClassShareBasis): number {
  if (!(b.total > 0)) return 0;
  return ((b.counts.get(0) ?? 0) + (b.counts.get(1) ?? 0)) / b.total;
}
