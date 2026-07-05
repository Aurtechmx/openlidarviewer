/**
 * StreamingRenderer.ts
 *
 * Manages the GPU meshes of resident COPC streaming nodes. Each resident node
 * is one instanced-quad mesh built by the Viewer's shared `buildPointMesh` —
 * the very same primitive a static cloud uses — so Eye Dome Lighting, point
 * sizing, and the WebGPU / WebGL2 backends all apply to streaming nodes for
 * free.
 *
 * It holds each node's decoded chunk so a colour-mode switch can recolour every
 * resident node without re-streaming. Colours use cloud-global ranges, seeded
 * from the coarse root node, so adjacent nodes never band.
 *
 * Three.js types are imported type-only — the actual meshes are built and
 * disposed by the Viewer; this module only orchestrates.
 */

import { clamp01 } from '../../numeric';
import type * as THREE from 'three/webgpu';
import type { Viewer, PointMeshHandle } from '../Viewer';
import type { StreamingSource } from './StreamingSource';
import type { StreamingNode } from './StreamingNode';
import type { DecodedChunk } from '../../io/copc/copcChunkDecode';
import type { ColorMode } from '../colorModes';
import { streamingNodeColors, intensityRangeOf } from './streamingColors';
// Shared sRGB → linear seam (a leaf module — no Viewer cycle). The recolour
// path must apply the same EOTF the initial `buildPointMesh` upload does.
import { writeFloatColorsInto } from '../colorEncode';
import { computeElevationRange } from '../elevationRange';
import type { StreamingColorRanges } from './streamingColors';
import type { RgbAppearance } from '../rgbAppearance';

/**
 * Node fade tunables. A freshly resident node starts at
 * `FADE_START_OPACITY` and lerps to 1.0 over `FADE_MS`, then drops the
 * transparency flag so EDL and the post-pipeline never see a `transparent:
 * true` material once the node has settled. Disabled on mobile and on the
 * low-tier device profile — see `attachStreamingCloud`.
 *
 * FADE_MS bumped 180 → 220 ms (the middle of the
 * 150-250 ms range that reads as smooth without dragging on long
 * enough to feel sluggish), and the eviction path now triggers a
 * symmetric fade-OUT instead of a hard remove. The result is a true
 * cross-fade between a parent node fading out and its higher-resolution
 * children fading in — no more "LOD pop" during refinement.
 */
export const FADE_MS = 220;
export const FADE_START_OPACITY = 0.5;

/**
 * The pure fade-in math, factored out so it is unit-tested in Node. Maps an
 * `elapsedMs / durationMs` ratio onto an `[startOpacity, 1]` interval with
 * ease-out cubic so the fade lands softly.
 */
export function fadeOpacity(
  elapsedMs: number,
  durationMs: number,
  startOpacity: number,
): number {
  if (durationMs <= 0) return 1;
  const t = clamp01(elapsedMs / durationMs);
  const eased = 1 - Math.pow(1 - t, 3);
  return startOpacity + (1 - startOpacity) * eased;
}

/**
 * Fade-OUT counterpart — maps elapsed/duration onto `[1, 0]` with ease-in
 * cubic so the node lingers at near-full opacity then accelerates into
 * disappearance. The parent stays visible long enough that the user's
 * eye is on the child's fade-in by the time the parent drops below 0.4
 * opacity, completing the cross-fade illusion.
 */
export function fadeOutOpacity(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  const t = clamp01(elapsedMs / durationMs);
  const eased = t * t * t;  // ease-in cubic
  return 1 - eased;
}

/** A Three.js material with the alpha-related fields we need to drive. */
type FadeableMaterial = THREE.Material & {
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
};

/**
 * Should this decoded node (re)seed the cloud-global colour ranges? Only a
 * non-empty node strictly shallower than the last seed qualifies, so the ramp
 * converges to the depth-0 root's whole-cloud percentile band instead of
 * locking onto whichever node won the concurrent decode race. Pure so the
 * race-correctness can be unit-tested without a GPU/Viewer (the stateful
 * bookkeeping lives in StreamingRenderer, mirroring edlMotionGate).
 */
export function shouldReseedColorRange(
  currentSeedDepth: number,
  nodeDepth: number,
  pointCount: number,
): boolean {
  return pointCount > 0 && nodeDepth < currentSeedDepth;
}

