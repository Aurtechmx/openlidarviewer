/**
 * e57AttributeMasks.test.ts: per-point validity of colour and intensity.
 *
 * A point the file flags `isColorInvalid` / `isIntensityInvalid` keeps its
 * geometry, but the flagged value is not a measurement. `PointCloud.attributeInvalid`
 * (bit 0 colour, bit 1 intensity) records which values those are, and these
 * specs pin that the mask is set at load, survives every rebuild of the cloud,
 * is honoured by display and statistics, and is written out as unavailable.
 *
 * The parser is mocked, as in e57AttributeHonesty.test.ts, so every column is
 * hand-built and synthetic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseE57 } from '../src/io/e57/parseE57';
import { loadE57 } from '../src/io/loadE57';
import { sanitizeAndRecenter } from '../src/io/sanitizeCloud';
import { toCsv, toXyz, toPly, toObj } from '../src/io/exporters';
import {
  ATTR_COLOUR_INVALID,
  ATTR_INTENSITY_INVALID,
  PointCloud,
} from '../src/model/PointCloud';
import { voxelDownsample } from '../src/process/voxelDownsample';
import { clipCloud } from '../src/render/clip/clipCloud';
import { colorForMode, rampRangeForMode, UNSTATED_COLOUR_GREY } from '../src/render/colorModes';
import { rgbAutoNormalize } from '../src/render/rgbAutoNormalize';
import { buildColorLegend } from '../src/render/colorLegend';
import { convertCloud } from '../src/convert/convertCloud';
import { cloudToGlobal } from '../src/convert/globalPoints';
import { scanReport } from '../src/analysis/modules/scanReport';
import { READ_EVERY_RECORD, scan, parseResult } from './helpers/e57ScanFixtures';

vi.mock('../src/io/e57/parseE57', () => ({
  parseE57: vi.fn(),
}));

const mockedParse = vi.mocked(parseE57);
const f64 = (...v: number[]): Float64Array => Float64Array.from(v);

function xyz(n: number, x0 = 0): Record<string, Float64Array> {
  return {
    cartesianX: Float64Array.from({ length: n }, (_, i) => x0 + i),
    cartesianY: Float64Array.from({ length: n }, () => 1),
    cartesianZ: Float64Array.from({ length: n }, () => 2),
  };
}

const mk = (o: Partial<ConstructorParameters<typeof PointCloud>[0]> & { positions: Float32Array }): PointCloud =>
  new PointCloud({ origin: [0, 0, 0], sourceFormat: 'e57', name: 'synthetic', ...o });
const load = () => loadE57(new ArrayBuffer(0), 'masks.e57', { plan: READ_EVERY_RECORD });
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Four points: colour invalid on 1 and 2, intensity invalid on 0 and 2. */
function flaggedScan(name = 'flagged', x0 = 0) {
  return scan(name, 4, {
    ...xyz(4, x0),
    colorRed: f64(10, 99, 99, 40),
    colorGreen: f64(20, 99, 99, 50),
    colorBlue: f64(30, 99, 99, 60),
    isColorInvalid: f64(0, 1, 1, 0),
    intensity: f64(9000, 200, 9000, 400),
    isIntensityInvalid: f64(1, 0, 1, 0),
  });
}

beforeEach(() => {
  mockedParse.mockReset();
});

describe('loadE57: attribute validity mask', () => {
  it('masks invalid colour and invalid intensity independently', async () => {
    mockedParse.mockReturnValue(parseResult([flaggedScan()]));
    const cloud = await load();
    expect([...cloud.attributeInvalid!]).toEqual([
      ATTR_INTENSITY_INVALID,
      ATTR_COLOUR_INVALID,
      ATTR_COLOUR_INVALID | ATTR_INTENSITY_INVALID,
      0,
    ]);
  });

  it('retains the geometry of every flagged point', async () => {
    mockedParse.mockReturnValue(parseResult([flaggedScan()]));
    const cloud = await load();
    expect(cloud.pointCount).toBe(4);
    const xs = Array.from({ length: 4 }, (_, i) => cloud.worldXYZ(i)[0]);
    expect(xs).toEqual([0, 1, 2, 3]);
  });

  it('keeps no mask when no point is flagged', async () => {
    mockedParse.mockReturnValue(
      parseResult([scan('clean', 2, { ...xyz(2), intensity: f64(1, 2), isIntensityInvalid: f64(0, 0) })]),
    );
    expect((await load()).attributeInvalid).toBeUndefined();
  });

  it('states in the load warning that flagged values are masked', async () => {
    mockedParse.mockReturnValue(parseResult([flaggedScan()]));
    const w = ((await load()).metadata?.loadWarnings ?? []).join('\n');
    expect(w).toMatch(/2 point\(s\) with invalid colour/);
    expect(w).toMatch(/masked/);
  });

  it('puts each merged scan\'s flags on that scan\'s own points', async () => {
    const a = scan('A', 2, {
      ...xyz(2, 0),
      intensity: f64(1, 2),
      isIntensityInvalid: f64(0, 1),
    });
    const b = scan('B', 3, {
      ...xyz(3, 10),
      intensity: f64(3, 4, 5),
      isIntensityInvalid: f64(1, 0, 1),
    });
    mockedParse.mockReturnValue(parseResult([a, b]));
    const cloud = await load();
    expect([...cloud.attributeInvalid!]).toEqual([0, 2, 2, 0, 2]);
  });

  it('keeps a scan without flag columns valid beside a scan that has them', async () => {
    const a = scan('A', 2, { ...xyz(2, 0), intensity: f64(1, 2) });
    const b = scan('B', 2, { ...xyz(2, 10), intensity: f64(3, 4), isIntensityInvalid: f64(0, 1) });
    mockedParse.mockReturnValue(parseResult([a, b]));
    expect([...(await load()).attributeInvalid!]).toEqual([0, 0, 0, 2]);
  });
});

