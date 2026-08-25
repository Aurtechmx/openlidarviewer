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
 * The per-cloud walk stays separate from the streaming walk because static
 * clouds report per-cloud indices to the highlight pipeline and streaming ones
 * do not. Both feed ONE pooled candidate set before the depth test runs, so a
 * layer can hide another layer; a per-source depth buffer could not see that.
 *
 * On the default basis the walk selects exactly what it always did.
 */

import type { PointCloud } from '../../model/PointCloud';
import { sourcePositions } from '../../model/pointFrames';
import type { LayerSpatialTransform } from '../../geo/ProjectSpatialFrame';
import { accumulatorOffset } from '../layerPlacement';
import type { VolumeBudgetDecision } from './volumeBudget';
import { decideVolumeBudget } from './volumeBudget';
import { selectByLassoWithDepth, volumeFromLassoWithFootprint } from './lassoVolume';
import type { LassoSelectionWithDepth, ScreenProjector, Vec2 } from './lassoVolume';
import { describeLassoSelectionBasis, rejectOccluded } from './lassoOcclusion';
import type { LassoSelectionBasis, OcclusionOutcome } from './lassoOcclusion';
export type { LassoSelectionBasis } from './lassoOcclusion';
export { makeLassoProjector } from './lassoProjector';

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

/**
 * A strided copy, with the layer's Float64 placement folded into every kept
 * point so both the selection (projected against the shared-frame camera) and
 * the packed volume points are in the project frame. Identity placement makes
 * this exactly {@link stridePositions}: `stride <= 1` returns `src` untouched
 * (no allocation, byte-identical) and a real stride adds an offset of zero —
 * so the lasso stays a provable no-op while mounting is disabled.
 */
export function stridePlacedPositions(
  src: Float32Array,
  stride: number,
  placement?: LayerSpatialTransform | null,
): Float32Array {
  const [dx, dy, dz] = accumulatorOffset(placement);
  const identity = dx === 0 && dy === 0 && dz === 0;
  if (stride <= 1 && identity) return src;
  const step = Math.max(1, stride);
  const points = Math.floor(src.length / 3);
  const kept = stride <= 1 ? points : Math.floor(points / stride);
  const out = new Float32Array(kept * 3);
  for (let i = 0; i < kept; i++) {
    const srcIdx = i * step * 3;
    out[i * 3] = src[srcIdx] + dx;
    out[i * 3 + 1] = src[srcIdx + 1] + dy;
    out[i * 3 + 2] = src[srcIdx + 2] + dz;
  }
  return out;
}

/**
 * A layer's points in the PROJECT-LOCAL frame: the cloud's source-local buffer
 * with its Float64 placement folded in, optionally strided.
 *
 * The cloud-taking form of {@link stridePlacedPositions}, and the one call
 * sites should reach for. Passing `cloud.positions` and the placement as two
 * separate arguments is how a layer gets placed twice or not at all; passing
 * the cloud lets the accessor own the pairing, and names the frame the result
 * is in at the call site.
 *
 * Identity placement with `stride <= 1` returns the source buffer itself, so
 * this is byte-identical to a raw read in the shipped single-layer
 * configuration and allocates nothing.
 */
export function copyPlacedPositions(
  cloud: PointCloud,
  stride: number,
  placement?: LayerSpatialTransform | null,
): Float32Array {
  return stridePlacedPositions(sourcePositions(cloud), stride, placement);
}

/** A layer as this walk needs to see it. */
export interface LassoCloudEntry {
  readonly cloud: PointCloud;
  /** Float64 placement into the shared project frame; null/absent = identity. */
  readonly placement?: LayerSpatialTransform | null;
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
  /**
   * Which selection basis to measure on. Defaults to `'through-surfaces'`,
   * which is what every lasso volume taken before this existed was measured on:
   * a default that changed would give a stored measurement a different value on
   * re-run without anything in the file saying why.
   */
  readonly basis?: LassoSelectionBasis;
}

/** What the occlusion decision did, for the caller to state alongside the figure. */
export interface LassoSelectionBasisReport {
  /** The basis asked for. */
  readonly requested: LassoSelectionBasis;
  /** The basis actually measured on — `through-surfaces` when no tolerance could be estimated. */
  readonly effective: LassoSelectionBasis;
  /** Present when occlusion was requested: why it did or did not run. */
  readonly outcome?: OcclusionOutcome;
  /** Candidates the polygon accepted before the depth test. */
  readonly candidateCount: number;
  /** Candidates the depth test rejected as hidden. 0 when it did not run. */
  readonly occludedCount: number;
  /** Depth-buffer cell size in screen pixels. 0 when the test did not run. */
  readonly cellSizePx: number;
  /** Accepted depth spread behind a cell's nearest point, cloud units. 0 when it did not run. */
  readonly depthTolerance: number;
  /**
   * The clause a toast, panel or report states the basis with. Built here so
   * every surface that shows a lasso figure says the same thing about it.
   */
  readonly clause: string;
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
  readonly selectionBasis: LassoSelectionBasisReport;
}

