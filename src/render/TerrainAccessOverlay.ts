/**
 * TerrainAccessOverlay.ts — the thin three.js binding that draws a Terrain
 * Access run in the 3D scene: the traversability map and the found route, two
 * independent, individually disposable objects attached through the same
 * `derivedLayerHost()`-shaped host `FlowOverlay.ts` and contours use.
 *
 * Reuses the same split `FlowOverlay.ts` makes: geometry decisions live in
 * `terrainAccessOverlayGeometry.ts`, pure and unit-tested; this file is
 * upload, material state and lifecycle only. `QuadLayer` (`QuadLayer.ts`) is
 * the same shared class `FlowOverlay.ts` uses for its own filled layers, so
 * the two overlays cannot silently diverge in how a quad mesh is attached,
 * toggled or disposed.
 *
 * PRESENTATION, NOT SCIENCE. Toggling this overlay on screen cannot change a
 * run's `resultDigest`; it only uploads buffers a pure builder already
 * computed.
 */

import { SceneLineOverlay, type SceneOverlayHost } from './sceneLineOverlay';
import { QuadLayer } from './QuadLayer';
import * as THREE from 'three/webgpu';
import type { TerrainAccessOverlayLineBuffers, TerrainAccessOverlayMeshBuffers } from './terrainAccessOverlayGeometry';

export type TerrainAccessOverlayHost = SceneOverlayHost;

const MAP_OPACITY = 0.65;
const ROUTE_COLOR = 0xfaf359;

/** The found route: one flat-coloured line strip. */
class RouteLayer extends SceneLineOverlay {
  constructor(host: SceneOverlayHost) {
    super(
      host,
      { color: ROUTE_COLOR, transparent: true, opacity: 0.95, depthTest: false },
      { name: 'olv-terrain-access-route', renderOrder: 3 },
    );
  }

  get segmentCount(): number {
    return (this.geometry.getAttribute('position')?.count ?? 0) / 2;
  }

  setRoute(buffers: TerrainAccessOverlayLineBuffers): void {
    if (this.isDisposed) return;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(buffers.verts, 3));
    if (buffers.segments > 0) this.present();
    else this.clear();
  }

  clearRoute(): void {
    this.clear();
  }
}

export class TerrainAccessOverlay {
  private readonly _map: QuadLayer;
  private readonly _route: RouteLayer;

  constructor(host: TerrainAccessOverlayHost) {
    this._map = new QuadLayer(host, MAP_OPACITY);
    this._route = new RouteLayer(host);
  }

  /** Cells the traversability map currently draws. 0 = nothing drawn. */
  get mapCellCount(): number {
    return this._map.cellCount;
  }

  /** Segments the route currently draws. 0 = nothing drawn. */
  get routeSegmentCount(): number {
    return this._route.segmentCount;
  }

  setMap(buffers: TerrainAccessOverlayMeshBuffers): void {
    this._map.set(buffers);
  }

  clearMap(): void {
    this._map.clear();
  }

  setMapVisible(visible: boolean): void {
    this._map.setVisible(visible);
  }

  setRoute(buffers: TerrainAccessOverlayLineBuffers): void {
    this._route.setRoute(buffers);
  }

  clearRoute(): void {
    this._route.clearRoute();
  }

  /** Remove every layer from the scene and release its GPU resources. Idempotent. */
  dispose(): void {
    this._map.clear();
    this._route.dispose();
  }
}
