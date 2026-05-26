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
  uniform,
  screenUV,
  screenSize,
  log2,
  exp,
  max,
  length,
  smoothstep,
  positionView,
  positionGeometry,
  perspectiveDepthToViewZ,
} from 'three/tsl';

import type { PointCloud } from '../model/PointCloud';
import { isZUpFormat } from '../io/sniffFormat';
import { colorForMode, defaultMode } from './colorModes';
import type { ColorMode } from './colorModes';
import { edlDefaultEnabled, EDL_DEFAULTS, EDL_DEPTH_BIAS } from './edl';
import { POINT_STYLE_DEFAULTS } from './pointStyle';
import type { PointSizeMode } from './pointStyle';
import { NavController } from './NavController';
import type { NavMode, CameraPose } from './NavController';
import { MeasureController } from './measure/MeasureController';
import { InspectTool } from './InspectTool';
import { AnnotationController } from './annotate/AnnotationController';
import type { SavedCameraState } from './annotate/types';
import { loadSvgImage } from './snapshotSvg';
import { LiveProbe } from './LiveProbe';
import { downsampleToBudget } from '../process/voxelDownsample';
import { makePointInfo } from './pointInfo';
import type { PointInfo } from './pointInfo';
import { speedForSize, nearestPointAlongRay } from './navMath';
// The streaming render engine is type-only here and dynamically imported in
// `attachStreamingCloud`, so `src/render/streaming/*` (scheduler, renderer,
// octree, cache) stays out of the initial bundle and loads only when a COPC
// scan is opened. `streamingBudget` is a tiny leaf kept static for the
// synchronous `setStreamingQuality` path.
import type { StreamingScheduler } from './streaming/StreamingScheduler';
import type { StreamingRenderer } from './streaming/StreamingRenderer';
import type { StreamingPointCloud } from './streaming/StreamingPointCloud';
import { streamingBudgets } from './streaming/streamingBudget';
import type { StreamingQuality } from './streaming/streamingBudget';
import type { StreamingBenchmark } from './streaming/streamingBenchmark';
// The streaming-engine `import()` split points live in `lazyChunks.ts` — a
// module excluded from the live-build obfuscator so Vite can still emit the
// chunks (see lazyChunks.ts).
import {
  loadStreamingRenderer,
  loadStreamingScheduler,
  loadStreamingColors,
} from '../lazyChunks';
import type { ChunkDecoder, DecodedChunk } from '../io/copc/copcChunkDecode';

// ─────────────────────────────────────────────────────────────────────────────
// Internal data per loaded cloud
// ─────────────────────────────────────────────────────────────────────────────

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
export type ToolMode = 'none' | 'measure' | 'inspect' | 'annotate' | 'probe' | 'slice';

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
}