describe('the mask survives rebuilds of the cloud', () => {
  it('is validated against the point count', () => {
    expect(
      () => mk({ positions: new Float32Array(6), attributeInvalid: new Uint8Array(3) }),
    ).toThrow(/attributeInvalid/);
  });

  it('follows its points through sanitation', () => {
    // Point 1 is non-finite and is dropped; the flags of 0 and 2 move to 0 and 1.
    const global = Float64Array.from([0, 0, 0, NaN, 0, 0, 2, 0, 0]);
    const clean = sanitizeAndRecenter(global, { attributeInvalid: Uint8Array.from([1, 2, 3]) });
    expect([...clean.attributes.attributeInvalid!]).toEqual([1, 3]);
  });

  it('follows its points through a clip', () => {
    const cloud = mk({
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      intensity: Uint16Array.from([1, 2, 3]),
      attributeInvalid: Uint8Array.from([0, 2, 0]),
    });
    const kept = clipCloud(cloud, { box: { min: [0.5, -1, -1], max: [2.5, 1, 1] }, mode: 'keep-inside', enabled: true } as never);
    expect([...kept.attributeInvalid!]).toEqual([2, 0]);
  });

  it('is carried into the global points an export reads', () => {
    const cloud = mk({
      positions: new Float32Array(6),
      attributeInvalid: Uint8Array.from([1, 0]),
    });
    expect([...cloudToGlobal(cloud).attributeInvalid!]).toEqual([1, 0]);
  });

  function gridCloud(): PointCloud {
    // Voxel A (x 0..1): points 0 and 1.  Voxel B (x 10..11): points 2 and 3.
    // Voxel C (x 20): point 4 alone.
    return mk({
      positions: Float32Array.from([0.1, 0, 0, 0.2, 0, 0, 10.1, 0, 0, 10.2, 0, 0, 20.1, 0, 0]),
      colors: Uint8Array.from([100, 100, 100, 250, 250, 250, 250, 250, 250, 250, 250, 250, 7, 7, 7]),
      intensity: Uint16Array.from([100, 5000, 5000, 5000, 9]),
      // A: point 0 valid, point 1 colour+intensity invalid.  B: both invalid.  C: valid.
      attributeInvalid: Uint8Array.from([0, 3, 3, 3, 0]),
    });
  }

  it('is carried through voxel downsampling and flagged values never enter a mean', () => {
    const out = voxelDownsample(gridCloud(), 1);
    expect(out.pointCount).toBe(3);
    expect([...out.attributeInvalid!]).toEqual([0, 3, 0]);
    // Voxel A averages its one valid member, not (100 + 250) / 2.
    expect([...out.colors!.subarray(0, 3)]).toEqual([100, 100, 100]);
    expect(out.intensity![0]).toBe(100);
    expect(out.intensity![2]).toBe(9);
  });

  it('leaves a cloud without a mask exactly as before through voxel downsampling', () => {
    const c = gridCloud();
    const plain = mk({ positions: c.positions, colors: c.colors, intensity: c.intensity });
    const out = voxelDownsample(plain, 1);
    expect(out.attributeInvalid).toBeUndefined();
    expect([...out.colors!.subarray(0, 3)]).toEqual([175, 175, 175]);
  });
});

