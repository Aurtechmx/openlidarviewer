/**
 * FlowOverlay.ts
 *
 * The thin three.js binding that draws routed flow in the 3D scene: the
 * accumulation heatmap, the click-to-pulse downstream path, and the upstream
 * catchment region — three independent, individually disposable objects
 * attached through the same `derivedLayerHost()`-shaped host contours use.
 *
 * Everything decidable without three lives next door in
 * `flowOverlayGeometry.ts` (which cells, what colour, where in the frame),
 * pure and unit-tested; what remains here is upload, material state, and
 * lifecycle — the same split `ContourOverlay.ts` makes for the same reason.
 * The path reuses `SceneLineOverlay`, the shared attach/detach/dispose base
 * `ProfileLinkOverlay` and the measure overlays already stand on, rather than
 * a second copy of that boilerplate; the two filled layers (accumulation,
 * catchment) have no such base in the tree, so `QuadLayer` below is the small
 * amount that is genuinely new.
 *
 * PRESENTATION, NOT SCIENCE. Every method here only uploads buffers a pure
 * builder already computed; it never reads a run's arrays to decide anything,
 * and it never writes to them. Toggling a layer on screen cannot change what
 * `flowFieldDigest` would report for the run behind it (see
 * `tests/flowOverlayGeometry.test.ts`).
 */

import * as THREE from 'three/webgpu';
import { SceneLineOverlay, type SceneOverlayHost } from './sceneLineOverlay';
import type { FlowOverlayLineBuffers, FlowOverlayMeshBuffers } from './flowOverlayGeometry';

/** Scene membership and redraw, and nothing more — `Viewer.derivedLayerHost()`. */
export type FlowOverlayHost = SceneOverlayHost;

const ACCUMULATION_OPACITY = 0.72;
const CATCHMENT_OPACITY = 0.5;
const PATH_COLOR = 0xfaf359;

/** One filled-quad layer's three.js state: geometry, material, mesh. */
class QuadLayer {
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

  constructor(host: SceneOverlayHost, opacity: number) {
    this._host = host;
    this._opacity = opacity;
  }

  /** Cells currently drawn — 6 vertices per cell. 0 = nothing drawn. */
  get cellCount(): number {
    return (this._geometry?.getAttribute('position')?.count ?? 0) / 6;
  }

  set(buffers: FlowOverlayMeshBuffers): void {
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
      this._mesh.renderOrder = 1;
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
    this._host.requestFrame();
  }
}

/** The click-to-pulse downstream path: one flat-coloured line strip. */
class PathLayer extends SceneLineOverlay {
  constructor(host: SceneOverlayHost) {
    super(
      host,
      { color: PATH_COLOR, transparent: true, opacity: 0.95, depthTest: false },
      { name: 'olv-flow-path', renderOrder: 3 },
    );
  }

  /** Segments currently drawn. 0 = nothing drawn. */
  get segmentCount(): number {
    return (this.geometry.getAttribute('position')?.count ?? 0) / 2;
  }

  setPath(buffers: FlowOverlayLineBuffers): void {
    if (this.isDisposed) return;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(buffers.verts, 3));
    if (buffers.segments > 0) this.present();
    else this.clear();
  }

  clearPath(): void {
    this.clear();
  }
}

export class FlowOverlay {
  private readonly _accumulation: QuadLayer;
  private readonly _catchment: QuadLayer;
  private readonly _path: PathLayer;

  constructor(host: FlowOverlayHost) {
    this._accumulation = new QuadLayer(host, ACCUMULATION_OPACITY);
    this._catchment = new QuadLayer(host, CATCHMENT_OPACITY);
    this._path = new PathLayer(host);
  }

  /** Cells the accumulation heatmap currently draws. 0 = nothing drawn. */
  get accumulationCellCount(): number {
    return this._accumulation.cellCount;
  }

  /** Cells the catchment region currently draws. 0 = nothing drawn. */
  get catchmentCellCount(): number {
    return this._catchment.cellCount;
  }

  /** Segments the path currently draws. 0 = nothing drawn. */
  get pathSegmentCount(): number {
    return this._path.segmentCount;
  }

  setAccumulation(buffers: FlowOverlayMeshBuffers): void {
    this._accumulation.set(buffers);
  }

  clearAccumulation(): void {
    this._accumulation.clear();
  }

  /** Show or hide the accumulation heatmap without discarding the upload. */
  setAccumulationVisible(visible: boolean): void {
    this._accumulation.setVisible(visible);
  }

  setCatchment(buffers: FlowOverlayMeshBuffers): void {
    this._catchment.set(buffers);
  }

  clearCatchment(): void {
    this._catchment.clear();
  }

  setPath(buffers: FlowOverlayLineBuffers): void {
    this._path.setPath(buffers);
  }

  clearPath(): void {
    this._path.clearPath();
  }

  /** Remove every layer from the scene and release its GPU resources. Idempotent. */
  dispose(): void {
    this._accumulation.clear();
    this._catchment.clear();
    this._path.dispose();
  }
}
