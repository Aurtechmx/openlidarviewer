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
import { instancedBufferAttribute } from 'three/tsl';

import type { PointCloud } from '../model/PointCloud';
import { colorForMode, defaultMode } from './colorModes';
import type { ColorMode } from './colorModes';
import { NavController } from './NavController';
import type { NavMode } from './NavController';
import { speedForSize, nearestPointAlongRay } from './navMath';

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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The four corners of the unit billboard quad shared by every point. */
const QUAD_CORNERS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
/** Two triangles covering the quad. */
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

/** Convert interleaved Uint8 [0-255] RGB to Float32 [0-1] for a GPU attribute. */
function toFloatColors(u8: Uint8Array): Float32Array {
  const f = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i++) f[i] = u8[i] / 255;
  return f;
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

  // ── Cloud registry ───────────────────────────────────────────────────────
  private readonly _clouds = new Map<string, CloudEntry>();
  private _nextId = 0;

  // ── Shared point size in screen pixels (applied to all materials) ────────
  // Matches the Inspector's point-size slider initial value.
  private _pointSize = 2;

  // ── Navigation state ─────────────────────────────────────────────────────
  /** The cloud's vertical axis — Z for LAS/LAZ surveys, Y for phone scans. */
  private readonly _worldUp = new THREE.Vector3(0, 1, 0);
  private _navListeners: NavListeners = {};
  private readonly _raycaster = new THREE.Raycaster();

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

    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600);

    // ── Scene ─────────────────────────────────────────────────────────────
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x1a1a2e);

    // ── Camera ────────────────────────────────────────────────────────────
    const aspect = (canvas.clientWidth || 800) / (canvas.clientHeight || 600);
    this._camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 5_000_000);
    this._camera.position.set(0, 0, 100);

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

    // ── Async backend init + render loop ──────────────────────────────────
    this.ready = this._renderer.init().then(() => {
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
  addCloud(cloud: PointCloud): string {
    const id = `cloud_${this._nextId++}`;
    const mode = defaultMode(cloud);

    // ── Shared billboard quad ─────────────────────────────────────────────
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(QUAD_CORNERS, 3),
    );
    geometry.setIndex(QUAD_INDEX);
    geometry.instanceCount = cloud.pointCount;

    // ── Per-point instance data ───────────────────────────────────────────
    const positionAttr = new THREE.InstancedBufferAttribute(cloud.positions, 3);
    const colorAttr = new THREE.InstancedBufferAttribute(
      toFloatColors(colorForMode(mode, cloud)),
      3,
    );

    // ── Material — drives the quad expansion on WebGPU and WebGL 2 ────────
    // `instancedBufferAttribute` is typed as a broad node-type union; narrow
    // it to each property's accepted type. The runtime value is correct — the
    // attribute's itemSize (3) makes it a vec3.
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

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    this._scene.add(mesh);

    this._clouds.set(id, { cloud, mesh, material, colorAttr, mode });
    this._configureForClouds(cloud);
    return id;
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
    for (const { material } of this._clouds.values()) {
      material.size = size;
    }
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
   * Render one frame and capture the canvas as a PNG `Blob`.
   */
  async snapshot(): Promise<Blob> {
    await this.ready;
    this._renderer.render(this._scene, this._camera);

    return new Promise<Blob>((resolve, reject) => {
      const canvas = this._renderer.domElement as HTMLCanvasElement;
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
    this._nav.dispose();
    this._controls.dispose();
    this._renderer.dispose();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Configure navigation (up-axis, speed, clip planes) for the loaded clouds. */
  private _configureForClouds(latest: PointCloud): void {
    // LAS/LAZ surveys are Z-up; phone-scan formats are Y-up.
    const zUp = latest.sourceFormat === 'las' || latest.sourceFormat === 'laz';
    this._worldUp.set(0, 0, zUp ? 1 : 0);
    if (!zUp) this._worldUp.set(0, 1, 0);
    this._nav.setWorldUp(this._worldUp);

    const sphere = this._visibleBoundingSphere();
    const size = sphere ? sphere.radius * 2 : 100;
    this._nav.setBaseSpeed(speedForSize(size));
    this._nav.setHasCloud(true);

    // Generous clip planes so flying around never clips the cloud.
    this._camera.near = Math.max(size * 0.0002, 0.01);
    this._camera.far = Math.max(size * 100, 1000);
    this._camera.updateProjectionMatrix();
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

  /** Pick the cloud point under normalised device coords, or null if none. */
  private _pickPoint(ndcX: number, ndcY: number): THREE.Vector3 | null {
    this._raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this._camera);
    const o = this._raycaster.ray.origin;
    const d = this._raycaster.ray.direction;

    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    for (const { mesh, cloud } of this._clouds.values()) {
      if (!mesh.visible) continue;
      const hit = nearestPointAlongRay(
        cloud.positions,
        [o.x, o.y, o.z],
        [d.x, d.y, d.z],
      );
      if (!hit) continue;
      const score = hit.offset / hit.along; // angular miss
      // Accept only a reasonably on-target hit (~within 4° of the ray).
      if (score < 0.07 && score < bestScore) {
        bestScore = score;
        best = new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2]);
      }
    }
    return best;
  }

  private _handleDoubleClick(e: MouseEvent, canvas: HTMLCanvasElement): void {
    const ndcX = (e.offsetX / canvas.clientWidth) * 2 - 1;
    const ndcY = -(e.offsetY / canvas.clientHeight) * 2 + 1;
    const point = this._pickPoint(ndcX, ndcY);
    if (point) this._nav.focusOn(point);
  }

  /** `F` key — focus on whatever point is centred in the view. */
  private _focusCenter(): void {
    const point = this._pickPoint(0, 0);
    if (point) this._nav.focusOn(point);
    else this.frameAll();
  }

  private _startLoop(): void {
    const loop = () => {
      this._rafId = requestAnimationFrame(loop);
      this._nav.update(this._clock.getDelta());
      this._renderer.render(this._scene, this._camera);
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
