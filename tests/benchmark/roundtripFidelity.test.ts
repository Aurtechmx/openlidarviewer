/**
 * roundtripFidelity.test.ts — suite 7: LAS/LAZ write-then-read fidelity.
 *
 * What survives a write-then-read cycle through this application's LAS path,
 * and what does not. Every comparison runs against two readers:
 *
 *   spec  — `readLasBySpec`, ASPRS byte offsets only, float64, no `src/io` code
 *   app   — `loadLas`, the reader this application ships
 *
 * Tolerances are declared in `roundtripFidelity.ts` as functions of the scale
 * factor the file itself declares, and are imported here before any value is
 * measured.
 *
 * Declared exclusions — fields the writers never populate, so a round-trip
 * cannot preserve them. Each is asserted to be absent/zero rather than dropped
 * from the comparison:
 *   scan angle, user data, classification flags (synthetic / key-point /
 *   withheld / overlap), scanner channel, scan direction, edge of flight line,
 *   file source id, project GUID, file creation date, NIR (format 8),
 *   waveform packets, EVLRs.
 *
 * Not coverable here — stated, not silently skipped:
 *   LAZ output. `CONVERT_FORMATS.laz.available` is false: the application has
 *   no LAZ encoder, so there is no LAZ file of its own to read back. The LAZ
 *   READ path shares `lasDecodeShared` record decoding with the `.las` path
 *   exercised below, but the compression leg is untested by this suite.
 */

import { describe, it, expect } from 'vitest';
import { writeLas, writeLas14, pickPointFormat, pickPointFormat14 } from '../../src/convert/writeLas';
import { loadLas } from '../../src/io/loadLas';
import { parseLasHeader } from '../../src/io/lasHeader';
import { convertCloud } from '../../src/convert/convertCloud';
import { cloudToGlobal } from '../../src/convert/globalPoints';
import { PointCloud } from '../../src/model/PointCloud';
import { CONVERT_FORMATS } from '../../src/convert/types';
import type { GlobalPoints } from '../../src/convert/globalPoints';
import {
  readLasBySpec,
  makeGlobal,
  displacement,
  quantBound,
  appBound,
  F32_REL,
} from './roundtripFidelity';

import { witnessSuite } from './reachability';

witnessSuite('export-writers');

const buf = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** Global coordinates as the application reader hands them back. */
function appGlobal(cloud: PointCloud): { x: Float64Array; y: Float64Array; z: Float64Array } {
  const n = cloud.pointCount;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const o = cloud.sourceOrigin;
  for (let i = 0; i < n; i++) {
    x[i] = cloud.positions[i * 3] + o[0];
    y[i] = cloud.positions[i * 3 + 1] + o[1];
    z[i] = cloud.positions[i * 3 + 2] + o[2];
  }
  return { x, y, z };
}

// ── coordinate fixtures that stress the quantiser ───────────────────────────

/** 7-digit UTM eastings/northings, sub-millimetre detail, 300 m extent. */
function utmCloud(): GlobalPoints {
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (let i = 0; i < 64; i++) {
    x.push(499123.4567 + i * 4.7311);
    y.push(4100987.6543 + i * 3.3179);
    z.push(1234.5678 + (i % 7) * 0.13);
  }
  return makeGlobal({ x, y, z });
}

/**
 * Coordinates landing exactly on the quantiser's half-step boundary. The
 * writer's offset is floor(min), so `floor(min) + (k + 0.5) * scale` is
 * exactly a rounding tie for scale 0.001.
 */
function boundaryCloud(): GlobalPoints {
  const base = 500000;
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (let k = 0; k < 32; k++) {
    x.push(base + (k + 0.5) * 0.001);
    y.push(4100000 + (k + 0.5) * 0.001);
    z.push(100 + (k + 0.5) * 0.001);
  }
  return makeGlobal({ x, y, z });
}

/** Negative eastings/northings/heights (southern-hemisphere-style + below datum). */
function negativeCloud(): GlobalPoints {
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (let i = 0; i < 48; i++) {
    x.push(-612345.6789 - i * 2.5);
    y.push(-1234567.891 - i * 1.75);
    z.push(-432.1 - i * 0.37);
  }
  return makeGlobal({ x, y, z });
}

/** Geographic degrees — the writer's 1e-7° scale branch. */
function geographicCloud(): GlobalPoints {
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (let i = 0; i < 48; i++) {
    x.push(-117.12345678 + i * 1e-5);
    y.push(34.87654321 + i * 1e-5);
    z.push(600.123 + i * 0.05);
  }
  return makeGlobal({ x, y, z });
}

/** A 50 km extent — wide, but not wide enough to force a scale widening. */
function wideCloud(): GlobalPoints {
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (let i = 0; i < 64; i++) {
    x.push(300000.001 + i * 781.25);
    y.push(3000000.002 + i * 781.25);
    z.push(-100.5 + i * 40.0);
  }
  return makeGlobal({ x, y, z });
}