/**
 * Run the walk. Returns null when there is nothing trustworthy to report:
 * a degenerate lasso, or fewer than three points selected.
 */
export function computeLassoVolume(
  input: LassoVolumeComputeInput,
): LassoVolumeComputeOutput | null {
  const { host, lasso, referencePercentile } = input;
  const requestedBasis: LassoSelectionBasis = input.basis ?? 'through-surfaces';
  if (lasso.length < 3) return null;

  // Count candidates BEFORE walking — every static cloud plus every resident
  // streaming node — so the budget can decide whether to stride or walk
  // exhaustively. The decision rides on the result so the inspector caption
  // can say "estimated (sampled — n%)".
  let candidatePointCount = 0;
  for (const [, entry] of host.integrable) candidatePointCount += entry.cloud.pointCount;
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
  let anySourceReduced = false;

  // Every source's candidates are gathered BEFORE anything is rejected. The
  // depth buffer has to be one buffer over all of them: a building in one layer
  // hides the ground in another, and a per-source buffer would never see that.
  const parts: Array<{ readonly id: string | null; readonly positions: Float32Array; readonly sel: LassoSelectionWithDepth }> = [];
  let candidateCount = 0;

  // Static clouds, walked independently so per-cloud indices can go back to
  // the highlight pipeline.
  for (const [id, entry] of host.integrable) {
    const positions = copyPlacedPositions(entry.cloud, stride, entry.placement);
    const sel = selectByLassoWithDepth({ positions, lasso, project: host.project });
    if (sel.count === 0) continue;
    if (host.wasReduced(entry.cloud)) anySourceReduced = true;
    parts.push({ id, positions, sel });
    candidateCount += sel.count;
  }

  // Streaming clouds contribute to the volume but not to the highlight: the
  // streaming renderer owns its own colour buffers, so per-mesh indexing is a
  // separate piece of work.
  for (const sourcePositions of host.streamingPositions) {
    const positions = stride === 1 ? sourcePositions : stridePositions(sourcePositions, stride);
    const sel = selectByLassoWithDepth({ positions, lasso, project: host.project });
    if (sel.count === 0) continue;
    parts.push({ id: null, positions, sel });
    candidateCount += sel.count;
  }

  // The depth test, over the pooled candidates. `keep` is indexed by the same
  // running offset the parts were appended at.
  let keep: Uint8Array | null = null;
  let occlusionOutcome: OcclusionOutcome | undefined;
  let cellSizePx = 0;
  let depthTolerance = 0;
  if (requestedBasis === 'occluded-excluded' && candidateCount > 0) {
    const screenX = new Float64Array(candidateCount);
    const screenY = new Float64Array(candidateCount);
    const depth = new Float64Array(candidateCount);
    let off = 0;
    for (const part of parts) {
      screenX.set(part.sel.screenX.subarray(0, part.sel.count), off);
      screenY.set(part.sel.screenY.subarray(0, part.sel.count), off);
      depth.set(part.sel.depth.subarray(0, part.sel.count), off);
      off += part.sel.count;
    }
    const decision = rejectOccluded({ screenX, screenY, depth, count: candidateCount });
    occlusionOutcome = decision.outcome;
    cellSizePx = decision.cellSizePx;
    depthTolerance = decision.depthTolerance;
    if (decision.applied) keep = decision.keep;
  }

  const subsetParts: Float32Array[] = [];
  let totalSelected = 0;
  let base = 0;
  for (const part of parts) {
    const { sel, positions, id } = part;
    // Kept indices, in the source array's own space.
    const kept: number[] = [];
    for (let i = 0; i < sel.count; i++) {
      if (keep === null || keep[base + i] === 1) kept.push(sel.indices[i]);
    }
    base += sel.count;
    if (kept.length === 0) continue;
    if (id !== null) {
      // Strided indices are in the reduced array's space; translate back so the
      // highlight lights up the right points in the source cloud.
      selectionByCloudId.set(id, stride === 1 ? kept : kept.map((i) => i * stride));
    }
    totalSelected += kept.length;
    const packed = new Float32Array(kept.length * 3);
    for (let i = 0; i < kept.length; i++) {
      const idx = kept[i];
      packed[i * 3] = positions[idx * 3];
      packed[i * 3 + 1] = positions[idx * 3 + 1];
      packed[i * 3 + 2] = positions[idx * 3 + 2];
    }
    subsetParts.push(packed);
  }

  if (totalSelected < 3) return null;

  const selectionBasis: LassoSelectionBasisReport = {
    requested: requestedBasis,
    effective: keep === null ? 'through-surfaces' : 'occluded-excluded',
    outcome: occlusionOutcome,
    candidateCount,
    occludedCount: candidateCount - totalSelected,
    cellSizePx,
    depthTolerance,
    clause: describeLassoSelectionBasis(
      keep === null ? 'through-surfaces' : 'occluded-excluded',
      occlusionOutcome,
    ),
  };

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
    selectionBasis,
  };
}
