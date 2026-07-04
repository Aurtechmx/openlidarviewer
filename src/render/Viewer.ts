/**
 * Viewer.ts
 *
 * Wraps three.js WebGPURenderer (auto-falls-back to WebGL 2) and exposes a
 * minimal, typed API for loading/managing point-cloud layers, switching colour
 * modes, and camera navigation.
 *
 * ## Why points are drawn as instanced quads
 *
 * A `THREE.Points` object is rendered with the GPU's native point primitive.
 * On the WebGPU backend that primitive is **locked to one pixel** — three.js
 * cannot enlarge it (see `PointsNodeMaterial`'s own documentation). A scan
 * therefore renders as invisible one-pixel dust on WebGPU while looking fine
 * on WebGL 2.
 *
 * To render identically on both backends every point is instead drawn as a
 * camera-facing quad: one shared unit quad, instanced once per point, with the
 * per-point centre and colour supplied as instanced attributes. `three/tsl`'s
 * `PointsNodeMaterial` expands those quads to a real, controllable pixel size
 * on WebGPU *and* WebGL 2 — the same node graph compiles to both.
 *
 * ## Navigation
 *
 * Camera control is delegated to `NavController` (orbit / walk / fly). The
 * Viewer owns the render loop, the cloud geometry, framing, and double-click
 * point picking; the controller owns input and camera motion.
 *
 * Import note: this file imports from 'three/webgpu' (browser globals required)
 * and must NOT be imported in Node / Vitest tests.
 */

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  instancedBufferAttribute,
  pass,
  Fn,
  vec2,
  vec4,
  float,
  int,
  uniform,
  uniformArray,
  attribute,
  materialPointSize,
  screenUV,
  screenSize,
  log2,
  exp,
  exp2,
  max,
  min,
  mix,
  length,
  smoothstep,
  step,
  positionView,
  positionGeometry,
  perspectiveDepthToViewZ,
} from 'three/tsl';

import type { PointCloud } from '../model/PointCloud';
import type { ClassVisibility } from './class/classVisibility';
import { classVisibleAt } from './class/classMaskUniform';
import { elevationFilterUniform, type UpAxis } from './elevationFilterUniform';
import { intensityFilterUniform } from './intensityFilterUniform';
import { isZUpFormat, verticalAxisHintForSources } from '../io/sniffFormat';
import type { SourceFormat } from '../io/sniffFormat';
import { colorForMode, defaultMode } from './colorModes';
import type { ColorMode, CoverageColorGrid } from './colorModes';
import { type ClipBox, clipKeepsPoint, countKept } from './clip/clipBox';
import { edlDefaultEnabled, EDL_DEFAULTS, EDL_DEPTH_BIAS } from './edl';
import { cameraIsMoving, edlActiveThisFrame } from './edlMotionGate';
import { angularVelocity } from './angularVelocity';
import {
  targetPixelRatio,
  quantizeDpr,
  shouldApplyDpr,
  DPR_MOTION_FLOOR,
  DPR_FULL_REDUCTION_ANGULAR,
} from './adaptiveDpr';
import {
  nextRefinementPhase,
  phaseDprScale,
  type RefinementPhase,
} from './refinementPhase';
import { readDevFlags } from '../perf/devFlags';
import { POINT_STYLE_DEFAULTS } from './pointStyle';
import type { PointSizeMode } from './pointStyle';
import {
  splatRadiusMultiplier,
  splatForcesAlphaToCoverage,
  GAUSSIAN_SPLAT_SHARPNESS,
} from './splatShader';
import type { SplatMode } from './splatShader';
import {
  filterSelectionToVisible,
  selectByLasso,
  volumeFromLassoWithFootprint,
} from './measure/lassoVolume';
import { stockpileToastSuffix } from './measure/stockpilePresenter';
import {
  cameraPresetPose,
  standardViewPose,
  fitBoxDistance,
  type CameraPresetName,
  type StandardView,
} from './camera/cameraPresets';
export type { CameraPresetName } from './camera/cameraPresets';
export type { StandardView } from './camera/cameraPresets';
import { compassHeadingDeg } from './viewCubeMath';
import type { VolumeResult } from './measure/volume';
import {
  decideVolumeBudget,
  type VolumeBudgetDecision,
} from './measure/volumeBudget';

/** Return shape from {@link Viewer.computeLassoVolume}. */
export interface LassoVolumeReturn {
  /** Cut / fill / footprint computed against the selected 3D points. */
  readonly result: VolumeResult;
  /**
   * The stockpile band suffix for the toast: ` · Stockpile: V ± σ (±%) ·
   * confidence`, re-graded over the same selected sample with a "lowest
   * ground" base plane and converted to metres via the `lin` factor passed to
   * {@link Viewer.computeLassoVolume}. Empty when there's nothing trustworthy
   * to claim (too few points / degenerate footprint).
   */
  readonly stockpileSuffix: string;
  /** Number of cloud points that fell inside the lasso. */
  readonly selectedCount: number;
  /** The lasso path the user drew (echoed back for the report card). */
  readonly lasso: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  /**
   * Per-static-cloud selected indices, suitable for passing into
   * {@link Viewer.setSelectionHighlight}. Streaming clouds are not
   * highlight-addressable per index — their meshes get their own
   * follow-up surface in a later cut.
   */
  readonly selectionByCloudId: ReadonlyMap<string, ReadonlyArray<number>>;
  /**
   * Adaptive-degradation verdict for this workload. `downsample: false`
   * means the walk was exhaustive; `true` means every `stride`-th
   * point was tested so the inspector can surface a "sampled" caveat.
   */
  readonly budget: VolumeBudgetDecision;
  /**
   * 3D convex-hull footprint polygon, vertices lifted to the
   * reference plane. Used by the "Save to session" path to persist
   * the lasso volume as a regular Volume measurement. Empty when the
   * selection collapsed to a degenerate hull.
   */
  readonly polygon3D: ReadonlyArray<[number, number, number]>;
  /** Reference Z used by the cut/fill integration. */
  readonly referenceZ: number;
}
import { NavController } from './NavController';
import type { NavMode, CameraPose } from './NavController';
import { computeScaleBar, pixelsPerMetreAt } from './scaleBar';
// Pure top-down framing math for the georeferenced Studio export (C4). A
// dependency-free leaf, so this static import does NOT merge the lazy
// pngWorldFile/Studio chunks into the shell bundle.
import { frameTopDownOrtho } from './export/orthoFraming';
import { MeasureController } from './measure/MeasureController';
import {
  sampleProfile,
  autoCorridorWidth,
  DEFAULT_GROUND_PERCENTILE,
  DEFAULT_PROFILE_SAMPLE_COUNT,
} from './measure/profileSampler';
import { volumeCutFill } from './measure/volume';
import {
  applyClassSwap,
  applyPolygonReclassify,
  applyIndexReclassify,
  type ClassEditResult,
} from './measure/classificationEditor';
import { ClassEditHistory, recordEdit } from './measure/classEditHistory';
import { ClassificationEpochs } from './measure/classificationEpoch';
import {
  getPreset,
  type PresetId,
  type SkyPreset,
} from './inspectionPresets';
import { getSkyDefinition } from './skyPresets';
import type { SkyPreset as SkyPresetId } from './inspectionPresets';
import {
  applyRgbAppearance,
  IDENTITY_RGB_APPEARANCE,
  getRgbAppearancePreset,
  type RgbAppearance,
  type RgbAppearancePresetId,
} from './rgbAppearance';
import { getEdlPreset, type EdlPresetId } from './edlPresets';
import type { ProfileChartSample, Vec3, VolumeRecord } from './measure/types';
import {
  decompose2Pointer,
  isZero as gestureIsZero,
  type Pointer as TouchPointer,
} from './touchGesture';
import { InspectTool } from './InspectTool';
import { AnnotationController } from './annotate/AnnotationController';
import type { SavedCameraState } from './annotate/types';
import { loadSvgImage } from './snapshotSvg';
import { LiveProbe } from './LiveProbe';
import { downsampleToBudget } from '../process/voxelDownsample';
import { makePointInfo } from './pointInfo';
import type { PointInfo } from './pointInfo';
import { speedForSize, nearestPointAlongRay } from './navMath';
import {
  aabbCenter,
  clampTargetToExpandedAabb,
  lerpTowardCenter,
  distance as vecDistance,
} from './orbitCenter';
import type { Aabb as OrbitAabb, Vec3Tuple } from './orbitCenter';
import {
  DAMPING_FACTOR,
  DAMPING_FACTOR_TOUCH,
  ROTATE_SPEED,
  ROTATE_SPEED_TOUCH,
  SETTLE_MS,
  SOFT_CLAMP_LERP_PER_FRAME,
  STREAMING_LERP_PER_FRAME,
  EXPAND_FRACTION,
  isWithinSettleWindow,
} from './orbitFeel';
import { selectStreamingPick } from './streaming/streamingPickSelection';
// The shared sRGB → linear seam — every Float32 colour-attribute write goes
// through this so recolour paths match the initial `toFloatColors` upload.
import { writeFloatColorsInto } from './colorEncode';
// The streaming render engine is type-only here and dynamically imported in
// `attachStreamingCloud`, so `src/render/streaming/*` (scheduler, renderer,
// octree, cache) stays out of the initial bundle and loads only when a COPC
// scan is opened. `streamingBudget` is a tiny leaf kept static for the
// synchronous `setStreamingQuality` path.
import type { StreamingScheduler } from './streaming/StreamingScheduler';
import type { StreamingRenderer } from './streaming/StreamingRenderer';
import { buildResidentSnapshot } from './streaming/residentSnapshot';
import type { StreamingSource } from './streaming/StreamingSource';
import { streamingBudgets, estimateGpuBytes } from './streaming/streamingBudget';
import type { StreamingQuality } from './streaming/streamingBudget';
import type { StreamingBenchmark } from './streaming/streamingBenchmark';
// The streaming-engine `import()` split points live in `lazyChunks.ts` — a
// module excluded from the live-build source-transform so Vite can still emit the
// chunks (see lazyChunks.ts).
import {
  loadStreamingRenderer,
  loadStreamingScheduler,
  loadExportStudio,
} from '../lazyChunks';
import type { ChunkDecoder, DecodedChunk } from '../io/copc/copcChunkDecode';
import type {
  ExportMode,
  ExportOptions,
  ExportResult,
  ExportSceneAdapter,
} from '../export/types';

// ─────────────────────────────────────────────────────────────────────────────
// Internal data per loaded cloud
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Six three.js clipping planes for a clip box, in render-local/world space.
 * keep-inside → inward-facing planes (a fragment survives only inside ALL of
 * them, the default intersection). keep-outside → the same planes negated, used
 * with `clipIntersection = true` so a fragment survives if it's outside ANY
 * face (i.e. outside the box). A three.js plane clips where n·p + c < 0.
 */
function clipBoxPlanes(clip: ClipBox): THREE.Plane[] {
  const { min, max } = clip.box;
  const planes = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -min[0]), // keep x ≥ min.x
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), max[0]), // keep x ≤ max.x
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -min[1]),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), max[1]),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -min[2]),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), max[2]),
  ];
  if (clip.mode === 'keep-outside') for (const p of planes) p.negate();
  return planes;
}

interface CloudEntry {
  cloud: PointCloud;
  /** The instanced-quad mesh that draws this cloud. */
  mesh: THREE.Mesh;
  /** The cloud's point material (one per cloud so colours are independent). */
  material: THREE.PointsNodeMaterial;
  /** Per-point colour, as an instanced attribute, so colour modes can swap it. */
  colorAttr: THREE.InstancedBufferAttribute;
  /** Current colour mode applied to the colour attribute. */
  mode: ColorMode;
  /**
   * Locked layers are excluded from picking / measuring / inspecting — the user
   * can keep a reference cloud on screen without it stealing picks from the one
   * they're working on. Visibility is independent (a locked layer stays drawn).
   */
  locked?: boolean;
  /**
   * Persistent sRGB scratch buffer reused across RGB-appearance recolors
   * (white-balance drag). Allocated lazily on first recolor and reused
   * thereafter; only reallocated if the cloud's colour length grows. Avoids
   * the multi-MB `new Float32Array` on every throttled drag step.
   */
  recolorScratch?: Float32Array;
}

/**
 * Per-streaming-mesh data the pick path needs — kept in lockstep with the
 * `_streamingMeshes` set so the picker can prove no entry references an
 * evicted mesh (see `_pickStreamingDetailed`).
 */
interface StreamingPickEntry {
  /** Decoded chunk (positions + per-point attributes) for this node. */
  decoded: DecodedChunk;
  /** Octree depth — feeds the "still refining" hint via `selectStreamingPick`. */
  depth: number;
}

/** UI-facing navigation events the app can subscribe to. */
export interface NavListeners {
  onModeChange?: (mode: NavMode) => void;
  onPointerLockChange?: (locked: boolean) => void;
  onToggleHelp?: () => void;
}

/** UI-facing measurement events the app can subscribe to. */
export interface MeasureListeners {
  onModeChange?: (active: boolean) => void;
}

/** UI-facing point-inspection events the app can subscribe to. */
export interface InspectListeners {
  onModeChange?: (active: boolean) => void;
}

/** UI-facing annotation events the app can subscribe to. */
export interface AnnotateListeners {
  onModeChange?: (active: boolean) => void;
}

/** UI-facing live-probe events the app can subscribe to. */
export interface ProbeListeners {
  onModeChange?: (active: boolean) => void;
}

/**
 * The picking tool that currently owns canvas clicks, if any. Only one is
 * ever active. `probe` is a passive hover-probe that keeps navigation live;
 * `slice` is reserved for a future section tool.
 */
export type ToolMode =
  | 'none'
  | 'measure'
  | 'inspect'
  | 'annotate'
  | 'probe'
  | 'slice'
  | 'lasso';

/**
 * Which overlay layers to burn into a {@link Viewer.snapshot}. With every
 * option off (the default) the snapshot is the bare rendered cloud, exactly as
 * before; enabling a layer composites that overlay's SVG on top.
 */
export interface SnapshotOptions {
  /** Include the annotation markers. */
  annotations?: boolean;
  /** Include the measurement geometry and value labels. */
  measurements?: boolean;
  /**
   * Visual Export Studio — bake the active Inspect tool state:
   * the selected-point marker (halo + dot) and a canvas-drawn point-info
   * card (X/Y/Z, intensity, classification, RGB, etc.). When false (the
   * default) the export is clean of inspector overlays even while the
   * inspect tool is active in the UI.
   */
  inspector?: boolean;
  /**
   * Visual Export Studio — bake the most recent LiveProbe readout
   * when probe mode is active. Uses the probe's last-known cursor position
   * so the bake survives the "cursor moves to click Export" gap that would
   * otherwise dismiss the live element before capture.
   */
  probe?: boolean;
  /**
   * v0.3.7 final-polish — supersample factor. 1 = native (default), 2 = 2×
   * supersampled, 4 = 4× supersampled. The snapshot renders the GL canvas
   * once at the requested resolution by upscaling the output canvas and
   * compositing through the 2-D pipeline. Output dimensions become
   * `canvas.width × factor` by `canvas.height × factor`.
   *
   * NOT a true MSAA — the GL framebuffer doesn't change. This is a
   * post-render upscale that lets overlay SVGs and scale bars composite
   * at higher resolution while the cloud itself reads at native quality.
   * Use 2× for a sharp print-ready PNG; 4× for a hero shot.
   */
  supersample?: 1 | 2 | 4;
  /**
   * v0.3.7 final-polish — composite a scale-bar overlay at the bottom-left
   * of the snapshot. The renderer feeds the bar a sane pixel-per-metre
   * derived from the current camera, the bar picks a 1-2-5 nice step,
   * and draws a contrasting bar + label.
   */
  scaleBar?: boolean;
}

/**
 * A lightweight rendering-performance sample, surfaced by {@link Viewer.frameStats}
 * for the `?debug=1` overlay. Reading it allocates only the returned object —
 * no per-frame cost — so the overlay can poll it on a throttled cadence.
 */
export interface FrameStats {
  /** Frames per second, derived from the rolling-average frame time. */
  fps: number;
  /** Rolling-average frame time, in milliseconds. */
  frameMs: number;
  /** GPU draw calls recorded for the last rendered frame. */
  drawCalls: number;
  /** Points uploaded to the GPU across the visible clouds. */
  displayedPoints: number;
  /** Points across every loaded cloud, visible or not. */
  totalPoints: number;
  /** Rough GPU memory held by the visible clouds' instance attributes, in bytes. */
  gpuBytesEstimate: number;
}

/** A built (but not yet mounted) instanced-quad point mesh and its handles. */
export interface PointMeshHandle {
  mesh: THREE.Mesh;
  material: THREE.PointsNodeMaterial;
  colorAttr: THREE.InstancedBufferAttribute;
  /**
   * The per-point ASPRS classification attribute (`aClass`), one value per
   * instance, or `null` when the source cloud carried no classification
   * channel. The class-visibility mask multiplies the resolved point size
   * by `mask[aClass]`, so a mesh without this attribute is never affected
   * by class filtering (it stays fully visible).
   */
  classAttr: THREE.InstancedBufferAttribute | null;
}

/**
 * The live streaming subsystem — present only while a COPC OR EPT cloud is
 * open. Widens the `cloud` type from `StreamingPointCloud`
 * to the format-agnostic `StreamingSource` interface (the same one the
 * scheduler/renderer already consume), so both COPC and EPT route through
 * the exact same session shape.
 */