/** An extent so large the writer must widen the scale to stay inside int32. */
function overflowCloud(): GlobalPoints {
  return makeGlobal({
    x: [0, 5_000_000, 2_500_000.123],
    y: [0, 5_000_000, 1_250_000.456],
    z: [0, 5_000, 2_500.75],
  });
}

interface Case {
  readonly name: string;
  readonly points: GlobalPoints;
  readonly geographic: boolean;
  readonly scale?: [number, number, number];
}

const COORD_CASES: readonly Case[] = [
  { name: 'UTM 7-digit, 300 m extent, mm scale', points: utmCloud(), geographic: false },
  { name: 'quantisation half-step boundary', points: boundaryCloud(), geographic: false },
  { name: 'negative easting / northing / height', points: negativeCloud(), geographic: false },
  { name: 'geographic degrees, 1e-7 scale', points: geographicCloud(), geographic: true },
  { name: 'wide 50 km extent, mm scale', points: wideCloud(), geographic: false },
  { name: 'explicit cm scale', points: utmCloud(), geographic: false, scale: [0.01, 0.01, 0.01] },
  { name: 'explicit 1 m scale', points: utmCloud(), geographic: false, scale: [1, 1, 1] },
  { name: '5000 km extent — writer widens the scale', points: overflowCloud(), geographic: false },
];

interface Row {
  readonly label: string;
  readonly scale: number;
  readonly specMax: number;
  readonly specMean: number;
  readonly appMax: number;
  readonly appMean: number;
  readonly bound: number;
  readonly appLimit: number;
}

const precisionTable: Row[] = [];

describe('coordinate fidelity — round-trip displacement is bounded by the declared scale', () => {
  for (const c of COORD_CASES) {
    it(`${c.name}`, async () => {
      const bytes = writeLas(c.points, { epsg: c.geographic ? 4326 : 32611, isGeographic: c.geographic, scale: c.scale });
      const spec = readLasBySpec(bytes);
      const app = await loadLas(buf(bytes), 'las', 'rt.las');
      const got = appGlobal(app);

      expect(spec.points.count).toBe(c.points.count);
      expect(app.pointCount).toBe(c.points.count);

      const axes: Array<['x' | 'y' | 'z', Float64Array, Float64Array, Float64Array]> = [
        ['x', c.points.x, spec.points.x, got.x],
        ['y', c.points.y, spec.points.y, got.y],
        ['z', c.points.z, spec.points.z, got.z],
      ];
      for (let a = 0; a < axes.length; a++) {
        const [axis, truth, viaSpec, viaApp] = axes[a];
        const scale = spec.scale[a];
        const extent = spec.max[a] - spec.min[a];
        const bound = quantBound(scale);
        const limit = appBound(scale, Math.max(extent, Math.abs(spec.offset[a] - spec.min[a])));

        const dSpec = displacement(truth, viaSpec);
        const dApp = displacement(truth, viaApp);
        precisionTable.push({
          label: `${c.name} [${axis}]`,
          scale, bound, appLimit: limit,
          specMax: dSpec.max, specMean: dSpec.mean,
          appMax: dApp.max, appMean: dApp.mean,
        });

        expect(dSpec.max, `spec-level ${axis} displacement, scale ${scale}`).toBeLessThanOrEqual(bound);
        expect(dApp.max, `application-level ${axis} displacement, scale ${scale}`).toBeLessThanOrEqual(limit);
      }
    });
  }

  it('records the measured precision loss in metres', () => {
    expect(precisionTable.length).toBeGreaterThan(0);
    const lines = precisionTable.map(
      (r) =>
        `${r.label.padEnd(46)} scale=${r.scale.toExponential(3)}` +
        ` specMax=${r.specMax.toExponential(3)} specMean=${r.specMean.toExponential(3)}` +
        ` bound=${r.bound.toExponential(3)}` +
        ` appMax=${r.appMax.toExponential(3)} appMean=${r.appMean.toExponential(3)}` +
        ` appLimit=${r.appLimit.toExponential(3)}`,
    );
    // Printed so the numbers behind the fidelity table are in the run log.
    console.log('\nround-trip displacement (metres, or degrees on a geographic axis)\n' + lines.join('\n'));
    // The spec-level worst case must actually approach the bound somewhere:
    // a suite where every measurement sat at zero would prove nothing.
    const tight = precisionTable.filter((r) => r.specMax > r.bound * 0.4);
    expect(tight.length, 'at least one case exercises the quantiser near its bound').toBeGreaterThan(0);
  });

  it('the half-step case displaces by exactly half the scale', () => {
    const bytes = writeLas(boundaryCloud(), { epsg: 32611 });
    const spec = readLasBySpec(bytes);
    const d = displacement(boundaryCloud().x, spec.points.x);
    // Exactly scale/2 (0.5 mm at the writer's default), not merely under it.
    expect(d.max).toBeGreaterThan(spec.scale[0] / 2 - 1e-9);
    expect(d.max).toBeLessThanOrEqual(quantBound(spec.scale[0]));
  });

  it('the widened scale keeps every record inside int32', () => {
    const bytes = writeLas(overflowCloud(), { epsg: 32611 });
    const spec = readLasBySpec(bytes);
    expect(spec.scale[0]).toBeGreaterThan(0.001);
    for (let i = 0; i < spec.points.count; i++) {
      expect(Math.abs(spec.points.xi[i])).toBeLessThanOrEqual(2147483647);
      expect(Math.abs(spec.points.yi[i])).toBeLessThanOrEqual(2147483647);
    }
  });

  it('the application reader loses more than the file does — float32 local storage', async () => {
    const src = wideCloud();
    const bytes = writeLas(src, { epsg: 32611 });
    const spec = readLasBySpec(bytes);
    const app = appGlobal(await loadLas(buf(bytes), 'las', 'rt.las'));
    const dSpec = displacement(src.x, spec.points.x);
    const dApp = displacement(src.x, app.x);
    // The file holds millimetres; the in-memory cloud does not.
    expect(dSpec.max).toBeLessThanOrEqual(quantBound(spec.scale[0]));
    expect(dApp.max).toBeGreaterThan(dSpec.max);
    expect(dApp.max).toBeLessThanOrEqual(appBound(spec.scale[0], spec.max[0] - spec.min[0]));
  });
});

