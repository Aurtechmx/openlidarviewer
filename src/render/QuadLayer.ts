/**
 * QuadLayer.ts — one filled-quad three.js layer's state: geometry, material,
 * mesh. Shared by `FlowOverlay.ts` (the accumulation/catchment layers) and
 * `TerrainAccessOverlay.ts` (the traversability-map layer) — the same
 * per-cell-quad upload/attach/dispose lifecycle, previously duplicated
 * verbatim between the two (Sonar-flagged).
 *
 * PRESENTATION, NOT SCIENCE. Every method here only uploads buffers a pure
 * builder already computed; it never reads a run's arrays to decide anything.
 */

import * as THREE from 'three/webgpu';
import type { SceneOverlayHost } from './sceneLineOverlay';

/** The buffer shape every caller's mesh builder produces. */
export interface QuadLayerBuffers {
  readonly verts: Float32Array;
  readonly colors: Float32Array;
  /**
   * Grid cells the buffers stand for, when that is not one quad per cell
   * (the flow network draws several quads per cell). Defaults to quads.
   */
  readonly cellsDrawn?: number;
}

export class QuadLayer {
  private readonly _host: SceneOverlayHost;
  private readonly _opacity: number;
  private _mesh: THREE.Mesh | null = null;
  private _geometry: THREE.BufferGeometry | null = null;
  private _material: THREE.MeshBasicMaterial | null = null;
  // Attach state is tracked here rather than read off `mesh.parent`: a host
  // is only guaranteed to satisfy `add`/`remove`/`requestFrame` (the same
  // narrow contract `SceneLineOverlay` documents), not to be a real
  // `THREE.Object3D` that sets `.parent` as a side effect of `add`.
  private _attached = false;
  private _cells: number | null = null;

  private readonly _renderOrder: number;

  /** `renderOrder` defaults to 1; a higher value draws over layers below it. */
  constructor(host: SceneOverlayHost, opacity: number, renderOrder = 1) {
    this._host = host;
    this._opacity = opacity;
    this._renderOrder = renderOrder;
  }

  /** Cells currently drawn — `cellsDrawn` when given, else 6 vertices per cell. 0 = nothing drawn. */
  get cellCount(): number {
    if (!this._geometry) return 0;
    return this._cells ?? (this._geometry.getAttribute('position')?.count ?? 0) / 6;
  }

  set(buffers: QuadLayerBuffers): void {
    this._cells = buffers.cellsDrawn ?? null;
    if (!this._material) {
      const material = new THREE.MeshBasicMaterial();
      material.vertexColors = true;
      material.transparent = true;
      material.opacity = this._opacity;
      material.depthWrite = false;
      material.side = THREE.DoubleSide;
      this._material = material;
    }
    if (!this._geometry) this._geometry = new THREE.BufferGeometry();
    this._geometry.setAttribute('position', new THREE.BufferAttribute(buffers.verts, 3));
    this._geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3));
    if (!this._mesh) {
      this._mesh = new THREE.Mesh(this._geometry, this._material);
      this._mesh.frustumCulled = false;
      this._mesh.renderOrder = this._renderOrder;
    }
    if (!this._attached) {
      this._host.add(this._mesh);
      this._attached = true;
    }
    this._host.requestFrame();
  }

  setVisible(visible: boolean): void {
    if (this._mesh) this._mesh.visible = visible;
    this._host.requestFrame();
  }

  clear(): void {
    if (this._attached && this._mesh) this._host.remove(this._mesh);
    this._attached = false;
    this._geometry?.dispose();
    this._material?.dispose();
    this._mesh = null;
    this._geometry = null;
    this._material = null;
    this._cells = null;
    this._host.requestFrame();
  }
}
