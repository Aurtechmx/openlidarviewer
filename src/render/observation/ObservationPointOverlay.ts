/**
 * ObservationPointOverlay.ts
 *
 * The thin three.js binding for OB-PR-01: a per-point colour view of the
 * evidence field, drawn as its OWN `THREE.Points` object rather than by
 * mutating the scan's own render mesh — `PointCloud` (`src/model/`) and
 * whatever object the main renderer builds from it stay untouched (OB-INV-11
 * reads narrowly as "no writes to points/classification/flags/poses", but
 * this overlay goes further and never even attaches to that object), so
 * nothing here needs the loader/PointCloud ASK.
 *
 * Everything decidable without three lives next door in
 * `observationColorModes.ts` (which colour, from which field), pure and
 * unit-tested; what remains here is upload and lifecycle, the same split
 * `ContourOverlay.ts` and `FlowOverlay.ts` make.
 *
 * NO-GEOMETRY-REBUILD (OB-PR-01). The `position` attribute is created once,
 * in `attach()`, from the cloud's own positions — the same array instance
 * `sourcePositions()`/`renderLocalPositions()` return, never copied twice.
 * `setColors()` — called once per resident cloud per field version — only
 * ever replaces the `color` attribute; it is the sole write path, and it
 * never touches `position`. `tests/observatoryPointOverlay.test.ts` asserts
 * the `position` attribute keeps object identity across repeated
 * `setColors()` calls with different field versions.
 */
import * as THREE from 'three/webgpu';
import type { SceneOverlayHost } from '../sceneLineOverlay';

export class ObservationPointOverlay {
  private readonly _host: SceneOverlayHost;
  private _points: THREE.Points | null = null;
  private _geometry: THREE.BufferGeometry | null = null;
  private _material: THREE.PointsMaterial | null = null;
  private _attached = false;
  private _disposed = false;

  constructor(host: SceneOverlayHost) {
    this._host = host;
  }

  /** The live `position` attribute, or `null` before the first `attach()`. Exposed only for the no-rebuild test. */
  get positionAttribute(): THREE.BufferAttribute | null {
    return (this._geometry?.getAttribute('position') as THREE.BufferAttribute | undefined) ?? null;
  }

  /** Points currently drawn — 0 before `attach()` or after `dispose()`. */
  get pointCount(): number {
    return this.positionAttribute?.count ?? 0;
  }

  /**
   * Builds the geometry ONCE from `positions` (a cloud's own frame,
   * unmodified) and a fixed point size. Calling `attach()` again on an
   * already-attached overlay is a no-op — a caller that resizes the resident
   * set disposes and constructs a fresh overlay instead, matching
   * `ContourOverlay`'s own one-shot-per-generation convention.
   */
  attach(positions: Float32Array, pointSizePx: number = 3): void {
    if (this._disposed || this._geometry) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const colors = new Uint8Array(positions.length);
    const colorAttr = new THREE.BufferAttribute(colors, 3, true);
    geometry.setAttribute('color', colorAttr);

    const material = new THREE.PointsMaterial({ size: pointSizePx, sizeAttenuation: false, vertexColors: true });
    const points = new THREE.Points(geometry, material);
    points.name = 'olv-observation-points';
    points.frustumCulled = false;
    points.visible = false;

    this._geometry = geometry;
    this._material = material;
    this._points = points;
  }

  /**
   * Replaces the `color` attribute with a new field's colours (OB-PR-01: one
   * rebuild of THIS buffer per resident cloud per field version). `position`
   * is never read from or written to here.
   */
  setColors(colors: Uint8Array): void {
    if (this._disposed || !this._geometry || !this._points) return;
    if (colors.length !== this.positionAttribute!.array.length) {
      throw new Error(
        `ObservationPointOverlay.setColors: expected ${this.positionAttribute!.array.length} colour bytes, got ${colors.length}`,
      );
    }
    const attr = new THREE.BufferAttribute(colors, 3, true);
    this._geometry.setAttribute('color', attr);
    if (!this._attached) {
      this._host.add(this._points);
      this._attached = true;
    }
    this._points.visible = true;
    this._host.requestFrame();
  }

  setVisible(visible: boolean): void {
    if (this._points) this._points.visible = visible;
    this._host.requestFrame();
  }

  /** Detaches from the host and releases every GPU buffer. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._attached && this._points) this._host.remove(this._points);
    this._attached = false;
    this._geometry?.dispose();
    this._material?.dispose();
    this._geometry = null;
    this._material = null;
    this._points = null;
    this._host.requestFrame();
  }
}