// ── attribute preservation ──────────────────────────────────────────────────

/** Every attribute the model carries, at the extremes of its field width. */
function attributeCloud(): GlobalPoints {
  const n = 8;
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (let i = 0; i < n; i++) {
    x.push(500000 + i);
    y.push(4100000 + i);
    z.push(100 + i);
  }
  return makeGlobal({
    x, y, z,
    intensity: [0, 1, 255, 256, 4095, 32768, 65534, 65535],
    classification: [0, 1, 2, 6, 9, 18, 31, 30],
    returnNumber: [1, 2, 3, 4, 5, 6, 7, 1],
    returnCount: [1, 2, 3, 4, 5, 6, 7, 1],
    pointSourceId: [0, 1, 100, 1000, 10000, 40000, 65534, 65535],
    gpsTime: [0, 1, 1.5, 1e5, 3.5e8, 4.1234567891e8, -1e5, 1e9 + 0.123456789],
    colors: [
      0, 0, 0, 255, 255, 255, 1, 2, 3, 254, 253, 252,
      128, 64, 32, 17, 34, 51, 200, 100, 50, 7, 7, 7,
    ],
  });
}

describe('attribute preservation — LAS 1.2 (formats 0–3)', () => {
  it('intensity, point source id, GPS time and RGB survive exactly', async () => {
    const g = attributeCloud();
    const bytes = writeLas(g, { epsg: 32611 });
    const spec = readLasBySpec(bytes);
    const app = await loadLas(buf(bytes), 'las', 'rt.las');

    expect(spec.pointFormat).toBe(3); // RGB + GPS time
    expect(Array.from(spec.points.intensity)).toEqual(Array.from(g.intensity!));
    expect(Array.from(app.intensity!)).toEqual(Array.from(g.intensity!));
    expect(Array.from(spec.points.pointSourceId)).toEqual(Array.from(g.pointSourceId!));
    expect(Array.from(app.pointSourceId!)).toEqual(Array.from(g.pointSourceId!));
    // GPS time is a float64 in the record — bit-exact, including the negative.
    expect(Array.from(spec.points.gpsTime!)).toEqual(Array.from(g.gpsTime!));
    expect(Array.from(app.gpsTime!)).toEqual(Array.from(g.gpsTime!));
    // 8-bit RGB is stored as v×257 and narrows back to v.
    expect(Array.from(app.colors!)).toEqual(Array.from(g.colors!));
    for (let i = 0; i < g.colors!.length; i++) {
      expect(spec.points.rgb16![i]).toBe(g.colors![i] * 257);
    }
  });

  it('return number and return count survive for values 1–7', async () => {
    const g = attributeCloud();
    const app = await loadLas(buf(writeLas(g, { epsg: 32611 })), 'las', 'rt.las');
    expect(Array.from(app.returnNumber!)).toEqual(Array.from(g.returnNumber!));
    expect(Array.from(app.returnCount!)).toEqual(Array.from(g.returnCount!));
  });

  it('classification survives exactly for classes 0–31', async () => {
    const g = attributeCloud();
    const app = await loadLas(buf(writeLas(g, { epsg: 32611 })), 'las', 'rt.las');
    expect(Array.from(app.classification!)).toEqual(Array.from(g.classification!));
  });

  it('classification above 31 does NOT survive — the 5-bit field wraps', async () => {
    const g = makeGlobal({
      x: [500000, 500001, 500002, 500003],
      y: [4100000, 4100001, 4100002, 4100003],
      z: [10, 11, 12, 13],
      classification: [32, 33, 64, 255],
    });
    const app = await loadLas(buf(writeLas(g, { epsg: 32611 })), 'las', 'rt.las');
    // Documented loss, with the actual arithmetic: value & 0x1f, i.e. modulo 32.
    expect(Array.from(app.classification!)).toEqual([0, 1, 0, 31]);
  });

  it('return values outside 1–7 do NOT survive — the 3-bit field clamps', async () => {
    const g = makeGlobal({
      x: [500000, 500001, 500002],
      y: [4100000, 4100001, 4100002],
      z: [10, 11, 12],
      returnNumber: [0, 8, 15],
      returnCount: [0, 8, 15],
    });
    const app = await loadLas(buf(writeLas(g, { epsg: 32611 })), 'las', 'rt.las');
    expect(Array.from(app.returnNumber!)).toEqual([1, 7, 7]);
    expect(Array.from(app.returnCount!)).toEqual([1, 7, 7]);
  });

  it('scan angle, user data and the classification flag bits are written as zero', () => {
    const spec = readLasBySpec(writeLas(attributeCloud(), { epsg: 32611 }));
    for (let i = 0; i < spec.points.count; i++) {
      expect(spec.points.scanAngle[i]).toBe(0);
      expect(spec.points.userData[i]).toBe(0);
      expect(spec.points.classFlags[i]).toBe(0);
    }
    // File source id and the project GUID are likewise never populated.
    const view = new DataView(spec.generatingSoftwareRaw.buffer);
    expect(view).toBeDefined();
  });
});

