/**
 * profileSectionSeam.ts
 *
 * The one place a profile reads the scene.
 *
 * Two products come off a section line. The derived series reduces the
 * corridor to one height per station; the section keeps the returns
 * themselves. They have to agree about which layers contributed, or a chart
 * and the points behind it describe different scenes. Both are served here
 * from a single eligibility decision — {@link integrableClouds}, the same
 * predicate the picker and the volume walk use — so there is no second rule
 * to drift from.
 *
 * The host is reached only through {@link ProfileSectionSeamDeps}, a set of
 * accessor functions closing over whatever holds the layers and the resident
 * streaming nodes. Nothing here imports the viewer, the scheduler or the DOM,
 * which is what lets the whole seam run under Node against plain arrays.
 *
 * The two products read the scene differently on purpose. The derived series
 * concatenates positions, because a percentile per bin needs every candidate
 * in one buffer and the buffer is thrown away immediately. A section keeps a
 * small fraction of the returns, so it walks each source in place through
 * `readProjectXYZ` and copies nothing.
 */
import {
  sampleProfile,
  assembleProfileBuffers,
  autoCorridorWidth,
  AUTO_CORRIDOR_FRACTION,
  DEFAULT_GROUND_PERCENTILE,
  DEFAULT_PROFILE_SAMPLE_COUNT,
  type ProfileSourceBuffer,
} from './profileSampler';
import { resolveCorridorHalfWidth } from './profileCorridor';
import { buildProfileFrame, type ProfileFrame } from './profileGeometry';
import {
  extractProfileSectionChunks,
  type ProfileSectionSourceView,
  type ProfileSourceBounds,
} from './profileSectionExtract';
import type { ProfileSourceChannels, ProfileSectionPoints } from './profileSectionBuilder';
import {
  orderResidentNodes,
  streamingIsComplete,
  resolveSectionScope,
  describeSectionScope,
  SectionGeneration,
  type ProfileSectionScope,
  type ResidentNodeRef,
  type StreamingCoverage,
} from './profileSectionSnapshot';
import { integrableClouds, type IntegrableEntry } from '../integrableClouds';
import { accumulatorOffset } from '../layerPlacement';
import type { LayerSpatialTransform } from '../../geo/ProjectSpatialFrame';
import type { ProfileChartSample, Vec3 } from './types';

/**
 * One loaded static layer offered to the seam.
 *
 * Extends {@link IntegrableEntry} rather than restating its fields, so the
 * eligibility rule reads the same properties here that it reads at the
 * picker: a layer cannot be visible to one and hidden from the other.
 */
export interface ProfileSeamLayer extends IntegrableEntry {
  /** Stable identity recorded against every return this layer contributes. */
  readonly id: string;
  /** Interleaved source-local XYZ, or null when the layer holds no points. */
  readonly positions: Float32Array | null;
  /** Channels aligned to this layer's own point index, or null. */
  readonly channels: ProfileSourceChannels | null;
  /** Conservative project-frame bounds, or null when unknown. */
  readonly bounds: ProfileSourceBounds | null;
  /** Float64 placement into the project frame; null/absent = identity. */
  readonly placement?: LayerSpatialTransform | null;
}

/** One resident streaming node offered to the seam. */
export interface ProfileSeamResidentNode {
  /** Octree key, `depth-x-y-z`. Identity comes from this, never from arrival. */
  readonly key: string;
  /** Interleaved render-local XYZ, or null. */
  readonly positions: Float32Array | null;
  readonly channels: ProfileSourceChannels | null;
}

/**
 * The host's services, as accessors.
 *
 * Every one is a thunk because the scene changes under the seam: layers are
 * added and hidden, nodes stream in and are evicted. Reading them at call
 * time is what makes a section a snapshot of the moment it was asked for
 * rather than of the moment the seam was built.
 */