/** One resident node's GPU mesh plus the decoded chunk kept for recolouring. */
interface NodeMesh {
  mesh: THREE.Mesh;
  colorAttr: THREE.InstancedBufferAttribute;
  decoded: DecodedChunk;
}

/** Construction options for {@link StreamingRenderer}. */
export interface StreamingRendererOptions {
  /**
   * Enable the cheap node fade-in on `onNodeReady`. Off on mobile
   * and the low-tier device profile; otherwise on by default. The animation
   * never affects EDL or the post-pipeline: `transparent: true` is set only
   * during the fade, with `depthWrite: true` explicitly preserved, and the
   * material is restored to fully opaque the moment the fade completes.
   */
  fadeIn?: boolean;
}

/** Manages the per-node meshes of a streaming COPC cloud. */
export class StreamingRenderer {
  private readonly _viewer: Viewer;
  private readonly _meshes = new Map<string, NodeMesh>();
  private _mode: ColorMode;
  private _ranges: StreamingColorRanges;
  /**
   * Depth of the coarsest node that has seeded the intensity + elevation colour
   * ranges so far (Infinity = not yet seeded). Concurrent decode means the first
   * node to *arrive* may be a deep node covering a small spatial extent, whose
   * 2nd/98th-percentile band is a poor estimate of the whole cloud — seeding
   * from it tints the entire stream off a sliver. So we (re)seed only from a
   * node strictly shallower than the last seed, converging to the depth-0 root
   * (which spans the full extent); once the root seeds, the ramp is final.
   *
   * Before any seed the ranges use the COPC bounding-box min/max, which tall
   * outliers (a tree, a flag-mast, a power line) would otherwise compress into
   * a single colour stop — the percentile reseed is what fixes that.
   */
  private _rangeSeedDepth = Number.POSITIVE_INFINITY;
  /**
   * Active RGB appearance bundle. Pushed in by the Viewer whenever the
   * user picks an RGB preset or moves the white-balance sliders; every
   * subsequent node decode + recolour applies it. `undefined` = identity
   * (no appearance change), so freshly attached streaming clouds render
   * the source colours unmodified until the user picks a preset.
   */
  private _rgbAppearance: RgbAppearance | undefined;
  private readonly _fadeIn: boolean;
  /** Active fade animations keyed by mesh; the value is its start wall time. */
  /**
   * Active fades. Direction `'in'` is a newly-resident node ramping from
   * `FADE_START_OPACITY` to 1.0; `'out'` is an evicted node ramping from
   * 1.0 to 0.0 before final removal. The `nodeId` is only set for fade-out
   * entries — when their fade completes, the mesh is actually removed from
   * the scene and the resident map is updated.
   */
  private readonly _fades = new Map<
    THREE.Mesh,
    {
      start: number;
      mat: FadeableMaterial;
      direction: 'in' | 'out';
      nodeId?: string;
    }
  >();
  /** Pending requestAnimationFrame handle for the next fade tick, if any. */
  private _fadeRafHandle: number | null = null;

  constructor(
    viewer: Viewer,
    cloud: StreamingSource,
    mode: ColorMode,
    options: StreamingRendererOptions = {},
  ) {
    this._viewer = viewer;
    this._mode = mode;
    this._fadeIn = options.fadeIn ?? false;
    // Elevation range from the COPC cube; intensity range is seeded once the
    // coarse root node arrives.
    const local = cloud.localBounds();
    this._ranges = {
      minZ: local[2],
      maxZ: local[5],
      minIntensity: 0,
      maxIntensity: 1,
    };
  }

  /** The active colour mode. */
  get colorMode(): ColorMode {
    return this._mode;
  }

  /** Count of resident node meshes currently in the scene. */
  get residentMeshCount(): number {
    return this._meshes.size;
  }

