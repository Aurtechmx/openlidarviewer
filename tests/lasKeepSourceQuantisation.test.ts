/**
 * Keeping the source file's scale and offset on LAS export.
 *
 * Sources are written by hand (tests/helpers/sourceLasQuantisation.ts), loaded
 * with the real loader, exported with the real converter and the integer
 * records of the export compared with the integers of the source.
 */

import { describe, it, expect } from 'vitest';
import { loadLas } from '../src/io/loadLas';
import { convertCloud } from '../src/convert/convertCloud';
import { writeLas, writeLas14 } from '../src/convert/writeLas';
import { cloudToGlobal, type GlobalPoints } from '../src/convert/globalPoints';
import {
  float32HalfSpacing,
  isValidQuantisation,
  planQuantisation,
  type Quantisation,
} from '../src/convert/lasQuantisation';
import { clipCloud } from '../src/render/clip/clipCloud';
import { makeClipBox } from '../src/render/clip/clipBox';
import { voxelDownsample } from '../src/process/voxelDownsample';
import { PointCloud } from '../src/model/PointCloud';
import { buildSourceLas, parseLasRecords, spreadRecords, type Triple } from './helpers/sourceLasQuantisation';

const UTM_OFFSET: Triple = [500000, 4100000, 100];
const KEPT_LINE = /Scale\/offset: kept from source \(scale .*offset .*\)\. Each exported X, Y and Z integer record equals the source's\./;

async function loadSource(version: '1.2' | '1.4', scale: Triple, offset: Triple, extent: number, n = 3000, stride = 1) {
  const records = spreadRecords(n, extent, scale);
  const cloud = await loadLas(buildSourceLas({ version, scale, offset, records }), 'las', 'src.las', stride);
  return { records, cloud };
}

function exportLas(cloud: PointCloud, version: '1.2' | '1.4', extra: Record<string, unknown> = {}) {
  const { file, report } = convertCloud(cloud, { format: version === '1.4' ? 'las14' : 'las', ...extra });
  if (!file) throw new Error(report.log.map((l) => l.message).join('; '));
  return { out: parseLasRecords(file.bytes), report };
}

/** Count integer records that differ from the source, and the largest difference. */
function compare(out: Int32Array, records: ReadonlyArray<readonly number[]>, pick: (i: number) => number = (i) => i) {
  let differing = 0;
  let worst = 0;
  for (let i = 0; i < out.length / 3; i++) {
    for (let a = 0; a < 3; a++) {
      const d = Math.abs(out[i * 3 + a] - records[pick(i)][a]);
      if (d !== 0) differing++;
      worst = Math.max(worst, d);
    }
  }
  return { differing, worst };
}

