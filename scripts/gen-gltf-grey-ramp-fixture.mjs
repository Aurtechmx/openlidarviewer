/**
 * gen-gltf-grey-ramp-fixture.mjs: regenerates `tests/fixtures/grey-ramp-normals.glb`.
 *
 * A 64 x 8 x 8 point block (POINTS mode, spacing 0.25) with a FLOAT COLOR_0 that ramps linearly
 * from 0.0 to 1.0 across x, and a unit NORMAL per point that tilts from -x to
 * +x across the same axis. glTF defines COLOR_0 as linear, so the ramp shows
 * whether the loader encodes it to sRGB before storing bytes, and the normals
 * give the Normal colour mode and the point inspector something to show.
 *
 * Run: node scripts/gen-gltf-grey-ramp-fixture.mjs
 */
import { writeFileSync } from 'node:fs';

const NX = 64;
const NY = 8;
const NZ = 8;
const n = NX * NY * NZ;
const pos = new Float32Array(n * 3);
const col = new Float32Array(n * 3);
const nor = new Float32Array(n * 3);
let k = 0;
for (let m = 0; m < NZ; m++) {
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++, k++) {
      const t = i / (NX - 1);
      pos.set([i * 0.25, j * 0.25, m * 0.25], k * 3);
      col.set([t, t, t], k * 3);
      const a = (t - 0.5) * Math.PI * 0.5;
      nor.set([Math.sin(a), 0, Math.cos(a)], k * 3);
    }
  }
}
const bin = Buffer.concat([pos, col, nor].map((a) => Buffer.from(a.buffer)));
const view = (i) => ({ buffer: 0, byteOffset: i * n * 12, byteLength: n * 12 });
const json = {
  asset: { version: '2.0', generator: 'olv-fixture' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1, NORMAL: 2 }, mode: 0 }] }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min: [0, 0, 0], max: [(NX - 1) * 0.25, (NY - 1) * 0.25, (NZ - 1) * 0.25] },
    { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: n, type: 'VEC3' },
  ],
  bufferViews: [view(0), view(1), view(2)],
  buffers: [{ byteLength: bin.length }],
};
let js = Buffer.from(JSON.stringify(json));
js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
const total = 12 + 8 + js.length + 8 + bin.length;
const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546c67, 0);
head.writeUInt32LE(2, 4);
head.writeUInt32LE(total, 8);
const chunk = (len, type) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(len, 0);
  b.writeUInt32LE(type, 4);
  return b;
};
writeFileSync(
  new URL('../tests/fixtures/grey-ramp-normals.glb', import.meta.url),
  Buffer.concat([head, chunk(js.length, 0x4e4f534a), js, chunk(bin.length, 0x004e4942), bin]),
);