/** The live COPC streaming subsystem — present only while a COPC is open. */
interface StreamingSession {
  cloud: StreamingPointCloud;
  scheduler: StreamingScheduler;
  renderer: StreamingRenderer;
  /** The streaming benchmark, when one is collecting — null in normal sessions. */
  benchmark: StreamingBenchmark | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The four corners of the unit billboard quad shared by every point. */
const QUAD_CORNERS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
/** Two triangles covering the quad. */
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

/**
 * Device-pixel-ratio cap. High-density displays render at up to DPR² the pixel
 * area; capping at 2 bounds the cost — most visible once the EDL pass adds a
 * full-screen render target — with no perceptible loss of sharpness.
 */
const MAX_PIXEL_RATIO = 2;

/** Default vertical field of view, in degrees — the camera's construction value. */
const DEFAULT_FOV = 60;

/**
 * Absolute GPU-upload point ceiling. The device-aware load budget already
 * sizes a cloud to the machine; this is the last-resort guard so that no path
 * — a future session restore, a streaming source — can ever upload a cloud
 * large enough to risk a GPU out-of-memory crash. It sits above every load
 * budget, so a normally-loaded cloud is never touched.
 */
const GPU_HARD_POINT_CEILING = 5_000_000;

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

/** Convert interleaved Uint8 [0-255] RGB to Float32 [0-1] for a GPU attribute. */
function toFloatColors(u8: Uint8Array): Float32Array {
  const f = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i++) f[i] = u8[i] / 255;
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
 */
function buildEdlOutputNode(
  scenePass: ReturnType<typeof pass>,
  strength: TslNode,
  near: TslNode,
  far: TslNode,
  radiusPx: number,
): TslNode {
  const colorNode: TslNode = scenePass.getTextureNode();
  const depthNode: TslNode = scenePass.getTextureNode('depth');

  // Positive eye-space distance at a screen UV, floored away from zero so the
  // following log2 is always finite.
  const eyeDistAt = Fn(([sampleUv]: TslNode[]): TslNode => {
    const raw: TslNode = depthNode.sample(sampleUv).r;
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
 */
function buildPointMaskNode(): TslNode {
  const r: TslNode = length((positionGeometry as TslNode).xy);
  return smoothstep(float(0.42), float(0.5), r).oneMinus();
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
  private readonly _clock = new THREE.Clock();
  private _rafId: number | null = null;

  // ── Frame timing (debug overlay) ─────────────────────────────────────────
  /** Rolling buffer of recent frame times, in ms — feeds {@link frameStats}. */
  private readonly _frameTimes = new Float64Array(FRAME_SAMPLE_COUNT);
  /** Next write index into the frame-time ring buffer. */
  private _frameWrite = 0;
  /** Number of valid samples in the ring buffer (≤ its length). */
  private _frameCount = 0;

  // ── Cloud registry ───────────────────────────────────────────────────────
  private readonly _clouds = new Map<string, CloudEntry>();
  private _nextId = 0;

  // ── Streaming COPC subsystem (set while a streaming cloud is open) ───────
  /** Streaming node meshes — tracked so material settings reach them too. */
  private readonly _streamingMeshes = new Set<THREE.Mesh>();
  /**
   * Per streaming mesh: its decoded chunk (for point picking) plus the
   * COPC octree depth of the node it came from (for the Task 24
   * "still refining" hint — comparing this depth against the deepest
   * resident depth tells the inspector whether finer detail is still
   * loading for the region under the picked point).
   */
  private readonly _streamingPickData = new Map<
    THREE.Mesh,
    { decoded: DecodedChunk; depth: number }
  >();
  /** The scheduler/renderer/cloud, present only while a COPC is streaming. */
  private _streaming: StreamingSession | null = null;
  /** Frames since the streaming scheduler last ran — for throttling. */
  private _streamingFrame = 0;

  // ── Shared point size in screen pixels (applied to all materials) ────────
  // Defaults to the smallest size; matches the Inspector slider's initial value.
  private _pointSize = 1;

  // ── Render-quality pipeline (Eye Dome Lighting post-processing) ──────────
  /** Post-processing pipeline — driven only while EDL is enabled. */
  private readonly _post: THREE.PostProcessing;
  /** The scene render pass that feeds the post-processing pipeline. */
  private readonly _scenePass: ReturnType<typeof pass>;
  /** Whether EDL is on; defaulted by the capability gate once the backend is known. */
  private _edlEnabled = false;
  /** EDL strength, and the camera near/far, as live uniforms. */
  private readonly _edlStrength = uniform(EDL_DEFAULTS.strength);
  private readonly _edlNear = uniform(0.1);
  private readonly _edlFar = uniform(5_000_000);

  // ── Point styling ────────────────────────────────────────────────────────
  /** Adaptive (distance-scaled) or fixed point size. */
  private _pointSizeMode: PointSizeMode = POINT_STYLE_DEFAULTS.mode;
  /** Whether point-edge antialiasing (alpha-to-coverage) is on. */
  private _antialiasing = true;
  /** Base point size and the adaptive reference distance, as live uniforms. */
  private readonly _pointSizeUniform = uniform(1);
  private readonly _attnRef = uniform(100);
  /** The shared adaptive size node, assigned to every cloud's material. */
  private readonly _adaptiveSizeNode = buildAdaptiveSizeNode(
    this._pointSizeUniform,
    this._attnRef,
  );

  // ── Navigation state ─────────────────────────────────────────────────────
  /** The cloud's vertical axis — Z for LAS/LAZ surveys, Y for phone scans. */
  private readonly _worldUp = new THREE.Vector3(0, 1, 0);
  private _navListeners: NavListeners = {};
  private readonly _raycaster = new THREE.Raycaster();

  // ── Picking tools (measure / inspect) ────────────────────────────────────
  private readonly _canvas: HTMLCanvasElement;
  private readonly _measure: MeasureController;
  private readonly _inspect: InspectTool;
  private readonly _annotate: AnnotationController;
  private readonly _probe: LiveProbe;
  /** Which picking tool currently owns canvas clicks. */
  private _toolMode: ToolMode = 'none';
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
    } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);

    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this._renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600);

    // ── Scene ─────────────────────────────────────────────────────────────
    this._scene = new THREE.Scene();
    // Deep Navy — the brand background colour.
    this._scene.background = new THREE.Color(0x0a0e1a);

    // ── Camera ────────────────────────────────────────────────────────────
    const aspect = (canvas.clientWidth || 800) / (canvas.clientHeight || 600);
    this._camera = new THREE.PerspectiveCamera(DEFAULT_FOV, aspect, 0.1, 5_000_000);
    this._camera.position.set(0, 0, 100);

    // ── Post-processing pipeline (Eye Dome Lighting) ──────────────────────
    // The scene renders into a pass; the EDL node shades it from the pass's
    // colour and depth. The pipeline is driven only while EDL is enabled (see
    // the render loop); its node graph compiles lazily on first use.
    this._scenePass = pass(this._scene, this._camera);
    this._post = new THREE.PostProcessing(this._renderer);
    this._post.outputNode = buildEdlOutputNode(
      this._scenePass,
      this._edlStrength,
      this._edlNear,
      this._edlFar,
      EDL_DEFAULTS.radiusPx,
    ) as typeof this._post.outputNode;

    // ── OrbitControls ─────────────────────────────────────────────────────
    this._controls = new OrbitControls(this._camera, canvas);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.zoomToCursor = true;
    this._controls.rotateSpeed = 0.85;

    // ── Navigation controller ─────────────────────────────────────────────
    this._nav = new NavController(this._camera, canvas, this._controls, {
      onModeChange: (m) => this._navListeners.onModeChange?.(m),
      onPointerLockChange: (l) => this._navListeners.onPointerLockChange?.(l),
      onToggleHelp: () => this._navListeners.onToggleHelp?.(),
      onReset: () => this.frameAll(),
      onFocusCenter: () => this._focusCenter(),
    });

    // Double-click a point to focus / fly to it.
    canvas.addEventListener('dblclick', (e) => this._handleDoubleClick(e, canvas));

    // Picking tools — while one is active, a canvas click picks a point.
    this._canvas = canvas;
    this._measure = new MeasureController({
      onExit: () => this.setMeasureMode(false),
    });
    this._measure.setPicker((ndcX, ndcY) => {
      const hit = this._pickPoint(ndcX, ndcY);
      return hit ? [hit.x, hit.y, hit.z] : null;
    });
    this._inspect = new InspectTool(this._camera, canvas, {
      onExit: () => this.setInspectMode(false),
    });
    this._annotate = new AnnotationController();
    // The annotation editor can link a finding to a measurement — feed it the
    // current measurement list whenever it opens.
    this._annotate.setMeasurementSource(() =>
      this._measure.getMeasurements().map((m) => ({ id: m.id, name: m.name })),
    );
    this._probe = new LiveProbe();
    canvas.addEventListener('click', (e) => {
      if (this._toolMode === 'measure') this._handleMeasureClick(e, canvas);
      else if (this._toolMode === 'inspect') this._handleInspectClick(e, canvas);
      else if (this._toolMode === 'annotate') this._handleAnnotateClick(e, canvas);
    });
    // Track the pointer so the measure tool can preview toward the cursor.
    canvas.addEventListener('pointermove', (e) => {
      this._pointerNdcX = (e.offsetX / canvas.clientWidth) * 2 - 1;
      this._pointerNdcY = -(e.offsetY / canvas.clientHeight) * 2 + 1;
      this._pointerClientX = e.clientX;
      this._pointerClientY = e.clientY;
      this._pointerOnCanvas = true;
      this._pointerMoved = true;
    });
    canvas.addEventListener('pointerleave', () => {
      this._pointerOnCanvas = false;
      this._pointerMoved = true;
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this._toolMode !== 'none') this._setToolMode('none');
    });

