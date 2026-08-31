/**
 * sceneLineOverlay.ts
 *
 * The shared lifecycle of a scene-object line overlay: one `THREE.LineSegments`
 * that attaches to a host only while it is shown, and releases its GPU buffers on
 * dispose. Subclasses own the geometry contents and when to show/clear; this base
 * owns the host membership and teardown so each overlay is not its own copy of
 * the attach / detach / dispose boilerplate.
 *
 * The host is the same minimal `add` / `remove` / `requestFrame` surface
 * `derivedLayerHost()` satisfies, so nothing here names the Viewer.
 */

import * as THREE from 'three/webgpu';

/** Scene membership and redraw, and nothing more. */
export interface SceneOverlayHost {
  add(object: THREE.Object3D): void;
  remove(object: THREE.Object3D): void;
  requestFrame(): void;
}

export interface SceneLineOverlayOptions {
  /** Object name, for scene inspection. */
  readonly name: string;
  /** Draw order relative to the scan and other overlays. */
  readonly renderOrder: number;
}

export abstract class SceneLineOverlay {
  protected readonly host: SceneOverlayHost;
  protected readonly geometry: THREE.BufferGeometry;
  protected readonly material: THREE.LineBasicMaterial;
  protected readonly lines: THREE.LineSegments;
  private _attached = false;
  private _disposed = false;

  protected constructor(
    host: SceneOverlayHost,
    material: THREE.LineBasicMaterialParameters,
    options: SceneLineOverlayOptions,
  ) {
    this.host = host;
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.LineBasicMaterial(material);
    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.name = options.name;
    this.lines.frustumCulled = false;
    this.lines.renderOrder = options.renderOrder;
    this.lines.visible = false;
  }

  /** Whether {@link dispose} has run; a subclass `show` returns early when true. */
  protected get isDisposed(): boolean {
    return this._disposed;
  }

  /** Make the object visible and part of the scene, then request a frame. */
  protected present(): void {
    this.lines.visible = true;
    if (!this._attached) {
      this.host.add(this.lines);
      this._attached = true;
    }
    this.host.requestFrame();
  }

  /** Hide and detach the object, then request a frame. */
  protected clear(): void {
    if (this._attached) {
      this.host.remove(this.lines);
      this._attached = false;
    }
    this.lines.visible = false;
    this.host.requestFrame();
  }

  /** Detach and release the GPU resources. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._attached) {
      this.host.remove(this.lines);
      this._attached = false;
    }
    this.geometry.dispose();
    this.material.dispose();
    this.host.requestFrame();
  }
}
