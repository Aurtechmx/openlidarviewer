import { toXyz, toCsv, toPly, toObj, exportCloud } from '../src/io/exporters';
import { loadXyz } from '../src/io/loadXyz';
import { PointCloud } from '../src/model/PointCloud';

function makeCloud(positions: number[], origin: [number, number, number], colors?: number[]): PointCloud {
  return new PointCloud({
    positions: new Float32Array(positions),
    colors: colors ? new Uint8Array(colors) : undefined,
    origin,
    sourceFormat: 'xyz',
    name: 'test',
  });
}

/** A cloud with the optional channels / CRS metadata the C5 columns need. */
function makeRichCloud(opts: {
  positions: number[];
  origin: [number, number, number];
  colors?: number[];
  intensity?: number[];
  classification?: number[];
  geographic?: boolean;
}): PointCloud {
  return new PointCloud({
    positions: new Float32Array(opts.positions),
    colors: opts.colors ? new Uint8Array(opts.colors) : undefined,
    intensity: opts.intensity ? new Uint16Array(opts.intensity) : undefined,
    classification: opts.classification ? new Uint8Array(opts.classification) : undefined,
    origin: opts.origin,
    sourceFormat: 'xyz',
    name: 'test',
    metadata:
      opts.geographic === undefined
        ? undefined
        : {
            crs: {
              source: 'wkt',
              name: opts.geographic ? 'WGS 84' : 'WGS 84 / UTM zone 12N',
              linearUnit: opts.geographic ? 'unknown' : 'metre',
              linearUnitToMetres: 1,
              isGeographic: opts.geographic,
            },
          },
  });
}

describe('toXyz / toCsv', () => {
  test('writes global coordinates (local position + origin)', () => {
    const cloud = makeCloud([0, 0, 0, 1, 2, 3], [100, 200, 300]);
    const text = toXyz(cloud);
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('100.000 200.000 300.000');
    expect(lines[1]).toBe('101.000 202.000 303.000');
  });

  test('includes r g b columns when the cloud has colour', () => {
    const cloud = makeCloud([0, 0, 0], [0, 0, 0], [255, 128, 0]);
    expect(toXyz(cloud).trim()).toBe('0.000 0.000 0.000 255 128 0');
  });

  test('CSV is comma-delimited with a header row', () => {
    const cloud = makeCloud([0, 0, 0, 1, 1, 1], [0, 0, 0]);
    const lines = toCsv(cloud).trim().split('\n');
    expect(lines[0]).toBe('x,y,z');
    expect(lines[1]).toBe('0.000,0.000,0.000');
  });
});

describe('XYZ/CSV optional columns + geographic precision (v0.4.5, C5)', () => {
  test('geographic CRS writes lat/lon at 7 dp; z stays 3 dp', () => {
    // Origin carries the degrees as exact doubles; local offset 0.5 is
    // exact in binary, so the sum is exactly 12.8456789 / -33.6456789.
    const cloud = makeRichCloud({
      positions: [0.5, 0.5, 0.25],
      origin: [12.3456789, -34.1456789, 100],
      geographic: true,
    });
    expect(toXyz(cloud).trim()).toBe('12.8456789 -33.6456789 100.250');
    expect(toCsv(cloud).trim().split('\n')[1]).toBe('12.8456789,-33.6456789,100.250');
  });

  test('projected CRS keeps the millimetre 3 dp', () => {
    const cloud = makeRichCloud({
      positions: [0.5, 0.5, 0.25],
      origin: [500000, 4100000, 100],
      geographic: false,
    });
    expect(toXyz(cloud).trim()).toBe('500000.500 4100000.500 100.250');
  });

  test('intensity + classification columns follow rgb, in header order', () => {
    const cloud = makeRichCloud({
      positions: [1, 2, 3],
      origin: [0, 0, 0],
      colors: [255, 128, 0],
      intensity: [40000],
      classification: [2],
    });
    const csv = toCsv(cloud).trim().split('\n');
    expect(csv[0]).toBe('x,y,z,r,g,b,intensity,classification');
    expect(csv[1]).toBe('1.000,2.000,3.000,255,128,0,40000,2');
  });

  test('XYZ documents the optional columns in a # header line', () => {
    const cloud = makeRichCloud({
      positions: [1, 2, 3],
      origin: [0, 0, 0],
      intensity: [123],
      classification: [5],
    });
    const lines = toXyz(cloud).trim().split('\n');
    expect(lines[0]).toBe('# columns: x y z intensity classification');
    expect(lines[1]).toBe('1.000 2.000 3.000 123 5');
  });

  test('a plain x-y-z cloud stays byte-identical to earlier releases (no header)', () => {
    const cloud = makeCloud([0, 0, 0], [0, 0, 0]);
    expect(toXyz(cloud)).toBe('0.000 0.000 0.000\n');
  });

  test('XYZ with the # header line still round-trips through loadXyz', async () => {
    const cloud = makeRichCloud({
      positions: [0.5, 1.5, 2.5],
      origin: [500000, 4100000, 100],
      intensity: [7],
      classification: [2],
    });
    const text = toXyz(cloud);
    const reloaded = await loadXyz(new TextEncoder().encode(text).buffer as ArrayBuffer);
    expect(reloaded.pointCount).toBe(1);
    expect(reloaded.positions[0] + reloaded.origin[0]).toBeCloseTo(500000.5, 2);
  });
});

