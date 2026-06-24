import { sniffFormat, verticalAxisHintForSources, is3dTilesName } from '../src/io/sniffFormat';

describe('is3dTilesName — 3D Tiles / PNTS detection', () => {
  test('matches .pnts and tileset.json (any case, with path / query)', () => {
    expect(is3dTilesName('points.pnts')).toBe(true);
    expect(is3dTilesName('TILESET.JSON')).toBe(true);
    expect(is3dTilesName('https://host/tiles/tileset.json?v=2')).toBe(true);
    expect(is3dTilesName('/a/b/c.PNTS')).toBe(true);
  });
  test('does not match other JSON or point formats', () => {
    expect(is3dTilesName('scan.las')).toBe(false);
    expect(is3dTilesName('session.olvsession')).toBe(false);
    expect(is3dTilesName('metadata.json')).toBe(false);
    expect(is3dTilesName('cloud.ply')).toBe(false);
  });
});

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

  test('detects xyz / csv by extension', () => {
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'cloud.xyz')).toBe('xyz');
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'cloud.csv')).toBe('xyz');
  });

  test('routes ASC and TXT ASCII point lists to the xyz loader', () => {
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'cloud.asc')).toBe('xyz');
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'cloud.txt')).toBe('xyz');
    expect(sniffFormat(bufWithBytes([0, 0, 0, 0]), 'CLOUD.ASC')).toBe('xyz');
  });
});

/** Build a LASF buffer with an explicit point-format byte at offset 104. */
function lasfBuffer(pointFormatByte: number, totalLen = 256): ArrayBuffer {
  const buf = new ArrayBuffer(totalLen);
  const view = new Uint8Array(buf);
  view[0] = 0x4c; // 'L'
  view[1] = 0x41; // 'A'
  view[2] = 0x53; // 'S'
  view[3] = 0x46; // 'F'
  view[104] = pointFormatByte;
  return buf;
}

describe('sniffFormat — LAS/LAZ compression bit', () => {
  test('a set compression bit (0x80) means LAZ even with a .las filename', () => {
    expect(sniffFormat(lasfBuffer(0x80 | 6), 'scan.las')).toBe('laz');
  });

  test('a clear compression bit means LAS even with a .laz filename', () => {
    expect(sniffFormat(lasfBuffer(6), 'scan.laz')).toBe('las');
  });

  test('the compression bit is authoritative regardless of the extension', () => {
    expect(sniffFormat(lasfBuffer(0x80), 'scan.bin')).toBe('laz');
    expect(sniffFormat(lasfBuffer(0x00), 'scan.bin')).toBe('las');
  });

  test('a buffer too short to reach byte 104 falls back to the extension', () => {
    // bufWithMagic builds a 64-byte buffer — no point-format byte to read.
    expect(sniffFormat(bufWithMagic('LASF'), 'scan.laz')).toBe('laz');
    expect(sniffFormat(bufWithMagic('LASF'), 'scan.las')).toBe('las');
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

describe('verticalAxisHintForSources — the loader z-up hint (v0.4.5)', () => {
  // LAS is z-up by spec — detection has nothing to decide, hint it.
  test('all-survey static sources hint z', () => {
    expect(verticalAxisHintForSources(['las'], false)).toBe('z');
    expect(verticalAxisHintForSources(['las', 'laz', 'e57', 'xyz'], false)).toBe('z');
  });

  test('streaming-only (COPC/EPT are LAS-family) hints z', () => {
    expect(verticalAxisHintForSources([], true)).toBe('z');
  });

  test('any phone-scan mesh format leaves detection active', () => {
    expect(verticalAxisHintForSources(['ply'], false)).toBeUndefined();
    expect(verticalAxisHintForSources(['gltf'], false)).toBeUndefined();
    // Mixed: one ambiguous-frame contributor poisons the hint — better to
    // detect than to force a frame that is wrong for part of the buffer.
    expect(verticalAxisHintForSources(['las', 'obj'], false)).toBeUndefined();
    expect(verticalAxisHintForSources(['glb'], true)).toBeUndefined();
  });

  test('an empty gather never fabricates a hint', () => {
    expect(verticalAxisHintForSources([], false)).toBeUndefined();
  });
});