export interface ProfileSectionSeamDeps {
  /** Every loaded static layer, eligible or not. The seam applies the rule. */
  layers: () => Iterable<ProfileSeamLayer>;
  /** Resident streaming nodes, in whatever order the host happens to hold. */
  residentNodes: () => Iterable<ProfileSeamResidentNode>;
  /**
   * Whether resident nodes may join `staticCount` static layers already
   * accepted. Owned by the host because it turns on what the open streaming
   * source has proven about the project frame.
   */
  streamingMayCombine: (staticCount: number) => boolean;
  /** The configured world up. Not a hardcoded Z: a Y-up scan cuts along Y. */
  worldUp: () => Vec3;
  /** Node coverage of the open streaming source, or null when none is open. */
  streamingCoverage: () => StreamingCoverage | null;
}

/** What the derived sampler hands back, with the values that shaped it. */
export interface ProfileSeriesResult {
  samples: ProfileChartSample[];
  residentOnly: boolean;
  corridorWidth: number;
  groundPercentile: number;
}

/** User overrides for the derived series. Absent fields take the defaults. */
export interface ProfileSeriesOptions {
  corridorWidth?: number | null;
  groundPercentile?: number | null;
  sampleCount?: number | null;
}

/** Where one slot's returns came from. */
export interface ProfileSectionSourceRef {
  readonly slot: number;
  readonly kind: 'static' | 'resident';
  /** Layer id, or octree key. */
  readonly id: string;
  readonly pointCount: number;
}

/** A raw section, with what it was read from and whether that was all of it. */
export interface ProfileSectionResult {
  readonly points: ProfileSectionPoints;
  readonly frame: ProfileFrame;
  /** Corridor half-width actually walked. */
  readonly band: number;
  readonly scope: ProfileSectionScope;
  /** The sentence a header shows for {@link scope}. */
  readonly scopeLabel: string;
  /** Null when the streaming source's node count is not known. */
  readonly streamingComplete: boolean | null;
  readonly sources: readonly ProfileSectionSourceRef[];
  /** The token this extraction ran under. */
  readonly generation: number;
  /** True when the scan stopped early because the signal aborted. */
  readonly aborted: boolean;
  readonly skippedSlots: readonly number[];
  readonly examined: number;
}

/** A section request. */
export interface ProfileSectionRequest {
  readonly a: Vec3;
  readonly b: Vec3;
  /** Corridor half-width; null/absent takes the same auto width the series does. */
  readonly corridorWidth?: number | null;
  /** Points examined between yields. */
  readonly chunkSize?: number;
  readonly signal?: { readonly aborted: boolean };
}

/** The seam a host wires its measure controller and section workbench to. */
export interface ProfileSectionSeam {
  /** The derived height-vs-chainage series. Null when nothing is loaded. */
  sampleSeries(a: Vec3, b: Vec3, opts?: ProfileSeriesOptions): ProfileSeriesResult | null;
  /**
   * Walk the corridor for its raw returns, yielding the count examined so
   * far so a host can spread the scan across frames.
   *
   * Returns null when a newer request was made while this one ran, so a slow
   * extraction can never replace the section the user is actually looking at.
   */
  sectionChunks(req: ProfileSectionRequest): Generator<number, ProfileSectionResult | null, void>;
  /** {@link sectionChunks} run to completion. */
  section(req: ProfileSectionRequest): ProfileSectionResult | null;
  /** Refuse every outstanding and future extraction. Permanent. */
  abandon(): void;
}

/**
 * A channel is used only when its length agrees with the point count it is
 * supposed to be aligned to. A misaligned array is the absence of the
 * channel, not a channel to be read with a shifted index — the rule
 * `sampleProfile` already applies to classification, applied to the same
 * decision here so the series and the section drop the same arrays.
 */
function alignedClassification(
  channels: ProfileSourceChannels | null,
  positionLength: number,
): Uint8Array | undefined {
  const cls = channels?.classification;
  return cls?.length === positionLength / 3 ? cls : undefined;
}