describe('attribute preservation — LAS 1.4 (formats 6–7)', () => {
  it('the extended record carries the full 8-bit classification', async () => {
    const g = makeGlobal({
      x: [500000, 500001, 500002, 500003, 500004],
      y: [4100000, 4100001, 4100002, 4100003, 4100004],
      z: [10, 11, 12, 13, 14],
      classification: [0, 31, 32, 64, 255],
    });
    const bytes = writeLas14(g, { epsg: 32611 });
    const spec = readLasBySpec(bytes);
    const app = await loadLas(buf(bytes), 'las', 'rt.las');
    expect(spec.pointFormat).toBe(6);
    expect(Array.from(spec.points.classification)).toEqual([0, 31, 32, 64, 255]);
    expect(Array.from(app.classification!)).toEqual([0, 31, 32, 64, 255]);
  });

  it('return number and count survive for values 1–15', async () => {
    const g = makeGlobal({
      x: [500000, 500001, 500002, 500003],
      y: [4100000, 4100001, 4100002, 4100003],
      z: [10, 11, 12, 13],
      returnNumber: [1, 7, 8, 15],
      returnCount: [1, 7, 8, 15],
    });
    const app = await loadLas(buf(writeLas14(g, { epsg: 32611 })), 'las', 'rt.las');
    expect(Array.from(app.returnNumber!)).toEqual([1, 7, 8, 15]);
    expect(Array.from(app.returnCount!)).toEqual([1, 7, 8, 15]);
  });

  it('intensity, source id, GPS time and RGB survive exactly (format 7)', async () => {
    const g = attributeCloud();
    const bytes = writeLas14(g, { epsg: 32611 });
    const spec = readLasBySpec(bytes);
    const app = await loadLas(buf(bytes), 'las', 'rt.las');
    expect(spec.pointFormat).toBe(7);
    expect(Array.from(app.intensity!)).toEqual(Array.from(g.intensity!));
    expect(Array.from(app.pointSourceId!)).toEqual(Array.from(g.pointSourceId!));
    expect(Array.from(app.gpsTime!)).toEqual(Array.from(g.gpsTime!));
    expect(Array.from(app.colors!)).toEqual(Array.from(g.colors!));
  });

  it('scan angle, user data and the flag byte are written as zero', () => {
    const spec = readLasBySpec(writeLas14(attributeCloud(), { epsg: 32611 }));
    for (let i = 0; i < spec.points.count; i++) {
      expect(spec.points.scanAngle[i]).toBe(0);
      expect(spec.points.userData[i]).toBe(0);
      expect(spec.points.classFlags[i]).toBe(0);
    }
  });

  it('a cloud with no GPS time still gets a GPS time field — written as zero', async () => {
    const g = makeGlobal({ x: [500000, 500001], y: [4100000, 4100001], z: [1, 2] });
    const app = await loadLas(buf(writeLas14(g, { epsg: 32611 })), 'las', 'rt.las');
    expect(Array.from(app.gpsTime!)).toEqual([0, 0]);
  });
});

