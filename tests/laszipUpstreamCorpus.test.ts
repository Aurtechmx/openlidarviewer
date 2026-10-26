/**
 * laszipUpstreamCorpus.test.ts
 *
 * Six files from the LASzip repository (LASzip/LASzip, Apache-2.0), vendored
 * in `tests/fixtures/las-laszip/`, opened through `loadFile` with the real
 * parse worker running in this process.
 *
 * The five `broken_*.laz` files were added upstream in 2011 as damaged
 * streams. Each is a LAS 1.0 file of 1,000 bytes whose header declares
 * 213,093 points, with one field of its `laszip encoded` VLR made invalid:
 *
 *   broken_coder.laz       coder 15 (LASzip defines only coder 0, arithmetic)
 *   broken_compressor.laz  compressor 16 (LASzip defines 0 to 3)
 *   broken_type.laz        item type 22 (no such LASzip item)
 *   broken_size.laz        POINT10 and GPSTIME11 at item version 6
 *   broken_version.laz     the same bytes as broken_size.laz
 *
 * LASzip's own reader rejects each at the VLR check (`check_coder`,
 * `check_compressor`, `check_item` in `src/laszip.cpp`). OLV must refuse each
 * through its normal load path with a message that names the fault, must not
 * size an allocation from the declared count, and must leave the parse worker
 * able to open the next file.
 *
 * `5points_14.las` is the LASzip DLL example output: LAS 1.4, point format 6,
 * five points, a zero legacy point count, extended classes 41 and 42, and
 * extended return numbers up to 9. The expected values below are read from
 * the file's records directly.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadFile } from '../src/io/loadFile';
import type { LoadResult } from '../src/io/loadFile';
import { LoadError, describeLoadError } from '../src/io/loadErrors';
import { parseLasHeader } from '../src/io/lasHeader';
import { getLazPerf } from '../src/io/lazDecode';
import { installInProcessParseWorker, type InProcessParseWorkerHandle } from './helpers/inProcessParseWorker';

function fixtureBytes(dir: string, name: string) {
  return readFileSync(new URL(`./fixtures/${dir}/${name}`, import.meta.url));
}

function asFile(dir: string, name: string): File {
  return new File([fixtureBytes(dir, name)], name);
}

/** Any load that has not settled after this is a hang. */
const HANG_MS = 5_000;

async function settle(promise: Promise<LoadResult>): Promise<{ ok: LoadResult } | { err: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`load did not settle within ${HANG_MS} ms`)), HANG_MS);
  });
  try {
    return { ok: await Promise.race([promise, hang]) };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('load did not settle')) throw err;
    return { err };
  } finally {
    clearTimeout(timer);
  }
}

let bridge: InProcessParseWorkerHandle;
let mallocSizes: number[] = [];

beforeAll(async () => {
  bridge = await installInProcessParseWorker();
  // Every block the LAZ decoder asks laz-perf for, so a refusal can be shown
  // to have sized nothing from the declared point count.
  const lazPerf = (await getLazPerf()) as unknown as { _malloc: (size: number) => number };
  const original = lazPerf._malloc.bind(lazPerf);
  vi.spyOn(lazPerf, '_malloc').mockImplementation((size: number) => {
    mallocSizes.push(size);
    return original(size);
  });
});
afterEach(() => { mallocSizes = []; });
afterAll(() => bridge.restore());

const BROKEN: ReadonlyArray<{ name: string; fault: RegExp }> = [
  { name: 'broken_coder.laz', fault: /coder 15\b/ },
  { name: 'broken_compressor.laz', fault: /compressor 16\b/ },
  { name: 'broken_type.laz', fault: /item type 22\b/ },
  { name: 'broken_size.laz', fault: /POINT10 item at version 6\b/ },
  { name: 'broken_version.laz', fault: /POINT10 item at version 6\b/ },
];