describe('valid-attribute statistics ignore flagged values', () => {
  function withAndWithout() {
    const flagged = mk({
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
      colors: Uint8Array.from([10, 10, 10, 255, 255, 255, 30, 30, 30, 40, 40, 40]),
      intensity: Uint16Array.from([100, 65535, 300, 400]),
      attributeInvalid: Uint8Array.from([0, 3, 0, 0]),
    });
    const clean = mk({
      positions: Float32Array.from([0, 0, 0, 2, 0, 0, 3, 0, 0]),
      colors: Uint8Array.from([10, 10, 10, 30, 30, 30, 40, 40, 40]),
      intensity: Uint16Array.from([100, 300, 400]),
    });
    return { flagged, clean };
  }

  it('gives the intensity ramp range of the cloud without the outliers', () => {
    const { flagged, clean } = withAndWithout();
    expect(rampRangeForMode('intensity', flagged)).toEqual(rampRangeForMode('intensity', clean));
  });

  it('paints a flagged colour and a flagged intensity the neutral grey', () => {
    const { flagged } = withAndWithout();
    const grey = Array(3).fill(UNSTATED_COLOUR_GREY);
    expect([...colorForMode('rgb', flagged).subarray(3, 6)]).toEqual(grey);
    expect([...colorForMode('rgb', flagged).subarray(0, 3)]).toEqual([10, 10, 10]);
    expect([...colorForMode('intensity', flagged).subarray(3, 6)]).toEqual(grey);
  });

  it('shades the valid points as the cloud without the outliers does', () => {
    const { flagged, clean } = withAndWithout();
    const a = colorForMode('intensity', flagged);
    const b = colorForMode('intensity', clean);
    expect([...a.subarray(0, 3), ...a.subarray(6, 12)]).toEqual([...b]);
  });

  it('feeds the colour balance only the valid colours', () => {
    const { flagged, clean } = withAndWithout();
    const a = rgbAutoNormalize({ colorsU8: flagged.colors!, invalid: flagged.attributeInvalid, stride: 1 });
    const b = rgbAutoNormalize({ colorsU8: clean.colors!, stride: 1 });
    expect(a).toEqual(b);
  });

  it('seeds the intensity filter from the valid intensities', () => {
    const { flagged, clean } = withAndWithout();
    const legend = (c: PointCloud) =>
      buildColorLegend({ firstStaticCloud: () => c, streaming: () => null } as never).intensityExtent();
    expect(legend(flagged)).toEqual(legend(clean));
  });

  it('counts the masked values in the scan report', () => {
    const { flagged } = withAndWithout();
    const rows = scanReport.run(flagged).rows ?? [];
    const row = (label: string) => rows.find((r) => r.label === label)?.value ?? '';
    expect(row('RGB')).toMatch(/1 flagged invalid/);
    expect(row('Intensity')).toMatch(/1 flagged invalid/);
  });
});

