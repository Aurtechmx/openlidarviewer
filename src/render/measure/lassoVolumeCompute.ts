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
import type {
  LassoSelectionWithDepth,
  ScreenProjector,
  SelectionVisibilityFilters,
  Vec2,
} from './lassoVolume';
import type { Vec3 } from '../navMath';
import { isWithheld } from '../../science/withheldPolicy';
import type { VolumeWithheldCounts } from './types';
/** A resident streaming node as the lasso walk needs to see it. */
export interface StreamingLassoPart {
  /** The node's decoded positions, render-local — which is world for a stream. */
  readonly positions: Float32Array;
  /**
   * What this node currently SHOWS, for a given walk stride. Taken as a
   * function of the stride because the walk chooses it from the point budget
   * after the parts are assembled, and `acceptIndex` reads the node's own
   * buffer rather than the strided copy.
   */
  filters(stride: number): SelectionVisibilityFilters | null;
  /** The node's own per-point flag bytes, or absent when it carries none. */
  readonly flags?: Uint8Array;
}

/** A resident node as the parts builder needs to read it. */
export interface StreamingChunkView {
  readonly positions: Float32Array;
  readonly classification?: Uint8Array;
  readonly intensity?: Uint16Array;
  readonly classificationFlags?: Uint8Array;
}

/**
 * Pair every resident node with the filters that decide what it shows.
 *
 * Built here rather than at the call site so the positions and the filters
 * cannot drift apart: a node's `acceptIndex` reads that node's own
 * classification, and indexing two lists separately is how one node's points
 * end up judged by another node's attributes.
 *
 * `clipKeep` is applied to the node's RENDER-LOCAL coordinates unchanged. A
 * streaming mesh sits at the scene origin, so those are the world coordinates
 * three.js clips against, unlike a static layer, which is source-local plus its
 * placement and needs the offset folded in first. It is a predicate or null
 * rather than a box plus a flag, so there is no shape in which a clip is
 * "enabled" and the test that implements it is missing.
 */
export function streamingLassoParts(
  chunks: ReadonlyArray<StreamingChunkView>,
  clipKeep: ((x: number, y: number, z: number) => boolean) | null,
  acceptFor: (chunk: StreamingChunkView) => ((index: number) => boolean) | null,
): StreamingLassoPart[] {
  return chunks.map((chunk) => ({
    positions: chunk.positions,
    flags: chunk.classificationFlags,
    filters: (stride: number) => lassoVisibilityFilters(clipKeep, acceptFor(chunk), stride),
  }));
}

/**
 * Drop the points a layer is not currently showing, from a selection that
 * carries its projection.
 *
 * All four arrays compact together: the depth test reads `indices`,
 * `screenX`, `screenY` and `depth` by one running offset, so dropping a hidden
 * point from one alone would pair the survivors with another point's screen
 * position. In place, so the hot path allocates nothing.
 */
function applyVisibility(
  raw: LassoSelectionWithDepth,
  positions: Float32Array,
  filters: SelectionVisibilityFilters | null,
): LassoSelectionWithDepth {
  const keep = filters?.keepPoint;
  const accept = filters?.acceptIndex;
  if (!keep && !accept) return raw;
  const { indices, screenX, screenY, depth } = raw;
  let w = 0;
  for (let r = 0; r < raw.count; r++) {
    const pi = indices[r];
    if (keep && !keep(positions[pi * 3], positions[pi * 3 + 1], positions[pi * 3 + 2])) continue;
    if (accept && !accept(pi)) continue;
    indices[w] = pi; screenX[w] = screenX[r]; screenY[w] = screenY[r]; depth[w] = depth[r];
    w++;
  }
  return { indices, screenX, screenY, depth, count: w };
}

/**
 * Drop the points the producer marked Withheld from a selection, in place,
 * the way the terrain gather does (`sampleStridedTerrain`): scientific
 * processing leaves them out (`withheldPolicy.ts`), Overlap and every other
 * marking are read as normal. `flags` indexes the source's OWN buffer, so the
 * walk's strided index is multiplied back by `stride` first.
 *
 * Returns the compacted selection and the number dropped, or `null` when the source has no flags channel
 * that lines up with its points: the count is then unknown, not zero, and
 * nothing is dropped. A voxel-reduced cloud lands here, because its centroids
 * carry no flags, and none are invented for them.
 */