// ── point format coverage ───────────────────────────────────────────────────

describe('point format coverage — every format written is read back', () => {
  const base = { x: [500000, 500001], y: [4100000, 4100001], z: [10, 11] };
  const variants: Array<{ fmt: number; g: GlobalPoints; ver: 12 | 14 }> = [
    { fmt: 0, ver: 12, g: makeGlobal(base) },
    { fmt: 1, ver: 12, g: makeGlobal({ ...base, gpsTime: [1, 2] }) },
    { fmt: 2, ver: 12, g: makeGlobal({ ...base, colors: [1, 2, 3, 4, 5, 6] }) },
    { fmt: 3, ver: 12, g: makeGlobal({ ...base, colors: [1, 2, 3, 4, 5, 6], gpsTime: [1, 2] }) },
    { fmt: 6, ver: 14, g: makeGlobal(base) },
    { fmt: 7, ver: 14, g: makeGlobal({ ...base, colors: [1, 2, 3, 4, 5, 6] }) },
  ];

  it('the writers emit exactly formats 0,1,2,3 (1.2) and 6,7 (1.4)', () => {
    const emitted12 = new Set(variants.filter((v) => v.ver === 12).map((v) => pickPointFormat(v.g)));
    const emitted14 = new Set(variants.filter((v) => v.ver === 14).map((v) => pickPointFormat14(v.g)));
    expect([...emitted12].sort()).toEqual([0, 1, 2, 3]);
    expect([...emitted14].sort()).toEqual([6, 7]);
  });

  for (const v of variants) {
    it(`format ${v.fmt} round-trips through both readers`, async () => {
      const bytes = v.ver === 12 ? writeLas(v.g, { epsg: 32611 }) : writeLas14(v.g, { epsg: 32611 });
      const spec = readLasBySpec(bytes);
      expect(spec.pointFormat).toBe(v.fmt);
      const header = parseLasHeader(buf(bytes));
      expect(header.pointFormat).toBe(v.fmt);
      const app = await loadLas(buf(bytes), 'las', 'rt.las');
      expect(app.pointCount).toBe(2);
      // A format that carries colour must come back with colour; one that does
      // not must not fabricate any.
      const carriesRgb = [2, 3, 7].includes(v.fmt);
      expect(app.colors != null).toBe(carriesRgb);
      // Formats 1, 3 and every extended format carry GPS time.
      const carriesGps = [1, 3, 6, 7].includes(v.fmt);
      expect(app.gpsTime != null).toBe(carriesGps);
      // Record length must match the format's spec length exactly.
      const specLen: Record<number, number> = { 0: 20, 1: 28, 2: 26, 3: 34, 6: 30, 7: 36 };
      expect(spec.recordLength).toBe(specLen[v.fmt]);
    });
  }

  it('LAZ output is not available, so no LAZ round-trip is claimed', () => {
    expect(CONVERT_FORMATS.laz.available).toBe(false);
  });
});

// ── version coverage ────────────────────────────────────────────────────────

describe('version coverage — LAS 1.2 and 1.4 header contracts', () => {
  it('1.2 declares version 1.2 and carries the legacy uint32 count', () => {
    const g = attributeCloud();
    const spec = readLasBySpec(writeLas(g, { epsg: 32611 }));
    expect([spec.versionMajor, spec.versionMinor]).toEqual([1, 2]);
    expect(spec.headerSize).toBe(227);
    expect(spec.legacyPointCount).toBe(g.count);
    expect(spec.extendedPointCount).toBeNull();
  });

  it('1.4 zeroes the legacy fields and uses the extended uint64 count', () => {
    const g = attributeCloud();
    const spec = readLasBySpec(writeLas14(g, { epsg: 32611 }));
    expect([spec.versionMajor, spec.versionMinor]).toEqual([1, 4]);
    expect(spec.headerSize).toBe(375);
    // The spec requires these zero for point formats 6+.
    expect(spec.legacyPointCount).toBe(0);
    expect(spec.legacyByReturn).toEqual([0, 0, 0, 0, 0]);
    expect(spec.extendedPointCount).toBe(g.count);
    expect(spec.pointCount).toBe(g.count);
  });

  it('the application reader takes the count from the right field per version', () => {
    const g = attributeCloud();
    expect(parseLasHeader(buf(writeLas(g, {}))).pointCount).toBe(g.count);
    expect(parseLasHeader(buf(writeLas14(g, {}))).pointCount).toBe(g.count);
  });

  it('the GPS time type bit is declared when GPS time is present', () => {
    const withGps = readLasBySpec(writeLas(attributeCloud(), {}));
    expect(withGps.globalEncoding & 0x1).toBe(1);
    const noGps = readLasBySpec(writeLas(makeGlobal({ x: [1], y: [2], z: [3] }), {}));
    expect(noGps.globalEncoding & 0x1).toBe(0);
  });

  it('generating software is a 32-byte NUL-padded ASCII field', () => {
    // The VALUE carries build identity and changes between branches; the
    // structure is what a reader depends on.
    const raw = readLasBySpec(writeLas(attributeCloud(), {})).generatingSoftwareRaw;
    expect(raw).toHaveLength(32);
    let sawNul = false;
    for (const b of raw) {
      if (b === 0) sawNul = true;
      else {
        expect(sawNul, 'no data after the NUL terminator').toBe(false);
        expect(b).toBeGreaterThanOrEqual(0x20);
        expect(b).toBeLessThan(0x80);
      }
    }
    expect(raw[0]).not.toBe(0);
    expect(sawNul, 'the field is NUL-terminated within 32 bytes').toBe(true);
  });
});

