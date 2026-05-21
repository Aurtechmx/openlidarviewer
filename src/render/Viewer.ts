/**
 * Viewer.ts
 *
 * Wraps three.js WebGPURenderer (auto-falls-back to WebGL 2) and exposes a
 * minimal, typed API for loading/managing point-cloud layers, switching colour
 * modes, and camera control.
 *
 * Import note: this file imports from 'three/webgpu' (browser globals required)
 * and must NOT be imported in Node / Vitest tests.
 */

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { PointCloud } from '../model/PointCloud';
import { colorForMode, defaultMode } from './colorModes';
import type { ColorMode } from './colorModes';

// ─────────────────────────────────────────────────────────────────────────────
// Internal data per loaded cloud
// ─────────────────────────────────────────────────────────────────────────────

interface CloudEntry {
  cloud: PointCloud;
  points: THREE.Points;
  /** Current colour mode applied to the geometry's color attribute. */
  mode: ColorMode;
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

  // ── Shared point size (applied to all materials) ─────────────────────────
  private _pointSize = 1.5;

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
   * Builds a `THREE.Points` mesh with a `BufferGeometry` carrying:
   * - `position` attribute from `cloud.positions` (Float32, xyz local coords)
   * - `color` attribute from the default colour mode, normalised to [0, 1]
   *
   * @returns A string ID that identifies this cloud in subsequent calls.
   */
  addCloud(cloud: PointCloud): string {
    const id = `cloud_${this._nextId++}`;
    const mode = defaultMode(cloud);

    const geometry = new THREE.BufferGeometry();

    // Position attribute — three.js needs Float32, 3 items per vertex.
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(cloud.positions, 3),
    );

    // Colour attribute — our colorForMode returns Uint8 [0-255]; pass
    // normalized=true so three.js maps them to [0,1] floats in the shader.
    const rawColors = colorForMode(mode, cloud);
    geometry.setAttribute(
      'color',
      new THREE.Uint8BufferAttribute(rawColors, 3, true),
    );

    const material = new THREE.PointsMaterial({
      size: this._pointSize,
      vertexColors: true,
      sizeAttenuation: true,
    });

    const points = new THREE.Points(geometry, material);
    this._scene.add(points);

    this._clouds.set(id, { cloud, points, mode });
    return id;
  }

  /**
   * Remove a previously added cloud from the scene and free its GPU resources.
   */
  removeCloud(id: string): void {
    const entry = this._clouds.get(id);
    if (!entry) return;
    this._scene.remove(entry.points);
    entry.points.geometry.dispose();
    (entry.points.material as THREE.PointsMaterial).dispose();
    this._clouds.delete(id);
  }

  /** Return an array of all currently loaded cloud IDs. */
  clouds(): string[] {
    return [...this._clouds.keys()];
  }

  /** Show or hide a cloud. */
  setCloudVisible(id: string, visible: boolean): void {
    const entry = this._clouds.get(id);
    if (entry) entry.points.visible = visible;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Colour mode & point size
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Swap the colour attribute of a cloud's geometry to a different mode.
   * The geometry's `color` attribute is replaced in-place so the existing
   * material and draw call are reused.
   */
  setColorMode(id: string, mode: ColorMode): void {
    const entry = this._clouds.get(id);
    if (!entry) return;
    if (entry.mode === mode) return;

    const rawColors = colorForMode(mode, entry.cloud);
    const attr = new THREE.Uint8BufferAttribute(rawColors, 3, true);
    entry.points.geometry.setAttribute('color', attr);
    entry.mode = mode;
  }

  /**
   * Set the pixel size of all rendered points.
   * Applies to every loaded cloud's material.
   */
  setPointSize(size: number): void {
    this._pointSize = size;
    for (const { points } of this._clouds.values()) {
      (points.material as THREE.PointsMaterial).size = size;
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
    for (const { points, cloud } of this._clouds.values()) {
      if (!points.visible) continue;
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