describe('integer records survive an export that keeps the source quantisation', () => {
  for (const version of ['1.2', '1.4'] as const) {
    for (const [scale, offset] of [
      [[0.01, 0.01, 0.01], UTM_OFFSET],
      [[0.001, 0.001, 0.001], [123456.789, -2000000.5, 0]],
      [[0.0001, 0.0001, 0.0001], [10, 20, 30]],
      [[0.01, 0.01, 0.005], [0, 0, 0]],
    ] as Array<[Triple, Triple]>) {
      it(`LAS ${version}, scale ${scale.join(' ')}, offset ${offset.join(' ')}: 1 m extent, identical records`, async () => {
        const { records, cloud } = await loadSource(version, scale, offset, 1);
        const { out, report } = exportLas(cloud, version);
        expect(out.count).toBe(records.length);
        expect(Array.from(out.records)).toEqual(records.flat());
        expect(out.scale).toEqual(scale);
        expect(out.offset).toEqual(offset);
        expect(out.vlrText).toMatch(KEPT_LINE);
        expect(report.log.some((l) => KEPT_LINE.test(l.message))).toBe(true);
      });
    }

    it(`LAS ${version}: 16 km at 1 mm returns identical records`, async () => {
      const { records, cloud } = await loadSource(version, [0.001, 0.001, 0.001], UTM_OFFSET, 16000, 20000);
      const { out } = exportLas(cloud, version);
      expect(out.count).toBe(20000);
      expect(compare(out.records, records)).toEqual({ differing: 0, worst: 0 });
      expect(out.vlrText).toMatch(KEPT_LINE);
    });

    it(`LAS ${version}: 40 km at 1 mm keeps the grid, bounds the error and says the records may differ`, async () => {
      const { records, cloud } = await loadSource(version, [0.001, 0.001, 0.001], UTM_OFFSET, 40000, 20000);
      const { out } = exportLas(cloud, version);
      const { differing, worst } = compare(out.records, records);
      expect(differing).toBeGreaterThan(0);
      // Half a Float32 spacing at 32768..65536 m is under 2 mm.
      expect(worst).toBeLessThanOrEqual(2);
      expect(out.scale).toEqual([0.001, 0.001, 0.001]);
      expect(out.offset).toEqual(UTM_OFFSET);
      expect(out.vlrText).toMatch(/kept from source/);
      expect(out.vlrText).toMatch(/can differ from the source's by up to 2 steps/);
      expect(out.vlrText).not.toMatch(/record equals the source's/);
    });
  }

  it('a coarse scale carries exact records over a wider extent than the 1 mm limit', async () => {
    const { records, cloud } = await loadSource('1.4', [0.01, 0.01, 0.01], UTM_OFFSET, 40000, 20000);
    const { out } = exportLas(cloud, '1.4');
    expect(compare(out.records, records)).toEqual({ differing: 0, worst: 0 });
    expect(out.vlrText).toMatch(KEPT_LINE);
  });

  it.each([
    [0.0001, 1000, true],
    [0.0001, 1100, false],
    [0.001, 16380, true],
    [0.001, 17000, false],
    [0.01, 130000, true],
    [0.01, 140000, false],
  ])('scale %s over %s m: exact=%s, and the stated status matches the records', async (s, extent, exact) => {
    const { records, cloud } = await loadSource('1.4', [s, s, s], UTM_OFFSET, extent, 20000);
    const { out } = exportLas(cloud, '1.4');
    const { differing, worst } = compare(out.records, records);
    if (exact) {
      expect(differing).toBe(0);
      expect(out.vlrText).toMatch(KEPT_LINE);
    } else {
      expect(differing).toBeGreaterThan(0);
      expect(worst).toBe(1);
      expect(out.vlrText).toMatch(/can differ from the source's by up to 1 step\./);
    }
  });

  it('the header bounds are the quantised extremes of the exported records', async () => {
    for (const version of ['1.2', '1.4'] as const) {
      const scale: Triple = [0.01, 0.01, 0.002];
      const { records, cloud } = await loadSource(version, scale, UTM_OFFSET, 500);
      const { out } = exportLas(cloud, version);
      for (let a = 0; a < 3; a++) {
        const col = records.map((r) => r[a]);
        expect(out.min[a]).toBeCloseTo(UTM_OFFSET[a] + Math.min(...col) * scale[a], 9);
        expect(out.max[a]).toBeCloseTo(UTM_OFFSET[a] + Math.max(...col) * scale[a], 9);
      }
    }
  });

  it('keeps the same integers for a display sample decoded with a stride', async () => {
    const { records, cloud } = await loadSource('1.2', [0.01, 0.01, 0.01], UTM_OFFSET, 200, 3000, 7);
    const { out } = exportLas(cloud, '1.2');
    expect(out.count).toBe(Math.ceil(3000 / 7));
    // The sampler jitters within each bucket, so check every exported triple is a source record.
    const source = new Set(records.map((r) => r.join(',')));
    const missing = [];
    for (let i = 0; i < out.count; i++) {
      if (!source.has(`${out.records[i * 3]},${out.records[i * 3 + 1]},${out.records[i * 3 + 2]}`)) missing.push(i);
    }
    expect(missing).toEqual([]);
    expect(out.vlrText).toMatch(KEPT_LINE);
  });

  it('keeps the same integers for the points a clip retains', async () => {
    const { records, cloud } = await loadSource('1.4', [0.01, 0.01, 0.01], UTM_OFFSET, 100, 3000);
    const box = makeClipBox({ min: [0, 0, -1000], max: [50, 50, 1000] });
    const clipped = clipCloud(cloud, { ...box, enabled: true });
    expect(clipped.pointCount).toBeLessThan(cloud.pointCount);
    const kept: number[] = [];
    for (let i = 0; i < cloud.pointCount; i++) {
      const x = cloud.positions[i * 3];
      const y = cloud.positions[i * 3 + 1];
      if (x >= 0 && x <= 50 && y >= 0 && y <= 50) kept.push(i);
    }
    const { out } = exportLas(clipped, '1.4');
    expect(out.count).toBe(kept.length);
    expect(compare(out.records, records, (i) => kept[i])).toEqual({ differing: 0, worst: 0 });
    expect(out.vlrText).toMatch(KEPT_LINE);
  });

  it('keeps the integers when the class of a point is edited and when the CRS is only assigned', async () => {
    const { records, cloud } = await loadSource('1.2', [0.01, 0.01, 0.01], UTM_OFFSET, 50, 500);
    cloud.classification![3] = 6;
    const { out } = exportLas(cloud, '1.2', { crsMode: 'assign', targetEpsg: 32611 });
    expect(Array.from(out.records)).toEqual(records.flat());
    expect(out.vlrText).toMatch(KEPT_LINE);
  });
});

describe('falling back to re-quantisation', () => {
  it('reprojected coordinates are re-quantised at the default scale', async () => {
    const { cloud } = await loadSource('1.4', [0.01, 0.01, 0.01], [500000, 4100000, 100], 1000);
    const { out, report } = exportLas(cloud, '1.4', { crsMode: 'reproject', sourceEpsg: 32611, targetEpsg: 4326 });
    expect(report.pointCount).toBe(3000);
    expect(out.scale[0]).toBe(1e-7);
    expect(out.vlrText).toMatch(/Scale\/offset: re-quantised \(the coordinates were reprojected\)\./);
  });

  it('a voxel-reduced cloud is re-quantised because its points are centroids', async () => {
    const { cloud } = await loadSource('1.2', [0.01, 0.01, 0.01], UTM_OFFSET, 20, 3000);
    const reduced = voxelDownsample(cloud, 5);
    expect(reduced.metadata?.sourceQuantisation).toBeUndefined();
    const { out } = exportLas(reduced, '1.2');
    expect(out.scale).toEqual([0.001, 0.001, 0.001]);
    expect(out.vlrText).toMatch(/Scale\/offset: re-quantised \(the source scale and offset are not recorded for this cloud\)\./);
  });

  it('a cloud with no recorded source quantisation is re-quantised', () => {
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
      origin: [500000, 4100000, 0],
      sourceFormat: 'las',
      name: 'a.las',
    });
    const { out } = exportLas(cloud, '1.2');
    expect(out.scale).toEqual([0.001, 0.001, 0.001]);
    expect(out.vlrText).toMatch(/re-quantised \(the source scale and offset are not recorded for this cloud\)/);
  });

  it('a non-LAS source is re-quantised', () => {
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
      origin: [0, 0, 0],
      sourceFormat: 'xyz',
      name: 'a.xyz',
      metadata: { sourceQuantisation: { scale: [0.01, 0.01, 0.01], offset: [0, 0, 0] } },
    });
    const { out } = exportLas(cloud, '1.4');
    expect(out.scale).toEqual([0.001, 0.001, 0.001]);
    expect(out.vlrText).toMatch(/re-quantised \(the source is not LAS or LAZ\)/);
  });

  it('records the fallback in the export log', async () => {
    const { cloud } = await loadSource('1.4', [0.01, 0.01, 0.01], UTM_OFFSET, 100);
    const { report } = exportLas(cloud, '1.4', { crsMode: 'reproject', sourceEpsg: 32611, targetEpsg: 4326 });
    expect(report.log.some((l) => l.message.startsWith('Scale/offset: re-quantised'))).toBe(true);
  });
});