    // ── Async backend init + render loop ──────────────────────────────────
    this.ready = this._renderer.init().then(() => {
      // EDL defaults on for desktop WebGPU; off on the WebGL 2 fallback and on
      // mobile, so a weak device is never dropped below interactive on load.
      this._edlEnabled = edlDefaultEnabled(this.activeBackend(), this._isMobile());
      this._startLoop();
    });

    // ── Resize observer ───────────────────────────────────────────────────
    const ro = new ResizeObserver(() => this._onResize(canvas));
    ro.observe(canvas);
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
      colorForMode(mode, cloud),
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
  buildPointMesh(positions: Float32Array, colorsU8: Uint8Array): PointMeshHandle {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(QUAD_CORNERS, 3),
    );
    geometry.setIndex(QUAD_INDEX);
    geometry.instanceCount = positions.length / 3;

    const positionAttr = new THREE.InstancedBufferAttribute(positions, 3);
    const colorAttr = new THREE.InstancedBufferAttribute(toFloatColors(colorsU8), 3);

    // `instancedBufferAttribute` is typed as a broad node-type union; narrow
    // it to each property's accepted type — the itemSize (3) makes it a vec3.
    const material = new THREE.PointsNodeMaterial();
    material.positionNode = instancedBufferAttribute(positionAttr) as NonNullable<
      typeof material.positionNode
    >;
    material.colorNode = instancedBufferAttribute(colorAttr) as NonNullable<
      typeof material.colorNode
    >;
    material.size = this._pointSize;
    material.sizeAttenuation = false;
    material.transparent = false;
    // Round, soft-edged points — a circular alpha mask kept depth-correct via
    // alpha-to-coverage (no transparency sort, no draw-order artefacts).
    material.opacityNode = buildPointMaskNode() as typeof material.opacityNode;
    material.alphaTest = 0.5;
    material.alphaToCoverage = this._antialiasing;
    this._applySizeMode(material);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return { mesh, material, colorAttr };
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
   * Phase 11 Task 34 — buffer-lifecycle proof:
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
   *      `_meshes` entry around this call, and `Phase 7 Task 25` clears any
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
    cloud: StreamingPointCloud,
    decoder: ChunkDecoder,
    quality: StreamingQuality,
    isMobile: boolean,
    benchmark?: StreamingBenchmark | null,
  ): Promise<void> {
    const [{ StreamingRenderer }, { StreamingScheduler }, { defaultStreamingMode }] =
      await Promise.all([
        loadStreamingRenderer(),
        loadStreamingScheduler(),
        loadStreamingColors(),
      ]);
    this.detachStreamingCloud();
    // Task 25 — fade-in is enabled on desktop/mid+ profiles only; mobile and
    // low-tier sessions skip it to preserve frame-budget headroom.
    const fadeIn = !isMobile && quality !== 'low';
    const renderer = new StreamingRenderer(
      this,
      cloud,
      defaultStreamingMode(cloud.metadata),
      { fadeIn },
    );
    const scheduler = new StreamingScheduler(
      cloud,
      decoder,
      {
        onNodeReady: (node, decoded) => {
          renderer.onNodeReady(node, decoded);
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
    this._streaming = { cloud, scheduler, renderer, benchmark: benchmark ?? null };
    this._streamingFrame = 0;
    this._configureForStreaming(cloud);
  }

  /** Detach and fully dispose the current streaming cloud, if any. */
  detachStreamingCloud(): void {
    if (!this._streaming) return;
    this._streaming.scheduler.stop();
    this._streaming.renderer.dispose();
    this._streaming = null;
    if (this._clouds.size === 0) this._nav.setHasCloud(false);
  }

  /** Whether a streaming COPC cloud is currently open. */
  get hasStreamingCloud(): boolean {
    return this._streaming !== null;
  }

  /** The open streaming cloud, or null. */
  get streamingCloud(): StreamingPointCloud | null {
    return this._streaming?.cloud ?? null;
  }

  /** The streaming scheduler, or null — for the streaming panel and diagnostics. */
  get streamingScheduler(): StreamingScheduler | null {
    return this._streaming?.scheduler ?? null;
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
  private _configureForStreaming(cloud: StreamingPointCloud): void {
    // COPC is LAS-derived — always Z-up.
    this._worldUp.set(0, 0, 1);
    this._nav.setWorldUp(this._worldUp);

    const b = cloud.localBounds();
    const size = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || 100;
    this._nav.setBaseSpeed(speedForSize(size));
    this._nav.setHasCloud(true);

    this._camera.near = Math.max(size * 0.0002, 0.01);
    this._camera.far = Math.max(size * 16, 1000);
    this._camera.updateProjectionMatrix();
    this._edlNear.value = this._camera.near;
    this._edlFar.value = this._camera.far;

    const radius = size / 2 || 1;
    const fovRad = THREE.MathUtils.degToRad(this._camera.fov);
    this._attnRef.value = (radius / Math.sin(fovRad / 2)) * 1.2;
    this._applyOrbitBounds(radius);

    this._measure.setContext({ worldUp: [0, 0, 1], origin: cloud.renderOrigin });
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
    if (this._clouds.size === 0) this._nav.setHasCloud(false);
  }

  /** Return an array of all currently loaded cloud IDs. */
  clouds(): string[] {
    return [...this._clouds.keys()];
  }

  /** Show or hide a cloud. */
  setCloudVisible(id: string, visible: boolean): void {
    const entry = this._clouds.get(id);
    if (entry) entry.mesh.visible = visible;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Colour mode & point size
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Swap a cloud's colour mode by rewriting its instanced colour attribute
   * in place — the geometry, material, and draw call are all reused.
   */
  setColorMode(id: string, mode: ColorMode): void {
    const entry = this._clouds.get(id);
    if (!entry) return;
    if (entry.mode === mode) return;

    const raw = colorForMode(mode, entry.cloud);
    const arr = entry.colorAttr.array as Float32Array;
    for (let i = 0; i < raw.length; i++) arr[i] = raw[i] / 255;
    entry.colorAttr.needsUpdate = true;
    entry.mode = mode;
  }

  /**
   * Set the pixel size of all rendered points.
   * Applies to every loaded cloud's material.
   */
  setPointSize(size: number): void {
    this._pointSize = size;
    // The uniform feeds the adaptive size node; `.size` feeds fixed mode.
    this._pointSizeUniform.value = size;
    for (const { material } of this._clouds.values()) {
      material.size = size;
    }
    for (const material of this._streamingMaterials()) {
      material.size = size;
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

  /** Set the EDL strength (0 = no shading). Negative values are clamped to 0. */
  setEdlStrength(strength: number): void {
    this._edlStrength.value = Math.max(0, strength);
  }

  /** The current EDL strength. */
  get edlStrength(): number {
    return Number(this._edlStrength.value);
  }

  /** Switch between adaptive (distance-scaled) and fixed point sizing. */
  setPointSizeMode(mode: PointSizeMode): void {
    this._pointSizeMode = mode;
    for (const { material } of this._clouds.values()) {
      this._applySizeMode(material);
      material.needsUpdate = true;
    }
    for (const material of this._streamingMaterials()) {
      this._applySizeMode(material);
      material.needsUpdate = true;
    }
  }

  /** The current point-size mode. */
  get pointSizeMode(): PointSizeMode {
    return this._pointSizeMode;
  }

  /** Enable or disable point-edge antialiasing (alpha-to-coverage). */
  setAntialiasing(on: boolean): void {
    this._antialiasing = on;
    for (const { material } of this._clouds.values()) {
      material.alphaToCoverage = on;
      material.needsUpdate = true;
    }
    for (const material of this._streamingMaterials()) {
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

  /** Switch the navigation mode (orbit / walk / fly). */
  setMode(mode: NavMode): void {
    this._nav.setMode(mode);
  }

  /** The active navigation mode. */
  get navMode(): NavMode {
    return this._nav.mode;
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
    const fov = state.fov ?? DEFAULT_FOV;
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

  // ─────────────────────────────────────────────────────────────────────────
  // Picking tools — measurement & point inspection
  // ─────────────────────────────────────────────────────────────────────────

  /** Enter or leave distance-measurement mode (freezes navigation). */
  setMeasureMode(on: boolean): void {
    this._setToolMode(on ? 'measure' : 'none');
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
  private _setToolMode(mode: ToolMode): void {
    if (mode === this._toolMode) return;
    this._toolMode = mode;
    this._measure.setActive(mode === 'measure');
    this._inspect.setActive(mode === 'inspect');
    this._annotate.setActive(mode === 'annotate');
    this._probe.setActive(mode === 'probe');
    // The probe keeps navigation live; every other tool freezes it.
    this._nav.setInputEnabled(mode === 'none' || mode === 'probe');
    // Inspect manages its own cursor; the measure, annotate and probe cursors
    // are owned here — a crosshair while picking, cleared when no tool is active.
    if (mode === 'measure' || mode === 'annotate' || mode === 'probe') {
      this._canvas.style.cursor = 'crosshair';
    } else if (mode === 'none') {
      this._canvas.style.cursor = '';
    }
    this._measureListeners.onModeChange?.(mode === 'measure');
    this._inspectListeners.onModeChange?.(mode === 'inspect');
    this._annotateListeners.onModeChange?.(mode === 'annotate');
    this._probeListeners.onModeChange?.(mode === 'probe');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Camera
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fit the camera to encompass all visible clouds, gliding to an oblique
   * overview rather than snapping there.
   */
  frameAll(): void {
    const sphere = this._visibleBoundingSphere();
    if (!sphere) return;

    const radius = sphere.radius === 0 ? 1 : sphere.radius;
    const fovRad = THREE.MathUtils.degToRad(this._camera.fov);
    const dist = (radius / Math.sin(fovRad / 2)) * 1.2;

    // An oblique direction: a horizontal heading lifted ~35° toward world-up,
    // so a scan opens at a natural three-quarter angle, not flat top-down.
    const horiz = this._horizontalAxis();
    const dir = horiz
      .multiplyScalar(Math.cos(0.61))
      .addScaledVector(this._worldUp, Math.sin(0.61))
      .normalize();

    const target = sphere.center.clone();
    const pos = target.clone().addScaledVector(dir, dist);
    this._nav.tweenTo(pos, target, 0.7);
  }

  /**
   * Bound the orbit dolly to the framed cloud: `radius` is the scan's bounding
   * radius. The camera can pull in close enough to inspect a detail and back
   * far enough to take in the whole scan with margin — but never so far the
   * cloud is lost off-screen, nor so close it clips through the near plane.
   */
  private _applyOrbitBounds(radius: number): void {
    const r = radius > 0 ? radius : 1;
    this._controls.minDistance = r * 0.02;
    this._controls.maxDistance = r * 16;
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
      gpuBytesEstimate: displayedPoints * BYTES_PER_GPU_POINT,
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
    // Render through the same path the loop uses, so the snapshot matches the
    // on-screen image — EDL included when it is enabled.
    if (this._edlEnabled) this._post.render();
    else this._renderer.render(this._scene, this._camera);

    const gl = this._renderer.domElement as HTMLCanvasElement;
    const wantAnnotations = options?.annotations === true;
    const wantMeasurements = options?.measurements === true;

    // Fast path: no overlays requested — return the GL canvas untouched.
    if (!wantAnnotations && !wantMeasurements) return this._canvasToBlob(gl);

    // Composite path: draw the GL frame into a 2-D canvas at full resolution.
    const out = document.createElement('canvas');
    out.width = gl.width;
    out.height = gl.height;
    const ctx = out.getContext('2d');
    if (!ctx) return this._canvasToBlob(gl);
    ctx.drawImage(gl, 0, 0, out.width, out.height);

    // Re-project each overlay with the export camera, then serialise it, so
    // alignment with the rendered frame is exact. Measurements sit beneath the
    // annotation markers, matching the live stacking order.
    const layers: string[] = [];
    if (wantMeasurements) {
      this._measure.render(this._camera, this._canvas);
      layers.push(this._measure.overlaySVG());
    }
    if (wantAnnotations) {
      this._annotate.render(this._camera, this._canvas);
      layers.push(this._annotate.markerSVG());
    }
    for (const svg of layers) {
      const img = await loadSvgImage(svg);
      if (img) ctx.drawImage(img, 0, 0, out.width, out.height);
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
   * Stop the render loop, dispose all clouds, and free renderer resources.
   */
  dispose(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    for (const id of [...this._clouds.keys()]) {
      this.removeCloud(id);
    }
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

  /** Apply the current point-size mode to one material. */
  private _applySizeMode(material: THREE.PointsNodeMaterial): void {
    material.sizeNode = (
      this._pointSizeMode === 'adaptive' ? this._adaptiveSizeNode : null
    ) as typeof material.sizeNode;
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

    // Clip planes generous enough to fly around the cloud, but no wider — a
    // very wide near/far range leaves the depth buffer with poor precision,
    // which makes the depth-based Eye Dome Lighting shimmer as the camera
    // moves. `size` is the cloud's diameter; 16× still lets the camera pull
    // well clear of it.
    this._camera.near = Math.max(size * 0.0002, 0.01);
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
  }

  /** Combined bounding sphere of every visible cloud, or null if none. */
  private _visibleBoundingSphere(): THREE.Sphere | null {
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
    if (!any || box.isEmpty()) return null;
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    return sphere;
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
   * Task 22 — resident-only picking. The pick map and the streaming-mesh set
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
    this._raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this._camera);
    const o = this._raycaster.ray.origin;
    const d = this._raycaster.ray.direction;
    let best:
      | { decoded: DecodedChunk; index: number; point: THREE.Vector3; depth: number }
      | null = null;
    let bestScore = Infinity;
    // Task 24 — track the deepest currently-resident depth so the hint
    // fires when the picked node is shallower than it.
    let maxResidentDepth = -1;
    for (const [mesh, entry] of this._streamingPickData) {
      // Task 22 invariant — pick from resident meshes only.
      if (!this._streamingMeshes.has(mesh) || mesh.parent === null) {
        this._reportStalePickEntry(mesh);
        this._streamingPickData.delete(mesh);
        continue;
      }
      if (!mesh.visible) continue;
      if (entry.depth > maxResidentDepth) maxResidentDepth = entry.depth;
      const hit = nearestPointAlongRay(
        entry.decoded.positions,
        [o.x, o.y, o.z],
        [d.x, d.y, d.z],
      );
      if (!hit) continue;
      const score = hit.offset / hit.along;
      if (score < 0.07 && score < bestScore) {
        bestScore = score;
        best = {
          decoded: entry.decoded,
          index: hit.index,
          point: new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2]),
          depth: entry.depth,
        };
      }
    }
    if (!best) return null;
    return {
      decoded: best.decoded,
      index: best.index,
      point: best.point,
      streamingRefining: best.depth < maxResidentDepth,
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
  private _pickDetailed(
    ndcX: number,
    ndcY: number,
  ): { cloud: PointCloud; index: number; point: THREE.Vector3 } | null {
    this._raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this._camera);
    const o = this._raycaster.ray.origin;
    const d = this._raycaster.ray.direction;

    let best: { cloud: PointCloud; index: number; point: THREE.Vector3 } | null = null;
    let bestScore = Infinity;
    for (const { mesh, cloud } of this._clouds.values()) {
      if (!mesh.visible) continue;
      const hit = nearestPointAlongRay(cloud.positions, [o.x, o.y, o.z], [d.x, d.y, d.z]);
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
    if (this._toolMode !== 'none') return; // clicks belong to the active tool
    const ndcX = (e.offsetX / canvas.clientWidth) * 2 - 1;
    const ndcY = -(e.offsetY / canvas.clientHeight) * 2 + 1;
    const point = this._pickPoint(ndcX, ndcY);
    if (point) this._nav.focusOn(point);
  }

  /** While measuring, a canvas click picks the point under the cursor. */
  private _handleMeasureClick(e: MouseEvent, canvas: HTMLCanvasElement): void {
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
      // v0.2.8 inspection extras — passed only when the cloud carries them.
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
    const viewProjection = new THREE.Matrix4().multiplyMatrices(
      this._camera.projectionMatrix,
      this._camera.matrixWorldInverse,
    );
    this._streaming.scheduler.update({
      viewProjection: viewProjection.elements,
      cameraPosition: [
        this._camera.position.x,
        this._camera.position.y,
        this._camera.position.z,
      ],
    });
  }

  private _startLoop(): void {
    const loop = () => {
      this._rafId = requestAnimationFrame(loop);
      const delta = this._clock.getDelta();
      this._recordFrame(delta);
      this._nav.update(delta);
      // EDL on → render through the post-processing pipeline; off → render
      // the scene directly, the v0.2 path, for zero post-processing overhead.
      if (this._edlEnabled) this._post.render();
      else this._renderer.render(this._scene, this._camera);
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
      this._measure.render(this._camera, this._canvas);
      this._inspect.render();
      this._annotate.render(this._camera, this._canvas);
    };
    loop();
  }

  private _onResize(canvas: HTMLCanvasElement): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(w, h);
  }
}
