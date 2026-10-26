/**
 * laspyCorpusDecode.test.ts
 *
 * Four files from laspy's test data (laspy/laspy `tests/data/`, BSD-2-Clause),
 * vendored in `tests/fixtures/las-laspy/`, opened through `loadFile` with the
 * real parse worker running in this process.
 *
 * Where laspy's own tests state a value for a file, that value is the
 * reference here, and the laspy test is named beside the assertion. Paths are
 * those of the laspy repository at the commit recorded in
 * `docs/project/THIRD_PARTY_NOTICES.md`.
 *
 * `simple_with_page.copc.laz` is read here as a plain LAZ file, the way laspy's
 * `test_reading_copc_file_normal_laz_file` reads COPC; its hierarchy paging is
 * exercised over HTTP in `copcRangeEdgeCases.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadFile } from '../src/io/loadFile';
import type { LoadResult } from '../src/io/loadFile';
import { parseLasHeader } from '../src/io/lasHeader';
import type { PointCloud } from '../src/model/PointCloud';
import { installInProcessParseWorker, type InProcessParseWorkerHandle } from './helpers/inProcessParseWorker';

function bytesOf(name: string) {
  return readFileSync(new URL(`./fixtures/las-laspy/${name}`, import.meta.url));
}
function bufferOf(name: string): ArrayBuffer {
  const b = bytesOf(name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
async function open(name: string, pointSemantics = false): Promise<LoadResult> {
  return loadFile(new File([bytesOf(name)], name), {}, { pointSemantics });
}

/** Per-axis minimum and maximum of the cloud in source coordinates. */
function worldExtent(cloud: PointCloud): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const p = cloud.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k] + cloud.origin[k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}
function range(a: ArrayLike<number> | undefined): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < (a?.length ?? 0); i++) {
    const v = a![i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

let bridge: InProcessParseWorkerHandle;
beforeAll(async () => { bridge = await installInProcessParseWorker(); });
afterAll(() => bridge.restore());

describe('unregistered_extra_bytes.las: record longer than its format, no Extra Bytes VLR', () => {
  // laspy tests/test_extrabytes.py::test_handle_unregistered_extra_bytes
  it('declares point format 6 with a 34-byte record and no VLRs', () => {
    const header = parseLasHeader(bufferOf('unregistered_extra_bytes.las'));
    expect(header.pointFormat).toBe(6);
    expect(header.pointDataRecordLength).toBe(34);
    expect(header.vlrCount).toBe(0);
    expect(header.pointCount).toBe(4);
  });

  it('opens, and the four undeclared bytes do not move the points', async () => {
    const { cloud } = await open('unregistered_extra_bytes.las');
    expect(cloud.pointCount).toBe(4);
    // laspy: x == y == z == [1, 2, 3, 4]
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 3; k++) {
        expect(cloud.positions[i * 3 + k] + cloud.origin[k]).toBe(i + 1);
      }
    }
  });
});

describe('1_4_w_evlr.laz: LAS 1.4 LAZ with one EVLR after the points', () => {
  const header = parseLasHeader(bufferOf('1_4_w_evlr.laz'));

  it('declares the EVLR the laspy tests read', () => {
    // laspy tests/test_reading_1_4.py::test_manually_reading_evlrs reads one
    // EVLR, user id "pylastest", record id 42, from this file.
    expect(header.versionMinor).toBe(4);
    expect(header.evlrCount).toBe(1);
    expect(header.evlrOffset).toBe(8872);
    const view = new DataView(bufferOf('1_4_w_evlr.laz'), 8872);
    const userId = new TextDecoder().decode(new Uint8Array(view.buffer, 8872 + 2, 16)).replace(/\0+$/, '');
    expect(userId).toBe('pylastest');
    expect(view.getUint16(18, true)).toBe(42);
  });

  it('opens all 1,000 points with the EVLR skipped, inside the header bounds', async () => {
    const { cloud } = await open('1_4_w_evlr.laz');
    // laspy tests/test_reading_1_4.py::test_selective_decompression: a point
    // format of 6 or above; the header's 64-bit count is 1,000.
    expect(header.pointFormat).toBeGreaterThanOrEqual(6);
    expect(cloud.pointCount).toBe(1000);
    const { min, max } = worldExtent(cloud);
    for (let k = 0; k < 3; k++) {
      // The decoded extent is the header's, to the float32 spacing of the
      // local coordinates (500 m span, so under 1e-4 m).
      expect(Math.abs(min[k] - header.min[k])).toBeLessThan(1e-4);
      expect(Math.abs(max[k] - header.max[k])).toBeLessThan(1e-4);
    }
  });

  it('takes the CRS from the VLR, in the US survey feet its projected CRS declares', async () => {
    const { cloud } = await open('1_4_w_evlr.laz');
    const crs = cloud.metadata?.crs;
    expect(crs?.epsg).toBe(2903);
    // EPSG:2903 is NAD83(HARN) / New Mexico Central (ftUS). The WKT's PROJCS
    // carries UNIT["US survey foot",0.3048006096012192]; the VERTCS nested at
    // its end carries a unit of its own, which must not stand in for it.
    expect(crs?.linearUnit).toBe('us-survey-foot');
    expect(crs?.linearUnitToMetres).toBeCloseTo(1200 / 3937, 12);
    expect(crs?.verticalDatum).toMatch(/North American Vertical Datum|NAVD/);
  });
});