interface StreamingSession {
  cloud: StreamingSource;
  scheduler: StreamingScheduler;
  renderer: StreamingRenderer;
  /**
   * The chunk decoder driving this session. Retained so the full-cloud grade
   * can re-decode a breadth-first octree sample through the
   * SAME decoder the scheduler uses, without standing up a second worker pool.
   */
  decoder: ChunkDecoder;
  /** The streaming benchmark, when one is collecting — null in normal sessions. */
  benchmark: StreamingBenchmark | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ASPRS class codes span a full byte (0-255) for LAS PDRF >= 6, so the GPU
 * mask uniform is a 256-entry array — one slot per legal class code. Matches
 * the width of `ClassVisibility` / `toMaskArray()`.
 */
const CLASS_COUNT = 256;

/** The four corners of the unit billboard quad shared by every point. */
const QUAD_CORNERS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
/** Two triangles covering the quad. */
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

/**
 * Device-pixel-ratio cap. High-density displays render at up to DPR² the pixel
 * area; capping at 2 bounds the cost — most visible once the EDL pass adds a
 * full-screen render target — with no perceptible loss of sharpness.
 */
/**
 * Cap the renderer's pixel ratio. A retina display reports DPR=2
 * and shades 4 sub-pixels per logical pixel. For a point-cloud
 * scene that's almost pure GPU waste — points are rasterised as
 * sprite quads, so the visible quality difference between 1.5x and
 * 2x is minimal but the fragment-shading cost grows quadratically
 * with the ratio (~44 % more work going 1.5 → 2.0). Capping to
 * 1.5 is what keeps M3-class laptops out of the thermal envelope
 * during long sessions; users on a low-DPR display still get their
 * native pixel ratio because `Math.min` keeps the floor.
 */
const MAX_PIXEL_RATIO = 1.5;

/**
 * Idle-render throttling. After any user input (pointer / key /
 * wheel) the renderer holds at the full requestAnimationFrame rate
 * for this window so the response feels native. Once the window
 * expires AND the scene is quiet (no tween, no streaming activity)
 * the loop drops to a heartbeat rate of one render per
 * `IDLE_HEARTBEAT_FRAMES` frames. This is the dominant fix for
 * "OpenLiDARViewer makes my laptop hot": a static point cloud was
 * previously being re-rasterised 60×/sec to produce the same image.
 *
 * The CPU paths (`_nav.update`, `_maintainOrbitCenter`,
 * `_updateAdaptiveEdl`, the streaming tick) keep running on every
 * loop iteration so OrbitControls damping integrates correctly and
 * the streaming scheduler keeps its cadence — only the actual
 * GPU `render()` call is gated.
 */
const RENDER_HOLDOVER_MS = 350;
/**
 * P6 proxy (until the P4 scheduler emits real coverage / spacing signals): ms
 * after the camera parks at which the center is treated as "refined", so the
 * refinement phase reaches `full-refine` and DPR steps up to full resolution.
 * Kept short so the view re-sharpens promptly after navigation stops.
 */
const PHASE_CENTER_PROXY_MS = 250;
const IDLE_HEARTBEAT_FRAMES = 6;

/** Default vertical field of view, in degrees — the camera's construction value. */
const DEFAULT_FOV = 60;
/**
 * Near-orthographic FOV. A very long "lens" — the camera pulls far back and
 * the frustum becomes almost parallel, so walls/floors read flat for accurate
 * measuring with no perspective skew. This keeps the existing perspective
 * camera (and the whole WebGPU render graph, culling, LOD and picking tools)
 * untouched, rather than swapping in a separate OrthographicCamera.
 */
const ORTHO_FOV = 2;

/**
 * Absolute GPU-upload point ceiling. The device-aware load budget already
 * sizes a cloud to the machine; this is the last-resort guard so that no path
 * — a future session restore, a streaming source — can ever upload a cloud
 * large enough to risk a GPU out-of-memory crash. It sits above every load
 * budget (incl. the desktop `high` budget of 6 M in deviceProfile.ts), so a
 * normally-loaded cloud is never touched — only a pathological bypass path is.
 */
const GPU_HARD_POINT_CEILING = 8_000_000;

/**
 * Frame-time history length for {@link Viewer.frameStats}. Sixty samples is
 * about one second at 60 fps — long enough to smooth jitter, short enough that
 * the reported rate still tracks a real change in load.
 */
const FRAME_SAMPLE_COUNT = 60;

/**
 * Rough GPU bytes held per displayed point: an instanced position (vec3 f32,
 * 12 B) and an instanced colour (vec3 f32, 12 B). Used only for the debug
 * overlay's memory estimate — an attribute-size figure, not a precise driver
 * allocation.
 */
const BYTES_PER_GPU_POINT = 24;

/**
 * Convert interleaved Uint8 [0-255] RGB to Float32 [0-1] for a GPU attribute.
 *
 * Performs sRGB → linear conversion in the process. Why: scanner RGB
 * is stored display-referred (sRGB-encoded) — that's what a camera
 * captures and a viewer expects to see. Our TSL pipeline plumbs the
 * attribute straight through `instancedBufferAttribute(colorAttr)` as
 * the colour node, which bypasses three.js's automatic sRGB → linear
 * conversion that `vertexColors: true` would normally apply. With
 * `outputColorSpace = SRGBColorSpace` the renderer then encodes
 * linear → sRGB at output. Passing already-sRGB values through the
 * linear path means three.js re-encodes a second time, which washes
 * out saturation and brightens midtones — exactly the "pale colours"
 * symptom v0.3.6 carried.
 *
 * Linearising the source here means the renderer receives true linear
 * light values, tone-maps (NoToneMapping = identity), then sRGB-encodes
 * once. Net round-trip: scanner sRGB in → display sRGB out, faithful.
 *
 * The piecewise sRGB EOTF (IEC 61966-2-1) is exact, not the 2.2-power
 * approximation — matches three.js's `Color.SRGBToLinear` and PNG
 * exports stay in lock-step with the on-screen image.
 */
/**
 * Build a strided copy of an interleaved xyz position buffer — keeps
 * every `stride`-th point. Used by `computeLassoVolume` when the
 * adaptive budget downsamples a heavy workload. O(n / stride) on the
 * source length; allocates one new Float32Array. The selection's
 * indices are remapped back to source space at the call site so the
 * highlight pipeline still points at real per-cloud points.
 */
function stridePositions(src: Float32Array, stride: number): Float32Array {
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

function toFloatColors(u8: Uint8Array): Float32Array {
  const f = new Float32Array(u8.length);
  // Delegates to the shared EOTF seam in `colorEncode.ts` so the in-place
  // recolour paths (colour-mode switch, coverage grid, percentile trim,
  // classification refresh, streaming recolour) apply byte-identical maths.
  writeFloatColorsInto(f, u8);
  return f;
}

/*
 * TSL (three.js Shading Language) is a dynamically-typed embedded DSL: its
 * node chains (`.mul`, `.negate`, `.sample`, `.addAssign`, …) are not tracked
 * by TypeScript, so the node values inside the builders below are typed
 * `TslNode` (an alias for `any`) by necessity. The shader maths is verified by
 * the pure unit tests in `edl.ts` and `pointStyle.ts` — which these builders
 * mirror exactly — and by the Playwright render tests.
 */
/** A TSL node value — see the note above on why this is `any`. */
type TslNode = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Build the Eye Dome Lighting output node for a scene pass.
 *
 * For each screen pixel it samples the pass colour, then compares the pixel's
 * eye-space depth against four neighbours on a ring of `radiusPx` pixels and
 * darkens the pixel in proportion to how far it recedes behind them. Works in
 * `log2(eye distance)` so the cue is scale-invariant. Mirrors `edlObscurance`
 * and `edlShade` in `edl.ts`, which are unit-tested.
 *
 * @param usesLogDepth - Whether the renderer owns a logarithmic depth buffer,
 * read back off the renderer instance at construction. Decides which depth
 * inversion the node graph is built with (the graph is compiled once, and the
 * renderer's depth mode is fixed at construction, so a build-time branch is
 * correct — no per-pixel uniform needed).
 */
function buildEdlOutputNode(
  scenePass: ReturnType<typeof pass>,
  strength: TslNode,
  near: TslNode,
  far: TslNode,
  radiusPx: number,
  usesLogDepth: boolean,
): TslNode {
  const colorNode: TslNode = scenePass.getTextureNode();
  const depthNode: TslNode = scenePass.getTextureNode('depth');

  // Positive eye-space distance at a screen UV, floored away from zero so the
  // following log2 is always finite.
  //
  // The inversion MUST match the encoding the renderer actually wrote:
  //
  //  • Logarithmic depth buffer (this app's default — see the renderer
  //    construction): three's node pipeline (`NodeMaterial.setupDepth` →
  //    `viewZToLogarithmicDepth`) replaces fragment depth with the Ulrich
  //    near-anchored log encoding
  //        raw = log2(eyeDist / near') / log2(far / near'),
  //        near' = max(near, 1e-6),
  //    so the eye distance is recovered with
  //        eyeDist = near' · 2^(raw · log2(far / near')).
  //    This mirrors `logDepthToEyeDistance` in `edl.ts` (unit-tested) exactly,
  //    including the 1e-6 near clamp. Both the WebGPU backend and the WebGL 2
  //    fallback compile this same node graph, so one inversion covers both.
  //    (Deliberately NOT the legacy WebGLRenderer chunk
  //    `log2(1 + w) / log2(1 + far)` — that convention never runs here.)
  //
  //  • Standard perspective depth otherwise: three's own
  //    `perspectiveDepthToViewZ` (which internally also handles a reversed
  //    depth buffer) recovers viewZ; negate for a positive distance.
  //
  // Using the wrong inversion is not subtle: treating a log-encoded sample as
  // perspective depth computes obscurance in the wrong space — EDL reads far
  // too weak up close and erratic at range — silently defeating the
  // unit-tested maths in `edl.ts`. That was the v0.4.x audit defect.
  const eyeDistAt = Fn(([sampleUv]: TslNode[]): TslNode => {
    const raw: TslNode = depthNode.sample(sampleUv).r;
    if (usesLogDepth) {
      const nearClamped: TslNode = max(near, float(1e-6));
      const eyeDist: TslNode = nearClamped.mul(
        exp2(raw.mul(log2(far.div(nearClamped)))),
      );
      return max(eyeDist, float(1e-4));
    }
    return max(perspectiveDepthToViewZ(raw, near, far).negate(), float(1e-4));
  });

  return Fn((): TslNode => {
    const texel: TslNode = vec2(radiusPx, radiusPx).div(screenSize);
    const logC: TslNode = log2(eyeDistAt(screenUV));
    // A neighbour contributes only when it is deeper by more than the bias —
    // gating depth-buffer noise so EDL does not shimmer as the camera moves.
    const bias: TslNode = float(EDL_DEPTH_BIAS);
    const sum: TslNode = float(0).toVar();
    sum.addAssign(max(float(0), logC.sub(log2(eyeDistAt(screenUV.add(vec2(texel.x, 0))))).sub(bias)));
    sum.addAssign(max(float(0), logC.sub(log2(eyeDistAt(screenUV.sub(vec2(texel.x, 0))))).sub(bias)));
    sum.addAssign(max(float(0), logC.sub(log2(eyeDistAt(screenUV.add(vec2(0, texel.y))))).sub(bias)));
    sum.addAssign(max(float(0), logC.sub(log2(eyeDistAt(screenUV.sub(vec2(0, texel.y))))).sub(bias)));
    const shade: TslNode = exp(sum.mul(strength).negate());
    return vec4(colorNode.rgb.mul(shade), colorNode.a);
  })();
}

/**
 * Build the adaptive point-size node: a point's pixel size is `base × ref /
 * eyeDistance`, clamped to `[minSizePx, base × maxSizeFactor]`. Mirrors
 * `adaptivePointSize` in `pointStyle.ts`. `positionView` is the point's
 * instance centre in view space, so `-z` is its eye-space distance.
 */
function buildAdaptiveSizeNode(base: TslNode, attnRef: TslNode): TslNode {
  const eyeDist: TslNode = max((positionView as TslNode).z.negate(), float(1e-4));
  const attenuated: TslNode = base.mul(attnRef).div(eyeDist);
  const maxSize: TslNode = base.mul(POINT_STYLE_DEFAULTS.maxSizeFactor);
  return attenuated.clamp(float(POINT_STYLE_DEFAULTS.minSizePx), maxSize);
}

/**
 * Build the circular point-mask opacity node: `positionGeometry.xy` is the
 * sprite-quad coordinate in [-0.5, 0.5]², so the point renders as a round dot
 * with a soft, antialiased rim instead of a hard square.
 *
 * v0.3.7 final-polish: widened the soft falloff from (0.42 → 0.50) to
 * (0.30 → 0.50). The wider gradient softens the rim noticeably without
 * touching the rest of the pipeline, and the matching `alphaTest`
 * lowered to 0.18 (was 0.5) keeps more of the soft pixels around the
 * disc. Net effect: cleaner rim, reduced sparkle on sparse regions, no
 * change to point centre brightness so a brown roof still reads brown
 * and a pixel-accurate measurement still hits the same point.
 *
 * The alpha is still gated against `alphaTest` so points stay correctly
 * depth-sorted — this is NOT full splatting, just a wider antialiased
 * rim on the existing sprite.
 */
function buildPointMaskNode(): TslNode {
  const r: TslNode = length((positionGeometry as TslNode).xy);
  return smoothstep(float(0.30), float(0.50), r).oneMinus();
}

/**
 * P13 — the GPU mirror of `gaussianSplatAlpha` (splatShader.ts). `positionGeometry.xy`
 * is the sprite-quad coordinate in [-0.5, 0.5]², so `r = length(xy)` runs 0 at the
 * centre to 0.5 at the sprite edge; normalise to `d ∈ [0, 1]` (d = min(2r, 1)) and
 * apply the SAME windowed Gaussian the unit test pins:
 *
 *   raw(d)   = exp(-k · d²)
 *   alpha(d) = (raw(d) − exp(-k)) / (1 − exp(-k))     ∈ [0, 1]
 *
 * Pinned to exactly 1 at the centre and 0 at the edge — no hard ring. `k` is the
 * shared `GAUSSIAN_SPLAT_SHARPNESS` constant so a screenshot and the unit test
 * agree at the same `d`.
 */
function buildGaussianAlphaNode(): TslNode {
  const r: TslNode = length((positionGeometry as TslNode).xy);
  const d: TslNode = min(r.mul(2), float(1));
  const k: TslNode = float(GAUSSIAN_SPLAT_SHARPNESS);
  const edge: TslNode = exp(k.negate()); // exp(-k), in (0, 1)
  const raw: TslNode = exp(k.negate().mul(d.mul(d))); // exp(-k · d²)
  return raw.sub(edge).div(float(1).sub(edge)).clamp(float(0), float(1));
}

/**
 * P13 — the point opacity node, switched between the existing antialiased rim
 * mask and the Gaussian kernel by a shared uniform (`gaussianFactor` = 0 for
 * Classic/Soft/Inspection, 1 for Gaussian). Both branches are cheap and evaluate
 * per-fragment; `mix` picks between them so switching modes needs no material
 * rebuild — just a uniform write.
 */
function buildPointOpacityNode(gaussianFactor: TslNode): TslNode {
  return mix(buildPointMaskNode(), buildGaussianAlphaNode(), gaussianFactor);
}

// ─────────────────────────────────────────────────────────────────────────────
// Viewer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Browser-only point-cloud viewer built on three.js WebGPURenderer.
 *
 * Lifecycle:
 * ```ts
 * const viewer = new Viewer(canvas);
 * await viewer.ready;          // wait for the GPU backend to initialise
 * const id = viewer.addCloud(cloud);
 * viewer.frameAll();
 * ```
 */
export class Viewer {
  // ── Public handle so callers can await GPU init before calling render() ──
  /** Resolves once the renderer backend has finished asynchronous init. */
  readonly ready: Promise<void>;

  // ── three.js objects ─────────────────────────────────────────────────────
  private readonly _renderer: THREE.WebGPURenderer;
  private readonly _scene: THREE.Scene;
  private readonly _camera: THREE.PerspectiveCamera;
  private readonly _controls: OrbitControls;
  private readonly _nav: NavController;
  // Three.js `Clock` was deprecated in r170 in favour of `Timer`, which has
  // an explicit `update()` step so multiple `getDelta()` reads within one
  // tick stay consistent. We use the same single-delta-per-frame pattern, so
  // the behaviour is unchanged — only the warning goes away.
  private readonly _timer = new THREE.Timer();
  private _rafId: number | null = null;

  // ── P5 adaptive DPR (program §P5) — drops backing-store resolution while the
  //    camera moves, driven by the P3 angular-velocity signal. Flag-gated. ──
  /** `?adaptiveDpr` dev flag (default on). Read once. */
  private readonly _adaptiveDpr: boolean = readDevFlags().adaptiveDpr;
  /** Reused quaternion buffers for the angular-velocity read — no per-frame alloc. */
  private readonly _curCamQuat: [number, number, number, number] = [0, 0, 0, 0];
  private readonly _prevCamQuat: [number, number, number, number] = [0, 0, 0, 0];
  private _hasPrevCamQuat = false;
  /** performance.now() of the last APPLIED DPR change — rate-limits reductions. */
  private _lastDprChangeMs = 0;
  /** `?refinementPhase` dev flag (default on) — drive DPR by discrete phases (P6). */
  private readonly _refinementPhasesEnabled: boolean = readDevFlags().refinementPhase;
  /** Current P6 refinement phase. */
  private _phase: RefinementPhase = 'moving';
  /** performance.now() when the camera last parked (0 while moving). */
  private _settledAtMs = 0;
  /**
   * Performance timestamp until which the renderer stays at full
   * rAF rate. Bumped on every user input via `_bumpRenderActivity`.
   * Past this point, the loop falls back to a heartbeat render.
   */
  private _renderActivityUntilMs: number = 0;
  /**
   * Counter for the idle-render heartbeat. Increments when the loop
   * skips a render; reaches `IDLE_HEARTBEAT_FRAMES` and forces a
   * render to keep the scene fresh (and to give streaming a chance
   * to commit any newly-resident nodes). Reset to 0 on every actual
   * render so the next heartbeat window starts clean.
   */
  private _idleRenderHeartbeat: number = IDLE_HEARTBEAT_FRAMES;

  // ── Frame timing (debug overlay) ─────────────────────────────────────────
  /** Rolling buffer of recent frame times, in ms — feeds {@link frameStats}. */
  private readonly _frameTimes = new Float64Array(FRAME_SAMPLE_COUNT);
  /** Next write index into the frame-time ring buffer. */
  private _frameWrite = 0;
  /** Number of valid samples in the ring buffer (≤ its length). */
  private _frameCount = 0;

  // ── Cloud registry ───────────────────────────────────────────────────────
  private readonly _clouds = new Map<string, CloudEntry>();
  /** The active clip box (GPU clipping planes + CPU kept-count), or null. */
  private _clip: ClipBox | null = null;
  private _nextId = 0;

  // ── Streaming COPC subsystem (set while a streaming cloud is open) ───────
  /** Streaming node meshes — tracked so material settings reach them too. */
  private readonly _streamingMeshes = new Set<THREE.Mesh>();
  /**
   * Per streaming mesh: its decoded chunk (for point picking) plus the
   * COPC octree depth of the node it came from (for the still-refining
   * "still refining" hint — comparing this depth against the deepest
   * resident depth tells the inspector whether finer detail is still
   * loading for the region under the picked point).
   */
  private readonly _streamingPickData = new Map<THREE.Mesh, StreamingPickEntry>();
  /** The scheduler/renderer/cloud, present only while a COPC is streaming. */
  private _streaming: StreamingSession | null = null;
  /** Frames since the streaming scheduler last ran — for throttling. */
  private _streamingFrame = 0;
  /**
   * Last-observed centre of the streaming cloud's bounds. The streaming
   * pipeline returns the COPC / EPT octree's *full* extent up front, so this
   * value is set once at attach and barely moves; the per-frame refinement
   * lerps the orbit target toward it only when a bounds update shifts the
   * centre by more than a millimetre, so a fresh node finishing decoding
   * never causes the camera to perceptibly jump. Cleared on detach.
   */
  private _lastStreamingCenter: Vec3Tuple | null = null;
  /**
   * The most recent visible-cloud AABB, captured at every attach/detach so
   * the per-frame orbit-soft-clamp doesn't have to re-walk every cloud entry
   * 60 times a second. `null` when no cloud is loaded — disables clamping.
   */
  private _orbitClampAabb: OrbitAabb | null = null;
  /**
   * True while the user is actively driving OrbitControls (drag, touch,
   * scroll). Set/cleared by the controls' 'start'/'end' event listeners.
   * The per-frame orbit-centre refinement reads this and suspends itself
   * mid-gesture so the soft-clamp pull-back and streaming-bounds lerp
   * never compete with live mouse input — a model-viewer-quality feel.
   */
  private _userInteracting = false;
  /**
   * High-resolution timestamp of the last OrbitControls 'end' event. The
   * orbit-centre maintenance reads this to skip itself for ~280 ms after
   * release — long enough for OrbitControls' damping curve to settle, so
   * the soft-clamp lerp never competes with the post-release glide and
   * the axis stays steady through the coast.
   */
  private _lastInteractMs = 0;
  /**
   * Edge detector for the hand tool's grab (v0.5.5 P1): true while
   * `_maintainOrbitCenter` saw `_nav.panDragging` on the previous frame, so
   * the release edge can stamp `_lastInteractMs` exactly once.
   */
  private _panWasDragging = false;

  // ── Shared point size in screen pixels (applied to all materials) ────────
  // Defaults to the smallest size; matches the Inspector slider's initial value.
  private _pointSize = 1;

  // ── Render-quality pipeline (Eye Dome Lighting post-processing) ──────────
  /**
   * Post-processing pipeline — driven only while EDL is enabled.
   *
   * Three.js renamed `PostProcessing` to `RenderPipeline` in r170; the API
   * surface (`outputNode`, `render()`, `dispose()`) is identical, so this
   * is a pure rename with no behaviour change.
   */
  private readonly _post: THREE.RenderPipeline;
  /** The scene render pass that feeds the post-processing pipeline. */
  private readonly _scenePass: ReturnType<typeof pass>;
  /** Whether EDL is on; defaulted by the capability gate once the backend is known. */
  private _edlEnabled = false;
  /**
   * Tracks whether the last paint applied EDL at rest. EDL is suspended while
   * the camera moves (its per-frame post-process is what makes motion judder);
   * this flag lets the loop force exactly ONE EDL repaint the moment motion
   * settles, so the depth cue snaps back without flickering every idle frame.
   */
  private _edlPaintedAtRest = false;
  /** EDL strength, and the camera near/far, as live uniforms. */
  private readonly _edlStrength = uniform(EDL_DEFAULTS.strength);
  private readonly _edlNear = uniform(0.1);
  private readonly _edlFar = uniform(5_000_000);
  /**
   * The user-facing base EDL strength — what the slider directly controls.
   * The live `_edlStrength` uniform is `base × adaptive_factor` each frame
   * (see `_updateAdaptiveEdl`), so a user who sets a strong base still
   * gets a stronger close-inspection effect than a user with a weak base.
   */
  private _edlBaseStrength: number = EDL_DEFAULTS.strength;
  /**
   * Approximate cloud density in points per square metre on the XY
   * footprint, captured at attach time. Feeds the density-aware EDL
   * adaptation — sparse clouds benefit from stronger depth cueing,
   * dense clouds need it gentler. `null` when no cloud is loaded;
   * `_updateAdaptiveEdl` falls back to the identity density factor.
   */
  private _currentDensityPtsPerM2: number | null = null;

  // ── Point styling ────────────────────────────────────────────────────────
  /** Adaptive (distance-scaled) or fixed point size. */
  private _pointSizeMode: PointSizeMode = POINT_STYLE_DEFAULTS.mode;
  /** Whether point-edge antialiasing (alpha-to-coverage) is on. */
  private _antialiasing = true;
  /** Base point size and the adaptive reference distance, as live uniforms. */
  private readonly _pointSizeUniform = uniform(1);
  /**
   * P13 — drives the point opacity node between the antialiased rim mask (0) and
   * the Gaussian kernel (1). Shared across every cloud material so `setSplatMode`
   * switches the whole scene with one uniform write — no material rebuild.
   */
  private readonly _gaussianOpacityFactor = uniform(0);
  private readonly _attnRef = uniform(100);
  /** The shared adaptive size node, assigned to every cloud's material. */
  private readonly _adaptiveSizeNode = buildAdaptiveSizeNode(
    this._pointSizeUniform,
    this._attnRef,
  );

  // ── Class visibility (GPU mask) ───────────────────────────────────────────
  /**
   * One Viewer-owned 256-entry visibility mask, shared by every point
   * material (static clouds AND streaming nodes). `1` = show, `0` = hide.
   * Defaults to all-1 so the unfiltered scene is visually identical to
   * pre-feature behaviour. `applyClassVisibility` writes new values into
   * the backing array; the node re-uploads once per render.
   *
   * Implementation note: a `uniformArray` of 256 floats was chosen over a
   * 256x1 DataTexture because it compiles cleanly in this three build's TSL
   * (`.element(int(aClass))` indexes it directly with no vertex-stage
   * texture-fetch LOD plumbing). 256 floats live well within the vertex
   * uniform budget on every WebGPU target and every practical WebGL2 device.
   */
  private readonly _classMaskUniform = uniformArray(
    new Array<number>(CLASS_COUNT).fill(1),
    'float',
  );
  /**
   * True when at least one class is currently hidden. Mirrors the mask written
   * by `applyClassVisibility` so the pick paths can decide — with a single
   * boolean check — whether to consult the per-point class filter at all. When
   * nothing is hidden, picking takes the original no-predicate path and is
   * byte-identical (and equally fast) to the pre-feature behaviour.
   */
  private _classFiltered = false;
  /**
   * Materials whose mesh carries the `aClass` attribute — only these get the
   * class-mask multiply folded into their size node. Materials on class-less
   * meshes keep the exact prior size graph so they are never affected by the
   * filter (and never reference a missing attribute).
   */
  private readonly _materialsWithClass = new WeakSet<THREE.PointsNodeMaterial>();

  // ── Elevation filter (v0.5.6) ────────────────────────────────────────────
  // Shared uniforms driving a per-point size multiply, mirroring the class
  // mask. `enabled` gates the whole test (0 → identity, so the unfiltered scene
  // is pixel-identical); `axisIsZ` selects the up-axis component (1 = z / Z-up,
  // 0 = y / Y-up); `min`/`max` are the inclusive window in ATTRIBUTE space
  // (origin-shifted), converted from the world window by `elevationFilterUniform`.
  private readonly _elevFilterEnabled = uniform(0);
  private readonly _elevFilterAxisIsZ = uniform(1);
  private readonly _elevFilterMin = uniform(0);
  private readonly _elevFilterMax = uniform(0);
  /**
   * Materials whose mesh carries the named `aPos` instance-position attribute —
   * only these fold the elevation multiply into their size node. Both static
   * clouds and streaming nodes get `aPos` (they share `buildPointMesh`), so both
   * are filtered by the shared uniforms; any mesh built without it keeps the
   * prior graph and never references a missing attribute.
   */
  private readonly _materialsWithElev = new WeakSet<THREE.PointsNodeMaterial>();

  // Intensity filter (v0.5.6): `enabled` gates the test; `min`/`max` are the
  // inclusive window in raw intensity units, matching the `aIntensity` attribute
  // (no origin shift — intensity is a raw per-point scalar).
  private readonly _intenFilterEnabled = uniform(0);
  private readonly _intenFilterMin = uniform(0);
  private readonly _intenFilterMax = uniform(0);
  /**
   * Materials whose mesh carries the `aIntensity` instance attribute — only
   * these fold the intensity multiply. A cloud without an intensity channel
   * (PLY, some PCD) skips the attribute and keeps the prior graph, so the filter
   * is a silent no-op there, exactly like the class mask.
   */
  private readonly _materialsWithInten = new WeakSet<THREE.PointsNodeMaterial>();

  // ── Navigation state ─────────────────────────────────────────────────────
  /** The cloud's vertical axis — Z for LAS/LAZ surveys, Y for phone scans. */
  private readonly _worldUp = new THREE.Vector3(0, 1, 0);

  /** Near-orthographic (parallel) projection toggle — see ORTHO_FOV. */
  private _orthographic = false;
  /** The last axis-aligned standard view applied, so toggling ortho re-frames it. */
  private _lastStandardView: StandardView | null = null;
  private _navListeners: NavListeners = {};
  private readonly _raycaster = new THREE.Raycaster();
  /**
   * Reusable view-projection matrix for the streaming scheduler. Allocating
   * a fresh `THREE.Matrix4` every tick (the scheduler ticks at ~10 Hz, but
   * also re-ticks on each camera change) churns the GC for no reason — the
   * matrix is consumed immediately as a `.elements` snapshot.
   */
  private readonly _streamingViewProj = new THREE.Matrix4();
  /**
   * Reusable 3-tuple for the streaming scheduler's camera-position input.
   * Same reasoning as `_streamingViewProj` — the scheduler clones it
   * internally before retaining anything.
   */
  private readonly _streamingCamPos: [number, number, number] = [0, 0, 0];
  /** Reusable NDC vector for pointer-picking, replaces per-event allocs. */
  private readonly _pickNdc = new THREE.Vector2();
  /**
   * RAF token for the debounced resize. The ResizeObserver callback fires
   * synchronously with every observed size change; during a window drag
   * that means many calls per frame, each calling `renderer.setSize` +
   * camera reprojection. RAF-debounce collapses them to one per frame.
   */
  private _resizeRafId: number | null = null;

  // ── Picking tools (measure / inspect) ────────────────────────────────────
  private readonly _canvas: HTMLCanvasElement;
  private readonly _measure: MeasureController;
  private readonly _inspect: InspectTool;
  private readonly _annotate: AnnotationController;
  private readonly _probe: LiveProbe;

  // ── bound listener references so `dispose()` can
  //    remove them. The constructor assigns these once and registers them
  //    on the canvas / window; `dispose()` removes them. Storing the
  //    bound closures here (rather than the methods themselves) preserves
  //    the canvas reference each listener captures.
  private _onCanvasDblClick!: (e: MouseEvent) => void;
  private _onCanvasClick!: (e: MouseEvent) => void;
  private _onCanvasPointerMove!: (e: PointerEvent) => void;
  private _onCanvasPointerLeave!: () => void;
  private _onWindowKeyDown!: (e: KeyboardEvent) => void;
  /**
   * Pauses the render loop while the tab is hidden; resumes when
   * the user comes back. Registered on `document.visibilitychange`.
   * Stored as a bound field so the symmetric `removeEventListener`
   * in `dispose()` actually matches.
   */
  private _onVisibilityChange!: () => void;
  /** Touch-gesture pointer trackers. See `_initTouchGesture`. */
  private _onCanvasPointerDown!: (e: PointerEvent) => void;
  private _onCanvasPointerUp!: (e: PointerEvent) => void;
  private _onCanvasPointerCancel!: (e: PointerEvent) => void;
  /** Active touch pointers, keyed by pointerId. */
  private readonly _activeTouches = new Map<number, TouchPointer>();
  /**
   * If true, the multi-touch recogniser will route 2-pointer gestures to
   * twist + pinch + pan decomposition (Maps / Procreate model). Defaults
   * to true; an Inspector toggle (D.7.3) can flip it for the advanced
   * "3-finger zoom" model.
   */
  private _twoFingerTwistEnabled = true;
  /** ResizeObserver subscribed to the host canvas — disconnected on dispose. */
  private _resizeObserver: ResizeObserver | null = null;
  /** Which picking tool currently owns canvas clicks. */
  private _toolMode: ToolMode = 'none';
  // Hold-Space "re-orient" pause: a modal tool stays armed but navigation gets
  // input back so the user can rotate / pan mid-draw, then resume on release.
  private _toolPaused = false;
  private _measureListeners: MeasureListeners = {};
  private _inspectListeners: InspectListeners = {};
  private _annotateListeners: AnnotateListeners = {};
  private _probeListeners: ProbeListeners = {};
  /** Last pointer position over the canvas, in NDC, for the measure preview. */
  private _pointerNdcX = 0;
  private _pointerNdcY = 0;
  /** Last pointer position in client pixels — anchors the live-probe readout. */
  private _pointerClientX = 0;
  private _pointerClientY = 0;
  private _pointerOnCanvas = false;
  /** Set when the pointer moved, so the preview re-picks at most once per frame. */
  private _pointerMoved = false;

  // ─────────────────────────────────────────────────────────────────────────
  // Constructor
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create the renderer attached to `canvas`, wire up a perspective camera
   * with OrbitControls and a NavController, and kick off the render loop.
   *
   * @param canvas - The `<canvas>` element to render into.
   */
  constructor(canvas: HTMLCanvasElement) {
    // ── Renderer ──────────────────────────────────────────────────────────
    this._renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: true,
      alpha: false,
      // logarithmic depth buffer distributes
      // precision across many orders of magnitude of distance, so a
      // 50 km COPC tile and a 5 m indoor scan both render without
      // z-fighting and the zoom envelope is effectively unbounded.
      // Eliminates the residual "stops zooming at a point" artifact
      // on huge surveys that even near=0.01 couldn't fully clear.
      logarithmicDepthBuffer: true,
    } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);

    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    // updateStyle=false: the stylesheet owns the canvas display size
    // (.olv-canvas is inset:0/100%×100%). Letting three.js write inline
    // style.width/height in px would override the CSS and pin the canvas to a
    // stale fixed box — under browser zoom the container grows but the canvas
    // stays clamped, confining the scene to a sub-region. We size only the
    // drawing buffer here and let CSS track the layout.
    this._renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600, false);
    // v0.3.7 colour-fidelity pass: ACES Filmic tone-mapping (the v0.3.6
    // default) was designed for HDR cinema content — it deliberately
    // rolls off highlights and desaturates near-white values. Applied
    // to LDR point-cloud RGB, which the scanner already captured in
    // display-referred space, that roll-off reads as pale, washed-out
    // colour. NoToneMapping passes scanner-captured RGB straight through
    // so a brown roof reads brown and grass reads green — what the
    // analyst expects from "RGB Natural" mode. Exposure stays at 1.0 to
    // preserve scanner-captured brightness; the v0.3.7 RGB appearance
    // controls (gamma / contrast / saturation / exposure) layer on top
    // per the user's preset choice. sRGB output-space ensures
    // PNG exports match the on-screen colour.
    this._renderer.toneMapping = THREE.NoToneMapping;
    this._renderer.toneMappingExposure = 1.0;
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;

    // ── Scene ─────────────────────────────────────────────────────────────
    this._scene = new THREE.Scene();
    // Deep Navy — the brand background colour. Slightly darker than the
    // previous 0x0a0e1a so the cyan EDL highlights pop against it and the
    // CSS vignette overlay reads as cinematic edge falloff rather than
    // a flat tint.
    this._scene.background = new THREE.Color(0x070b16);

    // ── Camera ────────────────────────────────────────────────────────────
    const aspect = (canvas.clientWidth || 800) / (canvas.clientHeight || 600);
    this._camera = new THREE.PerspectiveCamera(DEFAULT_FOV, aspect, 0.1, 5_000_000);
    this._camera.position.set(0, 0, 100);

    // ── Post-processing pipeline (Eye Dome Lighting) ──────────────────────
    // The scene renders into a pass; the EDL node shades it from the pass's
    // colour and depth. The pipeline is driven only while EDL is enabled (see
    // the render loop); its node graph compiles lazily on first use.
    //
    // Depth-encoding flag: read back off the renderer instance rather than
    // hard-coding `true` to match the constructor option above. three's base
    // `Renderer` class stores the option verbatim (`this.logarithmicDepthBuffer`),
    // and the node pipeline keys its fragment-depth override on that same
    // property — so deriving the EDL inversion from it keeps the two in
    // lock-step even if a future three release stops honouring (or starts
    // ignoring) the option on one backend.
    const usesLogDepth =
      (this._renderer as unknown as { logarithmicDepthBuffer?: boolean })
        .logarithmicDepthBuffer === true;
    this._scenePass = pass(this._scene, this._camera);
    this._post = new THREE.RenderPipeline(this._renderer);
    this._post.outputNode = buildEdlOutputNode(
      this._scenePass,
      this._edlStrength,
      this._edlNear,
      this._edlFar,
      EDL_DEFAULTS.radiusPx,
      usesLogDepth,
    ) as typeof this._post.outputNode;

