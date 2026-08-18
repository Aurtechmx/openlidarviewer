/**
 * loaderComparison.test.ts — OLV's loader against the standard web loader.
 *
 * The heavy-cloud roadmap frames the speed goal as "faster than the fastest web
 * loader". The fastest widely-used one is `@loaders.gl/las`'s LASLoader, so this
 * benchmark times OLV's `loadLas` and loaders.gl's `load` on the SAME files and
 * prints the ratio. It records two distinct results, because the two loaders do
 * not accept the same inputs:
 *
 *   1. COMMON GROUND (LAS <= 1.3, point formats 0-5). Both loaders decode these.
 *      This is the honest head-to-head. OLV does MORE per point here — it decodes
 *      full-precision local coordinates plus intensity, classification, returns,
 *      GPS time and RGB, where loaders.gl returns a float32 global position — so
 *      a tie on wall-clock already means OLV moves more data in the same time.
 *
 *   2. CAPABILITY GAP (LAS 1.4, point formats 6-8). loaders.gl rejects these
 *      outright ("Only file versions <= 1.3 are supported"). This is the format
 *      modern LiDAR ships in (COPC, recent airborne surveys), the format the
 *      chunk-parallel decode targets, and the one no web loader can read. There
 *      is no head-to-head to run; the test pins the rejection so the claim that
 *      loaders.gl cannot load a modern file stays true as versions move.
 *
 * The chunk-parallel speedup (measured ~3.2x over OLV's own single-thread decode
 * on an 8M-point LAS 1.4 file) therefore has no loaders.gl counterpart: it lives
 * entirely in category 2, where loaders.gl does not run.
 *
 * WHY IT IS GATED AND LOCAL-ONLY. Fixtures are made by shelling out to PDAL
 * (absent in CI), and the comparison pulls the `@loaders.gl/las` devDependency;
 * it runs only when `LOADER_COMPARE_BENCH=1` and PDAL is on the path, and skips
 * otherwise. Best-of-N sheds the WASM warm-up, and every run is printed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { loadLas } from '../../src/io/loadLas';

const ENABLED = process.env.LOADER_COMPARE_BENCH === '1';

function pdalPath(): string | null {
  for (const p of ['/opt/homebrew/bin/pdal', '/usr/local/bin/pdal', 'pdal']) {
    try {
      execFileSync(p, ['--version'], { stdio: 'ignore' });
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Sizes in millions of points; override with LOADER_COMPARE_SIZES=1,5,10. */
const SIZES_M = (process.env.LOADER_COMPARE_SIZES ?? '1,5')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/** Write a synthetic LAS/LAZ of the given version and point format via PDAL. */
function pdalFaux(
  pdal: string,
  count: number,
  minorVersion: number,
  dataformatId: number,
  out: string,
): void {
  const pipeline = {
    pipeline: [
      {
        type: 'readers.faux',
        mode: 'random',
        count,
        bounds: '([500000,501000],[4100000,4101000],[190,260])',
      },
      {
        type: 'writers.las',
        filename: out, // a `.laz` extension makes PDAL laszip-compress it
        minor_version: minorVersion,
        dataformat_id: dataformatId,
        scale_x: 0.001,
        scale_y: 0.001,
        scale_z: 0.001,
        offset_x: 500000,
        offset_y: 4100000,
        offset_z: 190,
      },
    ],
  };
  const pj = `${out}.json`;
  writeFileSync(pj, JSON.stringify(pipeline));
  if (existsSync(out)) rmSync(out);
  execFileSync(pdal, ['pipeline', pj], { stdio: 'ignore' });
  rmSync(pj, { force: true });
}

function readAsArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

async function bestOf(n: number, fn: () => Promise<void>): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('loader comparison — OLV vs loaders.gl LASLoader', () => {
  const PDAL = ENABLED ? pdalPath() : null;
  const run = ENABLED && PDAL !== null ? it : it.skip;

  run(
    'times both loaders on the common ground (LAS 1.2, point format 3)',
    async () => {
      const { load } = await import('@loaders.gl/core');
      const { LASLoader } = await import('@loaders.gl/las');
      const dir = join(tmpdir(), 'olv-loader-compare');
      mkdirSync(dir, { recursive: true });
      // eslint-disable-next-line no-console
      console.log(`\nLoader comparison — cores=${cpus().length}, sizes=${SIZES_M.join(',')}M`);

      for (const m of SIZES_M) {
        const n = Math.round(m * 1e6);
        for (const [ext, fmt] of [
          ['las', 'las'],
          ['laz', 'laz'],
        ] as const) {
          const path = join(dir, `c-${n}.${ext}`);
          pdalFaux(PDAL!, n, 2, 3, path);
          const buf = readAsArrayBuffer(path);

          let decoded = 0;
          const olv = await bestOf(3, async () => {
            const pc = await loadLas(buf.slice(0), fmt, `c.${ext}`);
            decoded = pc.decodedPointCount ?? 0;
          });
          const lgl = await bestOf(3, async () => {
            await load(buf.slice(0), LASLoader);
          });
          rmSync(path, { force: true });

          const mp = decoded / 1e6;
          // eslint-disable-next-line no-console
          console.log(
            `  ${m.toString().padStart(3)}M .${ext} | ` +
              `OLV ${olv.toFixed(0).padStart(5)}ms ${(mp / (olv / 1000)).toFixed(2).padStart(6)} M/s | ` +
              `loaders.gl ${lgl.toFixed(0).padStart(5)}ms ${(mp / (lgl / 1000)).toFixed(2).padStart(6)} M/s | ` +
              `OLV ${(lgl / olv).toFixed(2)}x`,
          );
          expect(decoded).toBeGreaterThan(n * 0.99);
        }
      }
    },
    600_000,
  );

  run(
    'records the capability gap: loaders.gl rejects LAS 1.4, OLV loads it',
    async () => {
      const { load } = await import('@loaders.gl/core');
      const { LASLoader } = await import('@loaders.gl/las');
      const dir = join(tmpdir(), 'olv-loader-compare');
      mkdirSync(dir, { recursive: true });
      const n = 500_000;
      const path = join(dir, `cap-${n}.laz`);
      pdalFaux(PDAL!, n, 4, 6, path); // LAS 1.4, point format 6
      const buf = readAsArrayBuffer(path);

      // loaders.gl refuses the modern format...
      await expect(load(buf.slice(0), LASLoader)).rejects.toThrow(/1\.3/);
      // ...and OLV decodes it in full.
      const pc = await loadLas(buf.slice(0), 'laz', 'cap.laz');
      expect(pc.decodedPointCount).toBeGreaterThan(n * 0.99);
      rmSync(path, { force: true });
      // eslint-disable-next-line no-console
      console.log(`\n  capability: loaders.gl REJECTS LAS 1.4 pf6; OLV decoded ${pc.decodedPointCount} pts`);
    },
    600_000,
  );
});
