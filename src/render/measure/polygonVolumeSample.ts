/**
 * polygonVolumeSample.ts — the polygon Volume tool's cut/fill sample.
 *
 * Lifted out of the Viewer's volume sampler: the Viewer gathers the placed
 * buffers (with each source's classification flags), and this turns them
 * into the stored record. Withheld points are left out of the integration
 * and counted inside the footprint, so the record states points read,
 * Withheld excluded and points analysed the way the lasso volume does.
 *
 * Pure: no DOM, no three.js.
 */
import type { Vec3 } from '../navMath';
import type { VolumeRecord } from './types';
import { deriveVolumeRecord } from './measureDerivations';
import {
  assembleVolumePositions,
  POINT_SAMPLE_VOLUME_METHOD,
  volumeCutFill,
  type PlacedVolumeBuffer,
} from './volume';

// Re-exported so the Viewer keeps one import edge for the volume cluster.
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
): VolumeRecord {
  const { positions, withheldPositions, everySourceFlagged } = assembleVolumePositions(buffers, total);
  const result = volumeCutFill({ polygon, referenceZ, up, positions });
  const record = deriveVolumeRecord(result, referenceZ, POINT_SAMPLE_VOLUME_METHOD);
  let excluded = 0;
  if (withheldPositions.length > 0) {
    const w = volumeCutFill({ polygon, referenceZ, up, positions: withheldPositions });
    excluded = w.pointsInPolygon + (w.skippedNonFinite ?? 0);
  }
  const analysed = result.pointsInPolygon;
  record.withheld = {
    source: analysed + (result.skippedNonFinite ?? 0) + excluded,
    excluded: everySourceFlagged ? excluded : 'unknown',
    analysed,
  };
  return record;
}
