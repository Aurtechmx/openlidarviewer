/**
 * arms.ts: the two OB-PR-02 overlay arms the O11 protocol compares
 * (validation/protocols/observatory-o11-v1.md). Each arm counts the bytes it
 * hands to the GPU, as the protocol defines them.
 */
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, positionLocal } from 'three/tsl';
import { OBSERVATION_STATES } from '../../src/observation/types';
import { OBSERVATION_STATE_RGB } from '../../src/observation/presentationLegend';
import type { DenseField } from './field';

export const MAX_SLICE_EDGE = 1024;
const OVERLAY_STATES = new Set(['OBSERVED_EMPTY', 'SHADOWED', 'UNADDRESSED']);
const FRONTIER_RGB: readonly [number, number, number] = [0.95, 0.3, 0.75];

/** RGBA8 per state index: overlay states opaque-ish, every other state clear. */
function stateRgba(): Uint8Array {
  const out = new Uint8Array(OBSERVATION_STATES.length * 4);
  OBSERVATION_STATES.forEach((s, i) => {
    const rgb = OBSERVATION_STATE_RGB[s];
    out[i * 4] = Math.round(rgb[0] * 255);
    out[i * 4 + 1] = Math.round(rgb[1] * 255);
    out[i * 4 + 2] = Math.round(rgb[2] * 255);
    out[i * 4 + 3] = OVERLAY_STATES.has(s) ? 200 : 0;
  });
  return out;
}

export interface OverlayArm {
  readonly object: THREE.Object3D;
  /** Called once per measured frame, before render. */
  frame(index: number): void;
  /** Start counting at the first measured frame: buffers uploaded once stay counted, repeated uploads restart. */
  startCounting(): void;
  uploadBytes(): number;
  dispose(): void;
}

function geometryBytes(g: THREE.BufferGeometry): number {
  let n = g.index ? g.index.array.byteLength : 0;
  for (const name of Object.keys(g.attributes)) n += (g.attributes[name] as THREE.BufferAttribute).array.byteLength;
  return n;
}

export function createSliceArm(field: DenseField): OverlayArm {
  const { nx, ny, nz } = field.grid;
  if (nx > MAX_SLICE_EDGE || ny > MAX_SLICE_EDGE) throw new Error(`slice arm: ${nx} x ${ny} exceeds MAX_SLICE_EDGE`);
  const lut = stateRgba();
  const data = new Uint8Array(nx * ny * 4);
  const texture = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  const geometry = new THREE.PlaneGeometry(nx * field.voxelEdge, ny * field.voxelEdge);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  let bytes = geometryBytes(geometry);
  let level = -1;
  const fill = (iz: number) => {
    const base = nx * ny * iz;
    for (let i = 0; i < nx * ny; i++) {
      const v = base + i;
      if (field.frontier[v]) {
        data[i * 4] = FRONTIER_RGB[0] * 255; data[i * 4 + 1] = FRONTIER_RGB[1] * 255; data[i * 4 + 2] = FRONTIER_RGB[2] * 255; data[i * 4 + 3] = 230;
      } else {
        const s = field.states[v]! * 4;
        data[i * 4] = lut[s]!; data[i * 4 + 1] = lut[s + 1]!; data[i * 4 + 2] = lut[s + 2]!; data[i * 4 + 3] = lut[s + 3]!;
      }
    }
    texture.needsUpdate = true;
    bytes += data.byteLength;
    mesh.position.set((nx * field.voxelEdge) / 2, (ny * field.voxelEdge) / 2, (iz + 0.5) * field.voxelEdge);
  };
  return {
    object: mesh,
    frame(index) {
      const next = Math.floor(index / 10) % nz;
      if (next !== level) { level = next; fill(level); }
    },
    startCounting() { bytes = geometryBytes(geometry); level = -1; },
    uploadBytes: () => bytes,
    dispose() { geometry.dispose(); material.dispose(); texture.dispose(); },
  };
}

export function createInstanceArm(field: DenseField): OverlayArm {
  const { nx, ny, nz } = field.grid;
  const lut = stateRgba();
  const overlayIndex = new Set(OBSERVATION_STATES.map((s, i) => (OVERLAY_STATES.has(s) ? i : -1)).filter((i) => i >= 0));
  let count = 0;
  for (let v = 0; v < field.states.length; v++) if (field.frontier[v] || overlayIndex.has(field.states[v]!)) count++;
  const offsets = new Float32Array(count * 3);
  const colours = new Uint8Array(count * 4);
  const h = field.voxelEdge;
  let w = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const v = ix + nx * (iy + ny * iz);
        const front = field.frontier[v] === 1;
        if (!front && !overlayIndex.has(field.states[v]!)) continue;
        offsets[w * 3] = (ix + 0.5) * h; offsets[w * 3 + 1] = (iy + 0.5) * h; offsets[w * 3 + 2] = (iz + 0.5) * h;
        if (front) {
          colours[w * 4] = FRONTIER_RGB[0] * 255; colours[w * 4 + 1] = FRONTIER_RGB[1] * 255; colours[w * 4 + 2] = FRONTIER_RGB[2] * 255; colours[w * 4 + 3] = 230;
        } else {
          const s = field.states[v]! * 4;
          colours[w * 4] = lut[s]!; colours[w * 4 + 1] = lut[s + 1]!; colours[w * 4 + 2] = lut[s + 2]!; colours[w * 4 + 3] = lut[s + 3]!;
        }
        w++;
      }
    }
  }
  const box = new THREE.BoxGeometry(h * 0.9, h * 0.9, h * 0.9);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = box.index;
  geometry.setAttribute('position', box.getAttribute('position'));
  geometry.instanceCount = count;
  const offsetAttr = new THREE.InstancedBufferAttribute(offsets, 3);
  const colourAttr = new THREE.InstancedBufferAttribute(colours, 4, true);
  geometry.setAttribute('aOffset', offsetAttr);
  geometry.setAttribute('aColour', colourAttr);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  // TSL's node unions are too wide for tsc here; the same cast Viewer.ts uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offsetNode = instancedBufferAttribute(offsetAttr) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (material as any).positionNode = (positionLocal as any).add(offsetNode);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (material as any).colorNode = instancedBufferAttribute(colourAttr) as any;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const bytes = (box.index ? box.index.array.byteLength : 0) + box.getAttribute('position').array.byteLength + offsets.byteLength + colours.byteLength;
  return {
    object: mesh,
    frame() {},
    startCounting() {},
    uploadBytes: () => bytes,
    dispose() { box.dispose(); geometry.dispose(); material.dispose(); },
  };
}

export function instanceCountOf(field: DenseField): number {
  const overlayIndex = new Set(OBSERVATION_STATES.map((s, i) => (OVERLAY_STATES.has(s) ? i : -1)).filter((i) => i >= 0));
  let count = 0;
  for (let v = 0; v < field.states.length; v++) if (field.frontier[v] || overlayIndex.has(field.states[v]!)) count++;
  return count;
}
