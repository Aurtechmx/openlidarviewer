/**
 * localOpenBaseline.test.ts — the "before" for the local LAZ open path.
 *
 * `lazDecodeBaseline` times the decoder alone. An open is more than a decode:
 * the file's prefix is read, the whole file is read into one ArrayBuffer, and
 * only then is anything decoded. This benchmark times those phases separately
 * over the same PDAL-compressed ladder, through the same calls the production
 * path makes, so the roadmap's chunk-range decoder (item C) and its preview
 * (item E) are judged against measured phase costs rather than asserted ones.
 *
 * WHAT NODE CAN AND CANNOT MEASURE. Node has `File` and `Blob`, so the prefix
 * and whole-file reads are the real calls. It has no Worker, so the pooled
 * decoder cannot engage; the decode leg is the single-reader `decodeLaz`,
 * which is the path every file under `PARALLEL_DECODE_MIN_POINTS` takes in
 * production anyway. There is no GPU and no frame, so TTFP and TTI are not
 * measured here; this records TTR up to decoded points, which is where C acts.
 * The browser-side leg (first visible frame, preview commit) is item B's
 * second half and is not this file.
 *
 * STAGING MODEL, STATED NOT MEASURED. On the single-reader path the compressed
 * file is resident twice during decode: once as the JS ArrayBuffer and once
 * as laz-perf's heap copy (`lazDecode.ts:121`). The column prints that model
 * so the reader can see what C removes; it is arithmetic on `byteLength`, not
 * a heap measurement, and it says so.
 *
 * Gated the same way as `lazDecodeBaseline`: `LAZ_DECODE_BENCH=1` and PDAL on
 * the path; otherwise it skips. Best-of-N per phase, every run printed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeLas14 } from '../../src/convert/writeLas';
import { parseLasHeader } from '../../src/io/lasHeader';
import { computeOrigin } from '../../src/io/coordinateBridge';
import { decodeLaz } from '../../src/io/lazDecode';
import { HEADER_PEEK_BYTES } from '../../src/app/openLocalHeavyLas';
import { PARALLEL_DECODE_MIN_POINTS } from '../../src/io/heavy/worker/lazChunkWorkerClient';
import type { GlobalPoints } from '../../src/convert/globalPoints';

const ENABLED = process.env.LAZ_DECODE_BENCH === '1';
function pdalPath(): string | null {
  for (const p of ['/opt/homebrew/bin/pdal', '/usr/local/bin/pdal', 'pdal']) {
    try {
      execFileSync(p, ['--version'], { stdio: 'ignore' });
      return p;
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** Sizes in millions of points; override with LAZ_DECODE_BENCH_SIZES=1,5,10. */
const SIZES_M = (process.env.LAZ_DECODE_BENCH_SIZES ?? '1,5,10')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const RUNS = 3;

/** The same deterministic terrain-like cloud the decode baseline builds. */
function makeCloud(n: number): GlobalPoints {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  let s = 20260726;
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const side = Math.ceil(Math.sqrt(n));
  const span = 1000;
  for (let i = 0; i < n; i++) {
    const gx = (i % side) / side;
    const gy = Math.floor(i / side) / side;
    x[i] = 500000 + gx * span + rnd() * 0.3;
    y[i] = 4100000 + gy * span + rnd() * 0.3;
    z[i] = 190 + 20 * Math.sin(gx * 6) * Math.cos(gy * 5) + rnd() * 0.1;
  }
  return { x, y, z, count: n } as unknown as GlobalPoints;
}

const best = (runs: number[]): number => Math.min(...runs);
const ms = (v: number): string => v.toFixed(0).padStart(6);
const mb = (b: number): string => (b / 1e6).toFixed(1).padStart(6);

describe('local LAZ open baseline (prefix read + whole-file read + single-reader decode)', () => {
  const PDAL = ENABLED ? pdalPath() : null;
  const run = ENABLED && PDAL !== null ? it : it.skip;

  run(
    'measures the open phases across a size ladder',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'olv-local-open-bench-'));
      // eslint-disable-next-line no-console
      console.log(
        `\nLocal LAZ open baseline — cores=${cpus().length}, node=${process.version}, sizes=${SIZES_M.join(',')}M, best of ${RUNS}`,
      );
      // eslint-disable-next-line no-console
      console.log(
        '  size | laz MB | head ms | read ms | decode ms | TTR ms | pool in prod | staging model (JS+WASM) MB',
      );

      for (const m of SIZES_M) {
        const n = Math.round(m * 1e6);
        const lasPath = join(dir, `c-${n}.las`);
        const lazPath = join(dir, `c-${n}.laz`);
        writeFileSync(lasPath, writeLas14(makeCloud(n)));
        if (existsSync(lazPath)) rmSync(lazPath);
        execFileSync(PDAL!, ['translate', lasPath, lazPath], { stdio: 'ignore' });

        const bytes = readFileSync(lazPath);
        const file = new File([bytes], `c-${n}.laz`);
        const origin = computeOrigin([500000, 4100000, 190]);

        const head: number[] = [];
        const read: number[] = [];
        const decode: number[] = [];
        for (let r = 0; r < RUNS; r++) {
          // 1. The one prefix read the open path now makes (item A).
          const t0 = performance.now();
          const prefix = await file.slice(0, Math.min(file.size, HEADER_PEEK_BYTES)).arrayBuffer();
          head.push(performance.now() - t0);
          expect(prefix.byteLength).toBeGreaterThan(0);

          // 2. The whole-file read the loader still makes before any decode.
          const t1 = performance.now();
          const buf = await file.arrayBuffer();
          read.push(performance.now() - t1);

          // 3. The single-reader decode, at stride 1 (every record).
          const header = parseLasHeader(buf);
          const t2 = performance.now();
          const raw = await decodeLaz(buf, header, origin, 1);
          decode.push(performance.now() - t2);
          expect(raw.positions.length / 3, `decoded point count for ${m}M`).toBeGreaterThan(n * 0.99);
        }
        rmSync(lasPath, { force: true });
        rmSync(lazPath, { force: true });

        const ttr = best(head) + best(read) + best(decode);
        const pooled = n >= PARALLEL_DECODE_MIN_POINTS ? 'yes' : 'no';
        // eslint-disable-next-line no-console
        console.log(
          `  ${m.toString().padStart(3)}M | ${mb(bytes.byteLength)} | ${ms(best(head))} | ${ms(best(read))} | ` +
            `${ms(best(decode))} | ${ms(ttr)} | ${pooled.padStart(12)} | ${mb(bytes.byteLength * 2)}` +
            `   runs head[${head.map((x) => x.toFixed(1)).join(',')}] read[${read.map((x) => x.toFixed(0)).join(',')}] decode[${decode.map((x) => x.toFixed(0)).join(',')}]`,
        );
      }
      rmSync(dir, { recursive: true, force: true });
    },
    3_600_000,
  );
});