function pointsOf(x: number[], y: number[], z: number[]): GlobalPoints {
  return { count: x.length, x: Float64Array.from(x), y: Float64Array.from(y), z: Float64Array.from(z) };
}
const ctx = { sourceFormat: 'las', sourceOrigin: [0, 0, 0] as [number, number, number], coordinatesChanged: null };
const q = (scale: Triple, offset: Triple): Quantisation => ({ scale, offset });

describe('planQuantisation', () => {
  const g = pointsOf([0, 1, 2], [0, 1, 2], [0, 1, 2]);

  it('keeps a valid quantisation for points on its grid', () => {
    const plan = planQuantisation(g, q([0.01, 0.01, 0.01], [0, 0, 0]), ctx);
    expect(plan.status).toBe('kept-exact');
    expect(plan.use).toEqual(q([0.01, 0.01, 0.01], [0, 0, 0]));
  });

  it.each([
    ['zero scale', q([0, 0.01, 0.01], [0, 0, 0])],
    ['negative scale', q([0.01, -0.01, 0.01], [0, 0, 0])],
    ['NaN scale', q([0.01, 0.01, NaN], [0, 0, 0])],
    ['infinite scale', q([Infinity, 0.01, 0.01], [0, 0, 0])],
    ['NaN offset', q([0.01, 0.01, 0.01], [0, NaN, 0])],
    ['infinite offset', q([0.01, 0.01, 0.01], [0, 0, -Infinity])],
  ])('re-quantises for a %s', (_name, bad) => {
    expect(isValidQuantisation(bad)).toBe(false);
    const plan = planQuantisation(g, bad, ctx);
    expect(plan.status).toBe('requantised');
    expect(plan.use).toBeNull();
    expect(plan.line).toMatch(/^Scale\/offset: re-quantised \(the source header scale or offset is not valid\)\.$/);
  });

  it('re-quantises when a coordinate would overflow int32', () => {
    const far = pointsOf([0, 30000000], [0, 1], [0, 1]);
    const plan = planQuantisation(far, q([0.001, 0.001, 0.001], [0, 0, 0]), ctx);
    expect(plan.status).toBe('requantised');
    expect(plan.line).toMatch(/does not fit the source scale and offset in int32/);
  });

  it('re-quantises when the offset puts a coordinate past int32 on the low side', () => {
    const plan = planQuantisation(g, q([0.001, 0.001, 0.001], [5e6, 0, 0]), ctx);
    expect(plan.status).toBe('requantised');
  });

  it('accepts a coordinate at the int32 limit', () => {
    const edge = pointsOf([2147483647 * 0.01, 0], [0, 0], [0, 0]);
    const plan = planQuantisation(edge, q([0.01, 0.01, 0.01], [0, 0, 0]), ctx);
    expect(plan.status).not.toBe('requantised');
  });

  it('re-quantises points that are not on the source grid', () => {
    const off = pointsOf([0.0123, 1], [0, 1], [0, 1]);
    const plan = planQuantisation(off, q([0.01, 0.01, 0.01], [0, 0, 0]), ctx);
    expect(plan.status).toBe('requantised');
    expect(plan.line).toMatch(/do not lie on the source scale and offset grid/);
  });

  it('re-quantises changed coordinates, empty clouds and non-finite coordinates', () => {
    const src = q([0.01, 0.01, 0.01], [0, 0, 0]);
    expect(planQuantisation(g, src, { ...ctx, coordinatesChanged: 'the coordinates were reprojected' }).line).toMatch(/reprojected/);
    expect(planQuantisation(pointsOf([], [], []), src, ctx).line).toMatch(/no points/);
    expect(planQuantisation(pointsOf([NaN], [0], [0]), src, ctx).status).toBe('requantised');
  });

  it('re-quantises a missing quantisation and a non-LAS format', () => {
    expect(planQuantisation(g, undefined, ctx).status).toBe('requantised');
    expect(planQuantisation(g, q([0.01, 0.01, 0.01], [0, 0, 0]), { ...ctx, sourceFormat: 'ply' }).status).toBe('requantised');
  });

  it('measures the Float32 spacing at the powers of two', () => {
    expect(float32HalfSpacing(0)).toBe(0);
    expect(float32HalfSpacing(16383.999)).toBe(2 ** -11);
    expect(float32HalfSpacing(16384)).toBe(2 ** -10);
    expect(float32HalfSpacing(-40000)).toBe(2 ** -9);
  });

  it('marks the 1 mm exact limit at 16384 m', () => {
    const local = (extent: number) => ({ ...ctx, sourceOrigin: [0, 0, 0] as [number, number, number], extent });
    const at = (extent: number) => planQuantisation(pointsOf([0, extent], [0, 0], [0, 0]), q([0.001, 0.001, 0.001], [0, 0, 0]), local(extent));
    expect(at(16383).status).toBe('kept-exact');
    expect(at(16385).status).toBe('kept-approximate');
  });
});

