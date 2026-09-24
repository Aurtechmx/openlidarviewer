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
 * catchment) share `QuadLayer.ts`, the same filled-quad layer
 * `TerrainAccessOverlay.ts` uses for its traversability map.
 *
 * PRESENTATION, NOT SCIENCE. Every method here only uploads buffers a pure
 * builder already computed; it never reads a run's arrays to decide anything,
 * and it never writes to them. Toggling a layer on screen cannot change what
 * `flowFieldDigest` would report for the run behind it (see
 * `tests/flowOverlayGeometry.test.ts`).
 */

import * as THREE from 'three/webgpu';
import { SceneLineOverlay, type SceneOverlayHost } from './sceneLineOverlay';
import { QuadLayer } from './QuadLayer';
import type { FlowOverlayLineBuffers, FlowOverlayMeshBuffers } from './flowOverlayGeometry';

/** Scene membership and redraw, and nothing more — `Viewer.derivedLayerHost()`. */
export type FlowOverlayHost = SceneOverlayHost;

const ACCUMULATION_OPACITY = 0.72;
const CATCHMENT_OPACITY = 0.5;
const PATH_COLOR = 0xfaf359;

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
