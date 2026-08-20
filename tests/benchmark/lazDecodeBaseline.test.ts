/**
 * lazDecodeBaseline.test.ts — the honest "before" for chunk-parallel LAZ decode.
 *
 * OLV's live path decodes a dropped `.laz` with a single laz-perf `LASZip`
 * reader (`src/io/lazDecode.ts`), one arithmetic-coder state across the whole
 * stream: strictly sequential, one core. This benchmark measures that path's
 * throughput on a ladder of synthetic clouds, so the chunk-parallel work the
 * heavy-cloud roadmap describes is proven against a number, not asserted.
 *
 * WHY IT IS GATED AND LOCAL-ONLY. laz-perf ships a decoder, not an encoder, so
 * there is no in-process way to make a LAZ fixture; this benchmark writes an
 * uncompressed LAS with the real writer and shells out to PDAL to compress it,
 * the same local-tool pattern the cross-implementation reference generators use.
 * PDAL is not a project dependency and is absent in CI, so the benchmark runs
 * only when `LAZ_DECODE_BENCH=1` and PDAL is on the path; otherwise it skips.
 * It is not a `benchmarks/runner` suite yet — it establishes the baseline leg;
 * the loaders.gl LASLoader competitor leg and the manifest integration follow.
 *
 * WHY BEST-OF-N. Decode is CPU-bound and the WASM heap warms on the first call;
 * the minimum of a few runs is the cleanest estimate of the decode cost, and
 * every run is printed so the spread is visible rather than hidden.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { writeLas14 } from '../../src/convert/writeLas';
import { parseLasHeader } from '../../src/io/lasHeader';
import { computeOrigin } from '../../src/io/coordinateBridge';
import { decodeLaz } from '../../src/io/lazDecode';
import type { GlobalPoints } from '../../src/convert/globalPoints';

const ENABLED = process.env.LAZ_DECODE_BENCH === '1';
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

/** Sizes in millions of points; override with LAZ_DECODE_BENCH_SIZES=1,5,10,50. */
const SIZES_M = (process.env.LAZ_DECODE_BENCH_SIZES ?? '1,5,10')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/** A deterministic terrain-like cloud: a rolling surface plus small noise. */
function makeCloud(n: number): GlobalPoints {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  let s = 123456789 >>> 0;
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const side = Math.ceil(Math.sqrt(n));
  const span = 1000;
  for (let i = 0; i < n; i++) {
    const gx = (i % side) / side;
    const gy = Math.floor(i / side) / side;
    x[i] = 500000 + gx * span + (rnd() - 0.5) * 0.5;
    y[i] = 4100000 + gy * span + (rnd() - 0.5) * 0.5;
    z[i] = 200 + 8 * Math.sin(gx * 12) * Math.cos(gy * 9) + (rnd() - 0.5) * 0.3;
  }
  return { count: n, x, y, z };
}

describe('LAZ decode baseline (single-threaded laz-perf)', () => {
  const PDAL = ENABLED ? pdalPath() : null;
  const run = ENABLED && PDAL !== null ? it : it.skip;

  run(
    'measures decode throughput across a size ladder',
    async () => {
      // mkdtemp, not a fixed name under the shared temp dir: a predictable path
      // there can be pre-created by another user as a symlink, so the benchmark
      // would write its fixtures through it.
      const dir = mkdtempSync(join(tmpdir(), 'olv-laz-decode-bench-'));
      // eslint-disable-next-line no-console
      console.log(`\nLAZ decode baseline — cores=${cpus().length}, sizes=${SIZES_M.join(',')}M`);

      for (const m of SIZES_M) {
        const n = Math.round(m * 1e6);
        const lasPath = join(dir, `c-${n}.las`);
        const lazPath = join(dir, `c-${n}.laz`);
        writeFileSync(lasPath, writeLas14(makeCloud(n)));
        if (existsSync(lazPath)) rmSync(lazPath);
        execFileSync(PDAL!, ['translate', lasPath, lazPath], { stdio: 'ignore' });

        const bytes = readFileSync(lazPath);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const header = parseLasHeader(buf);
        const origin = computeOrigin([500000, 4100000, 190]);

        const runs: number[] = [];
        for (let r = 0; r < 3; r++) {
          const t0 = performance.now();
          const raw = await decodeLaz(buf, header, origin, 1);
          runs.push(performance.now() - t0);
          expect(raw.positions.length / 3, `decoded point count for ${m}M`).toBeGreaterThan(n * 0.99);
        }
        rmSync(lasPath, { force: true });
        rmSync(lazPath, { force: true });

        const best = Math.min(...runs);
        // eslint-disable-next-line no-console
        console.log(
          `  ${m.toString().padStart(3)}M pts | laz ${(buf.byteLength / 1e6).toFixed(1).padStart(5)} MB | ` +
            `decode best ${best.toFixed(0).padStart(6)} ms | ${(m / (best / 1000)).toFixed(2).padStart(6)} M pts/s | ` +
            `runs [${runs.map((x) => x.toFixed(0)).join(', ')}]`,
        );
      }
    },
    600_000,
  );
});