describe('writeLas with a supplied quantisation', () => {
  const g = pointsOf([100.12, 100.5, 101], [200, 200.25, 201], [5, 5.5, 6]);
  const supplied = q([0.01, 0.01, 0.01], [100, 200, 5]);

  it.each([
    ['LAS 1.2', (p: GlobalPoints, o: object) => writeLas(p, o)],
    ['LAS 1.4', (p: GlobalPoints, o: object) => writeLas14(p, o)],
  ])('%s writes the supplied scale and offset and bounds that match the records', (_n, write) => {
    const out = parseLasRecords(write(g, { quantisation: supplied }));
    expect(out.scale).toEqual([0.01, 0.01, 0.01]);
    expect(out.offset).toEqual([100, 200, 5]);
    expect(Array.from(out.records)).toEqual([12, 0, 0, 50, 25, 50, 100, 100, 100]);
    expect(out.min).toEqual([100.12, 200, 5]);
    expect(out.max).toEqual([101, 201, 6]);
  });

  it('ignores a supplied quantisation that is invalid or overflows and derives its own', () => {
    for (const bad of [q([0, 0.01, 0.01], [0, 0, 0]), q([0.01, 0.01, NaN], [0, 0, 0]), q([1e-9, 1e-9, 1e-9], [0, 0, 0])]) {
      const out = parseLasRecords(writeLas(g, { quantisation: bad }));
      expect(out.scale).toEqual([0.001, 0.001, 0.001]);
      expect(out.offset).toEqual([100, 200, 5]);
    }
  });

  it('derives its own quantisation when none is supplied', () => {
    expect(parseLasRecords(writeLas(g)).scale).toEqual([0.001, 0.001, 0.001]);
    expect(parseLasRecords(writeLas(cloudToGlobal(new PointCloud({ positions: Float32Array.from([0, 0, 0]), origin: [1, 2, 3], sourceFormat: 'las', name: 'x.las' })))).offset).toEqual([1, 2, 3]);
  });
});