export function dropWithheld(
  sel: LassoSelectionWithDepth,
  flags: Uint8Array | undefined,
  pointCount: number,
  stride: number,
): { readonly sel: LassoSelectionWithDepth; readonly dropped: number | null } {
  if (!flags || flags.length !== pointCount) return { sel, dropped: null };
  const step = Math.max(1, Math.floor(stride));
  const { indices, screenX, screenY, depth } = sel;
  let w = 0;
  for (let r = 0; r < sel.count; r++) {
    const pi = indices[r];
    if (isWithheld(flags[pi * step])) continue;
    indices[w] = pi; screenX[w] = screenX[r]; screenY[w] = screenY[r]; depth[w] = depth[r];
    w++;
  }
  return { sel: { indices, screenX, screenY, depth, count: w }, dropped: sel.count - w };
}

import { describeLassoSelectionBasis, rejectOccluded } from './lassoOcclusion';
import type { LassoSelectionBasis, OcclusionOutcome } from './lassoOcclusion';
export type { LassoSelectionBasis } from './lassoOcclusion';
export { makeLassoProjector } from './lassoProjector';
// Re-exported through this cluster so the Viewer keeps one import for the
// whole lasso walk rather than gaining an edge per helper.
export { sourcePositions } from '../../model/pointFrames';

/**
 * Pair a clip-box test with a per-point accept, or null when neither hides
 * anything and the walk should skip the filter entirely.
 *
 * `clipKeep` is called with PROJECT-frame coordinates, because that is the
 * frame the clip box is defined in and the frame the walk's placed copy is
 * already in — no offset is re-applied.
 *
 * `accept` is called with an index into the cloud's OWN buffer. The walk's
 * indices address its strided copy, so `stride` undoes that here rather than
 * at each call site, where getting it wrong would accept the wrong points
 * silently.
 */