/** A source view over an in-memory buffer, read in the project frame. */
function viewOf(
  slot: number,
  positions: Float32Array,
  channels: ProfileSourceChannels | null,
  bounds: ProfileSourceBounds | null,
  placement: LayerSpatialTransform | null | undefined,
): ProfileSectionSourceView {
  // The placement is resolved once, as float64, and added per read. The
  // source buffer is never written and never copied: a section over a
  // hundred returns must not cost a copy of the layer that holds them.
  const [dx, dy, dz] = accumulatorOffset(placement);
  return {
    slot,
    pointCount: positions.length / 3,
    channels,
    bounds,
    readProjectXYZ(index: number, out: Float64Array): void {
      const base = index * 3;
      out[0] = positions[base]! + dx;
      out[1] = positions[base + 1]! + dy;
      out[2] = positions[base + 2]! + dz;
    },
  };
}

/** A static layer that holds points, with the buffer already resolved. */
interface StaticSource {
  readonly layer: ProfileSeamLayer;
  readonly pos: Float32Array;
}

/** A resident node that holds points, with the buffer already resolved. */
interface ResidentSource {
  readonly node: ProfileSeamResidentNode;
  readonly pos: Float32Array;
}

/** What one pass over the scene found, shared by both products. */
interface SceneWalk {
  readonly statics: readonly StaticSource[];
  readonly residents: readonly ResidentSource[];
}

/**
 * The eligible sources, in a fixed order.
 *
 * Static layers come from {@link integrableClouds}, so a hidden or locked
 * layer stays off a section the way it is off the screen and an unmounted
 * layer cannot contribute coordinates that mean somewhere else. Resident
 * nodes join only on the terms a static layer would have to meet, and are
 * ordered by {@link orderResidentNodes} so the result does not depend on the
 * order the network happened to deliver them in.
 */
function walkScene(deps: ProfileSectionSeamDeps): SceneWalk {
  const statics: StaticSource[] = [];
  for (const layer of integrableClouds(deps.layers())) {
    const pos = layer.positions;
    if (pos && pos.length > 0) statics.push({ layer, pos });
  }
  // The stream is judged against the static layers the walk has ALREADY
  // accepted, so it can never get in on terms a static cloud would be
  // refused on.
  if (!deps.streamingMayCombine(statics.length)) return { statics, residents: [] };
  // `orderResidentNodes` decides the read order from the octree key alone, so
  // its input is a bare ref. The buffer is carried back through the ref's own
  // identity rather than by re-parsing the key.
  const refs: ResidentNodeRef[] = [];
  const held = new Map<ResidentNodeRef, ResidentSource>();
  for (const node of deps.residentNodes()) {
    const pos = node.positions;
    if (!pos || pos.length === 0) continue;
    const ref: ResidentNodeRef = { key: node.key, pointCount: pos.length / 3 };
    refs.push(ref);
    held.set(ref, { node, pos });
  }
  const residents: ResidentSource[] = [];
  for (const ref of orderResidentNodes(refs)) {
    const source = held.get(ref);
    if (source) residents.push(source);
  }
  return { statics, residents };
}