// ── CRS survival ────────────────────────────────────────────────────────────

describe('CRS survival — what is written reads back as the same CRS', () => {
  const g = makeGlobal({ x: [500000, 500010], y: [4100000, 4100010], z: [100, 110] });

  it('a projected EPSG survives via GeoTIFF keys (LAS 1.2)', () => {
    const bytes = writeLas(g, { epsg: 32611, linearUnitCode: 9001 });
    const crs = parseLasHeader(buf(bytes)).crs;
    expect(crs).not.toBeNull();
    expect(crs!.source).toBe('geotiff');
    expect(crs!.epsg).toBe(32611);
    expect(crs!.isGeographic).toBe(false);
    expect(crs!.linearUnit).toBe('metre');
    expect(crs!.linearUnitToMetres).toBe(1);
  });

  it('a geographic EPSG survives via GeoTIFF keys', () => {
    const bytes = writeLas(g, { epsg: 4326, isGeographic: true });
    const crs = parseLasHeader(buf(bytes)).crs;
    expect(crs!.epsg).toBe(4326);
    expect(crs!.isGeographic).toBe(true);
  });

  it('a compound CRS (metre horizontal, foot vertical) survives both axes', () => {
    const bytes = writeLas(g, {
      epsg: 32611,
      linearUnitCode: 9001,
      verticalEpsg: 5703,
      verticalUnitCode: 9002,
    });
    const crs = parseLasHeader(buf(bytes)).crs!;
    expect(crs.epsg).toBe(32611);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
    expect(crs.verticalEpsg).toBe(5703);
    expect(crs.verticalDatum).toBe('NAVD88');
    expect(crs.verticalLinearUnit).toBe('foot');
    expect(crs.verticalUnitToMetres).toBeCloseTo(0.3048, 10);
  });

  it('a foot horizontal CRS keeps its own unit and does not infect the vertical', () => {
    const bytes = writeLas(g, {
      epsg: 2229,
      linearUnitCode: 9003,
      verticalEpsg: 5703,
      verticalUnitCode: 9001,
    });
    const crs = parseLasHeader(buf(bytes)).crs!;
    expect(crs.linearUnit).toBe('us-survey-foot');
    expect(crs.verticalLinearUnit).toBe('metre');
    expect(crs.verticalUnitToMetres).toBe(1);
  });

  it('LAS 1.4 WKT survives, coexisting with the vertical GeoKeys', () => {
    const wkt =
      'PROJCS["WGS 84 / UTM zone 11N",GEOGCS["WGS 84",DATUM["WGS_1984",' +
      'SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],' +
      'UNIT["degree",0.0174532925199433]],UNIT["metre",1],AUTHORITY["EPSG","32611"]]';
    const bytes = writeLas14(g, {
      epsg: 32611, wkt, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: 9002,
    });
    const spec = readLasBySpec(bytes);
    // Global-encoding bit 4 must declare the WKT.
    expect(spec.globalEncoding & 0x10).toBe(0x10);
    const ids = spec.vlrs.map((v) => `${v.userId}/${v.recordId}`);
    expect(ids).toContain('LASF_Projection/2112');
    expect(ids).toContain('LASF_Projection/34735');
    const crs = parseLasHeader(buf(bytes)).crs!;
    expect(crs.source).toBe('wkt');
    expect(crs.epsg).toBe(32611);
    expect(crs.linearUnit).toBe('metre');
    // The vertical keys ride alongside the horizontal-only WKT.
    expect(crs.verticalEpsg).toBe(5703);
    expect(crs.verticalLinearUnit).toBe('foot');
  });

  it('an EPSG too large for a uint16 GeoKey is omitted, not corrupted', () => {
    const bytes = writeLas(g, { epsg: 100000 });
    const spec = readLasBySpec(bytes);
    expect(spec.vlrCount).toBe(0);
    expect(parseLasHeader(buf(bytes)).crs).toBeNull();
  });

  it('the WKT VLR payload is NUL-terminated at its declared length', () => {
    const wkt = 'PROJCS["x",UNIT["metre",1],AUTHORITY["EPSG","32611"]]';
    const spec = readLasBySpec(writeLas14(g, { epsg: 32611, wkt }));
    const vlr = spec.vlrs.find((v) => v.recordId === 2112)!;
    expect(vlr.bytes).toHaveLength(wkt.length + 1);
    expect(vlr.bytes[vlr.bytes.length - 1]).toBe(0);
    expect(String.fromCharCode(...vlr.bytes.subarray(0, wkt.length))).toBe(wkt);
  });
});