export function lassoVisibilityFilters(
  clipKeep: ((x: number, y: number, z: number) => boolean) | null,
  accept: ((index: number) => boolean) | null,
  stride: number,
): SelectionVisibilityFilters | null {
  if (!clipKeep && !accept) return null;
  const step = Math.max(1, Math.floor(stride));
  return {
    keepPoint: clipKeep ?? undefined,
    acceptIndex: accept ? (i) => accept(i * step) : undefined,
  };
}


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
  /**
   * Resident streaming nodes, each paired with the filters that decide what it
   * SHOWS, or an empty array when nothing streams.
   *
   * Positions and filters travel together rather than as two parallel lists,
   * because the only thing keeping two lists aligned would be the order a map
   * happened to iterate in.
   *
   * A node's positions are render-local, and a streaming mesh sits at the scene
   * origin, so render-local IS the world frame the clipping planes are given to
   * three.js in. No offset is re-applied — which is also why this is a separate
   * entry from {@link visibilityFor}, whose static buffers are source-local
   * plus placement.
   */
  readonly streamingParts: ReadonlyArray<StreamingLassoPart>;
  /** Whether this cloud was voxel-reduced to fit the device budget. */
  wasReduced(cloud: PointCloud): boolean;
  /**
   * The clip box and class/elevation/intensity filters that decide what this
   * layer currently SHOWS, or null when nothing is hiding anything.
   *
   * A MEASUREMENT must not be taken over points the user cannot see, for the
   * same reason an edit must not rewrite them (reclassify-invisible-points,
   * Critical) — and more so, because a measurement is a claim about the scene
   * on screen. Clip a stockpile away from the road cut behind it, lasso the
   * pile, and the clipped-away low returns still set the reference percentile
   * and inflate the fill, with nothing in the result saying so.
   *
   * `positions` passed to `keepPoint` are in the PROJECT frame, already
   * placed, which is the frame the clip box is defined in. The index handed to
   * `acceptIndex` is the index into the cloud's OWN buffer, so the walk undoes
   * its stride first.
   */
  visibilityFor(entry: LassoCloudEntry, stride: number): SelectionVisibilityFilters | null;
  /** The scan's up axis, for the footprint hull and the reference plane. */
  readonly worldUp: Vec3;
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
  /**
   * Keep points the producer marked Withheld. Default false: a volume is
   * scientific processing, which leaves them out (`withheldPolicy.ts`).
   */
  readonly includeWithheld?: boolean;
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
  /**
   * True when at least one selected point came from a streaming source. The
   * completeness of a streaming source is a property of the transfer, not of
   * the footprint, so a caller that states an authority has to know whether
   * the figure rests on one at all.
   */
  readonly streamingContributed: boolean;
  /**
   * Whether the clip box or a visibility filter held candidates back, so the
   * figure describes the visible subset rather than everything inside the
   * drawn shape. A viewer who clipped deliberately wants exactly that; one who
   * forgot a class was hidden needs telling.
   */
  readonly selectionRestrictedByVisibility: boolean;
  readonly polygon3D: ReadonlyArray<[number, number, number]>;
  readonly referenceZ: number;
  readonly result: ReturnType<typeof volumeFromLassoWithFootprint>['result'];
  readonly selectionBasis: LassoSelectionBasisReport;
  /** Source, Withheld-excluded and analysed point counts for this walk. */
  readonly withheld: VolumeWithheldCounts;
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
  for (const part of host.streamingParts) candidatePointCount += part.positions.length / 3;

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
  /** Whether the clip box or a visibility filter held any candidate back. */
  let anyHidden = false;

  // Every source's candidates are gathered BEFORE anything is rejected. The
  // depth buffer has to be one buffer over all of them: a building in one layer
  // hides the ground in another, and a per-source buffer would never see that.
  const parts: Array<{ readonly id: string | null; readonly positions: Float32Array; readonly sel: LassoSelectionWithDepth }> = [];
  let candidateCount = 0;
  // Withheld points leave at the input, before the depth buffer and the
  // estimators see them. `withheldKnown` turns false as soon as one
  // contributing source has no flags channel: its count is then unknown.
  const excludeWithheld = !input.includeWithheld;
  let withheldDropped = 0;
  let withheldKnown = true;
  let sourceCount = 0;
  const takeWithheld = (
    sel: LassoSelectionWithDepth,
    flags: Uint8Array | undefined,
    points: number,
  ): LassoSelectionWithDepth => {
    sourceCount += sel.count;
    if (!excludeWithheld) return sel;
    const out = dropWithheld(sel, flags, points, stride);
    if (out.dropped === null) withheldKnown = false;
    else withheldDropped += out.dropped;
    return out.sel;
  };

  // Static clouds, walked independently so per-cloud indices can go back to
  // the highlight pipeline.
  for (const [id, entry] of host.integrable) {
    const positions = copyPlacedPositions(entry.cloud, stride, entry.placement);
    const raw = selectByLassoWithDepth({ positions, lasso, project: host.project });
    if (raw.count === 0) continue;
    // Hidden points leave before anything is measured or pooled into the depth
    // buffer, so neither the volume nor the occlusion test can see them.
    const visible = applyVisibility(raw, positions, host.visibilityFor(entry, stride));
    if (visible.count === 0) continue;
    if (visible.count < raw.count) anyHidden = true;
    // A voxel-reduced cloud's points are centroids, which have no flags of
    // their own: its Withheld count is unknown whatever array it holds.
    const flags = host.wasReduced(entry.cloud) ? undefined : entry.cloud.classificationFlags;
    const sel = takeWithheld(visible, flags, entry.cloud.pointCount);
    if (sel.count === 0) continue;
    if (host.wasReduced(entry.cloud)) anySourceReduced = true;
    parts.push({ id, positions, sel });
    candidateCount += sel.count;
  }

  // Streaming clouds contribute to the volume but not to the highlight: the
  // streaming renderer owns its own colour buffers, so per-mesh indexing is a
  // separate piece of work.
  for (const part of host.streamingParts) {
    const src = part.positions;
    const positions = stride === 1 ? src : stridePositions(src, stride);
    const raw = selectByLassoWithDepth({ positions, lasso, project: host.project });
    if (raw.count === 0) continue;
    // The same rule the static layers get: a clip box or a class filter that
    // hides a point hides it from the measurement too. Leaving this out meant a
    // clip bound the static layers and not a resident stream.
    const visible = applyVisibility(raw, positions, part.filters(stride));
    if (visible.count === 0) continue;
    if (visible.count < raw.count) anyHidden = true;
    const sel = takeWithheld(visible, part.flags, src.length / 3);
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
  // Streaming parts carry a null id; a part that survives the depth test is a
  // streaming contribution to the figure.
  let streamingContributed = false;
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
    } else {
      streamingContributed = true;
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
    // The footprint hull and the reference plane are defined against this; a
    // Y-up scan measured without it gets a side elevation for a plan area.
    up: host.worldUp,
  });

  return {
    selectedPositions,
    selectedCount: totalSelected,
    selectionByCloudId,
    budget,
    anySourceReduced,
    streamingContributed,
    selectionRestrictedByVisibility: anyHidden,
    polygon3D: lassoOut.polygon3D as ReadonlyArray<[number, number, number]>,
    referenceZ: lassoOut.referenceZ,
    result: lassoOut.result,
    selectionBasis,
    withheld: {
      source: sourceCount,
      excluded: !excludeWithheld ? 0 : withheldKnown ? withheldDropped : 'unknown',
      analysed: totalSelected,
    },
  };
}
