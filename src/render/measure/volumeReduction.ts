/**
 * volumeReduction.ts — what a volume walk knows about reduced source clouds.
 *
 * A loader can hand the viewer fewer points than the file declared in two
 * ways. A stride keeps original records, so each point still has its own
 * class and flags. A voxel reduction replaces records with centroids: a
 * centroid carries only the first member's class and no flags, so neither says
 * anything reliable about the points it stands for. A volume measured on the
 * second kind cannot filter ASPRS noise (classes 7 and 18) or Withheld points,
 * and its record says so instead of reporting a zero.
 *
 * Pure: no DOM, no three.js.
 */
import type { PointCloud } from '../../model/PointCloud';
import type { VolumeSourceReduction, VolumeWithheldCounts } from './types';

/** The fraction of the declared count below which a cloud counts as reduced. */
const REDUCED_BELOW = 0.95;

/** One source cloud's reduction, or undefined when it is held whole. */
export interface CloudReduction {
  readonly mode: VolumeSourceReduction['mode'];
  readonly resident: number;
  readonly declared: number;
}

/** The fields of a cloud the reduction check reads. */
export type ReductionSource = Pick<
  PointCloud,
  'pointCount' | 'declaredPointCount' | 'decodedPointCount' | 'pointReduction'
>;

/**
 * How `cloud` was reduced, if it was. A voxel reduction is reported whatever
 * the counts say; a stride is reported when the declared count exceeds the
 * resident count by more than 5%.
 */
export function cloudReduction(cloud: ReductionSource): CloudReduction | undefined {
  const declared = cloud.declaredPointCount;
  const voxel = cloud.pointReduction === 'voxel-centroids';
  const thinned = declared !== undefined && cloud.pointCount < declared * REDUCED_BELOW;
  if (!voxel && !thinned) return undefined;
  return {
    mode: voxel ? 'voxel-centroids' : 'strided-records',
    resident: cloud.pointCount,
    declared: declared ?? cloud.decodedPointCount ?? cloud.pointCount,
  };
}

/** Whether the labels of a reduced source are its original records' labels. */
export function labelsReliable(reduction: CloudReduction | undefined): boolean {
  return reduction?.mode !== 'voxel-centroids';
}

/** One summary over every reduced source a walk read, or undefined when none. */
export function summariseReductions(
  list: ReadonlyArray<CloudReduction | undefined>,
): VolumeSourceReduction | undefined {
  let mode: VolumeSourceReduction['mode'] | undefined;
  let resident = 0;
  let declared = 0;
  for (const r of list) {
    if (!r) continue;
    if (mode === undefined || r.mode === 'voxel-centroids') mode = r.mode;
    resident += r.resident;
    declared += r.declared;
  }
  return mode === undefined ? undefined : { mode, resident, declared };
}

/** The withheld block's reduction fields: nothing at all for a whole-cloud walk. */
export function reductionFields(
  list: ReadonlyArray<CloudReduction | undefined>,
): Pick<VolumeWithheldCounts, 'reduction' | 'exclusionUnavailable'> {
  const reduction = summariseReductions(list);
  if (!reduction) return {};
  return reduction.mode === 'voxel-centroids'
    ? { reduction, exclusionUnavailable: 'reduced-sample' }
    : { reduction };
}