    // ── OrbitControls ─────────────────────────────────────────────────────
    // v0.3.6 smoothness tuning, take 2 — after the first pass made orbit
    // feel "weird on the axis" on large LAS surveys (the camera over-
    // coasted after release, exaggerating any minor target drift):
    //   • dampingFactor: 0.05 → 0.07. Still softer than the v0.3.5 baseline
    //     of 0.08 so glide is noticeable, but not so soft the camera
    //     keeps moving distractingly after the finger lifts.
    //   • rotateSpeed:   1.00 → 0.95. Closer to the v0.3.5 0.85 baseline
    //     so the *active* drag doesn't feel slippery alongside the new
    //     damping. The net feel is "a hair smoother than v0.3.5" rather
    //     than "model-viewer's full coast", which is what the camera
    //     navigation actually wants for survey data.
    this._controls = new OrbitControls(this._camera, canvas);
    this._controls.enableDamping = true;
    // Touch-class devices need slower rotate + faster settling than the
    // desktop tuning. OrbitControls applies these values uniformly to
    // mouse and touch, so we check the viewport class once at init and
    // pick the right pair. Users that rotate from portrait phone to
    // landscape tablet may cross the breakpoint; they re-init only on
    // a Viewer reconstruction (page reload), which is acceptable
    // — same trade-off as the existing edl-default + sky-preset paths.
    const touchTuned = this._isMobile();
    this._controls.dampingFactor = touchTuned ? DAMPING_FACTOR_TOUCH : DAMPING_FACTOR;
    this._controls.zoomToCursor = true;
    this._controls.rotateSpeed = touchTuned ? ROTATE_SPEED_TOUCH : ROTATE_SPEED;
    // ── Mobile touch model — twist + pinch + pan decomposition (D.7) ──────
    // Strip OrbitControls' 2-finger handler so our custom recogniser owns
    // the 2-pointer surface. 1-finger ROTATE stays untouched. The pointer-
    // tracking listeners are wired in the listener block below.
    this._controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      // Setting TWO to undefined disables OrbitControls' built-in dolly /
      // pan / dolly-pan path for two pointers. Our handler takes over.
      TWO: undefined as unknown as THREE.TOUCH,
    };
    // OrbitControls fires 'start' on first drag / touch / wheel and 'end' on
    // release. The Viewer subscribes here so the per-frame orbit-centre
    // maintenance can suspend itself while the user is actively driving the
    // camera — no lerp competes with live input, no clamp judders mid-pan.
    // 'end' also stamps `_lastInteractMs` so the orbit-centre maintenance
    // can wait through OrbitControls' post-release damping tail before
    // engaging — without that grace period, the soft-clamp lerp races
    // damping and the camera rotates around a sliding target.
    // OrbitControls fires 'change' for every camera-affecting input
    // (wheel zoom, drag, pan, programmatic camera moves) AND for every
    // damping tick after release. Bumping render-activity here keeps
    // the idle-render throttle out of the way while the camera is
    // actually moving, including the post-gesture damping tail.
    this._controls.addEventListener('change', () => { this._bumpRenderActivity(); });
    this._controls.addEventListener('start', () => { this._userInteracting = true; });
    this._controls.addEventListener('end', () => {
      this._userInteracting = false;
      this._lastInteractMs = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
    });

    // ── Navigation controller ─────────────────────────────────────────────
    this._nav = new NavController(this._camera, canvas, this._controls, {
      onModeChange: (m) => this._navListeners.onModeChange?.(m),
      onPointerLockChange: (l) => this._navListeners.onPointerLockChange?.(l),
      onToggleHelp: () => this._navListeners.onToggleHelp?.(),
      onReset: () => this.frameAll(),
      onFocusCenter: () => this._focusCenter(),
    });

    // Picking tools — while one is active, a canvas click picks a point.
    this._canvas = canvas;
    this._measure = new MeasureController({
      onExit: () => this.setMeasureMode(false),
    });
    this._measure.setPicker((ndcX, ndcY) => {
      const hit = this._pickPoint(ndcX, ndcY);
      return hit ? [hit.x, hit.y, hit.z] : null;
    });
    // Profile sampler — feeds the chart half of a Profile measurement.
    // Walks every cloud the Viewer currently holds (static + streaming
    // resident), concatenates their local positions, and runs the
    // pure-data `sampleProfile`. Returns null when no positions are
    // available so the controller leaves the chart unset.
    this._measure.setProfileSampler(
      (
        a,
        b,
        opts,
      ): {
        samples: ProfileChartSample[];
        residentOnly: boolean;
        corridorWidth: number;
        groundPercentile: number;
      } | null => {
        // Track each buffer's classification alongside it so the profile can
        // be computed over classified ground (vegetation / buildings dropped).
        const buffers: Array<{ pos: Float32Array; cls?: ArrayLike<number> }> = [];
        let total = 0;
        let staticPoints = 0;
        let streamingPoints = 0;
        let anyClass = false;
        const aligned = (
          c: ArrayLike<number> | null | undefined,
          pos: Float32Array,
        ): ArrayLike<number> | undefined => (c && c.length === pos.length / 3 ? c : undefined);
        for (const { cloud } of this._clouds.values()) {
          if (cloud.positions && cloud.positions.length > 0) {
            const cls = aligned(cloud.classification, cloud.positions);
            if (cls) anyClass = true;
            buffers.push({ pos: cloud.positions, cls });
            total += cloud.positions.length;
            staticPoints += cloud.positions.length;
          }
        }
        for (const { decoded } of this._streamingPickData.values()) {
          if (decoded.positions && decoded.positions.length > 0) {
            const cls = aligned(decoded.classification, decoded.positions);
            if (cls) anyClass = true;
            buffers.push({ pos: decoded.positions, cls });
            total += decoded.positions.length;
            streamingPoints += decoded.positions.length;
          }
        }
        if (total === 0) return null;
        // Flatten — cheap because we only walk the resident set.
        const positions = new Float32Array(total);
        // 255 = "no class channel" sentinel; the sampler treats it as "keep".
        const classification = anyClass ? new Uint8Array(total / 3).fill(255) : undefined;
        let off = 0;
        let coff = 0;
        for (const { pos, cls } of buffers) {
          positions.set(pos, off);
          off += pos.length;
          const m = pos.length / 3;
          if (classification && cls) for (let i = 0; i < m; i++) classification[coff + i] = cls[i];
          coff += m;
        }
        // `up` is the configured world up — hardcoding [0,0,1] here cut Y-up
        // phone scans along the wrong axis (v0.4.4 audit, B1). The same
        // format-driven up the navigation/measure context already uses.
        const up: Vec3 = [this._worldUp.x, this._worldUp.y, this._worldUp.z];
        // Sampler parameters (B7/B8, v0.4.5): the controller's resample path
        // passes user overrides; absent/null fields fall back to the standing
        // defaults — the 5 %-of-length auto corridor, p25, 64 bins. Every
        // value that ACTUALLY shaped the estimate is passed back so it lands
        // on the measurement record and the PDF/CSV provenance prints the
        // real numbers instead of "auto" (B4).
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
        // The chart is "resident-only" whenever any streaming bytes are
        // in the walk and there is no fully-loaded static cloud beside
        // it — that's exactly the case where additional nodes may
        // refine the profile as they stream in.
        const residentOnly = streamingPoints > 0 && staticPoints === 0;
        return {
          samples,
          residentOnly,
          corridorWidth,
          groundPercentile,
        };
      },
    );
    // Volume sampler — feeds the cut/fill record half of a Volume
    // measurement. Same residency-only contract as the profile sampler:
    // walks every static cloud + every resident streaming node, runs
    // `volumeCutFill` against the concatenated positions buffer, and
    // returns the record. Null when no positions are loaded.
    this._measure.setVolumeSampler(
      (polygon, referenceZ): { record: VolumeRecord; residentOnly: boolean } | null => {
        const buffers: Float32Array[] = [];
        let total = 0;
        let staticPoints = 0;
        let streamingPoints = 0;
        for (const { cloud } of this._clouds.values()) {
          if (cloud.positions && cloud.positions.length > 0) {
            buffers.push(cloud.positions);
            total += cloud.positions.length;
            staticPoints += cloud.positions.length;
          }
        }
        for (const { decoded } of this._streamingPickData.values()) {
          if (decoded.positions && decoded.positions.length > 0) {
            buffers.push(decoded.positions);
            total += decoded.positions.length;
            streamingPoints += decoded.positions.length;
          }
        }
        if (total === 0) return null;
        const positions = new Float32Array(total);
        let off = 0;
        for (const b of buffers) {
          positions.set(b, off);
          off += b.length;
        }
        // `up` is the configured world up, not a hardcoded [0,0,1]. The
        // profile sampler above already reads `this._worldUp` (v0.4.4 audit,
        // B1); the cut/fill path was missed. On a Y-up phone scan (PLY/OBJ/
        // GLB) the controller derives the reference plane along `_worldUp`
        // (`autoReferenceZ`), so integrating height along Z here disagreed
        // with the reference and produced a wrong cut/fill volume.
        const up: Vec3 = [this._worldUp.x, this._worldUp.y, this._worldUp.z];
        const result = volumeCutFill({
          polygon,
          referenceZ,
          up,
          positions,
        });
        const confidence: 'high' | 'medium' | 'low' =
          result.pointsInPolygon >= 1000
            ? 'high'
            : result.pointsInPolygon >= 100
              ? 'medium'
              : 'low';
        // Volume readout is "resident-only" whenever any streaming bytes
        // were in the walk and no fully-loaded static cloud sat beside
        // them — same rationale as the profile sampler.
        const residentOnly = streamingPoints > 0 && staticPoints === 0;
        return {
          record: {
            fill: result.fill,
            cut: result.cut,
            net: result.net,
            referenceZ,
            footprintArea: result.footprintArea,
            pointsInPolygon: result.pointsInPolygon,
            density: result.density,
            confidence,
          },
          residentOnly,
        };
      },
    );
    this._inspect = new InspectTool(this._camera, canvas, {
      onExit: () => this.setInspectMode(false),
    });
    // v0.3.7 photometric witness — feed the inspector the raw positions
    // + sRGB Uint8 colours for any picked point so it can build a
    // patch-view thumbnail and the colour-provenance values block.
    // Walks both static clouds and streaming resident nodes, returning
    // null when the requested layer carries no RGB (the inspector then
    // falls back to the classic numeric card).
    this._inspect.setPatchProvider((layer, _index) => {
      // Static cloud — fast path, returns the cloud's own buffers.
      // PointInfo.layer is populated from `cloud.name` in `_infoForHit`,
      // so we match by name here.
      for (const [, entry] of this._clouds) {
        if (entry.cloud.name === layer) {
          if (!entry.cloud.colors || entry.cloud.colors.length === 0) return null;
          return {
            positions: entry.cloud.positions,
            colorsU8: entry.cloud.colors,
          };
        }
      }
      // Streaming resident set — concatenate every node's positions and
      // colours so the patch-view walks the full resident neighbourhood
      // around the picked point.
      const posBuffers: Float32Array[] = [];
      const colorBuffers: Uint8Array[] = [];
      let total = 0;
      for (const { decoded } of this._streamingPickData.values()) {
        if (
          decoded.positions &&
          decoded.positions.length > 0 &&
          decoded.rgb &&
          decoded.rgb.length > 0
        ) {
          posBuffers.push(decoded.positions);
          colorBuffers.push(decoded.rgb);
          total += decoded.positions.length;
        }
      }
      if (total === 0) return null;
      const positions = new Float32Array(total);
      const colorsU8 = new Uint8Array(total);
      let off = 0;
      for (let i = 0; i < posBuffers.length; i++) {
        positions.set(posBuffers[i], off);
        colorsU8.set(colorBuffers[i], off);
        off += posBuffers[i].length;
      }
      return { positions, colorsU8 };
    });
    this._annotate = new AnnotationController();
    // The annotation editor can link a finding to a measurement — feed it the
    // current measurement list whenever it opens.
    this._annotate.setMeasurementSource(() =>
      this._measure.getMeasurements().map((m) => ({ id: m.id, name: m.name })),
    );
    this._probe = new LiveProbe();

    // ── leak-free listener wiring. Every listener is
    //    stored as a bound reference and removed in `dispose()`, so a
    //    re-created Viewer on the same canvas does not pile up listeners
    //    across the 50-scan open/close cycle.
    this._onCanvasDblClick = (e) => this._handleDoubleClick(e, canvas);
    this._onCanvasClick = (e) => {
      // While paused (hold-Space to re-orient), the click belongs to camera
      // navigation, not the tool — don't place a point / pick / annotation.
      if (this._toolPaused) return;
      if (this._toolMode === 'measure') this._handleMeasureClick(e, canvas);
      else if (this._toolMode === 'inspect') this._handleInspectClick(e, canvas);
      else if (this._toolMode === 'annotate') this._handleAnnotateClick(e, canvas);
    };
    this._onCanvasPointerMove = (e) => {
      this._bumpRenderActivity();
      this._pointerNdcX = (e.offsetX / canvas.clientWidth) * 2 - 1;
      this._pointerNdcY = -(e.offsetY / canvas.clientHeight) * 2 + 1;
      this._pointerClientX = e.clientX;
      this._pointerClientY = e.clientY;
      this._pointerOnCanvas = true;
      this._pointerMoved = true;
      // Touch-gesture path (D.7.2). Only fires when we have exactly two
      // active touch pointers AND no picking tool owns the canvas, so a
      // measurement drag is never hijacked. The 1-pointer path stays with
      // OrbitControls' inherited rotate-by-touch behaviour.
      if (
        e.pointerType !== 'touch' ||
        !this._twoFingerTwistEnabled ||
        this._toolMode !== 'none'
      ) {
        return;
      }
      const prev = this._activeTouches.get(e.pointerId);
      if (!prev) return;
      const cur: TouchPointer = { x: e.offsetX, y: e.offsetY };
      // Need exactly 2 pointers for the 2-finger gesture model.
      if (this._activeTouches.size === 2) {
        // Pull the OTHER pointer out of the map — it stays put for this
        // frame (its own pointermove will run later in the same tick).
        let otherId = -1;
        let other: TouchPointer | null = null;
        for (const [id, p] of this._activeTouches) {
          if (id !== e.pointerId) {
            otherId = id;
            other = p;
            break;
          }
        }
        if (other) {
          const delta = decompose2Pointer(prev, other, cur, other);
          if (!gestureIsZero(delta)) {
            this._applyTouchGesture(delta);
          }
        }
        void otherId;
      }
      this._activeTouches.set(e.pointerId, cur);
    };
    this._onCanvasPointerLeave = () => {
      this._pointerOnCanvas = false;
      this._pointerMoved = true;
    };
    // ── Touch gesture wiring (D.7.2) ──────────────────────────────────────
    // Track active touch pointers so the recogniser can run on every
    // 2-pointer move. Mouse pointers are ignored — OrbitControls still
    // owns the desktop wheel-zoom + click-drag path. The recogniser is
    // also suspended while a picking tool (measure / inspect / annotate)
    // owns the canvas, so a 2-finger measurement drag isn't hijacked.
    this._onCanvasPointerDown = (e) => {
      this._bumpRenderActivity();
      if (e.pointerType !== 'touch') return;
      if (this._toolMode !== 'none') return;
      this._activeTouches.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      // Capture so we keep getting moves even if the finger slides off
      // the canvas before lift.
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Pointer-capture can throw on devices that already lost the
        // pointer; safe to ignore — we'll receive pointerup naturally.
      }
    };
    this._onCanvasPointerUp = (e) => {
      if (e.pointerType !== 'touch') return;
      this._activeTouches.delete(e.pointerId);
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Already released — ignore.
      }
    };
    this._onCanvasPointerCancel = this._onCanvasPointerUp;
    this._onWindowKeyDown = (e) => {
      this._bumpRenderActivity();
      if (e.code === 'Escape' && this._toolMode !== 'none') this._setToolMode('none');
    };
    this._onVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      // Coming back from background — bump activity so the first few
      // post-resume frames render at full rate (avoids a stuttery
      // catch-up on the first input after the tab regains focus).
      if (!document.hidden) this._bumpRenderActivity();
      if (document.hidden) {
        // Tab is in background — stop the render loop. The next
        // visibility change resumes it. Streaming work that fires on
        // a setInterval / setTimeout continues in the background; the
        // node fetcher is already throttled to a memory cap so it
        // won't run away.
        if (this._rafId !== null) {
          cancelAnimationFrame(this._rafId);
          this._rafId = null;
        }
      } else {
        // Tab is visible again. Reset the frame timer so the first
        // frame after resume doesn't see a giant delta (which would
        // otherwise look like a stutter to the camera intro / orbit
        // pivot lerp), then restart the loop.
        this._timer.update();
        if (this._rafId === null && this._renderer !== undefined) {
          this._startLoop();
        }
      }
    };
    canvas.addEventListener('dblclick', this._onCanvasDblClick);
    canvas.addEventListener('click', this._onCanvasClick);
    canvas.addEventListener('pointermove', this._onCanvasPointerMove);
    canvas.addEventListener('pointerleave', this._onCanvasPointerLeave);
    canvas.addEventListener('pointerdown', this._onCanvasPointerDown);
    canvas.addEventListener('pointerup', this._onCanvasPointerUp);
    canvas.addEventListener('pointercancel', this._onCanvasPointerCancel);
    window.addEventListener('keydown', this._onWindowKeyDown);
    // Thermal hardening — when the tab is hidden (user switched away
    // or the OS dimmed the window), stop scheduling render frames.
    // Without this gate the loop keeps rendering at 60 fps to an
    // invisible canvas, which is the single biggest cause of an
    // M-series laptop running hot while OpenLiDARViewer is "just
    // open". Pairs with the resume path in `_onVisibilityChange`.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    // ── Async backend init + render loop ──────────────────────────────────
    // Both the WebGPU init AND the WebGL 2 fallback can fail on very old
    // browsers or in headless contexts where neither backend can produce a
    // working context. Without an explicit `.catch`, the rejection is
    // unhandled: `_startLoop` is never called, the canvas stays blank, and
    // the user has no console signal as to why. Surface the failure to
    // the console (no telemetry leaves the device) and re-throw so any
    // caller that awaits `viewer.ready` can surface a fatal toast.
    this.ready = this._renderer.init().then(
      () => {
        // EDL defaults on for desktop WebGPU; off on the WebGL 2 fallback and on
        // mobile, so a weak device is never dropped below interactive on load.
        this._edlEnabled = edlDefaultEnabled(this.activeBackend(), this._isMobile());
        // Wire the WebGPU device's uncaptured-error channel to the host so a
        // shader-compile / pipeline-creation failure (which surfaces AFTER the
        // scan has decoded + attached) becomes a visible error instead of a
        // blank canvas with no signal. No-op on the WebGL 2 fallback.
        this._installGpuErrorListener();
        // Force the first window of frames to render at full rate so
        // the empty state, hero animation, and any pending tween land
        // smoothly before the idle-render throttle kicks in.
        this._bumpRenderActivity();
        this._startLoop();
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          'OpenLiDARViewer: GPU backend initialisation failed. ' +
            'Neither WebGPU nor WebGL 2 produced a usable context. ' +
            `(${message})`,
        );
        throw err;
      },
    );

    // ── Resize observer ── stored so `dispose()` can disconnect.
    this._resizeObserver = new ResizeObserver(() => this._scheduleResize(canvas));
    this._resizeObserver.observe(canvas);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cloud management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Add a point cloud to the scene.
   *
   * Builds an `InstancedBufferGeometry`: one shared unit quad drawn once per
   * point. The per-point centre (`cloud.positions`) and colour are supplied as
   * instanced attributes and consumed by a `PointsNodeMaterial`, which expands
   * each instance into a camera-facing, pixel-sized quad on both GPU backends.
   *
   * @returns A string ID that identifies this cloud in subsequent calls.
   */
  addCloud(input: PointCloud): string {
    // GPU-safety net — no caller may upload a cloud beyond the hard point
    // ceiling. The device-aware load budget already sizes clouds to the
    // machine; this guards any other path that might reach the GPU.
    const cloud =
      input.pointCount > GPU_HARD_POINT_CEILING
        ? downsampleToBudget(input, GPU_HARD_POINT_CEILING)
        : input;
    const id = `cloud_${this._nextId++}`;
    const mode = defaultMode(cloud);

    const { mesh, material, colorAttr } = this.buildPointMesh(
      cloud.positions,
      // upAxis from the source format so a Y-up phone scan's elevation ramp
      // follows true height, not a horizontal axis.
      colorForMode(mode, cloud, { upAxis: isZUpFormat(cloud.sourceFormat) ? 2 : 1 }),
      // Feed the DOWNSAMPLED classification (carried in lockstep with the
      // downsampled positions by `downsampleToBudget`), never the original
      // input — the attribute must align 1:1 with the uploaded points.
      cloud.classification ?? null,
      // Intensity rides along 1:1 for the intensity filter (v0.5.6); the
      // downsampled cloud carries a downsampled intensity in lockstep.
      cloud.intensity ?? null,
    );
    this._scene.add(mesh);

    this._clouds.set(id, { cloud, mesh, material, colorAttr, mode });
    this._configureForClouds(cloud);
    return id;
  }

  /**
   * Build one instanced-quad point mesh from local positions and interleaved
   * RGB colours — the shared primitive behind both static clouds and COPC
   * streaming nodes. The mesh is *not* added to the scene; the caller mounts
   * it. Picking up the viewer's current point size, size mode and
   * antialiasing means a freshly built mesh matches the rest of the scene.
   */
  buildPointMesh(
    positions: Float32Array,
    colorsU8: Uint8Array,
    classification: ArrayLike<number> | null = null,
    intensity: ArrayLike<number> | null = null,
  ): PointMeshHandle {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(QUAD_CORNERS, 3),
    );
    geometry.setIndex(QUAD_INDEX);
    const instanceCount = positions.length / 3;
    geometry.instanceCount = instanceCount;

    const positionAttr = new THREE.InstancedBufferAttribute(positions, 3);
    // Expose the per-instance position under a name so the size graph can read
    // the point's elevation for the elevation filter (v0.5.6). Same buffer as
    // `positionNode`, just a named binding — mirrors `aClass`.
    geometry.setAttribute('aPos', positionAttr);
    const colorAttr = new THREE.InstancedBufferAttribute(toFloatColors(colorsU8), 3);

    // Per-point ASPRS classification, uploaded as a one-value-per-instance
    // float attribute named `aClass`. Float (not an integer attribute) keeps
    // it portable across the WebGPU and WebGL2 backends — the size graph
    // rounds it back to an int before indexing the class-visibility mask.
    // When the cloud has no classification channel we skip the attribute
    // entirely; the size graph's mask lookup is guarded so such meshes stay
    // fully visible regardless of the active filter.
    let classAttr: THREE.InstancedBufferAttribute | null = null;
    if (classification !== null) {
      const classData = new Float32Array(instanceCount);
      const n = Math.min(instanceCount, classification.length);
      for (let i = 0; i < n; i++) classData[i] = classification[i];
      classAttr = new THREE.InstancedBufferAttribute(classData, 1);
      geometry.setAttribute('aClass', classAttr);
    }

    // Per-point intensity, uploaded as a one-value-per-instance float attribute
    // named `aIntensity` (v0.5.6 intensity filter). Raw source units — the size
    // graph compares against the window directly. Skipped when the cloud carries
    // no intensity channel, so such meshes keep the prior graph and the filter
    // stays a no-op for them. Mirrors `aClass`.
    let intenAttr: THREE.InstancedBufferAttribute | null = null;
    if (intensity !== null) {
      const intenData = new Float32Array(instanceCount);
      const ni = Math.min(instanceCount, intensity.length);
      for (let i = 0; i < ni; i++) intenData[i] = intensity[i];
      intenAttr = new THREE.InstancedBufferAttribute(intenData, 1);
      geometry.setAttribute('aIntensity', intenAttr);
    }

    // `instancedBufferAttribute` is typed as a broad node-type union; narrow
    // it to each property's accepted type — the itemSize (3) makes it a vec3.
    const material = new THREE.PointsNodeMaterial();
    material.positionNode = instancedBufferAttribute(positionAttr) as NonNullable<
      typeof material.positionNode
    >;
    material.colorNode = instancedBufferAttribute(colorAttr) as NonNullable<
      typeof material.colorNode
    >;
    // Apply the splat multiplier at build time so a cloud added after
    // the user has picked Soft / Inspection from the chip rail renders
    // with the right sprite size from the very first frame.
    material.size = this._pointSize * splatRadiusMultiplier(this._splatMode);
    material.sizeAttenuation = false;
    material.transparent = false;
    // Round, soft-edged points — a circular alpha mask kept depth-correct via
    // alpha-to-coverage (no transparency sort, no draw-order artefacts).
    material.opacityNode = buildPointOpacityNode(
      this._gaussianOpacityFactor,
    ) as typeof material.opacityNode;
    // v0.3.7 final-polish: 0.18 was 0.5. Combined with the widened
    // smoothstep range in `buildPointMaskNode`, this keeps more of the
    // soft-edge gradient around the disc while still depth-sorting
    // correctly (the centre alpha stays at 1.0). Net effect: softer
    // rims, less sparkle on sparse regions.
    material.alphaTest = 0.18;
    // Soft / Inspection splat modes force AA on for the smooth rim
    // — Classic respects the user's antialiasing preference.
    material.alphaToCoverage =
      splatForcesAlphaToCoverage(this._splatMode) || this._antialiasing;
    // Record that this material's mesh carries `aClass` BEFORE size-mode
    // setup, so `_applySizeMode` folds the class-mask multiply into its size
    // node. Class-less meshes are never registered and keep the prior graph.
    if (classAttr !== null) this._materialsWithClass.add(material);
    // Every mesh from this shared builder (static clouds and streaming nodes)
    // carries `aPos`, so all fold the elevation multiply (identity while off).
    this._materialsWithElev.add(material);
    // Record intensity carriers so `_applySizeMode` folds the intensity multiply.
    if (intenAttr !== null) this._materialsWithInten.add(material);
    // A cloud added while a clip is active inherits it from its first frame.
    if (this._clip?.enabled) {
      material.clippingPlanes = clipBoxPlanes(this._clip);
      material.clipIntersection = this._clip.mode === 'keep-outside';
    }
    this._applySizeMode(material);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return { mesh, material, colorAttr, classAttr };
  }

  /**
   * Add a streaming COPC node's mesh to the scene. The node's decoded chunk is
   * registered so the measurement tools, the inspector, and the live probe can
   * pick points and read their per-point attributes on streaming nodes. The
   * node's octree `depth` is recorded too so the inspector can show a
   * "still refining" hint when a pick lands on a coarse node that still has
   * deeper siblings loading.
   */
  addStreamingMesh(mesh: THREE.Mesh, decoded: DecodedChunk, depth: number): void {
    this._scene.add(mesh);
    this._streamingMeshes.add(mesh);
    this._streamingPickData.set(mesh, { decoded, depth });
  }

  /**
   * Remove a streaming node's mesh from the scene and free its GPU buffers.
   *
   * Buffer-lifecycle proof:
   *   1. `_scene.remove` severs the parent chain so the mesh is no longer
   *      reachable from the scene root.
   *   2. The `_streamingMeshes` Set delete and the `_streamingPickData` Map
   *      delete drop the Viewer's last two references to the mesh — the pick
   *      map's reference is what previously kept the `DecodedChunk` (positions
   *      + per-point attribute arrays) alive.
   *   3. `geometry.dispose()` releases the WebGL buffer and fires Three's
   *      `dispose` event. Three's docs note that `dispose()` does NOT null
   *      the geometry's `attributes` map, but the geometry itself becomes
   *      unreachable the moment this method returns (no one else holds it),
   *      so its attribute → Float32Array chain is reclaimable by GC.
   *   4. The caller (`StreamingRenderer.onNodeEvicted`) drops its own
   *      `_meshes` entry around this call, and the fade-in tunables clear any
   *      pending fade-animation reference before disposal — so there is no
   *      surviving reference to the mesh in any subsystem after the function
   *      returns.
   */
  removeStreamingMesh(mesh: THREE.Mesh): void {
    this._scene.remove(mesh);
    this._streamingMeshes.delete(mesh);
    this._streamingPickData.delete(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming COPC
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Attach a streaming COPC cloud: wire its scheduler to a renderer, configure
   * navigation for its extent, and begin view-dependent streaming on the next
   * render tick. Replaces any previously attached streaming cloud.
   *
   * Async: the streaming render engine is a lazily-imported chunk, fetched
   * here on the first COPC open so it never weighs on the initial bundle.
   */
  async attachStreamingCloud(
    cloud: StreamingSource,
    decoder: ChunkDecoder,
    quality: StreamingQuality,
    isMobile: boolean,
    benchmark?: StreamingBenchmark | null,
  ): Promise<void> {
    const [{ StreamingRenderer }, { StreamingScheduler }] =
      await Promise.all([
        loadStreamingRenderer(),
        loadStreamingScheduler(),
      ]);
    this.detachStreamingCloud();
    // Fade-in is enabled on desktop/mid+ profiles only; mobile and
    // low-tier sessions skip it to preserve frame-budget headroom.
    const fadeIn = !isMobile && quality !== 'low';
    // the default colour mode comes from the source itself, not
    // from a COPC-specific helper. Both `StreamingPointCloud` (COPC) and
    // `EptStreamingPointCloud` implement `defaultColorMode()` so the
    // Viewer never peeks at format-specific metadata shapes.
    const renderer = new StreamingRenderer(
      this,
      cloud,
      cloud.defaultColorMode(),
      { fadeIn },
    );
    const scheduler = new StreamingScheduler(
      cloud,
      decoder,
      {
        onNodeReady: (node, decoded) => {
          renderer.onNodeReady(node, decoded);
          // DISPLAY-ONLY class legend hook — hand the host the node's decoded
          // per-point classification so the legend can fold its histogram in.
          // A DecodedChunk always carries a `classification` array (zero-filled
          // when the source lacked the field). Pure read; never touches the GPU
          // mask path above.
          if (this.onStreamingNodeClasses && decoded.classification) {
            try {
              this.onStreamingNodeClasses(decoded.classification);
            } catch {
              /* a legend refresh must never break the streaming pipeline */
            }
          }
          // Geometry-level node-ready hook — lets the host re-route the scan
          // type as the cloud fills in. Guarded so a host throw can't break
          // streaming.
          if (this.onStreamingNodeReady) {
            try { this.onStreamingNodeReady(); }
            catch { /* a re-route must never break the streaming pipeline */ }
          }
          if (benchmark) {
            benchmark.recordFirstPaint();
            benchmark.recordNodeReady(node.record.id);
            // Position bytes are a stable proxy for "decoded points" volume.
            benchmark.recordDecodedBytes(decoded.positions.byteLength);
          }
        },
        onNodeEvicted: (node) => {
          renderer.onNodeEvicted(node);
          benchmark?.recordNodeEvicted(node.record.id);
        },
        onTick: benchmark ? (ms) => benchmark.recordSchedulerTick(ms) : undefined,
      },
      streamingBudgets(quality, isMobile),
    );
    this._streaming = { cloud, scheduler, renderer, decoder, benchmark: benchmark ?? null };
    this._streamingFrame = 0;
    this._configureForStreaming(cloud);
  }

  /** Detach and fully dispose the current streaming cloud, if any. */
  detachStreamingCloud(): void {
    if (!this._streaming) return;
    this._streaming.scheduler.stop();
    this._streaming.renderer.dispose();
    // Release the source's underlying reader (COPC file handle / range source)
    // so it doesn't outlive the detach. close() is async and may reject if the
    // reader is already gone; detach is synchronous and best-effort, so fire it
    // and swallow the rejection rather than block teardown.
    void this._streaming.cloud.close?.().catch(() => {});
    this._streaming = null;
    this._lastStreamingCenter = null;
    // Recompute the orbit-clamp envelope from whatever static clouds remain
    // (if any). Without this, the clamp would still reference the streaming
    // cloud's bounds after detach.
    this._orbitClampAabb = this._visibleCloudAabb();
    if (this._clouds.size === 0) this._nav.setHasCloud(false);
  }

  /** Whether a streaming COPC cloud is currently open. */
  get hasStreamingCloud(): boolean {
    return this._streaming !== null;
  }

  /**
   * The open streaming cloud, or null. Widens this from the
   * COPC-specific `StreamingPointCloud` to the format-agnostic
   * `StreamingSource` so callers can read off the common surface
   * (`name`, `sourcePointCount`, `crs()`, `defaultColorMode()`, etc.)
   * regardless of whether COPC or EPT is open. Callers that need
   * COPC-specific shape can narrow with `cloud.kind === 'copc'`.
   */
  get streamingCloud(): StreamingSource | null {
    return this._streaming?.cloud ?? null;
  }

  /** The streaming scheduler, or null — for the streaming panel and diagnostics. */
  get streamingScheduler(): StreamingScheduler | null {
    return this._streaming?.scheduler ?? null;
  }

  /**
   * The chunk decoder for the active streaming session, or null. Exposed so the
   * full-cloud grade can re-decode a sampling plan through the same decoder the
   * scheduler drives (one worker pool, not two).
   */
  get streamingDecoder(): ChunkDecoder | null {
    return this._streaming?.decoder ?? null;
  }

  /** Switch the streaming cloud's colour mode. */
  setStreamingColorMode(mode: ColorMode): void {
    this._streaming?.renderer.setColorMode(mode);
  }

  /** Apply a new streaming quality preset (point/concurrency budgets). */
  setStreamingQuality(quality: StreamingQuality, isMobile: boolean): void {
    this._streaming?.scheduler.setBudgets(streamingBudgets(quality, isMobile));
  }

  /** Pause streaming — no new nodes load. */
  pauseStreaming(): void {
    this._streaming?.scheduler.pause();
  }

  /** Resume streaming. */
  resumeStreaming(): void {
    this._streaming?.scheduler.resume();
  }

  /** Drop the streaming compressed-chunk cache. */
  clearStreamingCache(): void {
    this._streaming?.scheduler.clearCache();
  }

  /** Configure navigation and clip planes for a streaming cloud's extent. */
  private _configureForStreaming(cloud: StreamingSource): void {
    // COPC + EPT are both LAS-derived (EPT writes binary tiles via LAS
    // conventions) — always Z-up.
    this._worldUp.set(0, 0, 1);
    this._nav.setWorldUp(this._worldUp);

    const b = cloud.localBounds();
    const size = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || 100;
    this._nav.setBaseSpeed(speedForSize(size));
    this._nav.setHasCloud(true);

    // Near pinned at 1 cm so zoom-in is unbounded on streaming COPC / EPT
    // tiles regardless of cloud size — matches the static-load behaviour
    // above. Far still scales with the tile so a coarse fly-around frames.
    this._camera.near = 0.01;
    this._camera.far = Math.max(size * 16, 1000);
    this._camera.updateProjectionMatrix();
    this._edlNear.value = this._camera.near;
    this._edlFar.value = this._camera.far;

    const radius = size / 2 || 1;
    const fovRad = THREE.MathUtils.degToRad(this._camera.fov);
    this._attnRef.value = (radius / Math.sin(fovRad / 2)) * 1.2;
    this._applyOrbitBounds(radius);

    this._measure.setContext({ worldUp: [0, 0, 1], origin: cloud.renderOrigin });
    // Initial streaming orbit pivot = metadata bounds centre. Bounds rarely
    // shift after this (COPC carries the full extent in its header) — when
    // they do, the per-frame refinement lerps the pivot toward the new
    // centre without snapping.
    this._initOrbitCenterFromVisibleClouds();
    this._lastStreamingCenter = this._orbitClampAabb
      ? aabbCenter(this._orbitClampAabb)
      : null;

    // density estimate for streaming clouds. Total source point
    // count over the XY footprint — for COPC/EPT this is the full tile's
    // density, not the per-frame resident point count. Feeds adaptive EDL.
    const w = b[3] - b[0];
    const d = b[4] - b[1];
    const footprint = Math.max(1, w * d);
    this._currentDensityPtsPerM2 = cloud.sourcePointCount / footprint;
  }

  /**
   * the currently-active colour mode across the whole
   * scene. Used by the .olvsession exporter to round-trip the user's last
   * Color-by selection. Mirrors the export adapter's `currentColorMode()`
   * dispatch: streaming cloud takes priority, then the first static cloud,
   * then the runtime default.
   */
  activeColorMode(): ColorMode {
    if (this._streaming) return this._streaming.renderer.colorMode;
    const first = this._clouds.values().next().value;
    return first ? first.mode : 'rgb';
  }

  /**
   * Remove a previously added cloud from the scene and free its GPU resources.
   */
  removeCloud(id: string): void {
    const entry = this._clouds.get(id);
    if (!entry) return;
    this._scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.material.dispose();
    this._clouds.delete(id);
    // Drop the per-cloud undo / highlight snapshots too — without this the
    // maps retain full-size buffers for every cloud ever removed (leak).
    this._classHistory.delete(id);
    this._classEpochs.forget(id);
    this._selectionSnapshots.delete(id);
    // Refresh the orbit-clamp envelope so removing the last static cloud
    // doesn't leave the camera clamping to its ghost bounds.
    this._orbitClampAabb = this._visibleCloudAabb();
    if (this._clouds.size === 0) this._nav.setHasCloud(false);
  }

  /** Return an array of all currently loaded cloud IDs. */
  clouds(): string[] {
    return [...this._clouds.keys()];
  }

  /**
   * Gather a flattened (x,y,z interleaved) positions buffer from all
   * loaded static clouds plus resident streaming nodes, for terrain
   * analysis. Optionally strided down to at most `maxPoints` so a
   * multi-million-point cloud can be analysed synchronously without
   * freezing the UI; the stride is honest because the resulting coverage
   * and confidence reflect exactly the points passed in. Returns null
   * when nothing is loaded. v0.4.0.
   */
  gatherTerrainPositions(
    maxPoints = 300_000,
  ): {
    positions: Float32Array;
    classification?: Uint8Array;
    residentOnly: boolean;
    sampled: boolean;
    totalPoints: number;
    /**
     * `'z'` when every contributing source is z-up BY SPEC (LAS/LAZ/XYZ/E57/…
     * statics, COPC/EPT streams) so scan-shape detection can skip its up-axis
     * guess; `undefined` when any phone-scan format (PLY/OBJ/glTF) contributes
     * and the frame is genuinely ambiguous. v0.4.5 — see scanShape.ts header.
     */
    verticalAxisHint?: 'z';
  } | null {
    // Track each buffer's classification alongside it (when the cloud carries
    // an index-aligned class channel) so terrain analysis can drop vegetation
    // and buildings before contouring.
    const buffers: Array<{ pos: Float32Array; cls?: ArrayLike<number> }> = [];
    let staticPoints = 0;
    let streamingPoints = 0;
    let anyClass = false;
    const staticFormats: SourceFormat[] = [];
    const alignedClass = (
      cls: ArrayLike<number> | null | undefined,
      pos: Float32Array,
    ): ArrayLike<number> | undefined =>
      cls && cls.length === pos.length / 3 ? cls : undefined;
    for (const { cloud } of this._clouds.values()) {
      if (cloud.positions && cloud.positions.length > 0) {
        const cls = alignedClass(cloud.classification, cloud.positions);
        if (cls) anyClass = true;
        buffers.push({ pos: cloud.positions, cls });
        staticPoints += cloud.positions.length / 3;
        staticFormats.push(cloud.sourceFormat);
      }
    }
    for (const { decoded } of this._streamingPickData.values()) {
      if (decoded.positions && decoded.positions.length > 0) {
        const cls = alignedClass(decoded.classification, decoded.positions);
        if (cls) anyClass = true;
        buffers.push({ pos: decoded.positions, cls });
        streamingPoints += decoded.positions.length / 3;
      }
    }
    const totalPoints = staticPoints + streamingPoints;
    if (totalPoints === 0) return null;

    // Stride DURING the walk so a multi-million-point cloud is never fully
    // copied into one giant intermediate buffer (that allocation could
    // OOM). Non-finite points are skipped. The global counter `gi` keeps
    // the stride consistent across buffer boundaries.
    const stride = Math.max(1, Math.ceil(totalPoints / maxPoints));
    const cap = Math.ceil(totalPoints / stride);
    const positions = new Float32Array(cap * 3);
    // 255 = "no class channel" sentinel; terrain treats it as "keep".
    const classification = anyClass ? new Uint8Array(cap).fill(255) : undefined;
    let gi = 0;
    let oi = 0;
    for (const { pos, cls } of buffers) {
      const pts = (pos.length / 3) | 0;
      for (let i = 0; i < pts; i++, gi++) {
        if (gi % stride !== 0 || oi >= cap) continue;
        const s = i * 3;
        const x = pos[s];
        const y = pos[s + 1];
        const z = pos[s + 2];
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          positions[oi * 3] = x;
          positions[oi * 3 + 1] = y;
          positions[oi * 3 + 2] = z;
          if (classification && cls) classification[oi] = cls[i];
          oi++;
        }
      }
    }
    if (oi === 0) return null;
    // `residentOnly` means a PARTIAL stream — only some octree nodes are
    // resident, so the surface assessment must stay a "Preview". Previously
    // this was hard-wired true for ANY streaming scan, so a fully-streamed COPC
    // could NEVER earn a real grade. Now it reflects actual coverage: once every
    // known octree node is resident (the working set spans the whole cloud), the
    // sample is spatially complete and the analysis reports full coverage. A
    // stride is still applied (`sampled`), but that's a representative subsample
    // of the WHOLE extent, not a partial one.
    let residentOnly = streamingPoints > 0 && staticPoints === 0;
    if (residentOnly && this._streaming) {
      const totalNodes = this._streaming.cloud.octree.nodes().length;
      if (totalNodes > 0 && this._streamingPickData.size >= totalNodes) residentOnly = false;
    }
    return {
      positions: oi * 3 === positions.length ? positions : positions.subarray(0, oi * 3),
      classification: classification ? (oi === cap ? classification : classification.subarray(0, oi)) : undefined,
      residentOnly,
      sampled: stride > 1,
      totalPoints,
      verticalAxisHint: verticalAxisHintForSources(staticFormats, streamingPoints > 0),
    };
  }

  /**
   * Total resident point count — streaming nodes currently decoded, or every
   * loaded point for static clouds. Cheap (no buffer walk): used to gate a
   * debounced scan-type re-route so it only fires once the cloud has filled in
   * materially. v0.4.2.
   */
  residentPointTotal(): number {
    if (this._streaming) return this._streaming.cloud.residentPointCount;
    let total = 0;
    for (const { cloud } of this._clouds.values()) total += cloud.pointCount;
    return total;
  }

  /** Show or hide a cloud. */
  setCloudVisible(id: string, visible: boolean): void {
    const entry = this._clouds.get(id);
    if (entry) entry.mesh.visible = visible;
  }

  /**
   * Apply (or clear) an axis-aligned clip box. The keep/cull decision is the
   * pure {@link clipKeepsPoint} contract; here it is realised on the GPU via
   * three.js clipping planes — six inward planes intersected for keep-inside,
   * six outward planes unioned (`clipIntersection`) for keep-outside. The box is
   * in render-local space, the same frame as the measurement geometry it reuses.
   * Pass `null` or a disabled clip to render everything again.
   *
   * NOTE: the GPU result needs a device to verify; the kept-count
   * ({@link clipKeptCount}) and clip state are exact and testable without one.
   */
  setClip(clip: ClipBox | null): void {
    this._clip = clip;
    const active = clip?.enabled === true;
    // `localClippingEnabled` is a WebGLRenderer flag not yet typed on
    // WebGPURenderer; set it through a guarded cast so it takes effect on the
    // WebGL-2 fallback and on any WebGPU build that honours it. The in-viewport
    // clip is the piece to confirm on a device; the kept-count is exact either way.
    (this._renderer as unknown as { localClippingEnabled?: boolean }).localClippingEnabled = active;
    const planes = active ? clipBoxPlanes(clip) : null;
    const intersection = active && clip.mode === 'keep-outside';
    const apply = (m: THREE.PointsNodeMaterial): void => {
      m.clippingPlanes = planes;
      m.clipIntersection = intersection;
      m.needsUpdate = true;
    };
    for (const entry of this._clouds.values()) apply(entry.material);
    for (const m of this._streamingMaterials()) apply(m);
    this._bumpRenderActivity();
  }

  /** The active clip box, or null when none is set. */
  getClip(): ClipBox | null {
    return this._clip;
  }

  /** Live "kept of total" point count for the active clip against a cloud (CPU, exact). */
  clipKeptCount(id: string): { kept: number; total: number } | null {
    const entry = this._clouds.get(id);
    if (!entry) return null;
    const total = (entry.cloud.positions.length / 3) | 0;
    const kept = this._clip ? countKept(this._clip, entry.cloud.positions) : total;
    return { kept, total };
  }

  /** Exclude (or re-include) a cloud from picking / measuring / inspecting. */
  setCloudLocked(id: string, locked: boolean): void {
    const entry = this._clouds.get(id);
    if (entry) entry.locked = locked;
  }

  /** Whether a cloud is currently locked out of picking. */
  isCloudLocked(id: string): boolean {
    return this._clouds.get(id)?.locked === true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Colour mode & point size
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * v0.3.7 final-polish — symmetric percentile trim for the elevation
   * colour mode. 5 = 5th / 95th percentile (default). 0 = true min/max.
   * 25 = 25 / 75 percentile (very tight, dramatic gradient).
   */
  private _heightPercentileTrim = 5;

  /**
   * The DTM-confidence grid the `'coverage'` and `'confidence'` colour modes
   * sample, stored after a terrain analysis lands (mirrors how other
   * post-analysis state is kept on the Viewer). Null until the first analysis
   * runs; both trust-overlay colour buttons stay disabled while it is null.
   * Cleared on reset / new scan.
   */
  private _coverageGrid: CoverageColorGrid | null = null;

  /**
   * Adopt (or clear) the DTM-confidence grid that the `'coverage'` and
   * `'confidence'` colour modes sample. Called when a terrain analysis result
   * lands. Recolours any cloud currently showing either trust overlay so it
   * reflects the fresh grid immediately.
   */
  setCoverageGrid(grid: CoverageColorGrid | null): void {
    this._coverageGrid = grid;
    for (const entry of this._clouds.values()) {
      if (entry.mode !== 'coverage' && entry.mode !== 'confidence') continue;
      const raw = colorForMode(entry.mode, entry.cloud, { coverageGrid: grid ?? undefined });
      const arr = entry.colorAttr.array as Float32Array;
      // sRGB → linear via the shared EOTF seam — a bare `/255` here would
      // double-encode and visibly pale the cloud vs the initial upload.
      writeFloatColorsInto(arr, raw);
      entry.colorAttr.needsUpdate = true;
    }
    this._bumpRenderActivity();
  }

  /**
   * True once a DTM-confidence grid exists, so the Coverage / Confidence
   * colour modes are meaningful.
   */
  hasCoverageGrid(): boolean {
    return this._coverageGrid != null;
  }

  /**
   * Cheap per-CELL summary of the confidence grid (fraction of covered cells
   * that are interpolated, and that fall in the low-confidence 'gap' band). The
   * 3D confidence overlay tints POINTS, which cluster over measured ground, so
   * it always skews high — this cell-level view is what makes the interpolated
   * share visible, and lets the UI caption the overlay honestly. Null when no
   * grid or no covered cells.
   */
  coverageGridCellSummary(): { interpFrac: number; gapFrac: number } | null {
    const g = this._coverageGrid;
    if (!g) return null;
    let covered = 0;
    let interp = 0;
    let gap = 0;
    const n = g.confidence.length;
    for (let i = 0; i < n; i++) {
      const cov = g.coverage[i];
      if (cov === 0) continue;
      covered++;
      if (cov === 1) interp++;
      if (g.confidence[i] < 33) gap++;
    }
    return covered > 0 ? { interpFrac: interp / covered, gapFrac: gap / covered } : null;
  }

  /**
   * Set the symmetric percentile trim used by the elevation colour
   * mode and reseed every cloud currently rendering in elevation
   * mode. The streaming renderer reads the trim through the same
   * `colorForMode` seam, so subsequent streaming nodes pick it up.
   */
  setHeightPercentileTrim(trim: number): void {
    const next = Math.max(0, Math.min(25, Math.round(trim)));
    if (next === this._heightPercentileTrim) return;
    this._heightPercentileTrim = next;
    for (const [id, entry] of this._clouds) {
      if (entry.mode !== 'elevation') continue;
      const raw = colorForMode('elevation', entry.cloud, {
        heightPercentileTrim: next,
        upAxis: isZUpFormat(entry.cloud.sourceFormat) ? 2 : 1,
      });
      const arr = entry.colorAttr.array as Float32Array;
      // sRGB → linear via the shared EOTF seam (see colorEncode.ts).
      writeFloatColorsInto(arr, raw);
      entry.colorAttr.needsUpdate = true;
      void id; // silence the unused-binding lint
    }
  }

  /** Read the current percentile-trim setting. */
  get heightPercentileTrim(): number {
    return this._heightPercentileTrim;
  }

  // ── Visuals Studio — Visuals Studio state ─────────────────────────────
  /**
   * Active RGB appearance settings. Defaults to the identity bundle so
   * a session that never opens Visuals Studio renders the cloud
   * exactly as v0.3.7 did.
   */
  private _rgbAppearance: RgbAppearance = { ...IDENTITY_RGB_APPEARANCE };
  /**
   * Active RGB appearance preset id — the Inspector reads this to
   * highlight the right chip. `null` when the user has dragged a
   * slider into a custom configuration.
   */
  private _rgbAppearancePresetId: RgbAppearancePresetId | null = 'natural';
  /** Active sky preset id (the v0.3.7 catalogue). */
  private _skyPresetId: SkyPresetId = 'deep';
  /** Active EDL preset id, or `null` when EDL is disabled. */
  private _edlPresetId: EdlPresetId | null = 'balanced';
  /**
   * Trailing-edge throttle state for `_reapplyRgbAppearanceToAllRgbClouds`.
   *
   * White-balance sliders fire `input` events at ~60 Hz during a drag,
   * and each call walks every static + every resident streaming node,
   * re-uploading colour buffers. Even with the reusable buffers in
   * `streamingNodeColors`, that's tens of millions of operations per
   * drag — enough to hitch the renderer on a streaming cloud.
   *
   * The throttle keeps the trailing call so the final slider position
   * is always honoured; intermediate ticks during a fast drag are
   * coalesced into the next ~80 ms window.
   */
  private _recolorThrottleHandle: ReturnType<typeof setTimeout> | null = null;
  private _recolorThrottlePending = false;
  private static readonly _RECOLOR_THROTTLE_MS = 80;

  /**
   * Active splat mode. Defaults to Classic — the v0.3.7 baseline behavior
   * — because Soft and Inspection both force `alphaToCoverage` on every
   * material, and on a streaming COPC cloud with hundreds of resident
   * nodes that cost is non-trivial. Soft is a one-click opt-in via the
   * Splat-mode chip rail; users with the headroom pick it consciously.
   * Future tier-driven default can promote this for proven
   * high-tier devices once the FPS-feedback seam is wired and measured.
   */
  private _splatMode: SplatMode = 'classic';
  /**
   * Last known "is phone" state from the device-aware sky path. Used by
   * `_onResize` to skip the sky re-apply unless the breakpoint actually
   * crossed — every resize tick used to re-do CSS string work + a
   * `new THREE.Color` instantiation. `null` until the first sky apply.
   */
  private _lastSkyIsPhone: boolean | null = null;
  /**
   * Saved per-cloud colour snapshots — populated by
   * `setSelectionHighlight` so `clearSelectionHighlight` can revert
   * to the exact bytes the cloud carried before the highlight
   * landed. Keyed by static-cloud id; cleared on `clearSelectionHighlight`.
   */
  private readonly _selectionSnapshots = new Map<
    string,
    { indices: readonly number[]; saved: Float32Array }
  >();

  /**
   * Apply an RGB appearance bundle to every RGB-mode cloud in place.
   * Source colours come from `cloud.colors` (sRGB Uint8 the loader
   * recorded); the bundle's gamma / contrast / saturation maths runs in
   * sRGB space so the sliders feel like Lightroom / Photoshop. After
   * the appearance is applied, the result is linearised via the same
   * piecewise sRGB EOTF that `toFloatColors` uses, then uploaded. The
   * v0.3.7 sRGB-correct round trip is preserved.
   */
  setRgbAppearance(settings: Readonly<RgbAppearance>): void {
    this._rgbAppearance = { ...settings };
    this._rgbAppearancePresetId = null; // custom — let the Inspector
    // call `applyRgbAppearancePreset(id)` instead to keep the chip
    // highlight in sync.
    // Touching an RGB-only control implies the user wants to see the
    // result — silently switch into RGB colour mode for any cloud
    // that can serve it.
    this._ensureRgbColorMode();
    this._scheduleReapplyRgbAppearance();
  }

  /** Apply a named RGB appearance preset and keep the chip highlight in sync. */
  applyRgbAppearancePreset(id: RgbAppearancePresetId): void {
    const preset = getRgbAppearancePreset(id);
    this._rgbAppearance = { ...preset.settings };
    this._rgbAppearancePresetId = preset.id;
    this._ensureRgbColorMode();
    // Preset clicks are infrequent — flush immediately so the user sees
    // the colour change without the throttle's trailing-edge delay.
    this._flushReapplyRgbAppearance();
  }

  /**
   * Auto-switch every cloud that carries RGB data into RGB colour
   * mode. Called from `setRgbAppearance` / `applyRgbAppearancePreset`
   * so the Visuals Studio RGB chips and white-balance sliders are
   * never silent no-ops because the user happened to be in Intensity
   * or Elevation mode at the time. Clouds without RGB data are
   * untouched — their current mode is the only thing that makes
   * sense for them.
   */
  private _ensureRgbColorMode(): void {
    for (const [id, entry] of this._clouds) {
      if (entry.mode === 'rgb') continue;
      const u8 = entry.cloud.colors;
      if (!u8 || u8.length === 0) continue;
      this.setColorMode(id, 'rgb');
    }
    if (this._streaming) {
      // Streaming source exposes whether it has RGB via its
      // `defaultColorMode` (returns 'rgb' iff the format carries it).
      // We don't have a separate `hasRgb` accessor on the source, so
      // use the default mode as the proxy: if the cloud's default is
      // 'rgb' the format supports it.
      const defaultMode = this._streaming.cloud.defaultColorMode();
      if (defaultMode === 'rgb' && this._streaming.renderer.colorMode !== 'rgb') {
        this._streaming.renderer.setColorMode('rgb');
      }
    }
  }

  /** The active RGB appearance bundle (deep copy). */
  get rgbAppearance(): RgbAppearance {
    return { ...this._rgbAppearance };
  }

  /** The active RGB appearance preset id, or `null` when custom. */
  get rgbAppearancePresetId(): RgbAppearancePresetId | null {
    return this._rgbAppearancePresetId;
  }

  /**
   * Apply a sky preset by id. Public surface of the existing private
   * `_applySkyPreset`. Stores the active id so session persistence can
   * round-trip the choice.
   */
  setSky(preset: SkyPresetId): void {
    this._skyPresetId = preset;
    this._applySkyPreset(preset);
  }

  /** The active sky preset id. */
  get skyPresetId(): SkyPresetId {
    return this._skyPresetId;
  }

  /**
   * Apply a named EDL preset bundle (Subtle / Balanced / Inspection)
   * or disable EDL entirely when `null` is passed (the "Off" chip).
   * Bundles strength + (eventually) radius into one call.
   */
  setEdlPreset(id: EdlPresetId | null): void {
    if (id === null) {
      this._edlPresetId = null;
      this.setEdlEnabled(false);
      return;
    }
    const preset = getEdlPreset(id);
    this._edlPresetId = preset.id;
    this.setEdlEnabled(true);
    this.setEdlStrength(preset.strength);
  }

  /** The active EDL preset id, or `null` when EDL is off. */
  get edlPresetId(): EdlPresetId | null {
    return this._edlPresetId;
  }

  /**
   * Set the splat rendering mode.
   *
   * Each mode bundles two things:
   *   - A per-mode size multiplier applied at material-push time via
   *     `setPointSize` (Classic = 1×, Soft = 1.5×, Inspection = 2×).
   *     The user-entered point size stays meaningful; the rendered
   *     sprite is what scales.
   *   - A force-on for `alphaToCoverage`. Soft and Inspection both
   *     require the smooth circular rim to read as a continuous
   *     surface; Classic respects the user's antialiasing setting.
   *
   * Cheap — no shader rebuild, no geometry change. Safe to call
   * inside the render loop or the adaptive-degradation seam.
   */
  setSplatMode(mode: SplatMode): void {
    if (this._splatMode === mode) return;
    this._splatMode = mode;
    // P13 — flip the shared opacity-node uniform so every material renders the
    // Gaussian kernel (1) or the rim mask (0). No material rebuild required.
    this._gaussianOpacityFactor.value = mode === 'gaussian' ? 1 : 0;
    // Re-push the user's point size so the new multiplier lands.
    this.setPointSize(this._pointSize);
    // Force AA on for Soft / Inspection; restore the user's setting
    // when stepping back to Classic. Skip the shader-rebuild flag
    // for any material that already has the right value.
    const forceAa = splatForcesAlphaToCoverage(mode);
    const targetAa = forceAa ? true : this._antialiasing;
    for (const { material } of this._clouds.values()) {
      if (material.alphaToCoverage === targetAa) continue;
      material.alphaToCoverage = targetAa;
      material.needsUpdate = true;
    }
    for (const material of this._streamingMaterials()) {
      if (material.alphaToCoverage === targetAa) continue;
      material.alphaToCoverage = targetAa;
      material.needsUpdate = true;
    }
  }

  /** The active splat mode. */
  get splatMode(): SplatMode {
    return this._splatMode;
  }

  /**
   * Walk every RGB-mode static cloud and re-upload its colour attribute
   * with the active RGB appearance applied. Streaming clouds re-pick
   * up the appearance on the next node decode via the same colour
   * pipeline. NaN-safe; an empty colour buffer is a no-op.
   */
  /**
   * Trailing-edge schedule. The first call after a quiet period runs
   * immediately so a single click feels instant; subsequent calls
   * within the throttle window are coalesced into a single trailing
   * call. White-balance drags hit this path.
   */
  private _scheduleReapplyRgbAppearance(): void {
    if (this._recolorThrottleHandle === null) {
      // Leading edge — run now.
      this._doReapplyRgbAppearance();
      this._recolorThrottleHandle = setTimeout(() => {
        this._recolorThrottleHandle = null;
        if (this._recolorThrottlePending) {
          this._recolorThrottlePending = false;
          this._scheduleReapplyRgbAppearance();
        }
      }, Viewer._RECOLOR_THROTTLE_MS);
      return;
    }
    // Inside the window — mark a trailing call.
    this._recolorThrottlePending = true;
  }

  /**
   * Bypass the throttle and apply immediately. Used by preset chip
   * clicks (infrequent, the user expects instant feedback) and any
   * caller that wants the change visible on the next frame.
   */
  private _flushReapplyRgbAppearance(): void {
    if (this._recolorThrottleHandle !== null) {
      clearTimeout(this._recolorThrottleHandle);
      this._recolorThrottleHandle = null;
      this._recolorThrottlePending = false;
    }
    this._doReapplyRgbAppearance();
  }

  private _doReapplyRgbAppearance(): void {
    // Push the appearance into the streaming renderer first so resident
    // streaming nodes recolour synchronously, then walk the static
    // clouds. Both surfaces end up with the same `_rgbAppearance`.
    if (this._streaming) {
      this._streaming.renderer.setRgbAppearance(this._rgbAppearance);
    }
    for (const [, entry] of this._clouds) {
      if (entry.mode !== 'rgb') continue;
      const u8 = entry.cloud.colors;
      if (!u8 || u8.length === 0) continue;
      const arr = entry.colorAttr.array as Float32Array;
      const n = u8.length;
      // Reuse a persistent per-cloud scratch buffer instead of allocating
      // a fresh `Float32Array(n)` on every (throttled) recolor — a
      // white-balance drag fires this ~12×/sec on multi-MB clouds. Grow
      // only if the colour length ever exceeds the cached buffer; a `subarray`
      // view keeps the per-call math operating on exactly `n` elements.
      let scratch = entry.recolorScratch;
      if (!scratch || scratch.length < n) {
        scratch = new Float32Array(n);
        entry.recolorScratch = scratch;
      }
      const srgb = scratch.length === n ? scratch : scratch.subarray(0, n);
      // Step 1: copy sRGB-encoded bytes → sRGB Float32 [0, 1].
      for (let i = 0; i < n; i++) srgb[i] = u8[i] / 255;
      // Step 2: apply the appearance bundle in sRGB space.
      applyRgbAppearance(srgb, this._rgbAppearance);
      // Step 3: linearise via the piecewise sRGB EOTF — same maths as
      // `writeFloatColorsInto` (colorEncode.ts), kept inline because the
      // source here is already FLOAT sRGB (post-appearance), not Uint8.
      for (let i = 0; i < n; i++) {
        const v = srgb[i];
        arr[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      }
      entry.colorAttr.needsUpdate = true;
    }
  }

  /**
   * Swap a cloud's colour mode by rewriting its instanced colour attribute
   * in place — the geometry, material, and draw call are all reused.
   */
  setColorMode(id: string, mode: ColorMode): void {
    const entry = this._clouds.get(id);
    if (!entry) return;
    if (entry.mode === mode) return;

    const raw = colorForMode(mode, entry.cloud, {
      heightPercentileTrim: this._heightPercentileTrim,
      coverageGrid: this._coverageGrid ?? undefined,
      upAxis: isZUpFormat(entry.cloud.sourceFormat) ? 2 : 1,
    });
    const arr = entry.colorAttr.array as Float32Array;
    // sRGB → linear via the shared EOTF seam — keeps a mode switch
    // byte-identical to what the initial `toFloatColors` upload produced.
    writeFloatColorsInto(arr, raw);
    entry.colorAttr.needsUpdate = true;
    entry.mode = mode;
    // Color buffer just changed — make sure the idle-render throttle
    // doesn't swallow the next frame so the user sees the new colours.
    this._bumpRenderActivity();
  }

  /**
   * Public hook for callers outside the Viewer that change scene
   * state without going through a pointer/keyboard path (preset
   * application, theme swap, embed-bridge command, etc.). Bumps the
   * idle-render throttle so the next few frames render at full rate
   * without the caller having to know about the throttle.
   */
  requestFrame(): void {
    this._bumpRenderActivity();
  }

  // ── B.3 — classification editor ─────────────────────────────────────────
  /**
   * Per-cloud snapshot of the classification buffer taken before the last
   * mutation. Indexed by cloud id. `undoClassification()` reads from here.
   * One snapshot per cloud — repeated edits coalesce: undo always returns
   * to the state before the FIRST unconfirmed edit, which matches the
   * undo semantics for the measurement tools.
   */
  /** Per-cloud multi-step classification undo/redo history (delta-based). */
  private readonly _classHistory = new Map<string, ClassEditHistory>();

  /** Per-cloud edit epochs so stale analysis/grade/exports can be detected. */
  private readonly _classEpochs = new ClassificationEpochs();

  /**
   * Fires after any classification edit (swap / reclassify / undo / redo) that
   * actually changed points, with the cloud id. The host subscribes to
   * invalidate the terrain-core cache AND flag any on-screen analysis result
   * as stale (it reflects the previous classification until the user re-runs
   * Analyse) — so a manual edit is never silently presented as current.
   */
  onClassificationEdited?: (id: string) => void;

  private _historyFor(id: string): ClassEditHistory {
    let h = this._classHistory.get(id);
    if (!h) {
      h = new ClassEditHistory();
      this._classHistory.set(id, h);
    }
    return h;
  }

  private _markClassificationEdited(id: string): void {
    this._classEpochs.bump(id);
    this.onClassificationEdited?.(id);
  }

  /** The cloud's classification edit epoch (0 = never edited). */
  classificationEpoch(id: string): number {
    return this._classEpochs.current(id);
  }

  /** Whether a result stamped at `epoch` was invalidated by a later edit. */
  isClassificationStale(id: string, epoch: number): boolean {
    return this._classEpochs.isStale(id, epoch);
  }

  /**
   * Globally rewrite every point whose classification is `fromClass` to
   * `toClass`, then refresh the rendered colours if the cloud is showing
   * its classification mode. Returns the change summary (count, etc.).
   * No-op when the cloud doesn't carry classification data.
   */
  swapClassification(id: string, fromClass: number, toClass: number): ClassEditResult {
    const entry = this._clouds.get(id);
    if (!entry || !entry.cloud.classification) {
      return { changedCount: 0, pointCount: 0 };
    }
    const buf = entry.cloud.classification;
    // Record the edit as a delta so it can be undone independently of any
    // prior edit (real multi-step history, not a single coalesced snapshot).
    let result: ClassEditResult = { changedCount: 0, pointCount: buf.length };
    recordEdit(this._historyFor(id), buf, () => {
      result = applyClassSwap(buf, fromClass, toClass);
    });
    if (result.changedCount > 0) {
      this._refreshClassificationColours(id);
      this._markClassificationEdited(id);
    }
    return result;
  }

  /**
   * Re-classify every point whose horizontal projection falls inside the
   * given polygon to `newClass`. Polygon vertices are in local render
   * space. Returns the change summary. No-op when the cloud doesn't
   * carry classification data or the polygon is under-defined.
   */
  /**
   * Edit per-point classification in place inside a polygon. NOTE for whoever
   * wires this to a UI tool: an in-place class edit changes the bare-earth
   * surface, but the terrain-core cache keys classification by a SAMPLED hash —
   * a small edit can miss every sample and serve a stale core on the next
   * Analyse. The wiring MUST call `clearTerrainCoreCache()` (or the runner's
   * reset) after a successful edit / undo so the next analysis recomputes.
   * There is no live caller yet, so this is a precondition, not a current bug.
   */
  reclassifyInPolygon(
    id: string,
    polygon: ReadonlyArray<[number, number, number]>,
    newClass: number,
    includeIf?: (currentClass: number) => boolean,
  ): ClassEditResult {
    const entry = this._clouds.get(id);
    if (!entry || !entry.cloud.classification) {
      return { changedCount: 0, pointCount: 0 };
    }
    const buf = entry.cloud.classification;
    let result: ClassEditResult = { changedCount: 0, pointCount: buf.length };
    recordEdit(this._historyFor(id), buf, () => {
      result = applyPolygonReclassify({
        classification: buf,
        positions: entry.cloud.positions,
        polygon,
        newClass,
        includeIf,
      });
    });
    if (result.changedCount > 0) {
      this._refreshClassificationColours(id);
      this._markClassificationEdited(id);
    }
    return result;
  }

  /**
   * Reclassify every point inside the screen-space lasso to `newClass`,
   * recording the edit for undo/redo and bumping the edit epoch. Mirrors the
   * lasso volume selection (same projector + {@link selectByLasso}) but sets
   * classes instead of integrating volume. No-op without classification, a
   * degenerate lasso, or a zero-size canvas. `lasso` is in CSS pixels.
   */
  reclassifyLasso(
    id: string,
    lasso: ReadonlyArray<{ readonly x: number; readonly y: number }>,
    newClass: number,
  ): ClassEditResult {
    const entry = this._clouds.get(id);
    if (!entry || !entry.cloud.classification || lasso.length < 3) {
      return { changedCount: 0, pointCount: 0 };
    }
    const canvas = this._canvas;
    if (!canvas) return { changedCount: 0, pointCount: 0 };
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return { changedCount: 0, pointCount: 0 };
    this._camera.updateMatrixWorld(true);
    const projMatrix = this._camera.projectionMatrix;
    const viewMatrix = this._camera.matrixWorldInverse;
    const tmp = new THREE.Vector3();
    const project = (x: number, y: number, z: number): { x: number; y: number } | null => {
      tmp.set(x, y, z).applyMatrix4(viewMatrix).applyMatrix4(projMatrix);
      if (tmp.z < -1 || tmp.z > 1) return null;
      return { x: (tmp.x * 0.5 + 0.5) * w, y: (1 - (tmp.y * 0.5 + 0.5)) * h };
    };
    const indices = selectByLasso({ lasso, positions: entry.cloud.positions, project });
    // An EDIT must only touch points the user can currently see. The lasso
    // projector already drops points behind the camera, but not points hidden
    // by the clip box or the class-visibility filter — the raw selection
    // permanently rewrote invisible points (reclassify-invisible-points
    // finding, Critical). Apply the same visibility rules click-picking
    // enforces: the pure `clipKeepsPoint` contract the GPU clip planes
    // realise, and the `_classPickAccept` mask, so screen and edit agree
    // point-for-point. In-place filter — no extra allocation on the hot path.
    const clip = this._clip;
    filterSelectionToVisible(indices, entry.cloud.positions, {
      keepPoint: clip?.enabled
        ? (x, y, z) => clipKeepsPoint(clip, [x, y, z])
        : undefined,
      acceptIndex: this._classPickAccept(entry.cloud.classification),
    });
    const buf = entry.cloud.classification;
    let result: ClassEditResult = { changedCount: 0, pointCount: buf.length };
    recordEdit(this._historyFor(id), buf, () => {
      result = applyIndexReclassify(buf, indices, newClass);
    });
    if (result.changedCount > 0) {
      this._refreshClassificationColours(id);
      this._markClassificationEdited(id);
    }
    return result;
  }

  /**
   * Undo the most recent classification edit on this cloud. Returns true on
   * success, false when there's nothing to undo. Steps back one edit at a
   * time; a subsequent {@link redoClassification} re-applies it.
   */
  undoClassification(id: string): boolean {
    const entry = this._clouds.get(id);
    const h = this._classHistory.get(id);
    if (!entry || !entry.cloud.classification || !h || !h.canUndo) return false;
    h.undo(entry.cloud.classification);
    this._refreshClassificationColours(id);
    this._markClassificationEdited(id);
    return true;
  }

  /**
   * Redo the most recently undone classification edit. Returns true on
   * success, false when the redo branch is empty (nothing undone, or a fresh
   * edit cleared it).
   */
  redoClassification(id: string): boolean {
    const entry = this._clouds.get(id);
    const h = this._classHistory.get(id);
    if (!entry || !entry.cloud.classification || !h || !h.canRedo) return false;
    h.redo(entry.cloud.classification);
    this._refreshClassificationColours(id);
    this._markClassificationEdited(id);
    return true;
  }

  /** Whether the cloud has a classification edit that can be undone. */
  canUndoClassification(id: string): boolean {
    return this._classHistory.get(id)?.canUndo ?? false;
  }

  /** Whether the cloud has an undone classification edit that can be redone. */
  canRedoClassification(id: string): boolean {
    return this._classHistory.get(id)?.canRedo ?? false;
  }

  /**
   * Attach a DERIVED (heuristic) classification to a cloud that had none and
   * switch it to classification colours. The codes come from the unsupervised
   * `deriveClassification` pipeline (run off-thread via `deriveClassificationAsync`).
   *
   * Display, the legend histogram, the GPU class FILTER, and export all read
   * the derived codes, so this immediately colours the cloud by class, lets the
   * legend list AND show/hide the derived classes, and flows the codes into LAS
   * export — all flagged DERIVED via `cloud.classificationIsDerived`.
   *
   * Returns false when the id is unknown; throws on a code/point length
   * mismatch (a caller bug worth surfacing, not swallowing).
   */
  applyDerivedClassification(id: string, codes: Uint8Array): boolean {
    const entry = this._clouds.get(id);
    if (!entry) return false;
    entry.cloud.attachDerivedClassification(codes);
    // Give the mesh the same GPU class-filter wiring a cloud loaded WITH
    // classification gets: an `aClass` per-instance attribute plus the
    // class-mask multiply folded into the size node. Without this the legend
    // could colour the derived classes but not hide them.
    this._attachClassAttribute(entry, codes);
    if (entry.mode === 'classification') {
      this._refreshClassificationColours(id);
    } else {
      this.setColorMode(id, 'classification');
    }
    this._bumpRenderActivity();
    return true;
  }

  /**
   * Attach (or replace) the `aClass` instanced attribute on a cloud's mesh and
   * fold the class-mask multiply into its size node — the same wiring
   * `_buildPointsMesh` does at load for a classified cloud, applied after the
   * fact for a derived classification. Idempotent: re-deriving rewrites the
   * attribute and re-applies the size mode. `material.needsUpdate` forces the
   * node graph + new attribute to recompile.
   */
  private _attachClassAttribute(entry: CloudEntry, codes: Uint8Array): void {
    const instanceCount = entry.cloud.pointCount;
    const n = Math.min(instanceCount, codes.length);
    // Re-deriving a cloud reuses the existing aClass buffer in place rather
    // than allocating a new InstancedBufferAttribute — so a re-classify never
    // orphans the previous GPU buffer. Only the first derive (no attribute yet,
    // or a length change) allocates.
    const existing = entry.mesh.geometry.getAttribute('aClass') as
      | THREE.InstancedBufferAttribute
      | undefined;
    if (existing && existing.array.length === instanceCount) {
      const arr = existing.array as Float32Array;
      for (let i = 0; i < n; i++) arr[i] = codes[i];
      existing.needsUpdate = true;
    } else {
      const classData = new Float32Array(instanceCount);
      for (let i = 0; i < n; i++) classData[i] = codes[i];
      entry.mesh.geometry.setAttribute('aClass', new THREE.InstancedBufferAttribute(classData, 1));
    }
    this._materialsWithClass.add(entry.material);
    this._applySizeMode(entry.material);
    entry.material.needsUpdate = true;
  }

  /**
   * Recompute and re-upload the colour attribute for a cloud whose
   * classification just changed. Cheap when the cloud isn't currently
   * showing classification colours — `setColorMode` short-circuits when
   * the mode is unchanged, so we force a recompute by toggling to the
   * current mode after a no-op detour.
   */
  private _refreshClassificationColours(id: string): void {
    const entry = this._clouds.get(id);
    if (!entry) return;
    // Only the classification mode reads from the mutated buffer; other
    // modes don't need a refresh. The chassification mode itself does — so
    // re-derive its colours and re-upload.
    if (entry.mode === 'classification') {
      const raw = colorForMode('classification', entry.cloud);
      const arr = entry.colorAttr.array as Float32Array;
      // sRGB → linear via the shared EOTF seam (see colorEncode.ts).
      writeFloatColorsInto(arr, raw);
      entry.colorAttr.needsUpdate = true;
    }
  }

  /**
   * Set the pixel size of all rendered points.
   * Applies to every loaded cloud's material.
   */
  setPointSize(size: number): void {
    // Clamp at the source of truth: imported share/session/preset state can hand
    // in a non-finite or pathological value (a hand-edited `.olvsession` with
    // `pointSize: 1e9` would push a giant sprite to the GPU). Bound to the same
    // [1, 8] range the preferences clamp uses; non-finite falls back to 2.
    this._pointSize = Math.min(8, Math.max(1, Number.isFinite(size) ? size : 2));
    // Splat mode applies a constant per-mode multiplier on the way to
    // the GPU. The user-displayed size stays `this._pointSize`; the rendered
    // sprite is multiplied so neighbouring samples kiss in Soft /
    // Inspection mode without changing the "5 px" the user typed in.
    const effective = this._pointSize * splatRadiusMultiplier(this._splatMode);
    this._pointSizeUniform.value = effective;
    for (const { material } of this._clouds.values()) {
      material.size = effective;
    }
    for (const material of this._streamingMaterials()) {
      material.size = effective;
    }
  }

  /** The point material of every resident streaming node mesh. */
  private *_streamingMaterials(): Generator<THREE.PointsNodeMaterial> {
    for (const mesh of this._streamingMeshes) {
      yield mesh.material as THREE.PointsNodeMaterial;
    }
  }

  /** The current base point size, in screen pixels. */
  get pointSize(): number {
    return this._pointSize;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render quality — Eye Dome Lighting, point sizing, antialiasing
  // ─────────────────────────────────────────────────────────────────────────

  /** Enable or disable Eye Dome Lighting depth shading. */
  setEdlEnabled(on: boolean): void {
    this._edlEnabled = on;
  }

  /** Whether Eye Dome Lighting is currently enabled. */
  get edlEnabled(): boolean {
    return this._edlEnabled;
  }

  /**
   * Set the base EDL strength (0 = no shading). Negative values clamp to 0.
   * The live per-frame strength is `base × adaptive_factor` — see
   * `_updateAdaptiveEdl`. The slider drives the base.
   */
  setEdlStrength(strength: number): void {
    this._edlBaseStrength = Math.max(0, strength);
    // Immediate apply for the frame — adaptive update will refine next tick.
    this._edlStrength.value = this._edlBaseStrength;
  }

  /** The current base EDL strength (what the user set). */
  get edlStrength(): number {
    return this._edlBaseStrength;
  }

  /** Switch between adaptive (distance-scaled) and fixed point sizing. */
  setPointSizeMode(mode: PointSizeMode): void {
    this._pointSizeMode = mode;
    this._reapplyAllSizeModes();
  }

  /**
   * Re-run `_applySizeMode` on every live material — static clouds and streaming
   * nodes alike — and flag them for a pipeline rebuild. Called whenever the size
   * graph's SHAPE can change: a point-size-mode switch, or a per-point filter
   * turning on or off (which adds/removes a fold, changing the compiled shader).
   * A filter merely NARROWING within an already-active window does not call this
   * — that only moves uniform values and needs no rebuild.
   */
  private _reapplyAllSizeModes(): void {
    for (const { material } of this._clouds.values()) {
      this._applySizeMode(material);
      material.needsUpdate = true;
    }
    for (const material of this._streamingMaterials()) {
      this._applySizeMode(material);
      material.needsUpdate = true;
    }
  }

  /**
   * Apply a class-visibility state to the GPU. Writes the source's 256-entry
   * mask (`1` = show, `0` = hide) into the shared `_classMaskUniform` so every
   * point material — static clouds and streaming nodes alike — collapses the
   * sprite quad of any hidden class to zero size on the next frame.
   *
   * No per-material rebuild is needed: the mask node is already wired into each
   * size graph, and the uniform array re-uploads its current values once per
   * render. We only request a frame so the idle-render throttle doesn't swallow
   * the update.
   */
  /**
   * Optional host hook fired once per streaming node as it becomes resident,
   * with that node's decoded per-point classification. DISPLAY-ONLY: lets the
   * classification legend fold late-arriving nodes into its histogram. Set to
   * `undefined` to detach. Never invoked for static clouds (the host already
   * has their full classification buffer at load time).
   */
  onStreamingNodeClasses?: (classes: Uint8Array) => void;

  /**
   * Optional host hook fired once per streaming node as it becomes resident
   * (geometry, regardless of classification). Lets the host re-evaluate cheap,
   * resolution-sensitive decisions — e.g. the scan-type routing — as a sparse
   * early cloud fills in materially. Set to `undefined` to detach.
   */
  onStreamingNodeReady?: () => void;

  /**
   * Optional host hook fired when the GPU backend reports an UNCAPTURED error —
   * the async channel WebGPU uses for shader-compile and pipeline-creation
   * failures. These happen AFTER a scan's decode + attach have already resolved
   * (the render loop is what actually builds the pipeline), so without this hook
   * such a failure is silent: the load "succeeds", progress clears, but nothing
   * paints and the user has no signal as to why. The host routes this to a
   * visible error (drop-zone toast + catalog status). Messages are de-duplicated
   * upstream — a broken pipeline re-emits the same validation error every frame.
   * Set to `undefined` to detach.
   */
  onGpuError?: (message: string) => void;

  /**
   * Distinct GPU-error messages already surfaced this session. A shader/pipeline
   * validation failure repeats every frame; we report each unique message once
   * so `onGpuError` isn't spammed and the UI toast isn't retriggered in a loop.
   */
  private readonly _seenGpuErrors = new Set<string>();

  applyClassVisibility(v: ClassVisibility): void {
    const mask = v.toMaskArray();
    // `uniformArray`'s backing JS array is what its per-render `update()` copies
    // into the padded GPU buffer — mutate it in place (don't replace it).
    const target = this._classMaskUniform.array as number[];
    let anyHidden = false;
    for (let code = 0; code < CLASS_COUNT; code++) {
      target[code] = mask[code];
      if (mask[code] !== 1) anyHidden = true;
    }
    // Cache whether any class is hidden so the pick paths skip the per-point
    // visibility predicate entirely on the all-visible hot path.
    const wasFiltered = this._classFiltered;
    this._classFiltered = anyHidden;
    // The class fold is present in the size graph only while some class is
    // hidden. Crossing the all-visible ↔ some-hidden boundary changes the graph
    // shape, so rebuild the affected pipelines. Changing WHICH classes are hidden
    // while still filtered is a uniform-only change (the mask array re-uploads).
    if (wasFiltered !== anyHidden) this._reapplyAllSizeModes();
    this._bumpRenderActivity();
  }

  /**
   * Set the elevation filter window in world/source units, or clear it with
   * `undefined`. Points whose up-axis coordinate falls outside the inclusive
   * window collapse to zero size (hidden) on the next frame; the unfiltered
   * scene is pixel-identical. The window is converted to the primary cloud's
   * attribute space (origin-shifted along the up-axis) by the pure
   * `elevationFilterUniform` core. Applies to static clouds and streaming nodes
   * alike, since both come from the shared `buildPointMesh`.
   */
  setElevationFilter(range: readonly [number, number] | undefined): void {
    const axisIsZ = this._worldUp.z === 1;
    const axis: UpAxis = axisIsZ ? 2 : 1;
    const axisIdx = axisIsZ ? 2 : 1;
    // The world-space origin that was subtracted from the positions, along the
    // up-axis. Static clouds record it as `origin`; the streaming source as
    // `renderOrigin`. Prefer the streaming source when present, else the first
    // static cloud. Clouds that share an origin (the common case) convert
    // identically.
    const streamingCloud = this._streaming?.cloud;
    const staticCloud = this._clouds.values().next().value?.cloud;
    const origin = streamingCloud
      ? streamingCloud.renderOrigin[axisIdx]
      : staticCloud
        ? staticCloud.origin[axisIdx]
        : 0;
    const u = elevationFilterUniform(range, axis, origin);
    const wasActive = this._elevFilterEnabled.value !== 0;
    this._elevFilterEnabled.value = u.enabled;
    this._elevFilterAxisIsZ.value = axisIsZ ? 1 : 0;
    this._elevFilterMin.value = u.min;
    this._elevFilterMax.value = u.max;
    // Turning the filter on or off changes the size graph's SHAPE (the elevation
    // fold enters or leaves the compiled shader), so rebuild the affected
    // pipelines. Merely moving the window while it stays active only changes
    // uniform values and needs no rebuild — the mask node re-reads them per frame.
    if (wasActive !== (u.enabled !== 0)) this._reapplyAllSizeModes();
    this._bumpRenderActivity();
  }

  /**
   * The first static cloud's elevation extent in world/source units, along the
   * current up-axis, for seeding the elevation-filter control. `bounds()` is in
   * local (origin-shifted) space, so the world extent adds the cloud's origin
   * back. Returns null when no static cloud is loaded (e.g. a streaming-only
   * session), leaving the control to accept typed values.
   */
  elevationExtent(): { min: number; max: number } | null {
    const entry = this._clouds.values().next().value;
    if (!entry) return null;
    const axisIdx = this._worldUp.z === 1 ? 2 : 1;
    const b = entry.cloud.bounds();
    const o = entry.cloud.origin[axisIdx];
    return { min: b.min[axisIdx] + o, max: b.max[axisIdx] + o };
  }

  /**
   * Set the intensity filter window in raw intensity units, or clear it with
   * `undefined`. Points whose intensity falls outside the inclusive window
   * collapse to zero size (hidden); the unfiltered scene is pixel-identical.
   * Applies to static clouds and streaming nodes alike (both carry `aIntensity`
   * when the source has an intensity channel). No-op for clouds without one.
   */
  setIntensityFilter(range: readonly [number, number] | undefined): void {
    const u = intensityFilterUniform(range);
    const wasActive = this._intenFilterEnabled.value !== 0;
    this._intenFilterEnabled.value = u.enabled;
    this._intenFilterMin.value = u.min;
    this._intenFilterMax.value = u.max;
    // On/off toggles the intensity fold in the compiled shader — rebuild the
    // affected pipelines on that transition only. Narrowing an already-active
    // window is a uniform-only change.
    if (wasActive !== (u.enabled !== 0)) this._reapplyAllSizeModes();
    this._bumpRenderActivity();
  }

  /**
   * The first static cloud's intensity min/max, for seeding the intensity-filter
   * control. Returns null when no static cloud is loaded or the cloud has no
   * intensity channel. O(n) over the intensity array — run once on load.
   */
  intensityExtent(): { min: number; max: number } | null {
    const entry = this._clouds.values().next().value;
    const inten = entry?.cloud.intensity;
    if (!inten || inten.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < inten.length; i++) {
      const v = inten[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
  }

  /**
   * A PointCloud built from the streaming cloud's resident (decoded-so-far)
   * nodes — the honest display-resolution snapshot the Export / Convert panel
   * writes when a streaming scan is open. Returns null when no streaming cloud
   * is attached or nothing is resident yet. Full-resolution re-read isn't
   * available for a range-read streaming source, so this snapshot is exactly
   * what the viewer holds; positions carry the render origin as their shift.
   */
  snapshotResidentCloud(): PointCloud | null {
    const s = this._streaming;
    if (!s) return null;
    const chunks = s.renderer.residentChunks();
    if (chunks.length === 0) return null;
    const crs = s.cloud.crs();
    return buildResidentSnapshot(chunks, {
      origin: s.cloud.renderOrigin,
      name: s.cloud.name,
      // COPC and EPT both decode LAZ point records — the honest source format.
      sourceFormat: 'laz',
      ...(crs ? { metadata: { crs } } : {}),
    });
  }

  // ── A.6 Inspection presets ──────────────────────────────────────────────
  /** Currently-applied preset id. Persisted via prefs. */
  private _presetId: PresetId = 'survey';

  /**
   * AO strength last applied via a preset — used by the SSAO pass (A.1)
   * once the pass is plumbed; for now the field is preserved so prefs
   * round-trip an analyst's choice through the preset.
   */
  public lastPresetAoStrength = 0.35;

  /**
   * Apply a v0.3.7 inspection preset — Survey / Terrain / Foliage /
   * Classification / QA. Bundles EDL + point size / mode + sky
   * background into one call. Unknown preset ids fall back to the
   * default preset, so this method is safe to call from prefs / session
   * imports that may carry an older or third-party id.
   */
  applyPreset(id: PresetId | string): void {
    const preset = getPreset(id);
    this._presetId = preset.id;
    this.setEdlEnabled(preset.edlEnabled);
    this.setEdlStrength(preset.edlStrength);
    this.setPointSize(preset.pointSize);
    this.setPointSizeMode(preset.pointSizeMode);
    this._applySkyPreset(preset.sky);
    this.lastPresetAoStrength = preset.aoStrength;
  }

  /** The currently-applied preset id. */
  get presetId(): PresetId {
    return this._presetId;
  }

  /**
   * Apply a sky preset to the scene + the canvas container CSS.
   *
   * The renderer is opaque (`alpha: false`), so the canvas paints over
   * any CSS background set on its DOM parent. The user only sees what
   * `scene.background` clears to each frame. Setting both means:
   *   - `scene.background` is the source of truth the user sees
   *   - the parent CSS background acts as a fallback for any non-render
   *     edges (sheet transitions, resize blits) and matches the in-app
   *     reading so screenshots and HTML embeds stay coherent.
   *
   * Radial-gradient presets fall back to their flat `fallbackColor`
   * when fed into `scene.background` because Three.js takes a solid
   * Color or a Texture there — CSS gradients can't render against a
   * WebGPU clear. The fallback colour is chosen to match the centre
   * of the gradient so the visual difference reads small.
   */
  private _applySkyPreset(sky: SkyPreset): void {
    const def = getSkyDefinition(sky);
    const color = new THREE.Color(def.fallbackColor);
    // Three places need the new colour or the user sees nothing:
    //   1. scene.background — what `renderer.render(scene, camera)`
    //      clears to when EDL is OFF and the renderer paints direct.
    //   2. renderer.clearColor — what the EDL post-pipeline pass
    //      framebuffer clears to when EDL is ON. Without this the
    //      pass clears to the renderer default (opaque black) and
    //      the scene.background change is invisible while EDL is on.
    //   3. parent CSS background — sheet-edge fallback during resize
    //      / transitions and the source we read back in screenshot
    //      composition for in-context image exports.
    this._scene.background = color;
    this._renderer.setClearColor(color, 1.0);
    const canvas = this._canvas;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    // Device-aware CSS layer.
    //   Desktop (≥ 768 px) — apply the rich radial gradient. The wide
    //     canvas viewport carries the gradient without leaking under
    //     UI chrome.
    //   Phone (< 768 px) — apply only the flat fallback colour. On
    //     phones the Inspector becomes a bottom-sheet covering ~54 %
    //     of the viewport; a radial gradient extending behind the
    //     sheet edge or the topbar reads as visual leakage. The flat
    //     colour confines the visible background to the canvas area
    //     and matches what the renderer is clearing to anyway.
    const isPhone =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 767px)').matches;
    this._lastSkyIsPhone = isPhone;
    parent.style.background = isPhone ? def.fallbackColor : def.background;
    parent.style.backgroundColor = def.fallbackColor;
  }

  /** The current point-size mode. */
  get pointSizeMode(): PointSizeMode {
    return this._pointSizeMode;
  }

  /** Enable or disable point-edge antialiasing (alpha-to-coverage). */
  setAntialiasing(on: boolean): void {
    if (this._antialiasing === on) return;
    this._antialiasing = on;
    // Splat modes that force AA on don't need a material update at all
    // — `alphaToCoverage` is already true regardless of `on`.
    const forcedOn = splatForcesAlphaToCoverage(this._splatMode);
    if (forcedOn) return;
    for (const { material } of this._clouds.values()) {
      if (material.alphaToCoverage === on) continue;
      material.alphaToCoverage = on;
      material.needsUpdate = true;
    }
    for (const material of this._streamingMaterials()) {
      if (material.alphaToCoverage === on) continue;
      material.alphaToCoverage = on;
      material.needsUpdate = true;
    }
  }

  /** Whether point-edge antialiasing is currently on. */
  get antialiasing(): boolean {
    return this._antialiasing;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────

  /** Switch the navigation mode (orbit / walk / fly / pan). */
  setMode(mode: NavMode): void {
    this._nav.setMode(mode);
  }

  /** The active navigation mode. */
  get navMode(): NavMode {
    return this._nav.mode;
  }

  /**
   * Whether the v0.5.5 hand tool (pan mode) is available — false when the
   * `?handPan=off` dev flag disabled it. The app reads this to decide
   * whether the NavBar shows the Pan mode button and its legend entries.
   */
  get handPanEnabled(): boolean {
    return this._nav.handPanEnabled;
  }

  /** Set the user speed multiplier for walk/fly (from the speed slider). */
  setNavSpeed(multiplier: number): void {
    this._nav.setSpeedMultiplier(multiplier);
  }

  /** Subscribe to navigation events (mode change, pointer lock, help toggle). */
  setNavListeners(listeners: NavListeners): void {
    this._navListeners = listeners;
  }

  /** Capture the current camera viewpoint for a saved view. */
  getCameraPose(): CameraPose {
    return this._nav.getPose();
  }

  /** Glide the camera to a previously saved viewpoint. */
  applyCameraPose(pose: CameraPose): void {
    this._nav.applyPose(pose);
  }

  /**
   * Capture a richer camera state — pose plus navigation mode and field of
   * view — for an annotation. The fov is recorded only when it differs from
   * the default, keeping the serialised state minimal.
   */
  getCameraState(): SavedCameraState {
    const pose = this._nav.getPose();
    const state: SavedCameraState = {
      position: pose.position,
      target: pose.target,
      mode: this._nav.mode,
    };
    if (this._camera.fov !== DEFAULT_FOV) state.fov = this._camera.fov;
    return state;
  }

  /**
   * Restore a camera state captured by {@link getCameraState}. The mode is
   * applied first so the pose tween runs under the right navigation model;
   * the fov, if present, is set before the tween starts.
   */
  applyCameraState(state: SavedCameraState): void {
    if (state.mode && state.mode !== this._nav.mode) this._nav.setMode(state.mode);
    // Clamp imported FOV to a sane perspective range — a share/session file
    // could carry a non-finite or extreme value that breaks the projection.
    const rawFov = state.fov ?? DEFAULT_FOV;
    const fov = Math.min(120, Math.max(10, Number.isFinite(rawFov) ? rawFov : DEFAULT_FOV));
    if (this._camera.fov !== fov) {
      this._camera.fov = fov;
      this._camera.updateProjectionMatrix();
    }
    this._nav.applyPose({ position: state.position, target: state.target });
  }

  /** Look up a loaded cloud by id — used by the app to export it. */
  getCloud(id: string): PointCloud | undefined {
    return this._clouds.get(id)?.cloud;
  }

  /**
   * The current colour mode of a static cloud, or `undefined` when no
   * cloud has that id (e.g. it's the streaming cloud, or it was
   * detached). Used by main.ts to re-sync the Inspector's colour-mode
   * chip after `_ensureRgbColorMode` silently flips a cloud into RGB
   * mode from an RGB-only control.
   */
  colorModeOf(id: string): ColorMode | undefined {
    return this._clouds.get(id)?.mode;
  }

  /**
   * Whether a streaming cloud is currently attached. Used by main.ts
   * to gate the Visuals Studio Advanced disclosure — Temperature /
   * Tint / Auto-balance only meaningfully affect rendered colour on
   * the streaming COPC pipeline; for local LAZ the RGB preset chips
   * already cover the use case and the sliders would be misleading.
   */
  isStreamingActive(): boolean {
    return this._streaming !== null;
  }

  /**
   * Run the 3D volumetric lasso pipeline against every loaded point
   * (static + streaming-resident). The lasso is drawn in CSS pixel
   * coordinates on the canvas; this method projects every world-space
   * point through the active camera, tests against the lasso polygon,
   * and runs `volumeFromLasso` against the selected indices.
   *
   * Returns `null` when no points are loaded or the lasso is too
   * small to enclose anything. Otherwise returns the same
   * `VolumeResult` shape as `volumeCutFill` so the caller can render
   * fill / cut / net without a special case for the lasso path.
   *
   * The lasso is 3D-volumetric by construction: a point at any depth
   * along the camera ray through the lasso polygon is included. So a
   * lasso around a tree picks up the trunk + branches + ground
   * behind, producing a true volumetric pick rather than a screen
   * snapshot.
   *
   * @param lasso - Lasso path in canvas CSS pixels (0..clientWidth,
   *   0..clientHeight). At least 3 vertices required.
   * @param percentile - Reference-plane percentile in `[0, 1]`.
   *   Defaults to 0.05 — bottom 5 % of selected Z values is "ground".
   * @param lin - `linearUnitToMetres` for the source CRS, used to convert the
   *   returned {@link LassoVolumeReturn.stockpileSuffix} band into metres.
   *   Defaults to 1 (native units already metres).
   */
  computeLassoVolume(
    lasso: ReadonlyArray<{ readonly x: number; readonly y: number }>,
    percentile: number = 0.05,
    lin: number = 1,
  ): LassoVolumeReturn | null {
    if (lasso.length < 3) return null;

    const canvas = this._canvas;
    if (!canvas) return null;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return null;

    // ── Build projector once, reuse per cloud. ──────────────────────
    this._camera.updateMatrixWorld(true);
    const projMatrix = this._camera.projectionMatrix;
    const viewMatrix = this._camera.matrixWorldInverse;
    const tmp = new THREE.Vector3();
    const project = (x: number, y: number, z: number) => {
      tmp.set(x, y, z).applyMatrix4(viewMatrix).applyMatrix4(projMatrix);
      if (tmp.z < -1 || tmp.z > 1) return null;
      const sx = (tmp.x * 0.5 + 0.5) * w;
      const sy = (1 - (tmp.y * 0.5 + 0.5)) * h;
      return { x: sx, y: sy };
    };

    // ── Adaptive-degradation budget ─────────────────────────────────
    // Count candidate points BEFORE walking — every static cloud
    // plus every streaming-resident node — so the budget can decide
    // whether to stride or walk exhaustively. The decision is
    // attached to the result so the inspector caption reads
    // "estimated (sampled — n%)" when the stride > 1.
    let candidatePointCount = 0;
    for (const [, entry] of this._clouds) {
      candidatePointCount += entry.cloud.positions.length / 3;
    }
    if (this._streaming) {
      for (const positions of this._streaming.renderer.positionArrays()) {
        candidatePointCount += positions.length / 3;
      }
    }
    const budget = decideVolumeBudget({
      candidatePointCount,
      // Footprint area isn't known until selection; pass 0 so the
      // density branch sits out. Ceiling branch still fires on cloud
      // size alone, which is the bigger lever in practice.
      footprintAreaM2: 0,
    });
    const stride = budget.stride;

    // ── Walk each static cloud INDEPENDENTLY so we can report per-
    //    cloud indices to the highlight pipeline. Concatenate the
    //    selected XYZ subset for the volume math. ──────────────────
    const selectionByCloudId = new Map<string, ReadonlyArray<number>>();
    const subsetParts: Float32Array[] = [];
    let totalSelected = 0;
    // True once any cloud that contributes selected points was voxel-reduced to
    // fit the device budget — the volume's honesty caveat reflects the thinner
    // sample. (See `_cloudWasReduced`.)
    let anySourceReduced = false;
    for (const [id, entry] of this._clouds) {
      const positions =
        stride === 1
          ? entry.cloud.positions
          : stridePositions(entry.cloud.positions, stride);
      const localIndices = selectByLasso({
        positions,
        lasso: lasso as ReadonlyArray<{ x: number; y: number }>,
        project,
      });
      if (localIndices.length === 0) continue;
      // When strided, translate indices back to the source cloud's
      // index space so the highlight pipeline still lights up the
      // right points.
      const sourceIndices =
        stride === 1
          ? localIndices
          : localIndices.map((i) => i * stride);
      selectionByCloudId.set(id, sourceIndices);
      if (this._cloudWasReduced(entry.cloud)) anySourceReduced = true;
      totalSelected += localIndices.length;
      // Pack the selected points' xyz into a contiguous buffer for
      // the volume math.
      const part = new Float32Array(localIndices.length * 3);
      for (let i = 0; i < localIndices.length; i++) {
        const idx = localIndices[i];
        part[i * 3] = positions[idx * 3];
        part[i * 3 + 1] = positions[idx * 3 + 1];
        part[i * 3 + 2] = positions[idx * 3 + 2];
      }
      subsetParts.push(part);
    }
    // Streaming clouds — still selected, but indices aren't returned
    // (the streaming highlight surface is a follow-up cut). The
    // volume math still consumes their positions.
    if (this._streaming) {
      for (const sourcePositions of this._streaming.renderer.positionArrays()) {
        const positions =
          stride === 1
            ? sourcePositions
            : stridePositions(sourcePositions, stride);
        const indices = selectByLasso({
          positions,
          lasso: lasso as ReadonlyArray<{ x: number; y: number }>,
          project,
        });
        if (indices.length === 0) continue;
        totalSelected += indices.length;
        const part = new Float32Array(indices.length * 3);
        for (let i = 0; i < indices.length; i++) {
          const idx = indices[i];
          part[i * 3] = positions[idx * 3];
          part[i * 3 + 1] = positions[idx * 3 + 1];
          part[i * 3 + 2] = positions[idx * 3 + 2];
        }
        subsetParts.push(part);
      }
    }
    if (totalSelected < 3) return null;

    // Concatenate the per-cloud subset parts into one buffer for
    // volumeFromLasso, then call it with indices 0..N-1 (since the
    // buffer already contains ONLY selected points).
    let len = 0;
    for (const p of subsetParts) len += p.length;
    const selectedPositions = new Float32Array(len);
    let off = 0;
    for (const p of subsetParts) {
      selectedPositions.set(p, off);
      off += p.length;
    }
    const allIndices = new Array(totalSelected);
    for (let i = 0; i < totalSelected; i++) allIndices[i] = i;
    const lassoOut = volumeFromLassoWithFootprint({
      positions: selectedPositions,
      selected: allIndices,
      referencePercentile: percentile,
    });
    return {
      result: lassoOut.result,
      stockpileSuffix: stockpileToastSuffix(
        lassoOut.polygon3D as ReadonlyArray<[number, number, number]>,
        selectedPositions,
        lin,
        anySourceReduced,
      ),
      selectedCount: totalSelected,
      lasso,
      selectionByCloudId,
      budget,
      polygon3D: lassoOut.polygon3D as ReadonlyArray<[number, number, number]>,
      referenceZ: lassoOut.referenceZ,
    };
  }

  /**
   * Highlight a set of per-cloud point indices in a brand-cyan colour
   * so the user can see what their selection captured. The previous
   * colours are stashed so {@link clearSelectionHighlight} can revert.
   *
   * Static clouds only — streaming highlights need per-mesh indexing
   * (the streaming renderer owns its own colour buffers) and are
   * deferred to a follow-up cut.
   */
  setSelectionHighlight(
    perCloud: ReadonlyMap<string, ReadonlyArray<number>>,
    color: readonly [number, number, number] = [0, 0.7, 1.0],
  ): void {
    // Revert any prior highlight first so the user sees only the
    // latest selection.
    this.clearSelectionHighlight();
    for (const [id, indices] of perCloud) {
      const entry = this._clouds.get(id);
      if (!entry) continue;
      const arr = entry.colorAttr.array as Float32Array;
      const saved = new Float32Array(indices.length * 3);
      for (let i = 0; i < indices.length; i++) {
        const k = indices[i] * 3;
        saved[i * 3] = arr[k];
        saved[i * 3 + 1] = arr[k + 1];
        saved[i * 3 + 2] = arr[k + 2];
        arr[k] = color[0];
        arr[k + 1] = color[1];
        arr[k + 2] = color[2];
      }
      this._selectionSnapshots.set(id, { indices: indices.slice(), saved });
      entry.colorAttr.needsUpdate = true;
    }
  }

  /** Revert any active selection highlight back to the original colours. */
  clearSelectionHighlight(): void {
    for (const [id, snap] of this._selectionSnapshots) {
      const entry = this._clouds.get(id);
      if (!entry) continue;
      const arr = entry.colorAttr.array as Float32Array;
      for (let i = 0; i < snap.indices.length; i++) {
        const k = snap.indices[i] * 3;
        arr[k] = snap.saved[i * 3];
        arr[k + 1] = snap.saved[i * 3 + 1];
        arr[k + 2] = snap.saved[i * 3 + 2];
      }
      entry.colorAttr.needsUpdate = true;
    }
    this._selectionSnapshots.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Picking tools — measurement & point inspection
  // ─────────────────────────────────────────────────────────────────────────

  /** Enter or leave distance-measurement mode (freezes navigation). */
  setMeasureMode(on: boolean): void {
    this._setToolMode(on ? 'measure' : 'none');
  }

  /**
   * v0.3.10 — Enter or leave lasso-volume mode. Routes through the same
   * tool-mode switch the measure / inspect / annotate tools use so the
   * navigation freeze is consistent.
   *
   * Why this matters: the lasso draws on an SVG overlay that owns its
   * own pointer events. Without flipping the tool mode, OrbitControls
   * stays "enabled" and — critically — its damping integrator keeps
   * running every frame after a prior orbit drag. The user arms the
   * lasso while the camera is still gliding to a stop; each pointermove
   * sampled a vertex against a moving camera, and the at-commit-time
   * projection in `computeLassoVolume` matched the final (post-drift)
   * camera, not the camera-at-vertex-time. Result: the lasso selection
   * is offset from what the user drew around.
   *
   * `_setToolMode('lasso')` flips `_inputEnabled = false` on the
   * NavController, which both disables OrbitControls AND stops the
   * per-frame `_controls.update()` call. Damping decay halts. The
   * camera holds still for the duration of the draw.
   */
  setLassoMode(on: boolean): void {
    this._setToolMode(on ? 'lasso' : 'none');
  }

  /**
   * Enable or disable the v0.3.7 two-finger twist + pinch + pan
   * decomposition recogniser. The default is `true`. Setting to `false`
   * leaves the inherited Three.js OrbitControls touch model in place —
   * 1-finger orbit, 2-finger pinch-zoom, no twist gesture. The advanced
   * "3-finger zoom" model (D.7.3) flips this off and routes 3-finger
   * vertical drag to dolly via a different code path.
   */
  setTwoFingerTwistEnabled(enabled: boolean): void {
    this._twoFingerTwistEnabled = enabled;
    if (!enabled) {
      // Restore OrbitControls' default 2-finger handler so existing
      // pinch-zoom muscle memory keeps working in the off state.
      this._controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
      };
      this._activeTouches.clear();
    } else {
      this._controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: undefined as unknown as THREE.TOUCH,
      };
    }
  }

  /** Whether the two-finger twist + pinch + pan recogniser is active. */
  get twoFingerTwistEnabled(): boolean {
    return this._twoFingerTwistEnabled;
  }

  /** Enter or leave point-inspection mode (freezes navigation). */
  setInspectMode(on: boolean): void {
    this._setToolMode(on ? 'inspect' : 'none');
  }

  /** Whether distance measurement is currently active. */
  get measureMode(): boolean {
    return this._toolMode === 'measure';
  }

  /** Whether point inspection is currently active. */
  get inspectMode(): boolean {
    return this._toolMode === 'inspect';
  }

  /** Remove all measurements. */
  clearMeasurements(): void {
    this._measure.clear();
  }

  /** Subscribe to measurement events (mode change). */
  setMeasureListeners(listeners: MeasureListeners): void {
    this._measureListeners = listeners;
  }

  /** Subscribe to point-inspection events (mode change). */
  setInspectListeners(listeners: InspectListeners): void {
    this._inspectListeners = listeners;
  }

  /** The Measure tool's overlay + toolbar DOM elements, for the app to mount. */
  get measureElements(): { overlay: SVGSVGElement; hint: HTMLElement } {
    return { overlay: this._measure.overlay, hint: this._measure.hint };
  }

  /** The measurement controller, so the app can wire the Measurements panel. */
  get measure(): MeasureController {
    return this._measure;
  }

  /** The Inspect tool's overlay, hint and card DOM elements, for the app to mount. */
  get inspectElements(): { overlay: SVGSVGElement; hint: HTMLElement; card: HTMLElement } {
    return {
      overlay: this._inspect.overlay,
      hint: this._inspect.hint,
      card: this._inspect.card,
    };
  }

  /**
   * Push the active scan's origin + CRS into the point-inspector so it
   * can compute World (origin-relative) and Lat/Lon (CRS-projected)
   * coordinate rows in addition to Local X/Y/Z. Delegates to the
   * InspectTool via a thin pass-through so main.ts doesn't have to
   * reach into Viewer internals.
   */
  setInspectCoordinateContext(
    ctx: import('./InspectTool').CoordinateContext,
  ): void {
    this._inspect.setCoordinateContext(ctx);
  }

  /**
   * Push the active class-filter scope stamp into the point-inspector so a
   * copied point's text + JSON carry the filter they were taken under. Pass
   * an empty string when no class filter is active — the no-filter clipboard
   * payload is then byte-identical to the pre-feature output. Thin
   * pass-through so main.ts doesn't reach into the InspectTool directly.
   */
  setInspectClassScopeStamp(stamp: string): void {
    this._inspect.setClassScopeStamp(stamp);
  }

  /** Enter or leave annotation mode (freezes navigation). */
  setAnnotateMode(on: boolean): void {
    this._setToolMode(on ? 'annotate' : 'none');
  }

  /** Whether annotation mode is currently active. */
  get annotateMode(): boolean {
    return this._toolMode === 'annotate';
  }

  /** The annotation controller, so the app can wire the Annotations panel. */
  get annotate(): AnnotationController {
    return this._annotate;
  }

  /** Subscribe to annotation events (mode change). */
  setAnnotateListeners(listeners: AnnotateListeners): void {
    this._annotateListeners = listeners;
  }

  /** The Annotate tool's overlay, hint and editor DOM elements, to mount. */
  get annotateElements(): { overlay: SVGSVGElement; hint: HTMLElement; editor: HTMLElement } {
    return {
      overlay: this._annotate.overlay,
      hint: this._annotate.hint,
      editor: this._annotate.editorElement,
    };
  }

  /** Enter or leave live-probe mode (a hover readout; navigation stays live). */
  setProbeMode(on: boolean): void {
    this._setToolMode(on ? 'probe' : 'none');
  }

  /** Whether live-probe mode is currently active. */
  get probeMode(): boolean {
    return this._toolMode === 'probe';
  }

  /** Subscribe to live-probe events (mode change). */
  setProbeListeners(listeners: ProbeListeners): void {
    this._probeListeners = listeners;
  }

  /** The live-probe readout element, for the app to mount. */
  get probeElements(): { readout: HTMLElement } {
    return { readout: this._probe.element };
  }

  /**
   * Select an annotation and move the camera to it. When the annotation
   * carries a saved camera state, the exact framing it was created with is
   * restored; otherwise the camera simply focuses on the marked point.
   */
  jumpToAnnotation(id: string): void {
    const a = this._annotate.get(id);
    if (!a) return;
    this._annotate.select(id);
    if (a.cameraState) {
      this.applyCameraState(a.cameraState);
    } else {
      this._nav.focusOn(
        new THREE.Vector3(a.localPosition.x, a.localPosition.y, a.localPosition.z),
      );
    }
  }

  /**
   * Switch the active picking tool. Only one tool owns canvas clicks at a
   * time, so activating one deactivates the others. Navigation input is frozen
   * while a click-driven tool is active; the live probe is the exception — it
   * is a passive hover readout, so navigation stays live during it.
   */
  /** True while a modal click-to-act tool (measure / inspect / annotate) is
   *  armed. Probe keeps navigation live, so it does not count. */
  get toolActive(): boolean {
    return this._toolMode === 'measure' || this._toolMode === 'inspect' || this._toolMode === 'annotate';
  }

  /**
   * Hold-Space "re-orient" pause. While paused, a modal tool stays armed but
   * camera navigation gets pointer input back (orbit / pan / zoom) and canvas
   * clicks no longer act on the tool — so the user can reposition the view
   * mid-draw, then release to resume. No-op unless a modal tool is active.
   */
  setToolPaused(paused: boolean): void {
    if (!this.toolActive || this._toolPaused === paused) return;
    this._toolPaused = paused;
    this._nav.setInputEnabled(paused);
    // Inspect owns its own cursor; measure / annotate use the crosshair.
    this._canvas.style.cursor = paused
      ? 'grab'
      : this._toolMode === 'inspect'
        ? ''
        : 'crosshair';
  }

  private _setToolMode(mode: ToolMode): void {
    if (mode === this._toolMode) return;
    this._toolPaused = false;
    this._toolMode = mode;
    this._measure.setActive(mode === 'measure');
    this._inspect.setActive(mode === 'inspect');
    this._annotate.setActive(mode === 'annotate');
    this._probe.setActive(mode === 'probe');
    // Inspect manages its own cursor; the measure, annotate and probe cursors
    // are owned here — a crosshair while picking, cleared when no tool is active.
    if (mode === 'measure' || mode === 'annotate' || mode === 'probe') {
      this._canvas.style.cursor = 'crosshair';
    } else if (mode === 'none') {
      this._canvas.style.cursor = '';
    }
    // The probe keeps navigation live; every other tool freezes it. Runs
    // AFTER the cursor assignment: re-enabling navigation lets the
    // NavController reclaim its pan-mode `grab` cursor over the cleared one
    // (and disabling it cancels any hand-tool drag before the tool arms).
    this._nav.setInputEnabled(mode === 'none' || mode === 'probe');
    this._measureListeners.onModeChange?.(mode === 'measure');
    this._inspectListeners.onModeChange?.(mode === 'inspect');
    this._annotateListeners.onModeChange?.(mode === 'annotate');
    this._probeListeners.onModeChange?.(mode === 'probe');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Camera
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Pick the point under a screen-NDC position and glide the orbit pivot to it
   * (the right-click "Focus here" gesture, shared with double-click). Returns
   * false when nothing is under the cursor so the caller can fall back.
   */
  focusOnScreen(ndcX: number, ndcY: number): boolean {
    const point = this._pickPoint(ndcX, ndcY);
    if (!point) return false;
    this._nav.focusOn(point);
    return true;
  }

  /**
   * Whether a cloud's resident points are a device-budget reduction of a
   * denser source — true when the declared source count meaningfully exceeds
   * the resident count (voxel/stride downsample kicked in at load). Used to add
   * an honesty caveat to volumes measured on the thinner sample.
   */
  private _cloudWasReduced(cloud: PointCloud): boolean {
    const declared = cloud.declaredPointCount;
    return declared != null && cloud.pointCount < declared * 0.95;
  }

  /**
   * Fit the camera to encompass all visible clouds, gliding to an oblique
   * overview rather than snapping there.
   */
  frameAll(): void {
    const box = this._visibleBoundingBox();
    if (!box) return;
    const target = box.getCenter(new THREE.Vector3());

    // An oblique direction: a horizontal heading lifted ~35° toward world-up,
    // so a scan opens at a natural three-quarter angle, not flat top-down.
    const horiz = this._horizontalAxis();
    const dir = horiz
      .multiplyScalar(Math.cos(0.61))
      .addScaledVector(this._worldUp, Math.sin(0.61))
      .normalize();

    // Extent-aware fit: the distance at which the actual bounding BOX just fills
    // the frustum (aspect + FOV aware), not its much-larger bounding sphere. So
    // a flat wide scan fills the viewport and a tall scan isn't over-zoomed —
    // the framing adapts to the scan's shape. 1.05 leaves a small margin so the
    // edge points sit just inside the frame rather than on its border.
    const dist = fitBoxDistance({
      boxMin: { x: box.min.x, y: box.min.y, z: box.min.z },
      boxMax: { x: box.max.x, y: box.max.y, z: box.max.z },
      look: { x: -dir.x, y: -dir.y, z: -dir.z },
      worldUp: { x: this._worldUp.x, y: this._worldUp.y, z: this._worldUp.z },
      fovDeg: this._camera.fov,
      aspect: this._camera.aspect,
      pad: 1.05,
    });

    const pos = target.clone().addScaledVector(dir, dist);
    // Slightly longer than the default tween — a Frame All sweep usually
    // covers a larger camera delta, so the extra ~100 ms makes the cubic
    // ease feel cinematic rather than rushed. Matches model-viewer's
    // jump-to-goal cadence on a fresh load.
    this._nav.tweenTo(pos, target, 0.9);
  }

  /**
   * Jump the camera to a named pose — Top, Iso, Oblique, or Planar. The
   * geometry math lives in the pure `cameraPresets` module so it can be
   * unit-tested and shared with the v0.3.9 command palette and workflow
   * recorder without anyone reaching into three.js types.
   *
   * Returns `true` when the tween fired (a scan was loaded), `false`
   * when no visible cloud means no bounding sphere to fit. The caller
   * (keyboard handler, command palette, palette UI) can surface that
   * state if it cares.
   */
  setCameraPreset(name: CameraPresetName): boolean {
    const sphere = this._visibleBoundingSphere();
    if (!sphere) return false;
    const horiz = this._horizontalAxis();
    const pose = cameraPresetPose(name, {
      center: { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z },
      radius: sphere.radius,
      worldUp: { x: this._worldUp.x, y: this._worldUp.y, z: this._worldUp.z },
      horizontal: { x: horiz.x, y: horiz.y, z: horiz.z },
      fovDeg: this._camera.fov,
    });
    const pos = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z);
    const target = new THREE.Vector3(pose.target.x, pose.target.y, pose.target.z);
    // Match frameAll's cinematic 0.9 s tween — these presets are
    // discoverability surfaces, not micro-adjustments.
    this._nav.tweenTo(pos, target, 0.9);
    return true;
  }

  /** Whether the near-orthographic (parallel) projection is active. */
  get orthographic(): boolean {
    return this._orthographic;
  }

  /**
   * Snap to one of the six standard axis-aligned views (Top / Bottom / Front /
   * Back / Left / Right) — the Polycam-style "look straight at a face" framing
   * that makes a wall or floor read flat for measuring. Honours the current
   * projection (perspective or near-orthographic). Returns false when no scan
   * is loaded.
   */
  /**
   * The camera's heading around the world up axis, in degrees [0, 360), for the
   * on-canvas compass gizmo. Projects the camera forward vector onto the ground
   * plane (the two non-up axes) and measures its bearing. Pure-math lives in
   * `viewCubeMath.ts`; this only feeds it the camera/up geometry.
   */
  cameraHeadingDeg(): number {
    const fwd = this._camera.getWorldDirection(new THREE.Vector3());
    const east = this._horizontalAxis();
    const north = new THREE.Vector3().crossVectors(this._worldUp, east).normalize();
    return compassHeadingDeg(fwd.dot(east), fwd.dot(north));
  }

  setStandardView(view: StandardView): boolean {
    const sphere = this._visibleBoundingSphere();
    if (!sphere) return false;
    this._lastStandardView = view;
    // A standard view is an orbit pose — make sure we're in orbit mode so the
    // controls own the camera (walk/fly would fight the snap).
    this._nav.setMode('orbit');
    const horiz = this._horizontalAxis();
    const pose = standardViewPose(view, {
      center: { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z },
      radius: sphere.radius,
      worldUp: { x: this._worldUp.x, y: this._worldUp.y, z: this._worldUp.z },
      horizontal: { x: horiz.x, y: horiz.y, z: horiz.z },
      fovDeg: this._camera.fov,
    });
    const target = new THREE.Vector3(pose.target.x, pose.target.y, pose.target.z);
    const pos = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z);
    // Keep depth range + dolly bounds consistent with the (possibly far)
    // framing distance before the camera arrives there.
    this._applyProjectionRanges(sphere.radius, pos.distanceTo(target));
    this._nav.tweenTo(pos, target, 0.8);
    return true;
  }

  /**
   * Toggle the near-orthographic projection. Implemented as a very long lens
   * (ORTHO_FOV) rather than a separate OrthographicCamera, so the WebGPU
   * render graph, frustum culling, LOD streaming and the picking tools all
   * keep working unchanged — only the FOV + framing distance change. Re-frames
   * the current view so the scan stays the same apparent size.
   */
  setOrthographic(on: boolean): boolean {
    this._orthographic = on;
    this._camera.fov = on ? ORTHO_FOV : DEFAULT_FOV;
    this._camera.updateProjectionMatrix();

    const sphere = this._visibleBoundingSphere();
    if (!sphere) return false;

    const fovRad = THREE.MathUtils.degToRad(this._camera.fov);
    const fitDist = (Math.max(sphere.radius, 1e-3) / Math.sin(fovRad / 2)) * 1.2;
    this._applyProjectionRanges(sphere.radius, fitDist);

    // Re-frame so the cloud keeps its apparent size at the new lens. If a
    // standard view is active, re-apply it; otherwise pull along the current
    // view direction to the new fit distance.
    if (this._lastStandardView) {
      this.setStandardView(this._lastStandardView);
    } else {
      const target = this._controls.target.clone();
      const dir = this._camera.position.clone().sub(target);
      if (dir.lengthSq() < 1e-9) dir.copy(this._horizontalAxis());
      dir.normalize();
      this._nav.tweenTo(target.clone().addScaledVector(dir, fitDist), target, 0.6);
    }
    return true;
  }

  /**
   * Keep the camera's far plane, point-size attenuation reference and orbit
   * dolly bounds consistent with a (possibly very large) framing distance —
   * the near-orthographic lens pulls the camera back far beyond the normal
   * 50×-radius dolly cap, so without this the controls would clamp it and the
   * framing would collapse.
   */
  private _applyProjectionRanges(radius: number, fitDist: number): void {
    const r = radius > 0 ? radius : 1;
    const fovRad = THREE.MathUtils.degToRad(this._camera.fov);
    this._camera.far = Math.max(fitDist * 2.5, r * 32, 1000);
    this._camera.near = 0.01;
    this._camera.updateProjectionMatrix();
    this._edlNear.value = this._camera.near;
    this._edlFar.value = this._camera.far;
    this._attnRef.value = (r / Math.sin(fovRad / 2)) * 1.2;
    this._controls.minDistance = 0.02;
    this._controls.maxDistance = Math.max(fitDist * 3, r * 50);
  }

  /**
   * Bound the orbit dolly to the framed cloud: `radius` is the scan's bounding
   * radius. The camera can pull in close enough to inspect a detail and back
   * far enough to take in the whole scan with margin — but never so close it
   * clips through the near plane, nor so far the cloud is lost off-screen.
   *
   * v0.3.6 zoom-floor fix: `minDistance` was `r * 0.02`, which on a 1 km
   * aerial survey meant the camera couldn't approach closer than ~10 m to
   * the orbit pivot — and the pivot itself sits at the bbox CENTRE, which
   * is typically tens of metres above the actual ground surface. The user
   * would hit the floor while still floating above the terrain. Floor is
   * now anchored to the near-clip plane (4× near, so no clipping artefacts)
   * with a small absolute fallback for tiny clouds. `maxDistance` bumped
   * from 16× to 50× radius so the user can pull *way* out for context on
   * large surveys.
   */
  private _applyOrbitBounds(radius: number): void {
    const r = radius > 0 ? radius : 1;
    // No artificial zoom-in floor. With camera.near pinned at 1 cm, the
    // user can dolly down to centimetre-scale detail on any cloud,
    // regardless of bounding radius. The tiny 2 cm absolute minimum just
    // prevents the spherical math from becoming degenerate at radius 0.
    this._controls.minDistance = 0.02;
    this._controls.maxDistance = r * 50;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Report which GPU backend is active.
   * Call after `await viewer.ready`.
   */
  activeBackend(): 'webgpu' | 'webgl2' {
    const backend = (this._renderer as unknown as { backend: { isWebGPUBackend?: boolean } }).backend;
    return backend?.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
  }

  /**
   * Subscribe to the WebGPU device's `uncapturederror` event. This is the only
   * channel through which a shader-compile or render-pipeline validation error
   * surfaces: three.js builds the pipeline lazily inside the render loop, long
   * after `addCloud` / streaming-attach have resolved, so such a failure never
   * throws on a path any caller can `catch`. Left unhandled it is invisible —
   * the scan "opens", the progress toast clears, and the canvas simply stays
   * blank. Routing it to `onGpuError` turns "nothing happened and I don't know
   * why" into an actionable message.
   *
   * Guarded and best-effort: only WebGPU exposes a `GPUDevice`; the WebGL 2
   * fallback has no equivalent event and is skipped. Every access is defensive
   * because the backend's internal shape is not part of three's public API.
   */
  private _installGpuErrorListener(): void {
    if (this.activeBackend() !== 'webgpu') return;
    try {
      const backend = (this._renderer as unknown as {
        backend?: { device?: { addEventListener?: (t: string, cb: (e: unknown) => void) => void } };
      }).backend;
      const device = backend?.device;
      if (!device || typeof device.addEventListener !== 'function') return;
      device.addEventListener('uncapturederror', (event: unknown) => {
        const gpuError = (event as { error?: { message?: string; constructor?: { name?: string } } }).error;
        const kind = gpuError?.constructor?.name ?? 'GPUError';
        const detail = gpuError?.message ?? String(event);
        this._reportGpuError(`${kind}: ${detail}`);
      });
    } catch {
      // Never let error-plumbing setup break init — the viewer is still usable.
    }
  }

  /**
   * De-duplicate then forward a GPU error to the host. A broken pipeline emits
   * the same validation error on every frame; we surface each distinct message
   * exactly once so the toast isn't retriggered in a render-rate loop.
   */
  private _reportGpuError(message: string): void {
    if (this._seenGpuErrors.has(message)) return;
    this._seenGpuErrors.add(message);
    console.error(`OpenLiDARViewer: GPU error — ${message}`);
    try {
      this.onGpuError?.(message);
    } catch {
      // A throwing host handler must not take down the render loop.
    }
  }

  /**
   * Sample the current rendering performance — frame rate, draw calls, and the
   * point and memory footprint. Cheap enough for the `?debug=1` overlay to poll
   * on a throttled cadence; returns zeroed counters before the first frame has
   * been timed.
   */
  frameStats(): FrameStats {
    let sum = 0;
    for (let i = 0; i < this._frameCount; i++) sum += this._frameTimes[i];
    const frameMs = this._frameCount > 0 ? sum / this._frameCount : 0;

    let displayedPoints = 0;
    let totalPoints = 0;
    for (const { cloud, mesh } of this._clouds.values()) {
      totalPoints += cloud.pointCount;
      if (mesh.visible) displayedPoints += cloud.pointCount;
    }
    // Static byte estimate first — the streaming layout differs per point.
    let gpuBytesEstimate = displayedPoints * BYTES_PER_GPU_POINT;

    // A streaming cloud renders through its own node meshes, not
    // `this._clouds`, so without this fold the overlay reported 0 points
    // while a COPC/EPT scan was clearly on screen. Resident = uploaded to
    // the GPU right now; source = the whole remote file. The byte estimate
    // uses the streaming layout's own per-point cost (estimateGpuBytes),
    // which differs from the static BYTES_PER_GPU_POINT.
    if (this._streaming) {
      const resident = this._streaming.cloud.residentPointCount;
      displayedPoints += resident;
      totalPoints += this._streaming.cloud.sourcePointCount;
      gpuBytesEstimate += estimateGpuBytes(resident);
    }

    // three.js names this counter `drawCalls` on the WebGPU backend and
    // `calls` on WebGL 2 — read whichever the active backend populated.
    const render = (this._renderer.info as {
      render?: { calls?: number; drawCalls?: number };
    }).render;
    const drawCalls = render?.drawCalls ?? render?.calls ?? 0;

    return {
      fps: frameMs > 0 ? 1000 / frameMs : 0,
      frameMs,
      drawCalls,
      displayedPoints,
      totalPoints,
      gpuBytesEstimate,
    };
  }

  /**
   * Render one frame and capture it as a PNG `Blob`.
   *
   * With no options (or all off) this returns the bare rendered cloud — the
   * original, fast path. With an overlay enabled it becomes a compositor: the
   * rendered frame is drawn into a 2-D canvas at the GL drawing-buffer
   * resolution (high-DPI preserved), then each requested overlay is projected
   * with this exact camera, serialised to a self-styled SVG, rasterised and
   * drawn on top — so markers land precisely where they sit in the live view.
   */
  async snapshot(options?: SnapshotOptions): Promise<Blob> {
    await this.ready;

    // Render-and-present helper. The export pipeline mutates `colorAttr`
    // immediately before calling snapshot — for WebGPU specifically, the
    // first `render()` queues the new color buffer upload but the canvas
    // won't carry the new frame until the browser ticks an animation
    // frame. Calling `toBlob` immediately after a single un-awaited
    // `render()` reads the *previous* frame, which is why every export
    // mode came out looking identical (whatever was on screen before the
    // swap). The fix is to render, wait for a present cycle, then render
    // and wait once more — two frames is enough to flush the buffer
    // upload, the post-processing pipeline if EDL is on, and the
    // composited presentation.
    const renderAndPresent = (): Promise<void> => {
      if (this._edlEnabled) this._post.render();
      else this._renderer.render(this._scene, this._camera);
      return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => resolve());
        } else {
          // Test / Node fallback — snapshot is browser-only in practice,
          // but the type-check path goes through here without rAF.
          setTimeout(resolve, 0);
        }
      });
    };
    await renderAndPresent();
    await renderAndPresent();

    const gl = this._renderer.domElement as HTMLCanvasElement;
    const wantAnnotations = options?.annotations === true;
    const wantMeasurements = options?.measurements === true;
    const wantInspector = options?.inspector === true;
    const wantProbe = options?.probe === true;
    // v0.3.7 final-polish: supersample + scale bar both promote the
    // export to the composite path so the upscaled output canvas can
    // host overlays at the requested resolution.
    const supersample =
      options?.supersample === 2 || options?.supersample === 4 ? options.supersample : 1;
    const wantScaleBar = options?.scaleBar === true;

    // Fast path: no overlays + no upscale + no scale bar — return the
    // GL canvas untouched at native resolution.
    if (
      !wantAnnotations &&
      !wantMeasurements &&
      !wantInspector &&
      !wantProbe &&
      !wantScaleBar &&
      supersample === 1
    ) {
      return this._canvasToBlob(gl);
    }

    // Composite path: draw the GL frame into a 2-D canvas at full
    // (optionally upscaled) resolution.
    const out = document.createElement('canvas');
    out.width = gl.width * supersample;
    out.height = gl.height * supersample;
    const ctx = out.getContext('2d');
    if (!ctx) return this._canvasToBlob(gl);
    ctx.drawImage(gl, 0, 0, out.width, out.height);

    // Re-project each overlay with the export camera, then serialise it, so
    // alignment with the rendered frame is exact. Measurements sit beneath the
    // annotation markers, matching the live stacking order; the inspector
    // marker sits on top so the picked point is always identifiable.
    const layers: string[] = [];
    if (wantMeasurements) {
      this._measure.render(this._camera, this._canvas);
      layers.push(this._measure.overlaySVG());
    }
    if (wantAnnotations) {
      this._annotate.render(this._camera, this._canvas);
      layers.push(this._annotate.markerSVG());
    }
    if (wantInspector) {
      // The marker overlay is re-rendered against the live canvas so the
      // halo + dot coords match the current camera frame.
      this._inspect.render();
      layers.push(this._inspect.overlaySVG());
    }
    for (const svg of layers) {
      const img = await loadSvgImage(svg);
      if (img) ctx.drawImage(img, 0, 0, out.width, out.height);
    }
    // The point-info card the live UI shows is an HTML element, not SVG, so
    // we redraw an equivalent on the 2-D canvas next to the marker. Only the
    // selected-point fields the user actually sees are baked, so the card
    // matches the live UI line for line.
    if (wantInspector) {
      const sel = this._inspect.selectionForExport();
      if (sel) drawInspectorInfoCard(ctx, sel.info, sel.screen);
    }
    // v0.3.7 final-polish — scale bar overlay. Drawn last so it sits on
    // top of everything else but underneath the inspector / probe cards.
    if (wantScaleBar) {
      // Estimate pixels-per-metre from the current camera. The reference
      // distance is the orbit-target distance — what the analyst is
      // actually looking at.
      const dist = this._camera.position.distanceTo(this._controls.target);
      const fovY = (this._camera.fov * Math.PI) / 180;
      const ppm = pixelsPerMetreAt(fovY, out.height, dist);
      // Use 22 % of the canvas width as the bar's budget — leaves room
      // for the label and looks balanced in the bottom-left corner.
      const budgetPx = Math.max(80, Math.min(out.width * 0.22, 400));
      const bar = computeScaleBar(ppm, budgetPx);
      if (bar.stepPixels > 0) {
        drawScaleBar(ctx, out, bar);
      }
    }

    // LiveProbe — same compositing pattern. The probe stores its last known
    // cursor position in CLIENT coordinates; translate to canvas-local pixels
    // via the canvas's bounding rect so the bake lands where the user saw
    // the readout.
    if (wantProbe) {
      const probe = this._probe.activeProbeForExport();
      if (probe) {
        const rect = this._canvas.getBoundingClientRect();
        const sx = (probe.client.x - rect.left) * (out.width / rect.width);
        const sy = (probe.client.y - rect.top) * (out.height / rect.height);
        drawProbeReadoutCard(ctx, probe.info, { x: sx, y: sy });
      }
    }
    return this._canvasToBlob(out);
  }

  /** Encode a canvas to a PNG `Blob`, rejecting if the browser returns none. */
  private _canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Viewer.snapshot(): canvas.toBlob returned null'));
      }, 'image/png');
    });
  }

  /**
   * Visual Export Studio — render the live scene through a registered
   * export mode and return the result as a `Blob` ready for download.
   *
   * The Studio ships seven modes: `orthographic-rgb`, `height-map`,
   * `intensity`, `classification`, `depth`, `normal`, `contour`. The mode
   * factories live in their own code-split chunk (`loadExportStudio`) so they
   * only ship when the user opens the Studio panel or invokes an Export
   * action.
   *
   * The {@link ExportSceneAdapter} below is the narrow Viewer slice each
   * exporter consumes — colour-mode swap (and restore) and cloud capability
   * queries. Defining it inline here keeps the export module free of any
   * circular dependency on the Viewer class.
   */
  async exportImage(
    mode: ExportMode,
    options: ExportOptions = {},
    classScopeStamp = '',
  ): Promise<ExportResult> {
    const studio = await loadExportStudio();
    return studio.renderExport(
      mode,
      {
        renderer: this._renderer,
        scene: this._scene,
        camera: this._camera,
        canvas: this._canvas,
        adapter: this._buildExportAdapter(),
        // Class-filter scope stamp from the call site — drives the "showing
        // N of M classes" banner the Studio composes onto a filtered raster.
        // Empty string when nothing is hidden, keeping the export unchanged.
        classScopeStamp,
      },
      options,
    );
  }

  /**
   * Per-mode availability for the Visual Export Studio buttons, computed
   * inline from the same {@link ExportSceneAdapter} the Studio orchestrator
   * uses at render time. The Inspector calls this after each load so the
   * Normal map / Intensity / Class map buttons can be disabled at the
   * source on clouds that don't carry the required channel (LAZ has no
   * normals; PLY has no intensity; PCD without label channel has no
   * classification). Without this, the user could click those buttons and
   * get the orchestrator's "mode 'X' is not available" toast — a real UX
   * regression vs. a visibly-disabled button with a tooltip explaining why.
   *
   * Returns a plain map of mode → availability so this stays
   * shell-bundle-safe (no import of the lazy-loaded `defaultExportRegistry`
   * — which would pull every exporter into the initial chunk). The gates
   * here MUST stay in lockstep with each exporter's `isAvailable` /
   * `unavailableReason`. The contract is one-way: a mode missing from this
   * map renders as disabled.
   */
  availableImageExportModes(): ReadonlyMap<
    ExportMode,
    { readonly available: boolean; readonly reason?: string }
  > {
    const adapter = this._buildExportAdapter();
    const aabb = adapter.localBoundsAabb();
    const hasAabb = aabb !== null;
    const zRange = aabb ? aabb[5] - aabb[2] : 0;
    const hasIntensity = adapter.hasIntensity();
    const hasClassification = adapter.hasClassification();
    const hasNormals = adapter.hasNormals();

    const out = new Map<
      ExportMode,
      { readonly available: boolean; readonly reason?: string }
    >();

    // orthographic-rgb — always available (current-mode passthrough).
    out.set('orthographic-rgb', { available: true });

    // height-map — needs an AABB with a non-degenerate Z extent.
    if (!hasAabb) {
      out.set('height-map', { available: false, reason: 'No cloud is loaded.' });
    } else if (zRange <= 1e-4) {
      out.set('height-map', {
        available: false,
        reason: 'Cloud has no measurable height range.',
      });
    } else {
      out.set('height-map', { available: true });
    }

    // intensity — needs an AABB + the channel.
    if (!hasAabb) {
      out.set('intensity', { available: false, reason: 'No cloud is loaded.' });
    } else if (!hasIntensity) {
      out.set('intensity', {
        available: false,
        reason: 'This cloud has no per-point intensity channel.',
      });
    } else {
      out.set('intensity', { available: true });
    }

    // classification — needs an AABB + the channel.
    if (!hasAabb) {
      out.set('classification', { available: false, reason: 'No cloud is loaded.' });
    } else if (!hasClassification) {
      out.set('classification', {
        available: false,
        reason: 'This cloud has no per-point classification channel.',
      });
    } else {
      out.set('classification', { available: true });
    }

    // normal — needs the channel. LiDAR captures rarely include normals.
    if (!hasNormals) {
      out.set('normal', {
        available: false,
        reason:
          'This cloud has no per-point normals. LiDAR captures rarely include them; PCD / PTX / GLTF scans with normals are supported.',
      });
    } else {
      out.set('normal', { available: true });
    }

    return out;
  }

  /**
   * Construct the {@link ExportSceneAdapter} that each Studio exporter uses
   * to drive the live Viewer. Held inline (not as a stored field) so the
   * adapter always reflects the current loaded clouds without bookkeeping.
   */
  private _buildExportAdapter(): ExportSceneAdapter {
    const viewer = this;
    return {
      setExportColorMode(mode: ColorMode): void {
        // Apply to every loaded cloud + the streaming subsystem so every
        // resident mesh recolours in lockstep. Wrap each cloud's setColorMode
        // individually: if one cloud lacks the channel for `mode` (e.g.
        // classification on a PLY), `colorForMode` throws — we catch + skip
        // so the other clouds (and the streaming cloud, if any) still
        // recolour, and the export proceeds against whatever data IS valid.
        // Without this guard, a single channel-missing cloud poisoned the
        // whole export and left the UI half-recoloured.
        for (const id of viewer._clouds.keys()) {
          try {
            viewer.setColorMode(id, mode);
          } catch (err) {
            // Swallow per-cloud capability mismatches — the orchestrator's
            // `isAvailable` gate is the source of truth for whether the
            // export *should* run. This catch only protects mid-loop state.
            console.warn(`[export] setColorMode(${mode}) on cloud "${id}" skipped:`, err);
          }
        }
        try {
          viewer.setStreamingColorMode(mode);
        } catch (err) {
          console.warn(`[export] setStreamingColorMode(${mode}) skipped:`, err);
        }
      },
      currentColorMode(): ColorMode {
        // Prefer the streaming cloud's mode when present — otherwise the
        // first static cloud's mode, otherwise the runtime default.
        if (viewer._streaming) return viewer._streaming.renderer.colorMode;
        const first = viewer._clouds.values().next().value;
        return first ? first.mode : 'rgb';
      },
      hasRgb(): boolean {
        if (viewer._streaming) {
          // read off the abstract `availableColorModes` so this
          // works uniformly for COPC + EPT. The cloud's own implementation
          // knows whether it carries RGB (COPC: PDRF 7/8; EPT: schema has
          // Red/Green/Blue attrs).
          return viewer._streaming.cloud.availableColorModes().includes('rgb');
        }
        for (const { cloud } of viewer._clouds.values()) {
          if (cloud.colors) return true;
        }
        return false;
      },
      hasIntensity(): boolean {
        // Streaming COPC clouds always carry intensity (PDRF 6/7/8).
        if (viewer._streaming) return true;
        for (const { cloud } of viewer._clouds.values()) {
          if (cloud.intensity) return true;
        }
        return false;
      },
      hasClassification(): boolean {
        // dispatch on the abstract `availableColorModes()` so
        // COPC and EPT route uniformly. Static clouds fall through to
        // the explicit field check.
        if (viewer._streaming) {
          return viewer._streaming.cloud.availableColorModes().includes('classification');
        }
        for (const { cloud } of viewer._clouds.values()) {
          if (cloud.classification) return true;
        }
        return false;
      },
      hasNormals(): boolean {
        // COPC + EPT streaming sources never carry normals in
        // production (LAS reserves no field for them; EPT writers rarely
        // emit Normal X/Y/Z attrs). Static loaders (PCD, PTX, GLTF)
        // sometimes do — check the field explicitly.
        if (viewer._streaming) return false;
        for (const { cloud } of viewer._clouds.values()) {
          if (cloud.normals) return true;
        }
        return false;
      },
      snapshot(options: {
        measurements: boolean;
        annotations: boolean;
        inspector: boolean;
        probe: boolean;
      }): Promise<Blob> {
        // Delegate to the live snapshot pipeline so the export matches the
        // on-screen view EXACTLY — EDL, perspective camera, overlays, all
        // baked through the same code path the Save-view feature
        // uses. The inspector + probe flags add the Studio bakes:
        // active Inspect tool's marker + info card, and LiveProbe's last-
        // known readout. Together they capture every on-canvas data overlay
        // the user might have been working with when they clicked Export.
        return viewer.snapshot({
          measurements: options.measurements,
          annotations: options.annotations,
          inspector: options.inspector,
          probe: options.probe,
        });
      },
      sourceName(): string {
        if (viewer._streaming) return viewer._streaming.cloud.name;
        const first = viewer._clouds.values().next().value;
        return first?.cloud.name ?? 'scan';
      },
      sourcePointCount(): number {
        if (viewer._streaming) return viewer._streaming.cloud.sourcePointCount;
        let total = 0;
        for (const { cloud } of viewer._clouds.values()) total += cloud.pointCount;
        return total;
      },
      residentPointCount(): number {
        if (viewer._streaming) return viewer._streaming.cloud.residentPointCount;
        // Static clouds: every loaded point is resident.
        return this.sourcePointCount();
      },
      crsLabel(): { name: string; unit: string; epsg?: number } | null {
        // read off the abstract `cloud.crs()` so both COPC and
        // EPT surface consistently. COPC pulls from the LAS VLRs the
        // header parser walked; EPT pulls from `ept.json`'s `srs.wkt`.
        // Static clouds carry CRS through `CloudMetadata.crs`.
        const fromStreaming = viewer._streaming?.cloud.crs();
        if (fromStreaming) {
          return {
            name: fromStreaming.name,
            unit: linearUnitLabel(fromStreaming.linearUnit),
            epsg: fromStreaming.epsg,
          };
        }
        for (const { cloud } of viewer._clouds.values()) {
          const crs = cloud.metadata?.crs;
          if (crs) {
            return {
              name: crs.name,
              unit: linearUnitLabel(crs.linearUnit),
              epsg: crs.epsg,
            };
          }
        }
        return null;
      },
      captureLabel(): { label: string; confidence: 'low' | 'medium' | 'high' } | null {
        // Compute the same provenance fingerprint the Inspector + PDF
        // Provenance section surface. Auto-computed, varies per scan;
        // exporters get it via `baseReportRows` without any per-mode
        // code. Wrapped because a malformed cloud shape shouldn't sink
        // the export — null is a clean no-op in the renderer.
        try {
          if (viewer._streaming) {
            const f = classifyProvenance(
              signalsForStreamingCloud(viewer._streaming.cloud as never),
            );
            return { label: f.label, confidence: f.confidence };
          }
          const first = viewer._clouds.values().next().value;
          if (first) {
            const f = classifyProvenance(
              signalsForStaticCloud(first.cloud as never),
            );
            return { label: f.label, confidence: f.confidence };
          }
        } catch {
          /* defensive — null falls back to "no Capture row" */
        }
        return null;
      },
      localBoundsAabb(): readonly [number, number, number, number, number, number] | null {
        // Streaming first — it has authoritative bounds from the COPC header.
        if (viewer._streaming) {
          return viewer._streaming.cloud.localBounds();
        }
        // Fold every static cloud's bounds into a combined AABB.
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let any = false;
        for (const { cloud } of viewer._clouds.values()) {
          const bb = cloud.bounds();
          any = true;
          if (bb.min[0] < minX) minX = bb.min[0];
          if (bb.min[1] < minY) minY = bb.min[1];
          if (bb.min[2] < minZ) minZ = bb.min[2];
          if (bb.max[0] > maxX) maxX = bb.max[0];
          if (bb.max[1] > maxY) maxY = bb.max[1];
          if (bb.max[2] > maxZ) maxZ = bb.max[2];
        }
        return any ? [minX, minY, minZ, maxX, maxY, maxZ] : null;
      },
      georefContext(): {
        worldOrigin: { x: number; y: number } | null;
        wkt: string | null;
      } | null {
        // Mirrors main.ts's `getMapContext` (the contour/DEM seam): the
        // streaming cloud's recentre offset lives on `renderOrigin` and its
        // CRS on `crs()`; static clouds carry both on the cloud record.
        if (viewer._streaming) {
          const origin = viewer._streaming.cloud.renderOrigin;
          return {
            worldOrigin: origin ? { x: origin[0], y: origin[1] } : null,
            wkt: viewer._streaming.cloud.crs()?.wkt ?? null,
          };
        }
        // Static path: only assert a single, unambiguous frame. With several
        // clouds loaded the per-cloud origins can differ — a world file in
        // one cloud's frame would silently misplace the others, so we only
        // georeference when every loaded cloud shares the SAME origin.
        let worldOrigin: { x: number; y: number } | null = null;
        let wkt: string | null = null;
        let any = false;
        for (const { cloud } of viewer._clouds.values()) {
          any = true;
          const o = cloud.origin;
          if (!o) return null;
          if (worldOrigin === null) {
            worldOrigin = { x: o[0], y: o[1] };
          } else if (worldOrigin.x !== o[0] || worldOrigin.y !== o[1]) {
            return null; // conflicting frames — honestly not georeferenceable
          }
          if (wkt == null) wkt = cloud.metadata?.crs?.wkt ?? null;
        }
        return any ? { worldOrigin, wkt } : null;
      },
      async framedTopDownSnapshot(options: { widthPx?: number }): Promise<{
        blob: Blob;
        widthPx: number;
        heightPx: number;
        extent: { minX: number; minY: number; maxX: number; maxY: number };
      } | null> {
        const aabb = this.localBoundsAabb();
        if (!aabb) return null;
        return viewer._renderFramedTopDown(aabb, options.widthPx);
      },
    };
  }

  /**
   * Render the scene through a TRUE top-down orthographic camera framing the
   * full XY footprint and capture it as a PNG (the georeferenced ortho path
   * of the Visual Export Studio, v0.4.5). The framed render is the only
   * raster an affine `.pgw` world file can describe — the WYSIWYG snapshot's
   * perspective projection cannot be georeferenced.
   *
   * Renders DIRECT (no EDL post pass): the EDL pipeline's scene pass is
   * bound to the live perspective camera, and depth-edge shading is a
   * reading aid, not data — a placed GIS raster should carry the points'
   * colours, nothing else. No overlays / scan-report card are composited
   * either: their pixels would corrupt the raster as data (the metadata
   * travels in the ZIP's `.pgw`/`.prj` sidecars instead).
   *
   * The renderer size round-trip is `try/finally`-wrapped so a throw cannot
   * leave the live canvas at export resolution.
   */
  private async _renderFramedTopDown(
    aabb: readonly [number, number, number, number, number, number],
    widthPx?: number,
  ): Promise<{
    blob: Blob;
    widthPx: number;
    heightPx: number;
    extent: { minX: number; minY: number; maxX: number; maxY: number };
  } | null> {
    await this.ready;
    // All numbers come from the pure, unit-tested framing planner — the
    // extent it returns is DERIVED from the camera pose + frustum
    // (`orthoFrustumWorldRect`), so the rectangle the world file describes
    // is by construction the rectangle this camera renders. The planner is
    // a dependency-free leaf module, so importing it statically here does
    // not pull the lazy Studio chunk into the shell bundle.
    const framing = frameTopDownOrtho(aabb, widthPx);
    if (!framing) return null; // degenerate footprint
    const { frustum, camera: pose } = framing;
    const camera = new THREE.OrthographicCamera(
      frustum.left,
      frustum.right,
      frustum.top,
      frustum.bottom,
      frustum.near,
      frustum.far,
    );
    // Straight down (-Z; render space is Z-up) with +Y at the image top, so
    // the raster is north-up — the orientation the world file asserts.
    camera.position.set(pose.x, pose.y, pose.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(pose.x, pose.y, pose.lookZ);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    // Output size: requested width (default 2048), height from the
    // footprint aspect so pixels stay square to within the 1 px rounding the
    // world file's independent X/Y scales absorb exactly.
    const outW = framing.widthPx;
    const outH = framing.heightPx;

    const gl = this._renderer.domElement as HTMLCanvasElement;
    const prevSize = this._renderer.getSize(new THREE.Vector2());
    const prevRatio = this._renderer.getPixelRatio();
    try {
      // Pixel ratio 1 so the drawing buffer is EXACTLY outW × outH — the
      // world file divides the extent by these pixel counts.
      this._renderer.setPixelRatio(1);
      this._renderer.setSize(outW, outH, false);
      // Two render+present cycles for the same WebGPU buffer-flush reason
      // `snapshot()` documents: a single un-awaited render captures the
      // previous frame.
      const present = (): Promise<void> => {
        this._renderer.render(this._scene, camera);
        return new Promise((resolve) => {
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => resolve());
          } else {
            setTimeout(resolve, 0);
          }
        });
      };
      await present();
      await present();
      const blob = await this._canvasToBlob(gl);
      return {
        blob,
        widthPx: outW,
        heightPx: outH,
        // The frustum-derived rectangle — exactly what the camera framed.
        extent: framing.extent,
      };
    } finally {
      this._renderer.setPixelRatio(prevRatio);
      this._renderer.setSize(prevSize.x, prevSize.y, false);
      // Repaint the live view at the restored size on the next frames.
      this._bumpRenderActivity();
    }
  }

  /**
   * Stop the render loop, dispose all clouds, and free renderer resources.
   *
   * WebGL fallback hardening. Listener removal and
   * `ResizeObserver` disconnect are the leak-class fixes proved by
   * `tests/viewerLifecycle.test.ts`'s 50-cycle harness: a re-created
   * Viewer on the same canvas no longer accumulates listeners or
   * ResizeObserver subscriptions across the cycle.
   */
  dispose(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    // Remove every listener the constructor registered. Each is a stored
    // bound reference so the symmetric `removeEventListener` call actually
    // matches — anonymous arrow functions would silently leak.
    this._canvas.removeEventListener('dblclick', this._onCanvasDblClick);
    this._canvas.removeEventListener('click', this._onCanvasClick);
    this._canvas.removeEventListener('pointermove', this._onCanvasPointerMove);
    this._canvas.removeEventListener('pointerleave', this._onCanvasPointerLeave);
    this._canvas.removeEventListener('pointerdown', this._onCanvasPointerDown);
    this._canvas.removeEventListener('pointerup', this._onCanvasPointerUp);
    this._canvas.removeEventListener('pointercancel', this._onCanvasPointerCancel);
    this._activeTouches.clear();
    window.removeEventListener('keydown', this._onWindowKeyDown);
    if (typeof document !== 'undefined' && this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    // Disconnect the ResizeObserver so the canvas can be garbage-collected
    // when the host eventually drops it.
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    // Cancel any RAF scheduled by the resize debouncer so a disposed Viewer
    // doesn't run a final resize on a torn-down renderer.
    if (this._resizeRafId !== null) {
      cancelAnimationFrame(this._resizeRafId);
      this._resizeRafId = null;
    }
    // Clear the recolour throttle's trailing timer so it can't fire a recolour
    // on a torn-down renderer after dispose.
    if (this._recolorThrottleHandle !== null) {
      clearTimeout(this._recolorThrottleHandle);
      this._recolorThrottleHandle = null;
      this._recolorThrottlePending = false;
    }
    for (const id of [...this._clouds.keys()]) {
      this.removeCloud(id);
    }
    // `removeCloud` drops each cloud's snapshots, but clear both maps
    // outright in case a snapshot ever outlived its cloud entry.
    this._classHistory.clear();
    this._classEpochs.clear();
    this._selectionSnapshots.clear();
    this.detachStreamingCloud();
    this._nav.dispose();
    this._measure.dispose();
    this._inspect.dispose();
    this._annotate.dispose();
    this._probe.dispose();
    this._controls.dispose();
    // Release the post-processing pipeline's render targets before the renderer.
    this._post.dispose();
    this._scenePass.dispose();
    this._renderer.dispose();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Apply the current point-size mode to one material, folding in the class
   * visibility mask so it applies in BOTH size modes.
   *
   * The class mask must multiply the FINAL resolved size, but the size is
   * resolved differently per mode: adaptive mode encodes size in
   * `_adaptiveSizeNode` (driven by `_pointSizeUniform`), while fixed mode uses
   * the scalar `material.size` and would otherwise leave `sizeNode = null`.
   * `PointsNodeMaterial` IGNORES `material.size` whenever `sizeNode` is set, so
   * to keep fixed mode's pixel size while still masking we route fixed mode
   * through `materialPointSize` (the node form of `material.size`) and multiply
   * that by the mask. With the default all-1 mask the multiply is the identity,
   * so the unfiltered scene is pixel-for-pixel unchanged.
   *
   * Only materials whose mesh carries `aClass` get the multiply; class-less
   * meshes keep the exact prior graph (adaptive node or `null`).
   */
  private _applySizeMode(material: THREE.PointsNodeMaterial): void {
    const adaptive = this._pointSizeMode === 'adaptive';
    // A fold enters this material's size graph only when BOTH the mesh carries
    // the required attribute AND the corresponding filter is currently active.
    //
    // Gating on the ACTIVE state (not just attribute presence) is deliberate and
    // load-bearing: an inactive filter used to still fold its mask into every
    // carrier mesh, relying on the `mix(1, …, enabled)` identity to be a no-op.
    // That left `attribute('aPos')` / `attribute('aIntensity')` reads compiled
    // into essentially every scan's vertex shader even with no filter in use —
    // a shape the plain-open path never had before v0.5.6, and the regression
    // behind "scans open but nothing renders." With this gate, a scan opened
    // without any active filter gets the exact pre-filter graph (adaptive node
    // or `null`) — no extra attribute reads, no mask math. Folds appear only
    // when the user actually turns a filter on (which re-runs this via
    // `_reapplyAllSizeModes`, rebuilding the pipeline for that transition).
    const foldClass = this._materialsWithClass.has(material) && this._classFiltered;
    const foldElev = this._materialsWithElev.has(material) && this._elevFilterEnabled.value !== 0;
    const foldInten = this._materialsWithInten.has(material) && this._intenFilterEnabled.value !== 0;
    if (!foldClass && !foldElev && !foldInten) {
      material.sizeNode = (
        adaptive ? this._adaptiveSizeNode : null
      ) as typeof material.sizeNode;
      return;
    }
    // At least one filter is active on this material. Route fixed mode through
    // `materialPointSize` (the node form of `material.size`) so the pixel size is
    // preserved while the mask(s) multiply it, then fold each active multiplier.
    let node: TslNode = adaptive ? this._adaptiveSizeNode : materialPointSize;
    if (foldElev) node = node.mul(this._elevMaskMultiplier());
    if (foldClass) node = node.mul(this._classMaskMultiplier());
    if (foldInten) node = node.mul(this._intenMaskMultiplier());
    material.sizeNode = node as typeof material.sizeNode;
  }

  /**
   * The per-point class-mask multiplier node: reads the `aClass` instance
   * attribute, truncates it to an integer class code (class codes are exact
   * integers in the float attribute), and looks up the shared 256-entry mask.
   * Resolves to `1` when the class is shown and `0` when hidden — multiplying
   * a hidden point's size by 0 collapses its sprite quad to nothing.
   *
   * Mirrors the `classVisibleAt(mask, code)` test used by the pure helpers and
   * the UI: `mask[code] === 1`.
   */
  private _classMaskMultiplier(): TslNode {
    // `attribute()` / `int()` / `.element()` are dynamically-typed TSL chains;
    // route the per-point class code through `TslNode` (the `any` alias used by
    // every node builder in this file) so the strict overloads don't reject it.
    const aClass: TslNode = attribute('aClass');
    const code: TslNode = int(aClass);
    return (this._classMaskUniform as TslNode).element(code);
  }

  /**
   * The per-point elevation-mask multiplier (v0.5.6): reads the up-axis
   * component of the instanced position (`aPos`), tests it against the inclusive
   * `[min, max]` window, and resolves to `1` (in range or filter off) or `0`
   * (out of range) — multiplying an out-of-range point's size by 0 collapses its
   * sprite to nothing, exactly like the class mask.
   *
   * Built from `step` + `mix` only (no boolean nodes): `lo = step(min, elev)` is
   * 1 when `elev >= min`; `hi = step(elev, max)` is 1 when `elev <= max`; their
   * product is the inclusive in-range flag. `mix(1, inRange, enabled)` yields the
   * identity `1` when the filter is disabled, so the graph is a no-op until a
   * window is set. `axisIsZ` picks z (Z-up) or y (Y-up) without a rebuild.
   */
  private _elevMaskMultiplier(): TslNode {
    const pos: TslNode = attribute('aPos');
    const axisIsZ: TslNode = this._elevFilterAxisIsZ;
    const elev: TslNode = pos.z.mul(axisIsZ).add(pos.y.mul(axisIsZ.oneMinus()));
    const lo: TslNode = step(this._elevFilterMin as TslNode, elev); // elev >= min
    const hi: TslNode = step(elev, this._elevFilterMax as TslNode); // elev <= max
    const inRange: TslNode = lo.mul(hi);
    return mix(float(1), inRange, this._elevFilterEnabled as TslNode);
  }

  /**
   * The per-point intensity-mask multiplier (v0.5.6): reads the `aIntensity`
   * instance attribute, tests it against the inclusive `[min, max]` window, and
   * resolves to `1` (in range or filter off) or `0` (out of range). Same
   * `step` + `mix` construction as the elevation mask — no origin shift, since
   * intensity is a raw scalar compared directly against the window.
   */
  private _intenMaskMultiplier(): TslNode {
    const inten: TslNode = attribute('aIntensity');
    const lo: TslNode = step(this._intenFilterMin as TslNode, inten); // inten >= min
    const hi: TslNode = step(inten, this._intenFilterMax as TslNode); // inten <= max
    const inRange: TslNode = lo.mul(hi);
    return mix(float(1), inRange, this._intenFilterEnabled as TslNode);
  }

  /**
   * Record one frame's duration into the rolling buffer. A non-positive or
   * very large delta — the first frame, or a return from a backgrounded tab —
   * is dropped so a spurious gap cannot skew the reported frame rate.
   */
  private _recordFrame(deltaSeconds: number): void {
    const ms = deltaSeconds * 1000;
    if (ms <= 0 || ms > 1000) return;
    this._frameTimes[this._frameWrite] = ms;
    this._frameWrite = (this._frameWrite + 1) % this._frameTimes.length;
    if (this._frameCount < this._frameTimes.length) this._frameCount++;
    // Per-frame streaming-session sampling for the benchmark — only when a
    // benchmark is collecting on a streaming scan. The hot path stays cheap.
    this._streaming?.benchmark?.recordFrameMs(ms);
  }

  /** A coarse mobile check — a small viewport, matching the app's phone heuristic. */
  private _isMobile(): boolean {
    return typeof window !== 'undefined'
      && window.matchMedia('(max-width: 767px)').matches;
  }

  /** Configure navigation (up-axis, speed, clip planes) for the loaded clouds. */
  private _configureForClouds(latest: PointCloud): void {
    // LAS/LAZ/XYZ/E57 surveys are Z-up; phone-scan formats are Y-up.
    const zUp = isZUpFormat(latest.sourceFormat);
    this._worldUp.set(0, 0, zUp ? 1 : 0);
    if (!zUp) this._worldUp.set(0, 1, 0);
    this._nav.setWorldUp(this._worldUp);
    this._measure.setContext({
      worldUp: [this._worldUp.x, this._worldUp.y, this._worldUp.z],
      origin: latest.origin,
    });

    const sphere = this._visibleBoundingSphere();
    const size = sphere ? sphere.radius * 2 : 100;
    this._nav.setBaseSpeed(speedForSize(size));
    this._nav.setHasCloud(true);

    // capture point density for density-aware EDL.
    // Density = total source points / XY footprint area. For an aerial
    // survey this is genuinely "points per square metre on the ground".
    {
      const aabb = this._visibleCloudAabb();
      if (aabb) {
        const w = aabb[3] - aabb[0];
        const d = aabb[4] - aabb[1];
        const footprint = Math.max(1, w * d);
        let totalPts = 0;
        for (const { cloud } of this._clouds.values()) totalPts += cloud.pointCount;
        this._currentDensityPtsPerM2 = totalPts / footprint;
      } else {
        this._currentDensityPtsPerM2 = null;
      }
    }

    // Clip planes — near pinned at 1 cm so zoom-in is unbounded across any
    // cloud size (a 1 km aerial scan, a 50 km COPC tile, an indoor 5 m
    // capture, all the same). Previous behaviour scaled near with cloud
    // size, which on large surveys parked the near plane 0.2-10 m in
    // front of the camera and blocked close inspection. The far plane
    // still scales with the cloud so a coarse fly-around stays framed.
    //
    // Depth-buffer precision at near=0.01, far=50km is ~3-4 quanta per
    // millimetre with a 24-bit depth attachment — fine for both scene
    // rendering and EDL's linearised-depth pass.
    this._camera.near = 0.01;
    this._camera.far = Math.max(size * 16, 1000);
    this._camera.updateProjectionMatrix();

    // Keep the EDL depth-linearisation uniforms in step with the camera, and
    // set the adaptive-sizing reference distance to the framing distance — so
    // a freshly framed scan shows points at close to the chosen base size.
    this._edlNear.value = this._camera.near;
    this._edlFar.value = this._camera.far;
    const radius = sphere && sphere.radius > 0 ? sphere.radius : 1;
    const fovRad = THREE.MathUtils.degToRad(this._camera.fov);
    this._attnRef.value = (radius / Math.sin(fovRad / 2)) * 1.2;
    this._applyOrbitBounds(radius);
    // Snap the orbit pivot to the cloud's volumetric centre at attach so the
    // very first user click — before `frameAll` has a chance to tween — still
    // orbits around the scan rather than the dataset's coordinate origin.
    // The render-loop's clamp gate keeps it there once panned.
    this._initOrbitCenterFromVisibleClouds();
  }

  /** Combined bounding sphere of every visible cloud, or null if none. */
  /** The AABB of every visible cloud (+ the streaming octree extent), or null. */
  private _visibleBoundingBox(): THREE.Box3 | null {
    const box = new THREE.Box3();
    let any = false;
    for (const { mesh, cloud } of this._clouds.values()) {
      if (!mesh.visible) continue;
      const b = cloud.bounds();
      box.expandByPoint(new THREE.Vector3(b.min[0], b.min[1], b.min[2]));
      box.expandByPoint(new THREE.Vector3(b.max[0], b.max[1], b.max[2]));
      any = true;
    }
    // A streaming COPC contributes its whole octree extent so framing works
    // before any node has finished decoding.
    if (this._streaming) {
      const lb = this._streaming.cloud.localBounds();
      box.expandByPoint(new THREE.Vector3(lb[0], lb[1], lb[2]));
      box.expandByPoint(new THREE.Vector3(lb[3], lb[4], lb[5]));
      any = true;
    }
    return any && !box.isEmpty() ? box : null;
  }

  private _visibleBoundingSphere(): THREE.Sphere | null {
    const box = this._visibleBoundingBox();
    if (!box) return null;
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    return sphere;
  }

  /**
   * Combined visible-cloud AABB as a six-tuple, or null if no cloud is
   * loaded. This is the shape `orbitCenter.ts` consumes — calling it once at
   * attach avoids re-walking the cloud map in the render loop.
   */
  private _visibleCloudAabb(): OrbitAabb | null {
    const box = new THREE.Box3();
    let any = false;
    for (const { mesh, cloud } of this._clouds.values()) {
      if (!mesh.visible) continue;
      const b = cloud.bounds();
      box.expandByPoint(new THREE.Vector3(b.min[0], b.min[1], b.min[2]));
      box.expandByPoint(new THREE.Vector3(b.max[0], b.max[1], b.max[2]));
      any = true;
    }
    if (this._streaming) {
      const lb = this._streaming.cloud.localBounds();
      box.expandByPoint(new THREE.Vector3(lb[0], lb[1], lb[2]));
      box.expandByPoint(new THREE.Vector3(lb[3], lb[4], lb[5]));
      any = true;
    }
    if (!any || box.isEmpty()) return null;
    return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
  }

  /**
   * Snap the orbit pivot to the volumetric centre of the currently visible
   * clouds. Called from `_configureForClouds` and `_configureForStreaming` so
   * the orbit target is correct the instant a cloud attaches — *before* the
   * first user click and before the explicit `frameAll()` tween fires.
   * Without this, the very first orbit drag spins around (0, 0, 0) until the
   * user presses R.
   *
   * The Viewer's `frameAll()` continues to handle the smooth oblique opening
   * shot; this routine only fixes the pivot so the camera is already aiming
   * at the cloud when the tween begins.
   */
  private _initOrbitCenterFromVisibleClouds(): void {
    const aabb = this._visibleCloudAabb();
    this._orbitClampAabb = aabb;
    if (!aabb) return;
    const [cx, cy, cz] = aabbCenter(aabb);
    this._controls.target.set(cx, cy, cz);
    this._camera.lookAt(cx, cy, cz);
    this._controls.update();
  }

  /**
   * Per-frame orbit-centre maintenance — called once after `_nav.update()`
   * each render tick. Three behaviours:
   *
   *   1. Soft-clamp the orbit target inside the cloud's AABB inflated by 25 %
   *      of its diagonal, so a user-driven pan never lets the camera spin
   *      around empty space far from the cloud.
   *   2. While a streaming cloud is open, lerp the orbit target toward the
   *      latest bounds centre — only when the centre has shifted by more
   *      than a millimetre — at 5 % per frame, so a node finishing decoding
   *      never produces a visible snap.
   *   3. Suspended while a NavController tween is active (Frame All / Focus
   *      / applyPose) so the tween's own target interpolation isn't fought.
   *
   * Cost is bounded: a handful of vector ops + (when streaming) one octree
   * bounds query — orders of magnitude cheaper than a render pass.
   */
  /**
   * adaptive EDL — modulate the EDL strength uniform from two
   * orthogonal signals so the depth cueing scales with how the cloud is
   * being read, not just what's in it.
   *
   * **Distance factor** — camera-to-target distance normalised against
   * the cloud's bounding radius. Curve:
   *   • distance > 2 × radius (overview): factor = 0.45 (lighter)
   *   • distance < 0.1 × radius (close): factor = 0.95 (stronger)
   *   • smoothstep between
   *
   * **Density factor** — points per square metre on the XY footprint,
   * captured at attach time. Curve (log-scaled because density varies
   * across ~4 orders of magnitude across capture types):
   *   • ~1 pt/m² (very sparse aerial): factor = 1.40 (max strength)
   *   • ~100 pt/m² (dense aerial): factor = 1.05 (near neutral)
   *   • ~10 000 pt/m² (TLS / phone scan): factor = 0.70 (gentler)
   *
   * Final strength = `base × distance_factor × density_factor`. With base
   * defaulting to 0.7, a sparse 1km aerial at close range gets a punchy
   * ~0.93 effective strength, while a dense indoor TLS at overview gets
   * a calm ~0.22 — the right contrast for each context, automatically.
   *
   * No-op when EDL is disabled or no cloud is loaded.
   */
  private _updateAdaptiveEdl(): void {
    if (!this._edlEnabled || !this._orbitClampAabb) return;
    const r = (this._orbitClampAabb[3] - this._orbitClampAabb[0]
             + this._orbitClampAabb[4] - this._orbitClampAabb[1]
             + this._orbitClampAabb[5] - this._orbitClampAabb[2]) / 6;
    if (!Number.isFinite(r) || r <= 0) return;

    // Distance factor — closer = stronger.
    const t = this._controls.target;
    const dx = this._camera.position.x - t.x;
    const dy = this._camera.position.y - t.y;
    const dz = this._camera.position.z - t.z;
    const dist = Math.hypot(dx, dy, dz);
    const nd = dist / r;
    const ramp = Math.max(0, Math.min(1, (2.0 - nd) / (2.0 - 0.1)));
    const smooth = ramp * ramp * (3 - 2 * ramp);
    const distanceFactor = 0.45 + (0.95 - 0.45) * smooth;

    // Density factor — sparse = stronger, dense = gentler.
    // Map log10(density) ∈ [0, 4] → factor ∈ [1.4, 0.7] linearly.
    let densityFactor = 1.0;
    if (this._currentDensityPtsPerM2 != null && this._currentDensityPtsPerM2 > 0) {
      const logD = Math.log10(this._currentDensityPtsPerM2);
      const clamped = Math.max(0, Math.min(4, logD));
      densityFactor = 1.4 - clamped * 0.175;  // 1.4 at 1 pt/m², 0.7 at 10⁴
    }

    // Final strength — base × distance × density. Normalise the distance
    // factor by 0.7 so the slider's "1.0" base lands at neutral close-up.
    this._edlStrength.value =
      this._edlBaseStrength * (distanceFactor / 0.7) * densityFactor;
  }

  private _maintainOrbitCenter(): void {
    if (!this._orbitClampAabb) return;
    if (this._nav.mode !== 'orbit') return;
    if (this._nav.isTweening) return;
    // Suspend the per-frame refinement while the user is actively driving
    // OrbitControls. Lerping the target mid-drag would fight live input;
    // the clamp engages once the gesture ends and OrbitControls' damping
    // settles. Result: drag feels exactly like model-viewer's — no
    // micro-judder, no pull-back yank during the gesture.
    if (this._userInteracting) return;
    // Same suspension for the hand tool's grab (v0.5.5 P1): a middle-mouse
    // temporary grab in orbit mode bypasses OrbitControls entirely, so the
    // `_userInteracting` gate above never sees it — without this check the
    // soft-clamp lerp would fight the live drag. On release, stamp the same
    // settle window OrbitControls gestures get, so the clamp doesn't yank
    // the target the very next frame.
    const nowMs = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    if (this._nav.panDragging) {
      this._panWasDragging = true;
      return;
    }
    if (this._panWasDragging) {
      this._panWasDragging = false;
      this._lastInteractMs = nowMs;
      return;
    }
    // Settle delay — after release, OrbitControls keeps damping the
    // spherical angles for ~15-30 frames. If the soft-clamp lerp engages
    // during that tail, the camera rotates around a target that's also
    // sliding back into the envelope, which reads as a wobbly axis.
    // Skip the maintenance pass until the damping has settled.
    if (isWithinSettleWindow(nowMs, this._lastInteractMs, SETTLE_MS)) return;

    // 1) Streaming refinement — drift the target gently toward the live
    //    centre when the bounds shift materially. For static clouds this
    //    branch is skipped; their AABB is fixed at attach.
    if (this._streaming) {
      const lb = this._streaming.cloud.localBounds();
      const live: Vec3Tuple = [
        (lb[0] + lb[3]) * 0.5,
        (lb[1] + lb[4]) * 0.5,
        (lb[2] + lb[5]) * 0.5,
      ];
      if (this._lastStreamingCenter === null) {
        this._lastStreamingCenter = live;
      } else if (vecDistance(this._lastStreamingCenter, live) > 1e-3) {
        // Axis-feel fix: translate both the target AND the camera so the
        // relative offset stays constant. Without this, OrbitControls
        // recomputes spherical state around the moving target and the
        // user sees the camera "rotating around a weird axis."
        this._translateOrbit(live, STREAMING_LERP_PER_FRAME);
        this._lastStreamingCenter = live;
        // Refresh the clamp AABB so the next clamp step uses the new
        // envelope rather than the attach-time snapshot.
        this._orbitClampAabb = [lb[0], lb[1], lb[2], lb[3], lb[4], lb[5]];
      }
    }

    // 2) Soft-clamp — gently lerp the target back into the inflated
    //    envelope rather than snapping. Same translation contract: the
    //    camera position moves with the target by the same vector, so
    //    the user sees a smooth slide-back rather than an axis spin.
    const t = this._controls.target;
    const clamped = clampTargetToExpandedAabb(
      [t.x, t.y, t.z],
      this._orbitClampAabb,
      EXPAND_FRACTION,
    );
    if (clamped[0] !== t.x || clamped[1] !== t.y || clamped[2] !== t.z) {
      this._translateOrbit(clamped, SOFT_CLAMP_LERP_PER_FRAME);
    }
  }

  /**
   * Move the orbit target a fraction of the way toward `desired`, AND
   * translate the camera position by the same vector. Preserves the
   * camera's relative offset so OrbitControls' spherical state stays
   * stable — what the user sees is the scene moving, not the camera
   * rotating around a sliding axis.
   *
   * This is the central insight behind the second axis-feel fix: any
   * programmatic change to `controls.target` MUST be mirrored on
   * `camera.position` or the visible rotation axis will drift.
   */
  private _translateOrbit(desired: Vec3Tuple, lerpFactor: number): void {
    const t = this._controls.target;
    const current: Vec3Tuple = [t.x, t.y, t.z];
    const next = lerpTowardCenter(current, desired, lerpFactor);
    const dx = next[0] - current[0];
    const dy = next[1] - current[1];
    const dz = next[2] - current[2];
    if (dx === 0 && dy === 0 && dz === 0) return;
    t.set(next[0], next[1], next[2]);
    this._camera.position.x += dx;
    this._camera.position.y += dy;
    this._camera.position.z += dz;
  }

  /**
   * Apply a decomposed 2-pointer touch-gesture delta to the camera. Each
   * channel touches a different bit of the OrbitControls state:
   *
   *   - **dPinch** scales the (camera → target) vector by `1 + dPinch`,
   *     dollying the camera in (negative dPinch) or out (positive). Bounded
   *     by `controls.minDistance` / `maxDistance`.
   *   - **dTwist** rotates the (camera → target) vector around the world
   *     up axis by Δangle radians, which OrbitControls reads back as a
   *     yaw change next `update()`. This is the Maps "rotate bearing"
   *     convention — it matches a top-down LiDAR inspection.
   *   - **dPan** translates the orbit target in the camera's screen-X /
   *     screen-Y basis, scaled by a per-screen-pixel factor that keeps the
   *     pan rate roughly constant at any zoom (further out → pan moves
   *     more world units per pixel).
   *
   * After applying, `controls.update()` repopulates the spherical state so
   * inertia damping resumes from the new pose.
   */
  private _applyTouchGesture(delta: {
    dPinch: number;
    dTwist: number;
    dPan: { x: number; y: number };
  }): void {
    const cam = this._camera;
    const tgt = this._controls.target;

    // ── pinch / dolly ───────────────────────────────────────────────────
    if (delta.dPinch !== 0) {
      // dPinch is the ratio (cur − prev) / mid from the pure-data
      // decomposer: positive when fingers spread, negative when they
      // pinch together. We invert the sign here so the camera follows
      // the standard mobile convention every user already learned from
      // Maps / Photos / Procreate / browsers: spread = zoom IN (closer),
      // pinch = zoom OUT (further). The pure-data module keeps its
      // mathematically natural sign so its unit tests don't have to
      // know about user-facing conventions.
      const ox = cam.position.x - tgt.x;
      const oy = cam.position.y - tgt.y;
      const oz = cam.position.z - tgt.z;
      const scale = 1 - delta.dPinch;
      const distNow = Math.hypot(ox, oy, oz);
      let distNext = distNow * scale;
      // Honour the OrbitControls bounds so the gesture can't drag the
      // camera past min / max distance.
      const minD = this._controls.minDistance;
      const maxD = this._controls.maxDistance;
      if (distNext < minD) distNext = minD;
      if (distNext > maxD) distNext = maxD;
      const f = distNow > 1e-9 ? distNext / distNow : 1;
      cam.position.set(tgt.x + ox * f, tgt.y + oy * f, tgt.z + oz * f);
    }

    // ── twist / yaw around world up ────────────────────────────────────
    if (delta.dTwist !== 0) {
      // Yaw rotates the (camera − target) vector around the world up
      // axis. World up is +Z in the OpenLiDARViewer convention.
      const ox = cam.position.x - tgt.x;
      const oy = cam.position.y - tgt.y;
      const oz = cam.position.z - tgt.z;
      // 2D rotation in the XY plane keeps Z (height) constant.
      const c = Math.cos(delta.dTwist);
      const s = Math.sin(delta.dTwist);
      const nx = ox * c - oy * s;
      const ny = ox * s + oy * c;
      cam.position.set(tgt.x + nx, tgt.y + ny, tgt.z + oz);
    }

    // ── pan / centroid drift ───────────────────────────────────────────
    if (delta.dPan.x !== 0 || delta.dPan.y !== 0) {
      // Translate the target in screen-X / screen-Y. The world-units-per-
      // pixel scale derives from the visible vertical extent at the orbit
      // distance — same idiom OrbitControls' own `pan` uses.
      const cw = this._canvas?.clientHeight ?? 1;
      const fov = (cam.fov ?? 60) * (Math.PI / 180);
      const dist = cam.position.distanceTo(tgt);
      const worldPerPx = (2 * Math.tan(fov / 2) * dist) / Math.max(1, cw);
      // Right vector = +X of the camera basis. Up vector = +Y of the
      // camera basis. We build them from the camera's matrix without
      // touching its private internals.
      const m = cam.matrix.elements;
      const rightX = m[0];
      const rightY = m[1];
      const rightZ = m[2];
      const upX = m[4];
      const upY = m[5];
      const upZ = m[6];
      // dPan.x positive → fingers moved right → world target moves LEFT,
      // matching the OrbitControls drag-to-pan direction users expect.
      const tx = -delta.dPan.x * worldPerPx;
      // dPan.y positive → fingers moved DOWN (canvas Y grows downward) →
      // world target moves UP.
      const ty = delta.dPan.y * worldPerPx;
      const wx = rightX * tx + upX * ty;
      const wy = rightY * tx + upY * ty;
      const wz = rightZ * tx + upZ * ty;
      tgt.set(tgt.x + wx, tgt.y + wy, tgt.z + wz);
      cam.position.set(cam.position.x + wx, cam.position.y + wy, cam.position.z + wz);
    }

    // Refresh the OrbitControls spherical state so the next damping tick
    // resumes from the new pose instead of fighting the gesture.
    this._controls.update();
  }

  /**
   * Current orbit pivot in world coordinates — what `controls.target` holds.
   * Returned as a plain object so callers (diagnostics, embed bridge) don't
   * need a three.js dependency to read it.
   */
  orbitTarget(): { x: number; y: number; z: number } {
    const t = this._controls.target;
    return { x: t.x, y: t.y, z: t.z };
  }

  /**
   * Current camera orbit in spherical coordinates around the target —
   * `{ theta, phi, radius, target }` with theta/phi in radians. Mirrors
   * Google's `<model-viewer>` `getCameraOrbit()` so a research-grade
   * share link can encode the pose in 4 numbers instead of 6.
   *
   *   theta  — azimuthal angle around world-up (0 = looking down -X / -Z
   *            depending on up-axis convention), wrapped into (-π, π].
   *   phi    — polar angle from world-up; 0 = straight up, π = straight
   *            down. Matches three.js `Spherical` exactly.
   *   radius — distance from target to camera, in world units.
   *   target — orbit pivot, same as `orbitTarget()`.
   */
  getOrbit(): {
    theta: number;
    phi: number;
    radius: number;
    target: { x: number; y: number; z: number };
  } {
    const tgt = this._controls.target;
    const offset = new THREE.Vector3().subVectors(this._camera.position, tgt);
    const sph = new THREE.Spherical().setFromVector3(offset);
    return {
      theta: sph.theta,
      phi: sph.phi,
      radius: sph.radius,
      target: { x: tgt.x, y: tgt.y, z: tgt.z },
    };
  }

  /**
   * Programmatically advance the camera dolly by `delta` wheel-ticks. A
   * positive delta zooms *in* (closer to the target), negative zooms *out*.
   * One unit ≈ one mouse-wheel notch — matches Google's `<model-viewer>`
   * `zoom(delta)` contract so the same numeric scale can drive a +/- UI
   * pair, a keyboard shortcut, or a programmatic camera rig.
   *
   * Respects `minDistance` / `maxDistance` set by `_applyOrbitBounds`, so a
   * runaway zoom can never blow past the framing envelope. Cancels any
   * in-progress tween so a user-driven zoom always wins.
   *
   * No-op in walk / fly modes (those navigate the camera, not the dolly).
   */
  zoom(delta: number): void {
    if (this._nav.mode !== 'orbit') return;
    if (!Number.isFinite(delta) || delta === 0) return;
    // One wheel-tick equates to roughly a 5 % dolly change — matches the
    // three.js OrbitControls default `zoomSpeed = 1` scale empirically.
    const SCALE_PER_TICK = 0.95;
    const factor = delta > 0
      ? Math.pow(SCALE_PER_TICK, delta)        // zoom in  → shrink radius
      : Math.pow(1 / SCALE_PER_TICK, -delta);  // zoom out → grow radius
    const tgt = this._controls.target;
    const offset = new THREE.Vector3().subVectors(this._camera.position, tgt);
    const newRadius = THREE.MathUtils.clamp(
      offset.length() * factor,
      this._controls.minDistance,
      this._controls.maxDistance,
    );
    offset.setLength(newRadius);
    this._camera.position.copy(tgt).add(offset);
    this._controls.update();
  }

  /**
   * Volumetric centre of the currently loaded cloud(s), or null when nothing
   * is loaded. Pure read of the cached attach-time AABB; updated when
   * streaming bounds refine.
   */
  cloudCenter(): { x: number; y: number; z: number } | null {
    if (!this._orbitClampAabb) return null;
    const [x, y, z] = aabbCenter(this._orbitClampAabb);
    return { x, y, z };
  }

  /** A unit horizontal axis perpendicular to the current world-up. */
  private _horizontalAxis(): THREE.Vector3 {
    const seed = Math.abs(this._worldUp.z) < 0.9
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(1, 0, 0);
    return new THREE.Vector3().crossVectors(this._worldUp, seed).normalize();
  }

  /**
   * Pick the cloud point under normalised device coords, or null if none.
   * Searches static clouds first, then resident streaming nodes — so
   * measurement and focus work on a COPC scan as well as a static one.
   */
  private _pickPoint(ndcX: number, ndcY: number): THREE.Vector3 | null {
    const onStatic = this._pickDetailed(ndcX, ndcY)?.point;
    if (onStatic) return onStatic;
    return this._pickStreaming(ndcX, ndcY);
  }

  /** Pick a point among the resident streaming node meshes, or null. */
  private _pickStreaming(ndcX: number, ndcY: number): THREE.Vector3 | null {
    return this._pickStreamingDetailed(ndcX, ndcY)?.point ?? null;
  }

  /**
   * Pick the streaming node point under normalised device coords, returning
   * the decoded chunk it belongs to and the point's index — so the inspector
   * and live probe can read its per-point attributes.
   *
   * Resident-only picking. The pick map and the streaming-mesh set
   * are added and removed in lockstep (`addStreamingMesh` /
   * `removeStreamingMesh`), so any divergence between them or any orphaned
   * mesh (parent === null) means an upstream lifecycle bug. The pick path
   * fails closed on either condition: it skips the entry, prunes the map so
   * the bug can't compound, and in dev surfaces a console warning so the
   * stale reference is visible immediately.
   */
  private _pickStreamingDetailed(
    ndcX: number,
    ndcY: number,
  ): {
    decoded: DecodedChunk;
    index: number;
    point: THREE.Vector3;
    streamingRefining: boolean;
  } | null {
    if (this._streamingPickData.size === 0) return null;
    this._pickNdc.set(ndcX, ndcY);
    this._raycaster.setFromCamera(this._pickNdc, this._camera);
    const o = this._raycaster.ray.origin;
    const d = this._raycaster.ray.direction;
    // Resident-only pick invariant — pick from resident meshes only. Prune any orphan
    // sighting so the bug can't compound (and surface it in dev). The
    // resident, visible nodes are then handed to the pure selector below.
    const eligibleMeshes: THREE.Mesh[] = [];
    const eligibleEntries: StreamingPickEntry[] = [];
    for (const [mesh, entry] of this._streamingPickData) {
      if (!this._streamingMeshes.has(mesh) || mesh.parent === null) {
        this._reportStalePickEntry(mesh);
        this._streamingPickData.delete(mesh);
        continue;
      }
      if (!mesh.visible) continue;
      eligibleMeshes.push(mesh);
      eligibleEntries.push(entry);
    }
    if (eligibleEntries.length === 0) return null;
    // Pure selection — angular-miss-fair, refinement-aware. Centralised in
    // `streamingPickSelection.ts` so it's unit-tested separately from the
    // Viewer's mesh-lifecycle plumbing.
    // Only thread classification + the class predicate when a filter is active,
    // so the all-visible hot path allocates and compares exactly as before.
    const mask = this._classMaskUniform.array as ArrayLike<number>;
    const pick = selectStreamingPick(
      eligibleEntries.map((e) => ({
        positions: e.decoded.positions,
        depth: e.depth,
        classification: this._classFiltered ? e.decoded.classification : undefined,
      })),
      [o.x, o.y, o.z],
      [d.x, d.y, d.z],
      this._classFiltered ? (code: number) => classVisibleAt(mask, code) : undefined,
    );
    if (!pick) return null;
    const winning = eligibleEntries[pick.nodeIndex];
    return {
      decoded: winning.decoded,
      index: pick.pointIndex,
      point: new THREE.Vector3(pick.point[0], pick.point[1], pick.point[2]),
      streamingRefining: pick.streamingRefining,
    };
  }

  /**
   * Surface a stale pick-map entry. Production users see nothing; the
   * `?debug=1` overlay session and any dev build get a console warning so
   * the lifecycle bug is visible.
   */
  private _reportStalePickEntry(mesh: THREE.Mesh): void {
    if (typeof import.meta === 'undefined') return;
    const env = (import.meta as { env?: { DEV?: boolean } }).env;
    if (!env?.DEV) return;
    // eslint-disable-next-line no-console
    console.warn(
      'OpenLiDARViewer — streaming pick path saw an unpaired or orphaned mesh; pruning. mesh.uuid=',
      mesh.uuid,
    );
  }

  /**
   * Pick the cloud point under normalised device coords, returning the cloud
   * it belongs to and its buffer index alongside the position — or null on a
   * miss. Selection minimises the angular miss, so a near and a far point are
   * judged fairly; only a reasonably on-target hit (~within 4°) is accepted.
   */
  /**
   * Build the per-point `accept` predicate that confines a pick to currently-
   * visible classes — "you can't click a point you can't see". Returns
   * `undefined` when no class is hidden (the all-visible hot path) or when the
   * buffer carries no classification, so the caller passes no predicate and the
   * search runs exactly as it did pre-feature. When a filter is active, the
   * predicate consults the same 256-entry mask the GPU uses via `classVisibleAt`,
   * so screen and pick agree point-for-point.
   */
  private _classPickAccept(
    classification: ArrayLike<number> | null | undefined,
  ): ((index: number) => boolean) | undefined {
    if (!this._classFiltered || !classification) return undefined;
    const mask = this._classMaskUniform.array as ArrayLike<number>;
    return (index: number) => classVisibleAt(mask, classification[index]);
  }

  private _pickDetailed(
    ndcX: number,
    ndcY: number,
  ): { cloud: PointCloud; index: number; point: THREE.Vector3 } | null {
    this._pickNdc.set(ndcX, ndcY);
    this._raycaster.setFromCamera(this._pickNdc, this._camera);
    const o = this._raycaster.ray.origin;
    const d = this._raycaster.ray.direction;

    let best: { cloud: PointCloud; index: number; point: THREE.Vector3 } | null = null;
    let bestScore = Infinity;
    for (const { mesh, cloud, locked } of this._clouds.values()) {
      if (!mesh.visible || locked) continue;
      const hit = nearestPointAlongRay(
        cloud.positions,
        [o.x, o.y, o.z],
        [d.x, d.y, d.z],
        this._classPickAccept(cloud.classification),
      );
      if (!hit) continue;
      const score = hit.offset / hit.along; // angular miss
      if (score < 0.07 && score < bestScore) {
        bestScore = score;
        best = {
          cloud,
          index: hit.index,
          point: new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2]),
        };
      }
    }
    return best;
  }

  private _handleDoubleClick(e: MouseEvent, canvas: HTMLCanvasElement): void {
    // Polygon kinds (area / volume / polyline / profile) commit on
    // double-click — the tooltips promise this and the user expects
    // it. Distance / height / angle / slope are k-point kinds that
    // commit on their last click, so a double-click there is a
    // no-op anyway. Releasing this branch lets the focus-on-point
    // behaviour win when no tool is active.
    if (this._toolMode === 'measure') {
      this._measure.finishCurrent();
      return;
    }
    if (this._toolMode !== 'none') return; // other tools handle their own dbl
    const ndcX = (e.offsetX / canvas.clientWidth) * 2 - 1;
    const ndcY = -(e.offsetY / canvas.clientHeight) * 2 + 1;
    const point = this._pickPoint(ndcX, ndcY);
    if (point) this._nav.focusOn(point);
  }

  /** While measuring, a canvas click picks the point under the cursor. */
  private _handleMeasureClick(e: MouseEvent, canvas: HTMLCanvasElement): void {
    // Click-first-vertex snap close — when a polygon-kind draft has
    // enough vertices to close, project the first vertex to screen
    // and check whether this click landed within the snap radius.
    // If yes, finish the polygon instead of adding a new vertex.
    const first = this._measure.firstVertexForClose();
    if (first !== null) {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const v = new THREE.Vector3(first[0], first[1], first[2]).project(
        this._camera,
      );
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      const dx = e.offsetX - sx;
      const dy = e.offsetY - sy;
      const CLOSE_RADIUS_PX = 16;
      if (dx * dx + dy * dy <= CLOSE_RADIUS_PX * CLOSE_RADIUS_PX) {
        this._measure.finishCurrent();
        return;
      }
    }
    const ndcX = (e.offsetX / canvas.clientWidth) * 2 - 1;
    const ndcY = -(e.offsetY / canvas.clientHeight) * 2 + 1;
    const hit = this._pickPoint(ndcX, ndcY);
    this._measure.addPoint(hit ? [hit.x, hit.y, hit.z] : null);
  }

  /**
   * While annotating, a canvas click picks the point under the cursor and
   * opens the inline editor on a hit, or reports a clear miss message on a
   * miss — never creating an invalid annotation. Marker clicks are handled by
   * the overlay itself; a click while the editor is open is left to the editor.
   */
  private _handleAnnotateClick(e: MouseEvent, canvas: HTMLCanvasElement): void {
    if (this._annotate.isEditing) return;
    const ndcX = (e.offsetX / canvas.clientWidth) * 2 - 1;
    const ndcY = -(e.offsetY / canvas.clientHeight) * 2 + 1;
    const hit = this._pickPoint(ndcX, ndcY);
    if (hit) {
      this._annotate.beginDraft(
        { x: hit.x, y: hit.y, z: hit.z },
        e.clientX,
        e.clientY,
        this.getCameraState(),
      );
    } else {
      this._annotate.pickMissed();
    }
  }

  /** While inspecting, a canvas click selects the point under the cursor. */
  private _handleInspectClick(e: MouseEvent, canvas: HTMLCanvasElement): void {
    const ndcX = (e.offsetX / canvas.clientWidth) * 2 - 1;
    const ndcY = -(e.offsetY / canvas.clientHeight) * 2 + 1;
    const hit = this._pickDetailed(ndcX, ndcY);
    if (hit) {
      this._inspect.showPoint(this._infoForHit(hit), hit.point);
      return;
    }
    // Fall back to the resident streaming nodes — COPC point inspection.
    const streamHit = this._pickStreamingDetailed(ndcX, ndcY);
    if (streamHit) {
      this._inspect.showPoint(this._infoForStreamingHit(streamHit), streamHit.point);
      return;
    }
    this._inspect.showPoint(null, null);
  }

  /**
   * Build display-ready point info for a detailed pick hit. Shared by the
   * Inspect tool's click and the live probe's hover, so both surface exactly
   * the same per-point data.
   */
  private _infoForHit(hit: {
    cloud: PointCloud;
    index: number;
    point: THREE.Vector3;
  }): PointInfo {
    const { cloud, index, point } = hit;
    const rgb: [number, number, number] | null = cloud.colors
      ? [cloud.colors[index * 3], cloud.colors[index * 3 + 1], cloud.colors[index * 3 + 2]]
      : null;
    const normals = cloud.normals;
    return makePointInfo({
      layer: cloud.name,
      index,
      // `point` is in local space; the cloud's origin restores real-world
      // coordinates — the absolute survey position engineers expect.
      local: [point.x, point.y, point.z],
      origin: cloud.origin,
      distance: this._camera.position.distanceTo(point),
      intensity: cloud.intensity ? cloud.intensity[index] : null,
      classification: cloud.classification ? cloud.classification[index] : null,
      rgb,
      // inspection extras — passed only when the cloud carries them.
      returnNumber: cloud.returnNumber ? cloud.returnNumber[index] : undefined,
      returnCount: cloud.returnCount ? cloud.returnCount[index] : undefined,
      pointSourceId: cloud.pointSourceId ? cloud.pointSourceId[index] : undefined,
      gpsTime: cloud.gpsTime ? cloud.gpsTime[index] : undefined,
      normal: normals
        ? [normals[index * 3], normals[index * 3 + 1], normals[index * 3 + 2]]
        : undefined,
    });
  }

  /**
   * Build display-ready point info for a streaming-node pick hit — the COPC
   * equivalent of {@link _infoForHit}. The decoded chunk carries every
   * per-point attribute, so a streaming scan inspects exactly like a static one.
   */
  private _infoForStreamingHit(hit: {
    decoded: DecodedChunk;
    index: number;
    point: THREE.Vector3;
    streamingRefining: boolean;
  }): PointInfo {
    const { decoded, index, point, streamingRefining } = hit;
    const cloud = this._streaming?.cloud;
    const origin: [number, number, number] = cloud ? cloud.renderOrigin : [0, 0, 0];
    const rgb: [number, number, number] | null = decoded.rgb
      ? [decoded.rgb[index * 3], decoded.rgb[index * 3 + 1], decoded.rgb[index * 3 + 2]]
      : null;
    return makePointInfo({
      layer: cloud ? cloud.name : 'COPC',
      index,
      local: [point.x, point.y, point.z],
      origin,
      distance: this._camera.position.distanceTo(point),
      intensity: decoded.intensity[index],
      classification: decoded.classification[index],
      rgb,
      returnNumber: decoded.returnNumber[index],
      returnCount: decoded.returnCount[index],
      pointSourceId: decoded.pointSourceId ? decoded.pointSourceId[index] : undefined,
      gpsTime: decoded.gpsTime[index],
      // COPC PDRF 6/7/8 carry no surface normals.
      normal: undefined,
      streamingRefining,
    });
  }

  /** `F` key — focus on whatever point is centred in the view. */
  private _focusCenter(): void {
    const point = this._pickPoint(0, 0);
    if (point) this._nav.focusOn(point);
    else this.frameAll();
  }

  /** Feed the current camera view to the streaming scheduler. */
  private _tickStreaming(): void {
    if (!this._streaming) return;
    this._camera.updateMatrixWorld();
    this._streamingViewProj.multiplyMatrices(
      this._camera.projectionMatrix,
      this._camera.matrixWorldInverse,
    );
    this._streamingCamPos[0] = this._camera.position.x;
    this._streamingCamPos[1] = this._camera.position.y;
    this._streamingCamPos[2] = this._camera.position.z;
    // Feed the smoothed frame time from the ring buffer so the scheduler's
    // FPS-pressure adapter can back off the point budget on slow frames
    // and restore it when the device catches up. `_smoothedFrameMs()`
    // returns 0 until the buffer has at least one sample — passing 0
    // tells the scheduler to skip FPS adaptation until real measurements
    // arrive (i.e., during the first few RAF ticks).
    const frameMs = this._smoothedFrameMs();
    this._streaming.scheduler.update({
      viewProjection: this._streamingViewProj.elements,
      cameraPosition: this._streamingCamPos,
      frameTimeMs: frameMs > 0 ? frameMs : undefined,
    });
  }

  /**
   * Average of the live frame-time ring buffer, in milliseconds.
   * Returns 0 before the first frame has been recorded; the
   * `_tickStreaming` consumer treats that as "no sample, don't adapt."
   */
  private _smoothedFrameMs(): number {
    if (this._frameCount === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this._frameCount; i++) sum += this._frameTimes[i];
    return sum / this._frameCount;
  }

  /**
   * Bump the render-activity timestamp so the loop holds at full
   * rAF rate for the next `RENDER_HOLDOVER_MS`. Called from pointer,
   * keyboard, and OrbitControls 'change' listeners so any user input
   * — including damping motion after the gesture ends — keeps the
   * renderer responsive.
   */
  private _bumpRenderActivity(): void {
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    this._renderActivityUntilMs = now + RENDER_HOLDOVER_MS;
  }

  /**
   * Should the loop call `render()` on this iteration?
   * Yes if any of:
   *   - a tween is in progress (camera intro, preset transition);
   *   - the activity timestamp hasn't expired (recent input);
   *   - the streaming scheduler is actively loading nodes (so new
   *     resident points reach the screen as soon as they decode);
   *   - the heartbeat counter ticked, in which case we render once
   *     to keep the scene fresh and reset the counter.
   * Otherwise the frame is skipped — the GPU stays idle, the CPU
   * paths above still run (OrbitControls damping, adaptive EDL,
   * orbit-pivot maintenance) so resume-on-input is glitch-free.
   */
  private _shouldRenderFrame(): boolean {
    if (this._nav.isTweening) return true;
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    if (now < this._renderActivityUntilMs) return true;
    // Streaming activity check — scheduler reports `loading > 0` when
    // there are in-flight node fetches. We render full-rate during
    // load bursts so freshly-decoded nodes appear without latency,
    // then the heartbeat takes over when the scheduler is quiet.
    if (this._streaming) {
      const stats = this._streaming.scheduler.stats();
      if (stats.loading > 0 || stats.queued > 0) return true;
    }
    if (this._idleRenderHeartbeat >= IDLE_HEARTBEAT_FRAMES) return true;
    return false;
  }

  /**
   * P5 — set the renderer's device-pixel-ratio for this frame. Full resolution
   * when parked; a reduced ratio while moving, driven by the camera's angular
   * speed (the P3 signal). `setPixelRatio` reallocates the drawing buffer, so
   * `shouldApplyDpr` sharpens immediately on park but rate-limits reductions.
   * Reads the live applied ratio back from the renderer (no separate bookkeeping
   * to desync with the resize handler). No-op unless the frame renders and the
   * `?adaptiveDpr` flag is on; DPR-only, so it is camera-agnostic (ortho-safe).
   */
  private _applyAdaptiveDpr(moving: boolean, dt: number, nowMs: number, rendered: boolean): void {
    if (!this._adaptiveDpr || !rendered) return;
    const q = this._camera.quaternion;
    this._curCamQuat[0] = q.x;
    this._curCamQuat[1] = q.y;
    this._curCamQuat[2] = q.z;
    this._curCamQuat[3] = q.w;
    const angularSpeed = this._hasPrevCamQuat
      ? angularVelocity(this._prevCamQuat, this._curCamQuat, dt)
      : 0;
    this._prevCamQuat[0] = q.x;
    this._prevCamQuat[1] = q.y;
    this._prevCamQuat[2] = q.z;
    this._prevCamQuat[3] = q.w;
    this._hasPrevCamQuat = true;
    const maxDpr = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      MAX_PIXEL_RATIO,
    );
    const floor = Math.min(maxDpr, DPR_MOTION_FLOOR);

    let target: number;
    if (this._refinementPhasesEnabled) {
      // P6 — track settle time and step DPR by discrete refinement phase. The
      // coverage / central-refinement readiness are time proxies here until the
      // P4 scheduler emits real signals; the phase machine itself is exact.
      if (moving) this._settledAtMs = 0;
      else if (this._settledAtMs === 0) this._settledAtMs = nowMs;
      const msSinceSettle = moving ? 0 : nowMs - this._settledAtMs;
      this._phase = nextRefinementPhase(this._phase, {
        moving,
        msSinceSettle,
        settleMs: SETTLE_MS,
        coverageComplete: msSinceSettle >= SETTLE_MS,
        centralRefined: msSinceSettle >= PHASE_CENTER_PROXY_MS,
      });
      target = Math.max(floor, maxDpr * phaseDprScale(this._phase));
      if (this._phase === 'moving' && angularSpeed > 0) {
        // P3 — faster rotation pulls the moving-phase resolution toward the floor.
        const t = Math.min(1, angularSpeed / DPR_FULL_REDUCTION_ANGULAR);
        target = Math.max(floor, target + (floor - target) * t);
      }
    } else {
      // Flag off: the continuous P5 mapping (no discrete phases).
      target = targetPixelRatio({ maxDpr, moving, angularSpeed });
    }

    target = quantizeDpr(target);
    const applied = this._renderer.getPixelRatio();
    if (shouldApplyDpr(applied, target, nowMs, this._lastDprChangeMs)) {
      this._renderer.setPixelRatio(target);
      this._lastDprChangeMs = nowMs;
    }
  }

  private _startLoop(): void {
    const loop = () => {
      this._rafId = requestAnimationFrame(loop);
      this._timer.update();
      const delta = this._timer.getDelta();
      this._recordFrame(delta);
      this._nav.update(delta);
      // Orbit-pivot maintenance — soft-clamp + streaming bounds-refinement
      // lerp. Cheap and bounded; runs every frame regardless of EDL state.
      this._maintainOrbitCenter();
      // adaptive EDL. Modulate strength based on
      // camera-to-target distance — close inspection gets stronger depth
      // cueing (carves out structure), overview gets lighter (avoids
      // muddy contrast). Cheap, runs every frame.
      this._updateAdaptiveEdl();
      // Idle-render throttle — the dominant fix for "OpenLiDARViewer
      // makes my laptop hot". When the scene is quiet (no input, no
      // tween, no streaming work) we render only every Nth frame
      // instead of every frame. The CPU path above still runs every
      // iteration so OrbitControls damping integrates correctly and
      // streaming keeps its cadence; only the GPU `render()` call is
      // gated. See `_shouldRenderFrame` for the full predicate.
      const rendered = this._shouldRenderFrame();
      // Suspend EDL while the camera is moving: its full-screen post-process is
      // the dominant per-frame cost during orbit/pan/fly. The depth cue returns
      // the instant the view parks. `moving` reuses the same motion signal the
      // frame-rate throttle uses, so the two never disagree.
      const nowMs = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      const moving = cameraIsMoving(this._nav.isTweening, nowMs, this._renderActivityUntilMs);
      const wantEdl = edlActiveThisFrame(this._edlEnabled, moving);
      // P5 — pick this frame's DPR before rendering so the render uses it.
      this._applyAdaptiveDpr(moving, delta, nowMs, rendered);
      if (rendered) {
        this._idleRenderHeartbeat = 0;
        // EDL when parked → render through the post-processing pipeline; moving
        // or EDL off → render the scene directly for zero post-processing cost.
        if (wantEdl) this._post.render();
        else this._renderer.render(this._scene, this._camera);
        this._edlPaintedAtRest = wantEdl;
      } else if (wantEdl && !this._edlPaintedAtRest) {
        // Motion just settled and the last paint had EDL off — force one EDL
        // repaint so the depth cue snaps back, then resume idle throttling.
        this._idleRenderHeartbeat = 0;
        this._post.render();
        this._edlPaintedAtRest = true;
      } else {
        this._idleRenderHeartbeat++;
      }
      // Streaming COPC — run the view-dependent scheduler on a throttled
      // cadence (~10 Hz at 60 fps), never every frame.
      if (this._streaming) {
        this._streamingFrame++;
        if (this._streamingFrame % 6 === 0) this._tickStreaming();
      }
      // After render, camera matrices are current — project the tool overlays.
      if (this._toolMode === 'measure' && !this._measure.dragging && this._pointerMoved) {
        this._pointerMoved = false;
        const hit = this._pointerOnCanvas
          ? this._pickPoint(this._pointerNdcX, this._pointerNdcY)
          : null;
        this._measure.setCursor(hit ? [hit.x, hit.y, hit.z] : null);
      }
      // Live probe — at most one detailed pick per frame, only when the
      // pointer actually moved, so a hover readout costs no idle frame budget.
      if (this._toolMode === 'probe' && this._pointerMoved) {
        this._pointerMoved = false;
        let info: PointInfo | null = null;
        if (this._pointerOnCanvas) {
          const hit = this._pickDetailed(this._pointerNdcX, this._pointerNdcY);
          if (hit) {
            info = this._infoForHit(hit);
          } else {
            // Fall back to resident streaming nodes — COPC live probe.
            const streamHit = this._pickStreamingDetailed(
              this._pointerNdcX,
              this._pointerNdcY,
            );
            if (streamHit) info = this._infoForStreamingHit(streamHit);
          }
        }
        this._probe.update(info, this._pointerClientX, this._pointerClientY);
      }
      // Re-project the 2D tool overlays only on frames we actually rendered
      // (camera/scene changed). Pointer, keyboard and orbit input all bump
      // render-activity → `rendered` is true during any interaction, so the
      // live measure cursor stays responsive; quiet idle frames skip this DOM
      // work instead of re-laying-out overlays 60×/s for a static scene. The
      // idle heartbeat still renders periodically, keeping overlays fresh.
      if (rendered) {
        this._measure.render(this._camera, this._canvas);
        this._inspect.render();
        this._annotate.render(this._camera, this._canvas);
      }
    };
    loop();
  }

  /**
   * RAF-coalesce the resize. ResizeObserver fires synchronously for every
   * observed size change — during a window drag that's many calls per frame,
   * each invoking `renderer.setSize` + camera reprojection (the WebGPU
   * renderer's `setSize` is not free). Coalesce to one applied resize per
   * animation frame.
   */
  private _scheduleResize(canvas: HTMLCanvasElement): void {
    if (this._resizeRafId !== null) return;
    this._resizeRafId = requestAnimationFrame(() => {
      this._resizeRafId = null;
      this._onResize(canvas);
    });
  }

  private _onResize(canvas: HTMLCanvasElement): void {
    // A canvas resize invalidates the rendered frame, so make sure
    // the idle-render throttle holds at full rate for the resize
    // settle window.
    this._bumpRenderActivity();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    // Re-apply the pixel ratio: browser zoom and monitor-DPI changes alter
    // devicePixelRatio, and the backing-store resolution must follow or the
    // scene renders soft/aliased after a zoom.
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    // updateStyle=false — CSS owns the display box (see the constructor note);
    // we resize only the WebGPU drawing buffer so the canvas keeps tracking the
    // container at any browser zoom instead of pinning to a stale pixel size.
    this._renderer.setSize(w, h, false);
    // Re-apply the active sky preset only when the phone-breakpoint
    // state actually crosses. Rotating a phone or resizing across
    // 767 px flips the gradient vs flat-colour decision; resizing
    // within either side is a no-op and used to do a full sky apply
    // (CSS string set + `new THREE.Color`) on every debounced tick.
    const isPhoneNow =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 767px)').matches;
    if (isPhoneNow !== this._lastSkyIsPhone) {
      this._applySkyPreset(this._skyPresetId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual Export Studio — inspector point-info card compositing
// ─────────────────────────────────────────────────────────────────────────────

import { classificationText, intensityText, rgbText } from './pointInfo';
import { linearUnitLabel } from '../io/crs';
// Provenance classifier for the export adapter's `captureLabel` —
// surfaces capture-type + confidence into every exported image's
// scan-report card. Same path the Inspector + PDF report use.
import { classify as classifyProvenance } from '../diagnostics/provenance';
import {
  signalsForStaticCloud,
  signalsForStreamingCloud,
} from '../diagnostics/provenanceSignals';

/**
 * Draw the InspectTool's "Point Info" card directly onto a 2-D canvas next
 * to the selected-point marker. Mirrors the live HTML card so the export
 * carries the same data the user saw on-screen — X/Y/Z, distance, intensity,
 * classification, RGB, optional LAS extras.
 *
 * Layout: small translucent dark card positioned to the right of the marker
 * (or left if there isn't room on the right). Auto-sizes to its content.
 */
function drawInspectorInfoCard(
  ctx: CanvasRenderingContext2D,
  info: PointInfo,
  screen: { x: number; y: number },
): void {
  // Build the rows the live card builds (see InspectTool._fillCard).
  const rows: Array<[string, string]> = [
    ['X', `${info.x} m`],
    ['Y', `${info.y} m`],
    ['Z', `${info.z} m`],
    ['Distance', `${info.distance} m`],
    ['Intensity', intensityText(info)],
    ['Classification', classificationText(info)],
    ['RGB', rgbText(info)],
  ];
  if (info.returnNumber !== undefined && info.returnCount !== undefined) {
    rows.push(['Return', `${info.returnNumber} of ${info.returnCount}`]);
  }
  if (info.pointSourceId !== undefined) {
    rows.push(['Point source', String(info.pointSourceId)]);
  }
  rows.push(['Layer', info.layer]);
  rows.push(['Index', info.index.toLocaleString('en-US')]);

  // Measure layout — the card width is driven by the widest row.
  const PAD = 14;
  const TITLE_SIZE = 14;
  const ROW_SIZE = 12;
  const ROW_GAP = 6;
  ctx.save();
  ctx.font = `600 ${TITLE_SIZE}px system-ui, -apple-system, sans-serif`;
  const titleW = ctx.measureText('Point Info').width;
  ctx.font = `${ROW_SIZE}px system-ui, -apple-system, sans-serif`;
  let labelMax = 0;
  let valueMax = 0;
  for (const [l, v] of rows) {
    labelMax = Math.max(labelMax, ctx.measureText(l).width);
    valueMax = Math.max(valueMax, ctx.measureText(v).width);
  }
  const rowWidth = labelMax + 18 + valueMax;
  const cardW = Math.max(titleW, rowWidth) + PAD * 2;
  const cardH = PAD + TITLE_SIZE + 8 + rows.length * (ROW_SIZE + ROW_GAP) - ROW_GAP + PAD;

  // Decide placement: prefer to the right of the marker, fall back to left
  // if there isn't room on the right side of the canvas.
  const MARKER_GAP = 18;
  let x = screen.x + MARKER_GAP;
  if (x + cardW > ctx.canvas.width - 8) x = screen.x - MARKER_GAP - cardW;
  let y = screen.y - cardH / 2;
  if (y < 8) y = 8;
  if (y + cardH > ctx.canvas.height - 8) y = ctx.canvas.height - 8 - cardH;

  // Card background with hairline border and accent stripe — visual style
  // matches the scan-report card so the export reads as one consistent layer.
  ctx.fillStyle = 'rgba(10, 14, 22, 0.92)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1;
  const r = 6;
  const rr = Math.min(r, cardW / 2, cardH / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + cardW, y, x + cardW, y + cardH, rr);
  ctx.arcTo(x + cardW, y + cardH, x, y + cardH, rr);
  ctx.arcTo(x, y + cardH, x, y, rr);
  ctx.arcTo(x, y, x + cardW, y, rr);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#4f9dff';
  ctx.fillRect(x, y, 3, cardH);

  // Title.
  let cy = y + PAD + TITLE_SIZE;
  ctx.fillStyle = '#f4f6fa';
  ctx.font = `600 ${TITLE_SIZE}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('Point Info', x + PAD, cy);

  // Rows — label left, value right.
  cy += 8;
  ctx.font = `${ROW_SIZE}px system-ui, -apple-system, sans-serif`;
  for (const [label, value] of rows) {
    cy += ROW_SIZE;
    ctx.fillStyle = '#a8b0bc';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + PAD, cy);
    ctx.fillStyle = '#f4f6fa';
    ctx.textAlign = 'right';
    ctx.fillText(value, x + cardW - PAD, cy);
    cy += ROW_GAP;
  }
  ctx.restore();
}

/**
 * Draw the LiveProbe's compact readout (coordinates + key attributes) at
 * the cursor's last-known canvas position. Visually smaller than the
 * inspector card — the live probe is a glance-readout, not a study tool.
 */
function drawProbeReadoutCard(
  ctx: CanvasRenderingContext2D,
  info: PointInfo,
  screen: { x: number; y: number },
): void {
  const coords = `${info.x}, ${info.y}, ${info.z} m`;
  const attrParts: string[] = [];
  if (info.classification !== null) attrParts.push(classificationText(info));
  if (info.intensity !== null) attrParts.push(`Intensity ${info.intensity}`);
  const attrs = attrParts.join('  ·  ');

  const PAD = 10;
  const COORD_SIZE = 12;
  const ATTR_SIZE = 11;
  const ROW_GAP = 4;

  ctx.save();
  ctx.font = `600 ${COORD_SIZE}px system-ui, -apple-system, sans-serif`;
  const coordW = ctx.measureText(coords).width;
  ctx.font = `${ATTR_SIZE}px system-ui, -apple-system, sans-serif`;
  const attrW = attrs ? ctx.measureText(attrs).width : 0;
  const cardW = Math.max(coordW, attrW) + PAD * 2;
  const cardH = PAD + COORD_SIZE + (attrs ? ROW_GAP + ATTR_SIZE : 0) + PAD;

  // Cursor-aware placement — to the right and below, flipping when the
  // card would clip the canvas edges.
  const OFFSET = 16;
  let x = screen.x + OFFSET;
  if (x + cardW > ctx.canvas.width - 8) x = screen.x - OFFSET - cardW;
  let y = screen.y + OFFSET;
  if (y + cardH > ctx.canvas.height - 8) y = screen.y - OFFSET - cardH;
  if (x < 8) x = 8;
  if (y < 8) y = 8;

  // Background — visually consistent with the inspector card but smaller
  // and slightly less opaque so the cursor remains the dominant element.
  ctx.fillStyle = 'rgba(10, 14, 22, 0.88)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1;
  const r = 5;
  const rr = Math.min(r, cardW / 2, cardH / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + cardW, y, x + cardW, y + cardH, rr);
  ctx.arcTo(x + cardW, y + cardH, x, y + cardH, rr);
  ctx.arcTo(x, y + cardH, x, y, rr);
  ctx.arcTo(x, y, x + cardW, y, rr);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Coordinates row.
  let cy = y + PAD + COORD_SIZE;
  ctx.fillStyle = '#f4f6fa';
  ctx.font = `600 ${COORD_SIZE}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(coords, x + PAD, cy);

  // Attributes row (optional).
  if (attrs) {
    cy += ROW_GAP + ATTR_SIZE;
    ctx.fillStyle = '#a8b0bc';
    ctx.font = `${ATTR_SIZE}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(attrs, x + PAD, cy);
  }
  ctx.restore();
}

/**
 * v0.3.7 final-polish — paint a scale-bar overlay in the bottom-left
 * of the output canvas. Black bar with white tips + a white outline so
 * it stays legible against any cloud colour. Label sits above the bar.
 */
function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  out: HTMLCanvasElement,
  bar: { stepPixels: number; label: string },
): void {
  if (bar.stepPixels <= 0) return;
  // Padding scales with output height so the bar reads the same on a
  // 1× snapshot and a 4× supersampled hero shot.
  const padding = Math.max(12, Math.round(out.height * 0.022));
  const barHeight = Math.max(6, Math.round(out.height * 0.008));
  const tickHeight = barHeight * 1.6;
  const fontSize = Math.max(11, Math.round(out.height * 0.018));
  const x0 = padding;
  const y0 = out.height - padding - barHeight;
  ctx.save();
  // White stroke under the bar so it reads against dark clouds.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x0 - 1, y0 - tickHeight + barHeight, bar.stepPixels + 2, tickHeight + 1);
  // Black bar fill.
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(x0, y0, bar.stepPixels, barHeight);
  // White tick marks at the bar's ends.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x0, y0 - tickHeight + barHeight, 2, tickHeight);
  ctx.fillRect(x0 + bar.stepPixels - 2, y0 - tickHeight + barHeight, 2, tickHeight);
  // Label above the bar — white with a black stroke so it reads on either tone.
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  const labelY = y0 - tickHeight + barHeight - 4;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(13, 17, 23, 0.85)';
  ctx.strokeText(bar.label, x0, labelY);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(bar.label, x0, labelY);
  ctx.restore();
}
