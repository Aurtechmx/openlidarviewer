/**
 * TerrainAccessOverlay.ts — the thin three.js binding that draws a Terrain
 * Access run in the 3D scene: the traversability map and the found route, two
 * independent, individually disposable objects attached through the same
 * `derivedLayerHost()`-shaped host `FlowOverlay.ts` and contours use.
 *
 * Reuses the same split `FlowOverlay.ts` makes: geometry decisions live in
 * `terrainAccessOverlayGeometry.ts`, pure and unit-tested; this file is
 * upload, material state and lifecycle only. `QuadLayer` is deliberately
 * copied rather than imported from `FlowOverlay.ts` — a private class, not a
 * shared export — but is otherwise identical, so the two overlays cannot
 * silently diverge in how a quad mesh is attached, toggled or disposed.
 *
 * PRESENTATION, NOT SCIENCE. Toggling this overlay on screen cannot change a
 * run's `resultDigest`; it only uploads buffers a pure builder already
 * computed.
 */

import * as THREE from 'three/webgpu';
import { SceneLineOverlay, type SceneOverlayHost } from './sceneLineOverlay';
import type { TerrainAccessOverlayLineBuffers, TerrainAccessOverlayMeshBuffers } from './terrainAccessOverlayGeometry';

export type TerrainAccessOverlayHost = SceneOverlayHost;

const MAP_OPACITY = 0.65;
const ROUTE_COLOR = 0xfaf359;

class QuadLayer {
  private readonly _host: SceneOverlayHost;
  private readonly _opacity: number;
  private _mesh: THREE.Mesh | null = null;
  private _geometry: THREE.BufferGeometry | null = null;
  private _material: THREE.MeshBasicMaterial | null = null;
  private _attached = false;

  constructor(host: SceneOverlayHost, opacity: number) {
    this._host = host;
    this._opacity = opacity;
  }

  get cellCount(): number {
    return (this._geometry?.getAttribute('position')?.count ?? 0) / 6;
  }

  set(buffers: TerrainAccessOverlayMeshBuffers): void {
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