describe('toPly', () => {
  test('writes a valid ASCII PLY header with the vertex count', () => {
    const cloud = makeCloud([0, 0, 0, 1, 1, 1], [0, 0, 0]);
    const text = toPly(cloud);
    expect(text.startsWith('ply\nformat ascii 1.0')).toBe(true);
    expect(text).toContain('element vertex 2');
    expect(text).toContain('end_header');
  });

  test('declares colour properties only when colour is present', () => {
    expect(toPly(makeCloud([0, 0, 0], [0, 0, 0]))).not.toContain('property uchar red');
    expect(toPly(makeCloud([0, 0, 0], [0, 0, 0], [1, 2, 3]))).toContain('property uchar red');
  });
});

describe('toObj', () => {
  test('writes one v line per point', () => {
    const cloud = makeCloud([0, 0, 0, 5, 5, 5], [10, 0, 0]);
    const vLines = toObj(cloud).split('\n').filter((l) => l.startsWith('v '));
    expect(vLines).toHaveLength(2);
    expect(vLines[0]).toBe('v 10.000 0.000 0.000');
  });
});

describe('exportCloud + round-trip', () => {
  test('exportCloud dispatches by format', () => {
    const cloud = makeCloud([0, 0, 0], [0, 0, 0]);
    expect(exportCloud(cloud, 'ply').startsWith('ply')).toBe(true);
    expect(exportCloud(cloud, 'obj').startsWith('#')).toBe(true);
  });

  test('XYZ export stamps a DERIVED provenance comment for a derived classification', () => {
    const cloud = makeCloud([0, 0, 0, 1, 1, 1], [0, 0, 0]);
    cloud.attachDerivedClassification(new Uint8Array([2, 5]));
    const text = toXyz(cloud);
    expect(text).toMatch(/# classification: DERIVED/);
    expect(text).toMatch(/not survey-grade/);
    // A file-original classification carries no such stamp.
    const original = makeCloud([0, 0, 0, 1, 1, 1], [0, 0, 0]);
    // (no attachDerivedClassification → no classification at all → no stamp)
    expect(toXyz(original)).not.toMatch(/DERIVED/);
  });

  test('XYZ export re-imports to the same global coordinates', async () => {
    const cloud = makeCloud([0.5, 1.5, 2.5, 3, 4, 5], [500000, 4100000, 100], [10, 20, 30, 40, 50, 60]);
    const text = toXyz(cloud);
    const reloaded = await loadXyz(new TextEncoder().encode(text).buffer as ArrayBuffer);
    expect(reloaded.pointCount).toBe(2);
    // Global coordinate of the first point survives the round-trip.
    expect(reloaded.positions[0] + reloaded.origin[0]).toBeCloseTo(500000.5, 2);
    expect(reloaded.positions[1] + reloaded.origin[1]).toBeCloseTo(4100001.5, 2);
    expect(reloaded.colors?.[0]).toBe(10);
  });
});

describe('geographic precision in PLY/OBJ (same defect class as the v0.4.5 XYZ/CSV fix)', () => {
  test('OBJ writes lat/lon at 7 dp under a geographic CRS; z stays 3 dp', () => {
    const cloud = makeRichCloud({
      positions: [0.5, 0.5, 0.25],
      origin: [12.3456789, -34.1456789, 100],
      geographic: true,
    });
    const v = toObj(cloud).split('\n').find((l) => l.startsWith('v '));
    expect(v).toBe('v 12.8456789 -33.6456789 100.250');
  });

  test('PLY writes lat/lon at 7 dp under a geographic CRS; z stays 3 dp', () => {
    const cloud = makeRichCloud({
      positions: [0.5, 0.5, 0.25],
      origin: [12.3456789, -34.1456789, 100],
      geographic: true,
    });
    const body = toPly(cloud).split('end_header\n')[1].trim();
    expect(body).toBe('12.8456789 -33.6456789 100.250');
  });

  test('a projected CRS keeps the millimetre 3 dp in PLY/OBJ', () => {
    const cloud = makeRichCloud({
      positions: [0.5, 0.5, 0.25],
      origin: [500000, 4100000, 100],
      geographic: false,
    });
    expect(toObj(cloud)).toContain('v 500000.500 4100000.500 100.250');
    expect(toPly(cloud)).toContain('500000.500 4100000.500 100.250');
  });
});