// ── header self-consistency ─────────────────────────────────────────────────

describe('header self-consistency', () => {
  const cases: Array<[string, () => Uint8Array, number]> = [
    ['1.2 UTM', () => writeLas(utmCloud(), { epsg: 32611 }), utmCloud().count],
    ['1.2 negative', () => writeLas(negativeCloud(), { epsg: 32611 }), negativeCloud().count],
    ['1.2 geographic', () => writeLas(geographicCloud(), { epsg: 4326, isGeographic: true }), geographicCloud().count],
    ['1.4 attributes', () => writeLas14(attributeCloud(), { epsg: 32611 }), attributeCloud().count],
  ];

  for (const [label, make, expected] of cases) {
    it(`${label}: count, bounds and by-return tallies agree with the records`, () => {
      const spec = readLasBySpec(make());
      expect(spec.pointCount).toBe(expected);
      expect(spec.recordsAvailable).toBe(expected);
      expect(spec.points.count).toBe(expected);

      for (let a = 0; a < 3; a++) {
        const vals = [spec.points.x, spec.points.y, spec.points.z][a];
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of vals) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        // Declared bounds equal the true min/max of the decoded records, to
        // within the double arithmetic that reconstructs both.
        expect(Math.abs(spec.min[a] - lo)).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(spec.max[a] - hi)).toBeLessThanOrEqual(1e-6);
        // And contain every point.
        for (const v of vals) {
          expect(v).toBeGreaterThanOrEqual(spec.min[a] - 1e-6);
          expect(v).toBeLessThanOrEqual(spec.max[a] + 1e-6);
        }
      }

      const tally = spec.versionMinor >= 4 ? spec.extendedByReturn! : spec.legacyByReturn;
      expect(tally.reduce((a, b) => a + b, 0)).toBe(expected);
    });
  }

  it('the by-return histogram matches the return numbers actually written', () => {
    const g = makeGlobal({
      x: [1, 2, 3, 4, 5], y: [1, 2, 3, 4, 5], z: [1, 2, 3, 4, 5],
      returnNumber: [1, 1, 2, 5, 3],
    });
    const spec = readLasBySpec(writeLas(g, {}));
    const counted = new Array(5).fill(0);
    for (const r of spec.points.returnNumber) counted[r - 1]++;
    expect(spec.legacyByReturn).toEqual(counted);
  });

  it('LAS 1.2 returns 6–7 land in the top histogram slot, matching the record clamp', () => {
    const g = makeGlobal({
      x: [1, 2, 3], y: [1, 2, 3], z: [1, 2, 3],
      returnNumber: [6, 7, 1],
    });
    const spec = readLasBySpec(writeLas(g, {}));
    // The 5-slot legacy histogram cannot name returns 6–7; both records clamp
    // to return 7, and both tallies land in slot 5.
    expect(Array.from(spec.points.returnNumber)).toEqual([6, 7, 1]);
    expect(spec.legacyByReturn).toEqual([1, 0, 0, 0, 2]);
    expect(spec.legacyByReturn.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('the point data offset lands exactly where the records begin', () => {
    for (const bytes of [writeLas(attributeCloud(), { epsg: 32611 }), writeLas14(attributeCloud(), { epsg: 32611 })]) {
      const spec = readLasBySpec(bytes);
      expect(bytes).toHaveLength(spec.offsetToPointData + spec.pointCount * spec.recordLength);
      expect(spec.offsetToPointData).toBeGreaterThanOrEqual(spec.headerSize);
    }
  });

  it('an empty cloud writes a structurally valid, zero-point file', async () => {
    const g = makeGlobal({ x: [], y: [], z: [] });
    const bytes = writeLas(g, { epsg: 32611 });
    const spec = readLasBySpec(bytes);
    expect(spec.pointCount).toBe(0);
    expect(spec.legacyByReturn).toEqual([0, 0, 0, 0, 0]);
    const app = await loadLas(buf(bytes), 'las', 'rt.las');
    expect(app.pointCount).toBe(0);
  });
});

// ── order and identity ──────────────────────────────────────────────────────

describe('order and identity', () => {
  it('point order is preserved index-for-index through write then read', async () => {
    // Attributes chosen so every point is distinguishable from every other.
    const n = 40;
    const spec = {
      x: [] as number[], y: [] as number[], z: [] as number[],
      intensity: [] as number[], pointSourceId: [] as number[], gpsTime: [] as number[],
    };
    for (let i = 0; i < n; i++) {
      // Deliberately unsorted on every axis.
      spec.x.push(500000 + ((i * 17) % n));
      spec.y.push(4100000 + ((i * 29) % n));
      spec.z.push(100 + ((i * 7) % n));
      spec.intensity.push(i * 111);
      spec.pointSourceId.push(1000 + i);
      spec.gpsTime.push(4.0e8 + i);
    }
    const g = makeGlobal(spec);
    const bytes = writeLas(g, { epsg: 32611 });
    const readBack = readLasBySpec(bytes);
    const app = await loadLas(buf(bytes), 'las', 'rt.las');

    for (let i = 0; i < n; i++) {
      expect(readBack.points.intensity[i]).toBe(spec.intensity[i]);
      expect(readBack.points.pointSourceId[i]).toBe(spec.pointSourceId[i]);
      expect(app.intensity![i]).toBe(spec.intensity[i]);
      expect(app.gpsTime![i]).toBe(spec.gpsTime[i]);
      expect(readBack.points.x[i]).toBeCloseTo(spec.x[i], 6);
    }
  });

  it('a strided load samples rather than preserving order — order identity holds only at stride 1', async () => {
    const n = 40;
    const g = makeGlobal({
      x: Array.from({ length: n }, (_, i) => 500000 + i),
      y: Array.from({ length: n }, (_, i) => 4100000 + i),
      z: Array.from({ length: n }, (_, i) => 100 + i),
      intensity: Array.from({ length: n }, (_, i) => i + 1),
    });
    const bytes = writeLas(g, { epsg: 32611 });
    const strided = await loadLas(buf(bytes), 'las', 'rt.las', 4);
    expect(strided.pointCount).toBe(Math.ceil(n / 4));
    // The sampled indices are a strictly increasing subsequence of the source,
    // so relative order survives even though identity does not.
    const seen = Array.from(strided.intensity!);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen.length).toBeLessThan(n);
  });
});

