/**
 * polygonVolumeSample.ts — the polygon Volume tool's cut/fill sample.
 *
 * Lifted out of the Viewer's volume sampler: the Viewer gathers the placed
 * buffers (with each source's classification flags), and this turns them
 * into the stored record. Withheld points are left out of the integration
 * and counted inside the footprint, so the record states points read,
 * Withheld excluded and points analysed the way the lasso volume does.
 * Noise classes 7 and 18 are left out the same way and counted as
 * `noiseExcluded` when a source carries a classification channel.
 *
 * Pure: no DOM, no three.js.
 */
import type { Vec3 } from '../navMath';
import type { LayerSpatialTransform } from '../../geo/ProjectSpatialFrame';
import type { VolumeRecord } from './types';
import { labelsReliable, reductionFields, type CloudReduction } from './volumeReduction';
import { deriveVolumeRecord } from './measureDerivations';
import {
  assembleVolumePositions,
  POINT_SAMPLE_VOLUME_METHOD,
  volumeCutFill,
  type PlacedVolumeBuffer,
} from './volume';

// Re-exported so the Viewer keeps one import edge for the volume cluster.
export { cloudReduction } from './volumeReduction';
export { POINT_SAMPLE_VOLUME_METHOD, type PlacedVolumeBuffer, type VolumeResult } from './volume';

/**
 * Integrate the polygon cut/fill over `buffers`, leaving Withheld points out.
 *
 * `withheld.source` is every point inside the footprint, `excluded` the
 * Withheld ones among them (`'unknown'` when a source had no flags channel),
 * and `analysed` the points the integration read. A non-finite height inside
 * the footprint is read but not integrated (`skippedNonFinite`), so it counts
 * toward `source` and not toward `analysed`.
 */
export function samplePolygonVolume(
  buffers: ReadonlyArray<PlacedVolumeBuffer>,
  total: number,
  polygon: ReadonlyArray<Vec3>,
  referenceZ: number,
  up: Vec3,
  reductions: ReadonlyArray<CloudReduction | undefined> = [],
): VolumeRecord {
  const { positions, withheldPositions, noisePositions, everySourceFlagged } = assembleVolumePositions(buffers, total);
  const result = volumeCutFill({ polygon, referenceZ, up, positions });
  const record = deriveVolumeRecord(result, referenceZ, POINT_SAMPLE_VOLUME_METHOD);
  let excluded = 0;
  if (withheldPositions.length > 0) {
    const w = volumeCutFill({ polygon, referenceZ, up, positions: withheldPositions });
    excluded = w.pointsInPolygon + (w.skippedNonFinite ?? 0);
  }
  let noise = 0;
  if (noisePositions.length > 0) {
    const z = volumeCutFill({ polygon, referenceZ, up, positions: noisePositions });
    noise = z.pointsInPolygon + (z.skippedNonFinite ?? 0);
  }
  const analysed = result.pointsInPolygon;
  record.withheld = {
    source: analysed + (result.skippedNonFinite ?? 0) + excluded + noise,
    excluded: everySourceFlagged ? excluded : 'unknown',
    analysed,
    ...reductionFields(contributing(buffers, polygon, referenceZ, up, reductions)),
  };
  if (noise > 0) record.withheld = { ...record.withheld, noiseExcluded: noise };
  return record;
}

/**
 * The reductions of the static sources that put at least one point inside the
 * footprint, so the caveat describes only what the figure read. `reductions`
 * is aligned with the leading `buffers`.
 */
function contributing(
  buffers: ReadonlyArray<PlacedVolumeBuffer>,
  polygon: ReadonlyArray<Vec3>,
  referenceZ: number,
  up: Vec3,
  reductions: ReadonlyArray<CloudReduction | undefined>,
): Array<CloudReduction | undefined> {
  return reductions.map((r, i) => {
    const buffer = buffers[i];
    if (!r || !buffer) return undefined;
    const sets = assembleVolumePositions([buffer], buffer.pos.length);
    for (const positions of [sets.withheldPositions, sets.noisePositions, sets['positions']]) {
      if (positions.length === 0) continue;
      const cut = volumeCutFill({ polygon, referenceZ, up, positions });
      if (cut.pointsInPolygon + (cut.skippedNonFinite ?? 0) > 0) return r;
    }
    return undefined;
  });
}

/** A source the volume sampler reads: positions plus its per-point channels. */
export interface VolumeSourceCloud {
  readonly positions?: Float32Array;
  readonly classificationFlags?: Uint8Array;
  readonly classification?: Uint8Array;
}

/** The buffers one polygon volume walk reads, with the point totals. */
export interface GatheredVolumeBuffers {
  readonly buffers: PlacedVolumeBuffer[];
  /** Summed element length (Σ pos.length). */
  readonly total: number;
  /** Elements that came from resident streaming nodes. */
  readonly streamingPoints: number;
  /** How each static source was reduced, in walk order; undefined for a whole one. */
  readonly reductions: ReadonlyArray<CloudReduction | undefined>;
}

/**
 * Collect the placed buffers for the polygon Volume tool, each with its
 * Withheld flags and classification, so `samplePolygonVolume` can leave out
 * Withheld and noise points. A strided static cloud keeps its original
 * records and passes both. A voxel-reduced one holds centroids, whose labels
 * are not those of the points they stand for, so it passes neither; the
 * lasso walk does the same. `streaming` receives the static
 * buffer count and returns the resident nodes that may join the walk.
 */
export function gatherVolumeBuffers<C extends VolumeSourceCloud>(
  statics: Iterable<{ readonly cloud: C; readonly placement?: LayerSpatialTransform | null }>,
  streaming: (staticCount: number) => Iterable<VolumeSourceCloud>,
  reductionOf: (cloud: C) => CloudReduction | undefined,
): GatheredVolumeBuffers {
  const buffers: PlacedVolumeBuffer[] = [];
  let total = 0;
  let streamingPoints = 0;
  const reductions: Array<CloudReduction | undefined> = [];
  for (const { cloud, placement } of statics) {
    const pos = cloud.positions;
    if (!pos || pos.length === 0) continue;
    const reduction = reductionOf(cloud);
    const trusted = labelsReliable(reduction);
    reductions.push(reduction);
    buffers.push({
      pos,
      placement,
      flags: trusted ? cloud.classificationFlags : undefined,
      classification: trusted ? cloud.classification : undefined,
    });
    total += pos.length;
  }
  for (const node of streaming(buffers.length)) {
    const pos = node.positions;
    if (!pos || pos.length === 0) continue;
    buffers.push({ pos, flags: node.classificationFlags, classification: node.classification });
    total += pos.length;
    streamingPoints += pos.length;
  }
  return { buffers, total, streamingPoints, reductions };
}