  /** A decoded node is ready — build its mesh and add it to the scene. */
  onNodeReady(node: StreamingNode, decoded: DecodedChunk): void {
    if (this._meshes.has(node.record.id)) return; // already resident
    // Seed the global intensity + elevation ranges from the COARSEST node seen
    // so far — see _rangeSeedDepth. Re-seeding from a strictly shallower node
    // converges the ramp to the depth-0 root's whole-cloud percentile band
    // instead of locking onto whichever node won the decode race.
    const seedDepth = node.record.key.depth;
    if (shouldReseedColorRange(this._rangeSeedDepth, seedDepth, decoded.pointCount)) {
      const intensity = intensityRangeOf(decoded);
      const elevation = computeElevationRange({
        positions: decoded.positions,
        pointCount: decoded.pointCount,
      });
      this._ranges = {
        ...this._ranges,
        minIntensity: intensity.min,
        maxIntensity: intensity.max,
        minZ: elevation.minZ,
        maxZ: elevation.maxZ,
      };
      this._rangeSeedDepth = seedDepth;
      if (this._mode === 'intensity' || this._mode === 'elevation') this._recolorAll();
    }
    const colors = streamingNodeColors(this._mode, decoded, this._ranges, this._rgbAppearance);
    // Pass the node's decoded per-point classification so the shared class
    // mask applies to streaming nodes too. A DecodedChunk always carries a
    // `classification` array (zero-filled when the source lacked the field),
    // so streaming meshes always get an `aClass` attribute.
    //
    // `buildPointMesh` wires every material's size graph to the Viewer's ONE
    // shared `_classMaskUniform` node (not a per-node copy), so a node decoded
    // AFTER a class toggle reads the current mask the moment it is built — no
    // re-application call is needed for late-arriving nodes.
    const handle: PointMeshHandle = this._viewer.buildPointMesh(
      decoded.positions,
      colors,
      decoded.classification,
      decoded.intensity,
    );
    this._viewer.addStreamingMesh(handle.mesh, decoded, node.record.key.depth);
    this._meshes.set(node.record.id, {
      mesh: handle.mesh,
      colorAttr: handle.colorAttr,
      decoded,
    });
    // Fade-in animation. The mesh is added at opacity 1.0 first
    // so a synchronous skip-fade environment (no rAF) still renders fully.
    if (this._fadeIn) this._startFade(handle.mesh);
  }

  /**
   * A node was evicted — start its fade-out. The mesh stays in the scene
   * until the fade completes, at which point `_stepFades` actually
   * removes it. This produces the cross-fade with whatever child node
   * is being faded IN at the same time — no LOD pop.
   *
   * If fade-in is disabled (mobile / low-tier), we still skip the
   * fade-out and remove immediately — matching the existing perf-budget
   * contract for those tiers.
   */
  onNodeEvicted(node: StreamingNode): void {
    const entry = this._meshes.get(node.record.id);
    if (!entry) return;
    if (!this._fadeIn) {
      this._fades.delete(entry.mesh);
      this._viewer.removeStreamingMesh(entry.mesh);
      this._meshes.delete(node.record.id);
      return;
    }
    // Cancel any in-flight fade-IN — we override with the fade-OUT.
    this._fades.delete(entry.mesh);
    this._startFadeOut(entry.mesh, node.record.id);
  }

  /** Switch the colour mode — recolours every resident node in place. */
  setColorMode(mode: ColorMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    this._recolorAll();
  }

  /**
   * Push a new RGB appearance bundle. Every resident node is recoloured
   * synchronously; subsequent node decodes apply the same bundle on
   * arrival. Pass `undefined` to clear (identity appearance).
   *
   * Cheap when the cloud isn't in RGB mode — `_recolorAll` re-runs but
   * `streamingNodeColors` ignores the appearance for non-RGB modes.
   */
  setRgbAppearance(appearance: RgbAppearance | undefined): void {
    this._rgbAppearance = appearance;
    if (this._mode === 'rgb') this._recolorAll();
  }

  /** Resident node position arrays — for streaming point picking. */
  positionArrays(): Float32Array[] {
    const out: Float32Array[] = [];
    for (const entry of this._meshes.values()) out.push(entry.decoded.positions);
    return out;
  }

  /**
   * The decoded chunk of every resident node — for a resident-snapshot export.
   * Each chunk carries the full attribute set (positions, intensity, class,
   * returns, GPS time, optional RGB) kept CPU-side for recolouring, so the
   * snapshot needs no GPU readback or re-decode. Positions are in local
   * (render-origin-shifted) space, matching the picking arrays above.
   */
  residentChunks(): DecodedChunk[] {
    const out: DecodedChunk[] = [];
    for (const entry of this._meshes.values()) out.push(entry.decoded);
    return out;
  }

