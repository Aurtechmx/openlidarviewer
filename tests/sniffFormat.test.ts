import { sniffFormat } from '../src/io/sniffFormat';

/** Build an ArrayBuffer whose leading bytes are the given ASCII string. */
function bufWithMagic(magic: string, totalLen = 64): ArrayBuffer {
  const buf = new ArrayBuffer(totalLen);
  const view = new Uint8Array(buf);
  for (let i = 0; i < magic.length; i++) view[i] = magic.charCodeAt(i);
  return buf;
}

/** Build an ArrayBuffer with explicit leading bytes. */
function bufWithBytes(bytes: number[], totalLen = 64): ArrayBuffer {
  const buf = new ArrayBuffer(totalLen);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) view[i] = bytes[i];
  return buf;
}

describe('sniffFormat — magic byte detection', () => {
  test('detects PLY from leading "ply" bytes regardless of extension', () => {
    expect(sniffFormat(bufWithMagic('ply'), 'whatever.dat')).toBe('ply');
  });

  test('detects LAS from "LASF" signature with .las filename', () => {
    expect(sniffFormat(bufWithMagic('LASF'), 'scan.las')).toBe('las');
  });

  test('detects LAZ from "LASF" signature with .laz filename', () => {
    expect(sniffFormat(bufWithMagic('LASF'), 'scan.laz')).toBe('laz');
  });

  test('LASF signature defaults to las when filename is not .laz', () => {
    expect(sniffFormat(bufWithMagic('LASF'), 'scan.bin')).toBe('las');
  });

  test('detects GLB from "glTF" magic bytes (0x67 0x6C 0x54 0x46)', () => {
    expect(sniffFormat(bufWithBytes([0x67, 0x6c, 0x54, 0x46]), 'mesh.bin')).toBe('glb');
  });
});

describe('sniffFormat — extension fallback', () => {
  test('detects obj by extension', () => {
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'mesh.obj')).toBe('obj');
  });

  test('detects ply by extension', () => {
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'cloud.ply')).toBe('ply');
  });

  test('detects las by extension', () => {
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'cloud.las')).toBe('las');
  });

  test('detects laz by extension', () => {
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'cloud.laz')).toBe('laz');
  });

  test('detects glb by extension', () => {
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'mesh.glb')).toBe('glb');
  });

  test('detects gltf by extension', () => {
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'mesh.gltf')).toBe('gltf');
  });

  test('extension match is case-insensitive', () => {
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'MESH.OBJ')).toBe('obj');
  });
});

describe('sniffFormat — unknown', () => {
  test('returns unknown for unrecognized extension and no magic', () => {
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'mystery.dat')).toBe('unknown');
  });

  test('returns unknown for empty buffer with no extension', () => {
    expect(sniffFormat(new ArrayBuffer(0), 'noext')).toBe('unknown');
  });

  test('magic bytes win over a misleading extension', () => {
    expect(sniffFormat(bufWithMagic('ply'), 'mesh.obj')).toBe('ply');
  });
});