describe('simple.laz: the laspy reference cloud', () => {
  // laspy tests/test_reading_1_2.py, parametrised over simple.las and simple.laz.
  let cloud: PointCloud;
  beforeAll(async () => { ({ cloud } = await open('simple.laz', true)); });

  it('decodes 1,065 points of format 3', () => {
    const header = parseLasHeader(bufferOf('simple.laz'));
    expect(header.pointFormat).toBe(3);
    expect(cloud.pointCount).toBe(1065);
  });

  it('matches the unscaled X, Y, Z ranges (test_unscaled_x/y/z)', () => {
    const { min, max } = worldExtent(cloud);
    // Scale 0.01, offset 0: X 63561985..63898255, Y 84889970..85353543, Z 40659..58638.
    expect(Math.round(min[0] * 100)).toBe(63561985);
    expect(Math.round(max[0] * 100)).toBe(63898255);
    expect(Math.round(min[1] * 100)).toBe(84889970);
    expect(Math.round(max[1] * 100)).toBe(85353543);
    expect(Math.round(min[2] * 100)).toBe(40659);
    expect(Math.round(max[2] * 100)).toBe(58638);
  });

  it('matches the attribute ranges and class counts', () => {
    expect(range(cloud.intensity)).toEqual([0, 254]); // test_intensity
    expect(range(cloud.returnNumber)).toEqual([1, 4]); // test_return_number
    expect(range(cloud.returnCount)).toEqual([1, 4]); // test_number_of_returns
    expect(range(cloud.pointSourceId)).toEqual([7326, 7334]); // test_point_source_id
    expect(range(cloud.userData)).toEqual([117, 149]); // test_user_data
    expect(range(cloud.scanAngle)).toEqual([-19, 18]); // test_scan_angle_rank
    const [gpsLo, gpsHi] = range(cloud.gpsTime); // test_gps_time
    expect(gpsLo).toBeCloseTo(245370.417075, 4);
    expect(gpsHi).toBeCloseTo(249783.162158, 4);
    // test_classification_count: 789 of class 1, 276 of class 2.
    const counts = new Map<number, number>();
    for (const c of cloud.classification ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ 1: 789, 2: 276 });
  });

  it('matches the colour ranges, which are already 8-bit values (test_red/green/blue)', () => {
    const colors = cloud.colors!;
    const channel = (c: number): [number, number] =>
      range(Array.from({ length: cloud.pointCount }, (_, i) => colors[i * 3 + c]));
    expect(channel(0)).toEqual([39, 249]);
    expect(channel(1)).toEqual([57, 239]);
    expect(channel(2)).toEqual([56, 249]);
  });
});

describe('simple_with_page.copc.laz read as a plain LAZ file', () => {
  it('opens all 1,065 points, format 7, LAS 1.4', async () => {
    // laspy tests/test_copc.py::test_reading_copc_file_normal_laz_file (for
    // simple.copc.laz) and ::test_querying_copc_local_file_with_page: the
    // header count is 1,065 and a full query returns that many.
    const header = parseLasHeader(bufferOf('simple_with_page.copc.laz'));
    expect(header.versionMinor).toBe(4);
    expect(header.pointFormat).toBe(7);
    const { cloud } = await open('simple_with_page.copc.laz');
    expect(cloud.pointCount).toBe(1065);
    const { min, max } = worldExtent(cloud);
    expect(Math.round(min[0] * 100)).toBe(63561985);
    expect(Math.round(max[0] * 100)).toBe(63898255);
    expect(Math.round(min[2] * 100)).toBe(40659);
    expect(Math.round(max[2] * 100)).toBe(58638);
  });
});
