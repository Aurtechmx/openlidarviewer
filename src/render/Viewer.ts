/**
 * Viewer.ts
 *
 * Wraps three.js WebGPURenderer (auto-falls-back to WebGL 2) and exposes a
 * minimal, typed API for loading/managing point-cloud layers, switching colour
 * modes, and camera control.
 *
 * ## Why points are drawn as instanced quads
 *
 * A `THREE.Points` object is rendered with the GPU's native point primitive.
 * On the WebGPU backend that primitive is **locked to one pixel** — three.js
 * cannot enlarge it (see `PointsNodeMaterial`'s own documentation). A scan
 * therefore renders as invisible one-pixel dust on WebGPU while looking fine
 * on WebGL 2, which is exactly the kind of backend-specific bug that is hard
 * to catch.
 *
 * To render identically on both backends every point is instead drawn as a
 * camera-facing quad: one shared unit quad, instanced once per point, with the
 * per-point centre and colour supplied as instanced attributes. `three/tsl`'s
 * `PointsNodeMaterial` expands those quads to a real, controllable pixel size
 * on WebGPU *and* WebGL 2 — the same node graph compiles to both.
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
  private _rafId: number | null = null;

  // ── Cloud registry ───────────────────────────────────────────────────────
  private readonly _clouds = new Map<string, CloudEntry>();
  private _nextId = 0;

  // ── Shared point size in screen pixels (applied to all materials) ────────
  // Matches the Inspector's point-size slider initial value.
  private _pointSize = 2;

  // ─────────────────────────────────────────────────────────────────────────
  // Constructor
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create the renderer attached to `canvas`, wire up a perspective camera
   * with OrbitControls, and kick off the render loop.
   *
   * The renderer attempts to use a native WebGPU backend; if WebGPU is
   * unavailable it falls back automatically to WebGL 2.
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
    this._camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 1_000_000);
    this._camera.position.set(0, 0, 100);

    // ── OrbitControls ─────────────────────────────────────────────────────
    this._controls = new OrbitControls(this._camera, canvas);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.07;

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
    // Positions are reused as-is (Float32, xyz local coords); colours are
    // expanded to Float32 [0,1] so the attribute needs no normalisation.
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
    // Constant screen-space size: a cloud stays visible whatever its world
    // scale (a 2 m phone scan or a 2 km survey) and whatever the zoom.
    material.sizeAttenuation = false;
    material.transparent = false;

    const mesh = new THREE.Mesh(geometry, material);
    // The geometry's bounds are just the unit quad, so per-object frustum
    // culling would wrongly cull the whole cloud — disable it.
    mesh.frustumCulled = false;
    this._scene.add(mesh);

    this._clouds.set(id, { cloud, mesh, material, colorAttr, mode });
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
  // Camera
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fit the camera to encompass all visible clouds.
   *
   * Computes the combined world-space bounding sphere and positions the
   * camera so the full sphere fits within the viewport.
   */
  frameAll(): void {
    if (this._clouds.size === 0) return;

    const box = new THREE.Box3();
    for (const { mesh, cloud } of this._clouds.values()) {
      if (!mesh.visible) continue;
      const b = cloud.bounds();
      box.expandByPoint(new THREE.Vector3(b.min[0], b.min[1], b.min[2]));
      box.expandByPoint(new THREE.Vector3(b.max[0], b.max[1], b.max[2]));
    }
    if (box.isEmpty()) return;

    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);

    const center = sphere.center;
    const radius = sphere.radius === 0 ? 1 : sphere.radius;

    // Distance needed so the sphere fills ~80 % of the vertical FOV.
    const fovRad = THREE.MathUtils.degToRad(this._camera.fov);
    const dist = radius / Math.sin(fovRad / 2) * 1.2;

    this._camera.position.set(center.x, center.y, center.z + dist);
    this._camera.near = dist * 0.001;
    this._camera.far = dist * 100;
    this._camera.updateProjectionMatrix();

    this._controls.target.copy(center);
    this._controls.update();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Report which GPU backend is active.
   *
   * Reads `renderer.backend.isWebGPUBackend` which is set to `true` by the
   * WebGPU backend class after init.  Call after `await viewer.ready`.
   */
  activeBackend(): 'webgpu' | 'webgl2' {
    // The `backend` property is defined on Renderer as `this.backend`.
    // three.js sets `isWebGPUBackend = true` on WebGPUBackend instances.
    const backend = (this._renderer as unknown as { backend: { isWebGPUBackend?: boolean } }).backend;
    return backend?.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
  }

  /**
   * Render one frame and capture the canvas as a PNG `Blob`.
   *
   * Waits for the backend to be ready before rendering.
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

    this._controls.dispose();
    this._renderer.dispose();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private _startLoop(): void {
    const loop = () => {
      this._rafId = requestAnimationFrame(loop);
      this._controls.update();
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