describe('LASzip broken streams are refused through loadFile', () => {
  it('the five files are what the upstream commit describes', () => {
    for (const { name } of BROKEN) {
      const bytes = fixtureBytes('las-laszip', name);
      expect(bytes.byteLength).toBe(1000);
      const header = parseLasHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      expect(header.pointCount).toBe(213_093);
    }
    // Two of the five are byte-identical upstream.
    expect(fixtureBytes('las-laszip', 'broken_size.laz').equals(fixtureBytes('las-laszip', 'broken_version.laz'))).toBe(true);
  });

  for (const { name } of BROKEN) {
    it(`${name}: refused without a hang, nothing sized from the count, worker still usable`, async () => {
      const result = await settle(loadFile(asFile('las-laszip', name)));
      expect('err' in result).toBe(true);
      const err = (result as { err: unknown }).err;
      expect(err).toBeInstanceOf(LoadError);
      expect((err as LoadError).category).toBe('malformed-file');

      // Nothing was allocated in the decoder for 213,093 points: no laz-perf
      // block larger than the file itself.
      expect(Math.max(0, ...mallocSizes)).toBeLessThanOrEqual(1000);

      // The same worker opens a good LAZ file next.
      const workersBefore = bridge.workers.length;
      const next = await settle(loadFile(asFile('las-laspy', 'simple.laz')));
      expect('ok' in next).toBe(true);
      expect((next as { ok: LoadResult }).ok.cloud.pointCount).toBe(1065);
      expect(bridge.workers.length).toBe(workersBefore);
      expect(bridge.workers.at(-1)?.terminated).toBe(false);
    });
  }

  for (const { name, fault } of BROKEN) {
    it(`${name}: the refusal names the fault, and the page shows it`, async () => {
      const result = await settle(loadFile(asFile('las-laszip', name)));
      const err = (result as { err: unknown }).err;
      expect((err as LoadError).message).toMatch(fault);
      // The page shows this message, not the category's generic line.
      expect(describeLoadError(err)).toMatch(fault);
      expect(describeLoadError(err)).toContain(name);
    });
  }
});

describe('LASzip 5points_14.las (LAS 1.4, point format 6)', () => {
  const bytes = fixtureBytes('las-laszip', '5points_14.las');
  const header = parseLasHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

  it('reads the LAS 1.4 header fields', () => {
    expect(header.versionMinor).toBe(4);
    expect(header.headerSize).toBe(375);
    expect(header.pointFormat).toBe(6);
    expect(header.pointDataRecordLength).toBe(33);
    expect(header.offsetToPointData).toBe(921);
    expect(header.vlrCount).toBe(3);
    // The legacy 32-bit count is 0; the count is the 64-bit field at 247.
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(107, true)).toBe(0);
    expect(header.pointCount).toBe(5);
    expect(header.scale).toEqual([0.01, 0.01, 0.01]);
    expect(header.offset).toEqual([600000, 4800000, 0]);
    expect(header.min).toEqual([630498.56, 4834748.73, 61.33]);
    expect(header.max).toEqual([630499.95, 4834749.66, 63.68]);
    expect(header.generatingSoftware).toBe('LASzip DLL 2.4 r1 (150905)');
    expect(header.systemIdentifier).toBe('LASzip DLL example 9');
    expect(header.gpsTimeType).toBe('adjusted-standard');
    // The WKT bit is set but the projection VLR is empty: no CRS, not a crash.
    expect(header.crs).toBeNull();
  });

  it('opens with five points at the positions the records hold', async () => {
    const result = await settle(loadFile(new File([bytes], '5points_14.las')));
    expect('ok' in result).toBe(true);
    const { cloud } = (result as { ok: LoadResult }).ok;
    expect(cloud.pointCount).toBe(5);
    const expected = [
      [630499.95, 4834749.17, 62.15],
      [630499.83, 4834748.88, 62.68],
      [630499.54, 4834749.66, 62.66],
      [630498.56, 4834749.41, 63.68],
      [630498.8, 4834748.73, 62.16],
    ];
    for (let i = 0; i < 5; i++) {
      for (let k = 0; k < 3; k++) {
        expect(cloud.positions[i * 3 + k] + cloud.origin[k]).toBeCloseTo(expected[i][k], 4);
      }
    }
    // Extended (point format 6+) values a LAS 1.0-1.3 layout cannot hold.
    expect(Array.from(cloud.classification ?? [])).toEqual([2, 41, 42, 5, 2]);
    expect(Array.from(cloud.returnNumber ?? [])).toEqual([2, 8, 9, 1, 2]);
    expect(Array.from(cloud.returnCount ?? [])).toEqual([2, 9, 9, 2, 2]);
    expect(Array.from(cloud.intensity ?? [])).toEqual([60, 90, 70, 20, 110]);
  });
});