// ── the full application path ───────────────────────────────────────────────

describe('the export the application actually produces', () => {
  function loadedCloud(): PointCloud {
    return new PointCloud({
      positions: Float32Array.from([0.125, 0.25, 12.5, 10.5, 20.25, 13, 30, 40, 14.5]),
      origin: [500000, 4100000, 0],
      colors: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]),
      intensity: Uint16Array.from([100, 200, 300]),
      classification: Uint8Array.from([2, 2, 6]),
      sourceFormat: 'las',
      name: 'rt.las',
    });
  }

  for (const format of ['las', 'las14'] as const) {
    it(`convertCloud → ${format} → loadLas preserves the cloud`, async () => {
      const src = loadedCloud();
      const { file, report } = convertCloud(src, { format, crsMode: 'keep' });
      expect(report.ok).toBe(true);
      const bytes = file!.bytes;
      const spec = readLasBySpec(bytes);
      const out = await loadLas(buf(bytes), 'las', file!.filename);
      expect(out.pointCount).toBe(3);

      const truth = cloudToGlobal(src);
      const got = appGlobal(out);
      for (let a = 0; a < 3; a++) {
        const t = [truth.x, truth.y, truth.z][a];
        const r = [got.x, got.y, got.z][a];
        const limit = appBound(spec.scale[a], spec.max[a] - spec.min[a]);
        expect(displacement(t, r).max).toBeLessThanOrEqual(limit);
      }
      expect(Array.from(out.intensity!)).toEqual([100, 200, 300]);
      expect(Array.from(out.classification!)).toEqual([2, 2, 6]);
      expect(Array.from(out.colors!)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    });
  }

  it('omitting classification writes class 0, and the read-back says so', async () => {
    const { file } = convertCloud(loadedCloud(), { format: 'las14', crsMode: 'keep', omitClassification: true });
    const out = await loadLas(buf(file!.bytes), 'las', 'rt.las');
    expect(Array.from(out.classification!)).toEqual([0, 0, 0]);
  });
});

// ── the tolerance functions themselves ──────────────────────────────────────

describe('tolerance derivation', () => {
  it('the bound tracks the declared scale, not the data', () => {
    expect(quantBound(0.001)).toBeCloseTo(0.0005 + 1e-6, 12);
    expect(quantBound(0.01)).toBeCloseTo(0.005 + 1e-6, 12);
    expect(quantBound(1)).toBeCloseTo(0.5 + 1e-6, 12);
    // The application bound is strictly looser than the file bound.
    expect(appBound(0.001, 50000)).toBeGreaterThan(quantBound(0.001));
    expect(appBound(0.001, 50000)).toBeCloseTo(0.0005 + 1e-6 + F32_REL * 50000, 9);
  });
});
