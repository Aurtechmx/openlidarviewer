/**
 * StreamingRenderer.ts
 *
 * Manages the GPU meshes of resident COPC streaming nodes. Each resident node
 * is one instanced-quad mesh built by the Viewer's shared `buildPointMesh` —
 * the very same primitive a static cloud uses — so Eye Dome Lighting, point
 * sizing, and the WebGPU / WebGL2 backends all apply to streaming nodes for
 * free.
 *
 * It holds each node's decoded chunk so a colour-mode switch can recolour every
 * resident node without re-streaming. Colours use cloud-global ranges, seeded
 * from the coarse root node, so adjacent nodes never band.
 *
 * Three.js types are imported type-only — the actual meshes are built and
 * disposed by the Viewer; this module only orchestrates.
 */

import type * as THREE from 'three/webgpu';
import type { Viewer, PointMeshHandle } from '../Viewer';
import type { StreamingPointCloud } from './StreamingPointCloud';
import type { StreamingNode } from './StreamingNode';
import type { DecodedChunk } from '../../io/copc/copcChunkDecode';
import type { ColorMode } from '../colorModes';
import { streamingNodeColors, intensityRangeOf } from './streamingColors';
import type { StreamingColorRanges } from './streamingColors';

/** One resident node's GPU mesh plus the decoded chunk kept for recolouring. */
interface NodeMesh {
  mesh: THREE.Mesh;
  colorAttr: THREE.InstancedBufferAttribute;
  decoded: DecodedChunk;
}

/** Manages the per-node meshes of a streaming COPC cloud. */
export class StreamingRenderer {
  private readonly _viewer: Viewer;
  private readonly _meshes = new Map<string, NodeMesh>();
  private _mode: ColorMode;
  private _ranges: StreamingColorRanges;
  private _intensitySeeded = false;

  constructor(viewer: Viewer, cloud: StreamingPointCloud, mode: ColorMode) {
    this._viewer = viewer;
    this._mode = mode;
    // Elevation range from the COPC cube; intensity range is seeded once the
    // coarse root node arrives.
    const local = cloud.localBounds();
    this._ranges = {
      minZ: local[2],
      maxZ: local[5],
      minIntensity: 0,
      maxIntensity: 1,
    };
  }

  /** The active colour mode. */
  get colorMode(): ColorMode {
    return this._mode;
  }

  /** Count of resident node meshes currently in the scene. */
  get residentMeshCount(): number {
    return this._meshes.size;
  }

  /** A decoded node is ready — build its mesh and add it to the scene. */
  onNodeReady(node: StreamingNode, decoded: DecodedChunk): void {
    if (this._meshes.has(node.record.id)) return; // already resident
    // Seed the global intensity range from the first (coarsest) node decoded.
    if (!this._intensitySeeded && decoded.pointCount > 0) {
      const range = intensityRangeOf(decoded);
      this._ranges = {
        ...this._ranges,
        minIntensity: range.min,
        maxIntensity: range.max,
      };
      this._intensitySeeded = true;
      if (this._mode === 'intensity') this._recolorAll();
    }
    const colors = streamingNodeColors(this._mode, decoded, this._ranges);
    const handle: PointMeshHandle = this._viewer.buildPointMesh(decoded.positions, colors);
    this._viewer.addStreamingMesh(handle.mesh, decoded);
    this._meshes.set(node.record.id, {
      mesh: handle.mesh,
      colorAttr: handle.colorAttr,
      decoded,
    });
  }

  /** A node was evicted — remove and dispose its mesh. */
  onNodeEvicted(node: StreamingNode): void {
    const entry = this._meshes.get(node.record.id);
    if (!entry) return;
    this._viewer.removeStreamingMesh(entry.mesh);
    this._meshes.delete(node.record.id);
  }

  /** Switch the colour mode — recolours every resident node in place. */
  setColorMode(mode: ColorMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    this._recolorAll();
  }

  /** Resident node position arrays — for streaming point picking. */
  positionArrays(): Float32Array[] {
    const out: Float32Array[] = [];
    for (const entry of this._meshes.values()) out.push(entry.decoded.positions);
    return out;
  }

  /** Remove and dispose every resident mesh. */
  dispose(): void {
    for (const entry of this._meshes.values()) {
      this._viewer.removeStreamingMesh(entry.mesh);
    }
    this._meshes.clear();
  }

  /** Recolour every resident node for the current mode and ranges. */
  private _recolorAll(): void {
    for (const entry of this._meshes.values()) {
      const colors = streamingNodeColors(this._mode, entry.decoded, this._ranges);
      const array = entry.colorAttr.array as Float32Array;
      for (let i = 0; i < colors.length; i++) array[i] = colors[i] / 255;
      entry.colorAttr.needsUpdate = true;
    }
  }
}
