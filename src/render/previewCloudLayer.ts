/**
 * previewCloudLayer.ts
 *
 * The stand-in cloud a local load shows while its decode runs. It is drawn
 * like a layer but is not one: nothing lists, measures or exports it, and it
 * is disposed the moment the real cloud commits.
 *
 * The mesh is built once at a fixed capacity and filled in as chunks arrive,
 * in whatever order the pool finishes them, by writing into the attribute
 * arrays behind an update range and raising the instance count. The preview
 * stays a uniform subsample of the source as it fills rather than a complete
 * copy of its first part: `preThinned` chunks arrive already sampled to the
 * capacity, and any others are thinned here by one stride chosen so the whole
 * file fits it. Colour is an elevation ramp over one fixed
 * range, the header's declared extent when the file gave one, so successive
 * chunks share one ramp.
 *
 * Pure with respect to the Viewer: it takes a host (add, remove, redraw) and
 * the Viewer's point-mesh builder, and owns its three.js objects.
 */

import * as THREE from 'three/webgpu';
import { colorByElevation } from './colorModes';
import { writeFloatColorsInto } from './colorEncode';

export { PREVIEW_MAX_POINTS } from './previewLimits';

export interface PreviewLayerHost {
  add(object: THREE.Object3D): void;
  remove(object: THREE.Object3D): void;
  requestFrame(): void;
}

export interface PreviewLayerSpec {
  /** Points the mesh is built for; the stride follows from this and `expectedPoints`. */
  readonly capacity: number;
  /** Records the finished decode will hold. */
  readonly expectedPoints: number;
  /**
   * True when the chunks arrive already thinned to the capacity by whoever
   * decodes them, which is what the pooled `.laz` path does. The layer then
   * stores each chunk as it stands instead of sampling it a second time, which
   * would keep one record in `stride` of an already-strided sample.
   */
  readonly preThinned?: boolean;
  /** The declared extent, local frame, when the source gave a usable one. */
  readonly frame?: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };
  /** Which component is up for the elevation ramp; 2 for a LAS survey. */
  readonly upAxis?: 0 | 1 | 2;
}

/** The Viewer's mesh builder, as this layer needs it. */
export type PointMeshBuilder = (
  positions: Float32Array,
  colorsU8: Uint8Array,
) => { mesh: THREE.Mesh; material: THREE.Material; colorAttr: THREE.InstancedBufferAttribute };

export class PreviewCloudLayer {
  private readonly _mesh: THREE.Mesh;
  private readonly _material: THREE.Material;
  private readonly _positions: THREE.InstancedBufferAttribute;
  private readonly _colors: THREE.InstancedBufferAttribute;
  private readonly _capacity: number;
  private readonly _stride: number;
  private readonly _upAxis: 0 | 1 | 2;
  private _range: { min: number; max: number } | null;
  private _count = 0;
  private readonly _min: [number, number, number] = [Infinity, Infinity, Infinity];
  private readonly _max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  private readonly _host: PreviewLayerHost;

  constructor(host: PreviewLayerHost, build: PointMeshBuilder, spec: PreviewLayerSpec) {
    this._host = host;
    this._capacity = Math.max(1, Math.floor(spec.capacity));
    this._stride = spec.preThinned ? 1 : Math.max(1, Math.ceil(spec.expectedPoints / this._capacity));
    this._upAxis = spec.upAxis ?? 2;
    this._range = spec.frame
      ? { min: spec.frame.min[this._upAxis], max: spec.frame.max[this._upAxis] }
      : null;
    const { mesh, material, colorAttr } = build(
      new Float32Array(this._capacity * 3),
      new Uint8Array(this._capacity * 3),
    );
    this._mesh = mesh;
    this._material = material;
    this._colors = colorAttr;
    this._positions = mesh.geometry.getAttribute('aPos') as THREE.InstancedBufferAttribute;
    this._positions.setUsage(THREE.DynamicDrawUsage);
    this._colors.setUsage(THREE.DynamicDrawUsage);
    (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
    host.add(mesh);
  }

  /** Points on screen so far. */
  get pointCount(): number {
    return this._count;
  }

  /** The stride applied to every chunk. */
  get stride(): number {
    return this._stride;
  }

  /** Extent of the points appended so far, or null before the first. */
  bounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    return this._count === 0 ? null : { min: [...this._min], max: [...this._max] };
  }

  /**
   * Append a chunk's positions, thinned by the stride, up to the capacity.
   * The first append fixes the colour range from its own extent when the
   * source declared none.
   */
  append(chunk: { readonly positions: Float32Array }): void {
    const { positions } = chunk;
    const room = this._capacity - this._count;
    if (room <= 0) return;
    const available = Math.floor(positions.length / 3);
    const take = Math.min(room, Math.ceil(available / this._stride));
    if (take <= 0) return;
    const pos = this._positions.array as Float32Array;
    const base = this._count * 3;
    for (let k = 0, i = 0; k < take; k++, i += this._stride) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      pos[base + k * 3] = x;
      pos[base + k * 3 + 1] = y;
      pos[base + k * 3 + 2] = z;
      if (x < this._min[0]) this._min[0] = x;
      if (y < this._min[1]) this._min[1] = y;
      if (z < this._min[2]) this._min[2] = z;
      if (x > this._max[0]) this._max[0] = x;
      if (y > this._max[1]) this._max[1] = y;
      if (z > this._max[2]) this._max[2] = z;
    }
    const written = pos.subarray(base, base + take * 3);
    if (this._range === null) {
      this._range = { min: this._min[this._upAxis], max: this._max[this._upAxis] };
    }
    const colorsU8 = colorByElevation(written, take, this._range.min, this._range.max, undefined, this._upAxis);
    const colorArray = this._colors.array as Float32Array;
    writeFloatColorsInto(colorArray.subarray(base, base + take * 3), colorsU8);

    this._positions.addUpdateRange(base, take * 3);
    this._positions.needsUpdate = true;
    this._colors.addUpdateRange(base, take * 3);
    this._colors.needsUpdate = true;
    this._count += take;
    (this._mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = this._count;
    this._host.requestFrame();
  }

  /** Remove the mesh and release its buffers. */
  dispose(): void {
    this._host.remove(this._mesh);
    this._mesh.geometry.dispose();
    this._material.dispose();
    this._host.requestFrame();
  }
}
