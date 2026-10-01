/**
 * ObservatoryOverlay.ts: the three.js binding for the Observatory's
 * empty-space slice plane (OB-PR-02), drawn through
 * `Viewer.derivedLayerHost()` as contours and Flow Pulse are, so it is
 * visible in the scene and not only in the panel.
 *
 * One horizontal plane at one voxel level, textured with one texel per voxel
 * (`observatoryOverlayGeometry.ts`). Changing the level re-fills and
 * re-uploads the one texture; nothing else is rebuilt. The O11 benchmark chose
 * this over instanced boxes (validation/performance/observatory-o11/).
 */
import * as THREE from 'three/webgpu';
import type { SceneOverlayHost } from './sceneLineOverlay';
import type { ObservationState } from '../observation/types';
import { buildSliceTexels, sliceSize, type SliceGrid } from './observatoryOverlayGeometry';

export type ObservatoryOverlayHost = SceneOverlayHost;

export interface SliceField {
  readonly stateOf: (key: number) => ObservationState | undefined;
  readonly frontier: ReadonlySet<number>;
  readonly grid: SliceGrid;
  readonly voxelEdge: number;
  /** The field's minimum corner in the render (local) frame. */
  readonly domainMin: readonly [number, number, number];
}

export class ObservatoryOverlay {
  private readonly host: SceneOverlayHost;
  private mesh: THREE.Mesh | null = null;
  private texture: THREE.DataTexture | null = null;
  private field: SliceField | null = null;
  private level = 0;
  private disposed = false;

  constructor(host: ObservatoryOverlayHost) {
    this.host = host;
  }

  /** The level shown, or -1 when nothing is drawn. */
  get currentLevel(): number {
    return this.mesh ? this.level : -1;
  }

  /** Draw `field` at level `iz`, replacing any previous field. */
  show(field: SliceField, iz: number): void {
    if (this.disposed) return;
    this.release();
    const { width, height } = sliceSize(field.grid);
    const texture = new THREE.DataTexture(new Uint8Array(width * height * 4), width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    const w = field.grid.nx * field.voxelEdge;
    const h = field.grid.ny * field.voxelEdge;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    mesh.name = 'olv-observatory-slice';
    mesh.renderOrder = 5;
    mesh.frustumCulled = false;
    // Strided texels may cover several voxels each; the plane keeps the field's true extent.
    this.mesh = mesh;
    this.texture = texture;
    this.field = field;
    this.host.add(mesh);
    this.setLevel(iz);
  }

  /** Move the plane to level `iz` (clamped) and re-upload its texels. */
  setLevel(iz: number): void {
    if (!this.mesh || !this.texture || !this.field) return;
    const f = this.field;
    this.level = Math.min(Math.max(0, Math.round(iz)), f.grid.nz - 1);
    buildSliceTexels(f.stateOf, f.frontier, f.grid, this.level, this.texture.image.data as Uint8Array);
    this.texture.needsUpdate = true;
    this.mesh.position.set(
      f.domainMin[0] + (f.grid.nx * f.voxelEdge) / 2,
      f.domainMin[1] + (f.grid.ny * f.voxelEdge) / 2,
      f.domainMin[2] + (this.level + 0.5) * f.voxelEdge,
    );
    this.host.requestFrame();
  }

  /** Detach and release the GPU resources. Idempotent; a disposed overlay draws nothing. */
  dispose(): void {
    if (this.disposed) return;
    this.release();
    this.disposed = true;
  }

  private release(): void {
    if (!this.mesh) return;
    this.host.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture?.dispose();
    this.mesh = null;
    this.texture = null;
    this.field = null;
    this.host.requestFrame();
  }
}

// The station markers ride in this same lazy chunk (`loadObservatoryOverlay`).
export { ObservatoryStationMarkers } from './ObservatoryStationMarkers';
export { stationMarkerSize } from './observatoryStationMarkerGeometry';
export { defaultSliceLevel, sliceLegendText, sliceSize } from './observatoryOverlayGeometry';