describe('exports write a flagged value as unavailable', () => {
  async function loaded(): Promise<PointCloud> {
    mockedParse.mockReturnValue(parseResult([flaggedScan()]));
    return load();
  }

  it('CSV leaves the field empty and keeps the column count, with a note', async () => {
    const lines = toCsv(await loaded()).trim().split('\n');
    expect(lines[0]).toMatch(/^# .*colour \(2 points\) and intensity \(2 points\).*empty field.*unavailable/);
    const header = lines[1].split(',');
    const rows = lines.slice(2).map((l) => l.split(','));
    expect(header.slice(3)).toEqual(['r', 'g', 'b', 'intensity']);
    for (const r of rows) expect(r).toHaveLength(header.length);
    expect(rows[0].slice(3)).toEqual(['10', '20', '30', '']);
    expect(rows[1].slice(3)).toEqual(['', '', '', '200']);
    expect(rows[2].slice(3)).toEqual(['', '', '', '']);
    expect(rows[3].slice(3)).toEqual(['40', '50', '60', '400']);
  });

  it('XYZ writes nan for a flagged value and says so', async () => {
    const out = toXyz(await loaded());
    expect(out).toMatch(/^# .*flagged invalid by the source: written as nan, meaning unavailable/m);
    const rows = out.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' '));
    expect(rows[1].slice(3)).toEqual(['nan', 'nan', 'nan', '200']);
    expect(rows[0].slice(3)).toEqual(['10', '20', '30', 'nan']);
  });

  it('PLY and OBJ omit colour for the whole file and state why', async () => {
    const cloud = await loaded();
    const ply = toPly(cloud);
    expect(ply).not.toMatch(/property uchar red/);
    expect(ply).toMatch(/comment colour omitted: 2 points are flagged invalid/);
    const obj = toObj(cloud);
    expect(obj).toMatch(/# colour omitted: 2 points are flagged invalid/);
    expect(obj.split('\n').filter((l) => l.startsWith('v '))[0].split(' ')).toHaveLength(4);
  });

  it('XYZ conversion writes nan colour and records it', async () => {
    const { file, report } = convertCloud(await loaded(), { format: 'xyz' });
    const out = text(file!.bytes);
    expect(out).toMatch(/^# Conversion event attribute-invalid: .*colour \(2 points\).*nan/m);
    const rows = out.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' '));
    expect(rows[1].slice(3)).toEqual(['nan', 'nan', 'nan']);
    expect(rows[0].slice(3)).toEqual(['10', '20', '30']);
    expect(report.log.some((e) => /nan/.test(e.message))).toBe(true);
  });

  it('ASC conversion writes nan intensity and records it', async () => {
    const { file } = convertCloud(await loaded(), { format: 'asc' });
    const out = text(file!.bytes);
    expect(out).toMatch(/^# Conversion event attribute-invalid: .*intensity \(2 points\).*nan/m);
    const rows = out.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' '));
    expect(rows.map((r) => r[3])).toEqual(['nan', '200', 'nan', '400']);
  });

  it('LAS 1.2 conversion omits colour and intensity for the whole file and counts them', async () => {
    const { file } = convertCloud(await loaded(), { format: 'las' });
    const bytes = file!.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Point data record format 0 or 1: no colour. Intensity is 0 on every record.
    expect(view.getUint8(104)).toBeLessThan(2);
    const offset = view.getUint32(96, true);
    const recLen = view.getUint16(105, true);
    for (let i = 0; i < 4; i++) expect(view.getUint16(offset + i * recLen + 12, true)).toBe(0);
    expect(text(bytes)).toMatch(/Conversion event attribute-invalid: .*colour \(2 points\) and intensity \(2 points\)/);
  });

  it('LAS 1.4 conversion omits colour and says so', async () => {
    const { file } = convertCloud(await loaded(), { format: 'las14' });
    const view = new DataView(file!.bytes.buffer, file!.bytes.byteOffset, file!.bytes.byteLength);
    expect(view.getUint8(104)).toBe(6);
    expect(text(file!.bytes)).toMatch(/Conversion event attribute-invalid/);
  });

  it('LAS conversion keeps colour when only intensity is flagged', async () => {
    mockedParse.mockReturnValue(
      parseResult([
        scan('i', 2, {
          ...xyz(2),
          colorRed: f64(1, 2),
          colorGreen: f64(1, 2),
          colorBlue: f64(1, 2),
          intensity: f64(5, 6),
          isIntensityInvalid: f64(0, 1),
        }),
      ]),
    );
    const { file } = convertCloud(await load(), { format: 'las' });
    const view = new DataView(file!.bytes.buffer, file!.bytes.byteOffset, file!.bytes.byteLength);
    expect(view.getUint8(104)).toBe(2);
    expect(text(file!.bytes)).toMatch(/intensity \(1 point\)/);
    expect(text(file!.bytes)).not.toMatch(/colour \(/);
  });
});

describe('a cloud with no flagged values exports byte-identically', () => {
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0]);
  const colors = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  const intensity = Uint16Array.from([7, 8]);
  const plain = () => mk({ positions, colors, intensity });
  const zeroed = () => mk({ positions, colors, intensity, attributeInvalid: new Uint8Array(2) });

  it('keeps the exact CSV and XYZ text', () => {
    expect(toCsv(plain())).toBe('x,y,z,r,g,b,intensity\n0.000,0.000,0.000,1,2,3,7\n1.000,0.000,0.000,4,5,6,8\n');
    expect(toCsv(zeroed())).toBe(toCsv(plain()));
    expect(toXyz(zeroed())).toBe(toXyz(plain()));
    expect(toPly(zeroed())).toBe(toPly(plain()));
    expect(toObj(zeroed())).toBe(toObj(plain()));
  });

  it('keeps the exact bytes of every conversion', () => {
    for (const format of ['xyz', 'asc', 'las', 'las14'] as const) {
      const a = convertCloud(plain(), { format }).file!.bytes;
      const b = convertCloud(zeroed(), { format }).file!.bytes;
      expect(text(b), format).toBe(text(a));
      expect(a).toEqual(b);
      expect(text(a)).not.toMatch(/attribute-invalid/);
    }
  });

  it('draws and ranges the same as before', () => {
    expect(colorForMode('rgb', zeroed())).toBe(colors);
    expect(rampRangeForMode('intensity', zeroed())).toEqual({ min: 7, max: 8 });
  });
});