export function createProfileSectionSeam(deps: ProfileSectionSeamDeps): ProfileSectionSeam {
  const generation = new SectionGeneration();

  function sampleSeries(
    a: Vec3,
    b: Vec3,
    opts?: ProfileSeriesOptions,
  ): ProfileSeriesResult | null {
    // Track each buffer's classification alongside it so the profile can be
    // computed over classified ground (vegetation / buildings dropped).
    const buffers: ProfileSourceBuffer[] = [];
    let total = 0;
    let streamingPoints = 0;
    let anyClass = false;
    const { statics, residents } = walkScene(deps);
    for (const { layer, pos } of statics) {
      const cls = alignedClassification(layer.channels, pos.length);
      if (cls) anyClass = true;
      buffers.push({ pos, cls, placement: layer.placement });
      total += pos.length;
    }
    for (const { node, pos } of residents) {
      const cls = alignedClassification(node.channels, pos.length);
      if (cls) anyClass = true;
      buffers.push({ pos, cls });
      total += pos.length;
      streamingPoints += pos.length;
    }
    if (total === 0) return null;
    // Flatten — cheap because only the resident set is walked. The assembler
    // folds each layer's Float64 placement into the project frame as it
    // copies (identity while mounting is off = the same bytes as before).
    const { positions, classification } = assembleProfileBuffers(buffers, total, anyClass);
    // `up` is the configured world up — hardcoding [0,0,1] here cut Y-up
    // phone scans along the wrong axis (v0.4.4 audit, B1).
    const up = deps.worldUp();
    // Absent/null fields fall back to the standing defaults — the 5 %-of-length
    // auto corridor, p25, 64 bins. Every value that ACTUALLY shaped the
    // estimate is passed back so it lands on the measurement record and the
    // PDF/CSV provenance prints the real numbers instead of "auto" (B4).
    const corridorWidth = opts?.corridorWidth ?? autoCorridorWidth(a, b, up);
    const groundPercentile = opts?.groundPercentile ?? DEFAULT_GROUND_PERCENTILE;
    const sampleCount = opts?.sampleCount ?? DEFAULT_PROFILE_SAMPLE_COUNT;
    const samples = sampleProfile({
      a,
      b,
      up,
      positions,
      samples: sampleCount,
      bandWidth: corridorWidth,
      groundPercentile,
      classification,
    });
    // "Resident-only" whenever any streaming bytes are in the walk: those
    // nodes may still refine the profile as they stream in, and a fully-loaded
    // static cloud beside them does not complete the streaming part (audit #8:
    // gating on `staticPoints === 0` hid the caveat in mixed scenes).
    return { samples, residentOnly: streamingPoints > 0, corridorWidth, groundPercentile };
  }

  function* sectionChunks(
    req: ProfileSectionRequest,
  ): Generator<number, ProfileSectionResult | null, void> {
    const token = generation.next();
    const frame = buildProfileFrame(req.a, req.b, deps.worldUp());
    const band = resolveCorridorHalfWidth(
      frame.horizontalLength,
      req.corridorWidth,
      AUTO_CORRIDOR_FRACTION,
    );
    const { statics, residents } = walkScene(deps);
    const sources: ProfileSectionSourceView[] = [];
    const refs: ProfileSectionSourceRef[] = [];
    for (const { layer, pos } of statics) {
      const slot = sources.length;
      sources.push(viewOf(slot, pos, layer.channels, layer.bounds, layer.placement));
      refs.push({ slot, kind: 'static', id: layer.id, pointCount: pos.length / 3 });
    }
    for (const { node, pos } of residents) {
      const slot = sources.length;
      // A resident node carries no placement: it is local to the streaming
      // render origin, and the terms it was admitted on are what say that
      // origin is the project's.
      sources.push(viewOf(slot, pos, node.channels, null, null));
      refs.push({ slot, kind: 'resident', id: node.key, pointCount: pos.length / 3 });
    }
    const extraction = extractProfileSectionChunks({
      frame,
      band,
      sources,
      chunkSize: req.chunkSize,
      signal: req.signal,
    });
    let step = extraction.next();
    while (!step.done) {
      yield step.value;
      step = extraction.next();
    }
    // Checked after the walk, never before it: the point of the token is that
    // a request made WHILE this one ran wins, and only the end of the scan
    // can know whether that happened.
    if (!generation.accepts(token)) return null;
    const scope = resolveSectionScope({
      staticSourceCount: statics.length,
      streamingSourceCount: residents.length,
    });
    const coverage = deps.streamingCoverage();
    const complete = coverage === null ? null : streamingIsComplete(coverage);
    return {
      points: step.value.points,
      frame,
      band,
      scope,
      scopeLabel: describeSectionScope(scope, complete),
      streamingComplete: complete,
      sources: refs,
      generation: token,
      aborted: step.value.aborted,
      skippedSlots: step.value.skippedSlots,
      examined: step.value.examined,
    };
  }

  return {
    sampleSeries,
    sectionChunks,
    section(req) {
      const it = sectionChunks(req);
      let step = it.next();
      while (!step.done) step = it.next();
      return step.value;
    },
    abandon() {
      generation.abandon();
    },
  };
}