  /**
   * Every resident node tagged with its id and whether it is fading out — the
   * input the export frontier (Gate 5) needs to drop overlapping LOD samples of
   * the same region during a cross-fade. Fade-out state is read from the fade
   * table (`direction: 'out'`), which carries the node id.
   */
  residentFrontierEntries(): { id: string; fadingOut: boolean; decoded: DecodedChunk }[] {
    const fadingOut = new Set<string>();
    for (const state of this._fades.values()) {
      if (state.direction === 'out' && state.nodeId) fadingOut.add(state.nodeId);
    }
    const out: { id: string; fadingOut: boolean; decoded: DecodedChunk }[] = [];
    for (const [id, entry] of this._meshes) {
      out.push({ id, fadingOut: fadingOut.has(id), decoded: entry.decoded });
    }
    return out;
  }

  /** Remove and dispose every resident mesh. */
  dispose(): void {
    // Cancel any pending fade tick before disposing meshes so the rAF
    // callback can't see freed materials.
    if (this._fadeRafHandle !== null) {
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(this._fadeRafHandle);
      } else {
        clearTimeout(this._fadeRafHandle);
      }
      this._fadeRafHandle = null;
    }
    this._fades.clear();
    for (const entry of this._meshes.values()) {
      this._viewer.removeStreamingMesh(entry.mesh);
    }
    this._meshes.clear();
  }

  /**
   * Begin a fade-in for a newly-resident mesh. Sets `transparent: true` with
   * `depthWrite: true` to keep EDL valid through the animation, then schedules
   * the next tick.
   */
  private _startFade(mesh: THREE.Mesh): void {
    const mat = mesh.material as FadeableMaterial;
    mat.opacity = FADE_START_OPACITY;
    mat.transparent = true;
    mat.depthWrite = true; // keep EDL valid — transparent defaults to no depth write
    this._fades.set(mesh, { start: nowMs(), mat, direction: 'in' });
    this._scheduleFadeTick();
  }

  /**
   * Begin a fade-OUT for an evicted node — the inverse of `_startFade`.
   * The mesh stays in the scene (still rendered) until the fade
   * completes, at which point `_stepFades` actually disposes it.
   */
  private _startFadeOut(mesh: THREE.Mesh, nodeId: string): void {
    const mat = mesh.material as FadeableMaterial;
    mat.opacity = 1;
    mat.transparent = true;
    mat.depthWrite = true;
    this._fades.set(mesh, { start: nowMs(), mat, direction: 'out', nodeId });
    this._scheduleFadeTick();
  }

  /** Coalesce all active fades into a single rAF (or setTimeout fallback). */
  private _scheduleFadeTick(): void {
    if (this._fadeRafHandle !== null) return;
    const onTick = (): void => {
      this._fadeRafHandle = null;
      this._stepFades(nowMs());
      if (this._fades.size > 0) this._scheduleFadeTick();
    };
    if (typeof requestAnimationFrame !== 'undefined') {
      this._fadeRafHandle = requestAnimationFrame(onTick);
    } else {
      this._fadeRafHandle = setTimeout(onTick, 16) as unknown as number;
    }
  }

  /** Advance every active fade to wall time `now` and finalise completed ones. */
  private _stepFades(now: number): void {
    for (const [mesh, state] of this._fades) {
      const elapsed = now - state.start;
      if (state.direction === 'in') {
        state.mat.opacity = fadeOpacity(elapsed, FADE_MS, FADE_START_OPACITY);
        if (elapsed >= FADE_MS) {
          state.mat.opacity = 1;
          state.mat.transparent = false;
          this._fades.delete(mesh);
        }
      } else {
        // direction === 'out' — the node was evicted; ramp opacity 1 → 0,
        // then actually remove the mesh from the scene + resident map.
        state.mat.opacity = fadeOutOpacity(elapsed, FADE_MS);
        if (elapsed >= FADE_MS) {
          this._fades.delete(mesh);
          this._viewer.removeStreamingMesh(mesh);
          if (state.nodeId) this._meshes.delete(state.nodeId);
        }
      }
    }
  }

  /** Recolour every resident node for the current mode and ranges. */
  private _recolorAll(): void {
    for (const entry of this._meshes.values()) {
      const colors = streamingNodeColors(this._mode, entry.decoded, this._ranges, this._rgbAppearance);
      const array = entry.colorAttr.array as Float32Array;
      // sRGB → linear via the shared EOTF seam — a bare `/255` here left the
      // recoloured nodes sRGB-encoded in a linear attribute, so switching
      // colour mode visibly paled streaming nodes vs their initial upload.
      writeFloatColorsInto(array, colors);
      entry.colorAttr.needsUpdate = true;
    }
  }
}

/** A monotonic millisecond clock — `performance.now()` when available. */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
