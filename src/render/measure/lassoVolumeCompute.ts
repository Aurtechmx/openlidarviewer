/**
 * lassoVolumeCompute.ts — the lasso-volume walk, lifted out of the Viewer.
 *
 * This is the orchestration that sits between a screen-space lasso and
 * `volumeFromLassoWithFootprint`: count candidates, pick a stride, walk each
 * static cloud and each resident streaming node, pack the selected points, and
 * assemble the result with its honesty caveats.
 *
 * It takes a HOST rather than the Viewer, the same shape that worked for the
 * export adapter. The Viewer supplies a projector it built from its camera, so
 * nothing here imports three.js: the module stays inside the layer-boundaries
 * rule and is unit-testable without a WebGL context, which the method was not
 * while it lived on the class.
 *
 * Behaviour is unchanged. The per-cloud walk stays separate from the streaming
 * walk because static clouds report per-cloud indices to the highlight
 * pipeline and streaming ones do not.
 */

import type { PointCloud } from '../../model/PointCloud';
import type { VolumeBudgetDecision } from './volumeBudget';
import { decideVolumeBudget } from './volumeBudget';
import { selectByLasso, volumeFromLassoWithFootprint } from './lassoVolume';
import type { ScreenProjector, Vec2 } from './lassoVolume';

/**
 * A strided copy of an interleaved xyz buffer, keeping every `stride`-th
 * point. Used when the adaptive budget downsamples a heavy workload.
 * O(n / stride) on the source length; allocates one new array. Indices are
 * remapped back to source space by the caller so the highlight pipeline still
 * points at real per-cloud points.
 *
 * Moved here with the walk: it was module-local in the Viewer and had no other
 * caller.
 */
export function stridePositions(src: Float32Array, stride: number): Float32Array {
  if (stride <= 1) return src;
  const points = Math.floor(src.length / 3);
  const kept = Math.floor(points / stride);
  const out = new Float32Array(kept * 3);
  for (let i = 0; i < kept; i++) {
    const srcIdx = i * stride * 3;
    out[i * 3] = src[srcIdx];
    out[i * 3 + 1] = src[srcIdx + 1];
    out[i * 3 + 2] = src[srcIdx + 2];
  }
  return out;
}

/** A layer as this walk needs to see it. */
export interface LassoCloudEntry {
  readonly cloud: PointCloud;
}

/**
 * What the walk needs from the Viewer.
 *
 * Deliberately narrow: a projector, the layers that may take part, the
 * streaming position arrays, and one predicate. Everything else the method
 * used to reach for (canvas, camera, scene) is resolved by the caller before
 * it gets here.
 */
export interface LassoVolumeHost {
  /** Screen projector built from the live camera. Returns null behind the near/far planes. */
  readonly project: ScreenProjector;
  /** Layers eligible to contribute, already filtered for visibility and lock. */
  readonly integrable: ReadonlyArray<readonly [string, LassoCloudEntry]>;
  /** Resident streaming node positions, or an empty array when nothing streams. */
  readonly streamingPositions: ReadonlyArray<Float32Array>;
  /** Whether this cloud was voxel-reduced to fit the device budget. */
  wasReduced(cloud: PointCloud): boolean;
}

export interface LassoVolumeComputeInput {
  readonly host: LassoVolumeHost;
  readonly lasso: ReadonlyArray<Vec2>;
  readonly referencePercentile: number;
}

export interface LassoVolumeComputeOutput {
  readonly selectedPositions: Float32Array;
  readonly selectedCount: number;
  readonly selectionByCloudId: Map<string, ReadonlyArray<number>>;
  readonly budget: VolumeBudgetDecision;
  readonly anySourceReduced: boolean;
  readonly polygon3D: ReadonlyArray<[number, number, number]>;
  readonly referenceZ: number;
  readonly result: ReturnType<typeof volumeFromLassoWithFootprint>['result'];
}

/**
 * Run the walk. Returns null when there is nothing trustworthy to report:
 * a degenerate lasso, or fewer than three points selected.
 */
export function computeLassoVolume(
  input: LassoVolumeComputeInput,
): LassoVolumeComputeOutput | null {
  const { host, lasso, referencePercentile } = input;
  if (lasso.length < 3) return null;

  // Count candidates BEFORE walking — every static cloud plus every resident
  // streaming node — so the budget can decide whether to stride or walk
  // exhaustively. The decision rides on the result so the inspector caption
  // can say "estimated (sampled — n%)".
  let candidatePointCount = 0;
  for (const [, entry] of host.integrable) candidatePointCount += entry.cloud.positions.length / 3;
  for (const positions of host.streamingPositions) candidatePointCount += positions.length / 3;

  const budget = decideVolumeBudget({
    candidatePointCount,
    // Footprint area isn't known until selection, so the density branch sits
    // out. The ceiling branch still fires on cloud size, which is the bigger
    // lever in practice.
    footprintAreaM2: 0,
  });
  const stride = budget.stride;

  const selectionByCloudId = new Map<string, ReadonlyArray<number>>();
  const subsetParts: Float32Array[] = [];
  let totalSelected = 0;
  let anySourceReduced = false;

  const pack = (positions: Float32Array, indices: ReadonlyArray<number>): Float32Array => {
    const part = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      part[i * 3] = positions[idx * 3];
      part[i * 3 + 1] = positions[idx * 3 + 1];
      part[i * 3 + 2] = positions[idx * 3 + 2];
    }
    return part;
  };

  // Static clouds, walked independently so per-cloud indices can go back to
  // the highlight pipeline.
  for (const [id, entry] of host.integrable) {
    const positions =
      stride === 1 ? entry.cloud.positions : stridePositions(entry.cloud.positions, stride);
    const localIndices = selectByLasso({ positions, lasso, project: host.project });
    if (localIndices.length === 0) continue;
    // Strided indices are in the reduced array's space; translate back so the
    // highlight lights up the right points in the source cloud.
    const sourceIndices = stride === 1 ? localIndices : localIndices.map((i) => i * stride);
    selectionByCloudId.set(id, sourceIndices);
    if (host.wasReduced(entry.cloud)) anySourceReduced = true;
    totalSelected += localIndices.length;
    subsetParts.push(pack(positions, localIndices));
  }

  // Streaming clouds contribute to the volume but not to the highlight: the
  // streaming renderer owns its own colour buffers, so per-mesh indexing is a
  // separate piece of work.
  for (const sourcePositions of host.streamingPositions) {
    const positions = stride === 1 ? sourcePositions : stridePositions(sourcePositions, stride);
    const indices = selectByLasso({ positions, lasso, project: host.project });
    if (indices.length === 0) continue;
    totalSelected += indices.length;
    subsetParts.push(pack(positions, indices));
  }

  if (totalSelected < 3) return null;

  let len = 0;
  for (const p of subsetParts) len += p.length;
  const selectedPositions = new Float32Array(len);
  let off = 0;
  for (const p of subsetParts) {
    selectedPositions.set(p, off);
    off += p.length;
  }

  // The buffer holds ONLY selected points, so the index list is 0..N-1.
  const allIndices = new Array<number>(totalSelected);
  for (let i = 0; i < totalSelected; i++) allIndices[i] = i;

  const lassoOut = volumeFromLassoWithFootprint({
    positions: selectedPositions,
    selected: allIndices,
    referencePercentile,
  });

  return {
    selectedPositions,
    selectedCount: totalSelected,
    selectionByCloudId,
    budget,
    anySourceReduced,
    polygon3D: lassoOut.polygon3D as ReadonlyArray<[number, number, number]>,
    referenceZ: lassoOut.referenceZ,
    result: lassoOut.result,
  };
}
