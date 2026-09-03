/**
 * displaySample.ts: the one description of a display-sampled buffer.
 *
 * The loader strides a large file so the viewer holds a subset of the records
 * the header declares, and a voxel pass may then reduce that subset again to
 * one averaged centroid per occupied voxel. Everything measured off the buffer
 * afterwards (its bounding box, a per-class count, an areal density) describes
 * the SAMPLE, while the point total the file declares describes the FILE. A
 * surface that prints both without saying which is which reads as one basis.
 *
 * The Scan Report panel already says it. This module holds the sentence it says
 * it in, so the exported PDF can say the same thing rather than a second,
 * drifting version of it: {@link displaySample} returns the panel's own "Loaded"
 * row value, and the two suffix constants carry the qualifiers that go on the
 * rows the sample's geometry produced.
 *
 * Pure: numbers in, strings out. No cloud class, no DOM, no formatting policy
 * beyond the locale grouping the panel already applies.
 */

/**
 * What a cloud records about how its buffer was reduced. Structural rather than
 * a `PointCloud`, so the report layer can describe a sample it only has counts
 * for.
 */
export interface DisplaySampleCounts {
  /** Points held in memory: what `bounds()` and every per-point pass see. */
  readonly pointCount: number;
  /** The record total the file's header declared, when it declared one. */
  readonly declaredPointCount?: number;
  /** Points decoded before any voxel reduction, when one ran. */
  readonly decodedPointCount?: number;
  /** The 1-in-N record stride the loader applied, when it strided. */
  readonly loadStride?: number;
}

/** How a display-sampled buffer relates to the file it was read from. */
export interface DisplaySample {
  /** The in-memory count, locale-formatted: the panel's "Loaded" figure. */
  readonly loaded: string;
  /** The reductions that produced it, as the panel names them. */
  readonly how: string;
  /** The Scan Report panel's "Loaded" row value, whole. */
  readonly value: string;
}

/**
 * The qualifier for a row whose value came out of the sample's bounding box.
 * `PointCloud.bounds()` reduces over the in-memory buffer, so a strided load's
 * extents span the sample, not the survey.
 */
export const DISPLAY_SAMPLE_EXTENT_BASIS = ' (display sample)';

/**
 * The qualifier for an areal density that divides the FILE's declared count by
 * the SAMPLE's footprint: a mean over two different bases, not a measured
 * density. Verbatim from the Scan Report panel's Density row.
 */
export const DISPLAY_SAMPLE_DENSITY_BASIS =
  ' (mean: declared count over the display-sample footprint)';

/**
 * Describe the display sample, or `null` when the buffer holds the whole file.
 *
 * Sampled means the header declared MORE records than the buffer holds. A file
 * that declared nothing, or declared no more than is held, is not a sample and
 * gets no disclosure, which is what keeps a fully-loaded scan's output
 * unchanged.
 *
 * A voxel pass is named whenever the decoded count exceeds the held count,
 * because that gap is the reduction; otherwise the stride is named by its ratio
 * when the loader recorded one, and by name alone when it did not.
 */
export function displaySample(counts: DisplaySampleCounts): DisplaySample | null {
  const declared = counts.declaredPointCount;
  const held = counts.pointCount;
  if (declared === undefined || !(declared > held)) return null;
  const loaded = held.toLocaleString('en-US');
  const decoded = counts.decodedPointCount;
  const how =
    decoded !== undefined && decoded > held
      ? `stride to ${decoded.toLocaleString('en-US')}, then voxel-reduced to ${loaded} centroids`
      : counts.loadStride !== undefined && counts.loadStride > 1
        ? `1-in-${counts.loadStride} stride`
        : 'stride';
  return { loaded, how, value: `${loaded} (display sample: ${how})` };
}
