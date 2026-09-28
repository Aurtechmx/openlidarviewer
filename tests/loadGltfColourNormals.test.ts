import { readFileSync } from 'node:fs';
import { loadGltf } from '../src/io/loadGltf';
import { srgbToLinearScalar as srgbToLinear } from '../src/render/colorEncode';

/** Linear grey ramp and its sRGB-encoded bytes (IEC 61966-2-1 OETF). */
const LINEAR = [0, 0.18, 0.5, 0.75, 1];
const SRGB_BYTES = [0, 118, 188, 225, 255];

interface Attr {
  data: ArrayBufferView;
  componentType: number;
  type: 'VEC3' | 'VEC4';
  normalized?: boolean;
}

/** One-primitive glTF with the buffer inlined as a data URI. */
function gltf(attrs: Record<string, Attr>, count: number): ArrayBuffer {
  const parts: Uint8Array[] = [];
  const accessors: object[] = [];
  const bufferViews: object[] = [];
  const attributes: Record<string, number> = {};
  let offset = 0;
  for (const [name, a] of Object.entries(attrs)) {
    const bytes = new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength);
    const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4);
    padded.set(bytes);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    attributes[name] = accessors.length;
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: a.componentType,
      count,
      type: a.type,
      ...(a.normalized ? { normalized: true } : {}),
    });
    parts.push(padded);
    offset += padded.byteLength;
  }
  const all = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  let bin = '';
  for (const b of all) bin += String.fromCharCode(b);
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, mode: 0 }] }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: all.byteLength, uri: `data:application/octet-stream;base64,${btoa(bin)}` }],
  };
  return new TextEncoder().encode(JSON.stringify(doc)).buffer as ArrayBuffer;
}

const positions = (): Float32Array => Float32Array.from(LINEAR.flatMap((_, i) => [i, 0, 0]));
const grey = (scale: number, width: 3 | 4): number[] =>
  LINEAR.flatMap((v) => {
    const c = Math.round(v * scale);
    return width === 4 ? [c, c, c, scale] : [c, c, c];
  });

const cases: [string, Attr][] = [
  ['FLOAT', { data: Float32Array.from(LINEAR.flatMap((v) => [v, v, v])), componentType: 5126, type: 'VEC3' }],
  ['UNSIGNED_SHORT normalized', { data: Uint16Array.from(grey(65535, 4)), componentType: 5123, type: 'VEC4', normalized: true }],
  ['UNSIGNED_BYTE normalized', { data: Uint8Array.from(grey(255, 4)), componentType: 5121, type: 'VEC4', normalized: true }],
];

describe('loadGltf: COLOR_0 is linear and is stored sRGB-encoded', () => {
  for (const [label, color] of cases) {
    test(`${label} grey ramp encodes to sRGB bytes`, async () => {
      const pc = await loadGltf(
        gltf({ POSITION: { data: positions(), componentType: 5126, type: 'VEC3' }, COLOR_0: color }, LINEAR.length),
        'gltf',
      );
      const reds = Array.from({ length: LINEAR.length }, (_, i) => pc.colors![i * 3]);
      // UNSIGNED_BYTE carries only 256 linear steps, so its darkest midtone
      // lands one sRGB step off the float answer.
      reds.forEach((r, i) => expect(Math.abs(r - SRGB_BYTES[i])).toBeLessThanOrEqual(label.includes('BYTE') ? 2 : 1));
      if (!label.includes('BYTE')) {
        reds.forEach((r, i) => expect(Math.abs(srgbToLinear(r / 255) - LINEAR[i])).toBeLessThanOrEqual(1 / 255));
      }
    });
  }
});

describe('loadGltf: authored NORMAL', () => {
  test('unit normals are carried per point', async () => {
    const n = Float32Array.from(LINEAR.flatMap((_, i) => (i % 2 ? [0, 0, 1] : [0.6, 0.8, 0])));
    const pc = await loadGltf(
      gltf(
        { POSITION: { data: positions(), componentType: 5126, type: 'VEC3' }, NORMAL: { data: n, componentType: 5126, type: 'VEC3' } },
        LINEAR.length,
      ),
      'gltf',
    );
    expect(pc.normals).toBeDefined();
    expect(pc.normals!.length).toBe(pc.pointCount * 3);
    expect(Array.from(pc.normals!.slice(0, 6))).toEqual([
      expect.closeTo(0.6, 6), expect.closeTo(0.8, 6), 0, 0, 0, 1,
    ]);
  });

  test('a non-unit normal drops the channel, not the point', async () => {
    const n = Float32Array.from(LINEAR.flatMap((_, i) => (i === 2 ? [0, 0, 0] : [0, 0, 1])));
    const pc = await loadGltf(
      gltf(
        { POSITION: { data: positions(), componentType: 5126, type: 'VEC3' }, NORMAL: { data: n, componentType: 5126, type: 'VEC3' } },
        LINEAR.length,
      ),
      'gltf',
    );
    expect(pc.pointCount).toBe(LINEAR.length);
    expect(pc.normals).toBeUndefined();
  });
});

describe('loadGltf: grey-ramp-normals.glb fixture', () => {
  test('carries sRGB-encoded ramp colours and unit normals', async () => {
    const file = readFileSync(new URL('./fixtures/grey-ramp-normals.glb', import.meta.url));
    const pc = await loadGltf(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer, 'glb');
    expect(pc.pointCount).toBe(4096);
    expect(pc.normals!.length).toBe(4096 * 3);
    // Column 0 is black, column 63 white, and column 32 (linear 32/63) an sRGB midtone.
    expect(pc.colors![0]).toBe(0);
    expect(pc.colors![63 * 3]).toBe(255);
    expect(pc.colors![32 * 3]).toBe(Math.round(255 * (1.055 * Math.pow(32 / 63, 1 / 2.4) - 0.055)));
    const a = (32 / 63 - 0.5) * Math.PI * 0.5;
    expect(pc.normals![32 * 3]).toBeCloseTo(Math.sin(a), 6);
    expect(pc.normals![32 * 3 + 2]).toBeCloseTo(Math.cos(a), 6);
  });
});
