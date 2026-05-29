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

import type * as THREE from 'three/webgpu';
import type { Viewer, PointMeshHandle } from '../Viewer';
import type { StreamingSource } from './StreamingSource';
import type { StreamingNode } from './StreamingNode';
import type { DecodedChunk } from '../../io/copc/copcChunkDecode';
import type { ColorMode } from '../colorModes';
import { streamingNodeColors, intensityRangeOf } from './streamingColors';
import type { StreamingColorRanges } from './streamingColors';

/**
 * Node fade tunables. A freshly resident node starts at
 * `FADE_START_OPACITY` and lerps to 1.0 over `FADE_MS`, then drops the
 * transparency flag so EDL and the post-pipeline never see a `transparent:
 * true` material once the node has settled. Disabled on mobile and on the
 * low-tier device profile — see `attachStreamingCloud`.
 *
 * FADE_MS bumped 180 → 220 ms (the middle of the
 * 150-250 ms range that reads as "premium" without dragging on long
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
  const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
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
  const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
  const eased = t * t * t;  // ease-in cubic
  return 1 - eased;
}

/** A Three.js material with the alpha-related fields we need to drive. */
type FadeableMaterial = THREE.Material & {
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
};

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
  private _intensitySeeded = false;
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
    // Seed the global intensity range from the first (coarsest) node decoded.
    if (!this._intensitySeeded && decoded.pointCount > 0) {
      const range = intensityRangeOf(decoded);
      this._ranges = {
        ...this._ranges,
        minIntensity: range.min,
        maxIntensity: range.max,
      };
      this._intensitySeeded = true;
      if (this._mode === 'intensity') this._recolorAll();
    }
    const colors = streamingNodeColors(this._mode, decoded, this._ranges);
    const handle: PointMeshHandle = this._viewer.buildPointMesh(decoded.positions, colors);
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

  /** Resident node position arrays — for streaming point picking. */
  positionArrays(): Float32Array[] {
    const out: Float32Array[] = [];
    for (const entry of this._meshes.values()) out.push(entry.decoded.positions);
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
      const colors = streamingNodeColors(this._mode, entry.decoded, this._ranges);
      const array = entry.colorAttr.array as Float32Array;
      for (let i = 0; i < colors.length; i++) array[i] = colors[i] / 255;
      entry.colorAttr.needsUpdate = true;
    }
  }
}

/** A monotonic millisecond clock — `performance.now()` when available. */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
