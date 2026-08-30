/**
 * oocRebuildCost.test.ts — the honest rebuild cost of the out-of-core index.
 *
 * Re-opening a heavy local scan today rebuilds its whole OOC index: the file is
 * decoded and settled into a spilled octree from scratch. A persistent cache
 * would keep that index and reuse it, but the cache is only worth building if a
 * rebuild is actually expensive. This benchmark measures the rebuild so that
 * decision rests on a number, not an assumption. It is the Phase-0 gate: the
 * figure here is the cost a reopen must beat.
 *
 * WHAT IT MEASURES, AND WHAT IT CANNOT. The whole build runs in Node against an
 * in-memory spill store — `indexOutOfCore` takes an injected store, so no OPFS
 * and no browser are involved. It records two things per size: one decode pass
 * over the source on its own, and the full `buildTileStoreFromLas/Laz` (which
 * decodes internally, settles the octree, and serialises the manifest). The
 * one-pass build reads the source once; the forced slow path reads it twice, so
 * running both shows what the header fast path saves. Peak staging memory is
 * reported from the build itself.
 *
 * The reopen side — OPFS read-back latency, spill-write cost under a real quota,
 * GPU upload — is browser-only and is NOT measured here. This benchmark bounds
 * the rebuild cost; whether a reopen beats it is a separate browser measurement
 * and must not be inferred from these numbers.
 *
 * WHY IT IS GATED. It builds multi-million-point clouds and prints timings, so
 * it runs only under `OOC_REBUILD_BENCH=1`; otherwise it skips. The LAS leg is
 * pure Node. The LAZ leg additionally needs PDAL on the path to compress a
 * fixture (laz-perf decodes but cannot encode), the same local-tool pattern the
 * decode baseline uses; without PDAL the LAZ leg skips and the LAS leg still
 * runs. Best-of-N because the WASM heap and the allocator warm on the first run.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { writeLas14 } from '../../src/convert/writeLas';
import { ArrayBufferRangeSource } from '../../src/io/range/ArrayBufferRangeSource';
import { openSlicedLasSource } from '../../src/io/heavy/slicedLasSource';
import { openChunkedLazSource } from '../../src/io/heavy/chunkedLazSource';
import { buildTileStoreFromLas, buildTileStoreFromLaz } from '../../src/io/heavy/tileStoreBuilder';
import type { SpillStore } from '../../src/io/heavy/oocIndexer';
import type { GlobalPoints } from '../../src/convert/globalPoints';

const ENABLED = process.env.OOC_REBUILD_BENCH === '1';

/** The build memory budget the live path uses (heavyLasExecutor). */
const BUILD_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;

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

/** Sizes in millions of points; override with OOC_REBUILD_BENCH_SIZES=1,5,10,50. */
const SIZES_M = (process.env.OOC_REBUILD_BENCH_SIZES ?? '1,5,10')
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

/** An in-memory {@link SpillStore}: append concatenates, read joins. */
function memoryStore(): SpillStore {
  const parts = new Map<string, Uint8Array[]>();
  return {
    async append(key, bytes) {
      const arr = parts.get(key) ?? [];
      arr.push(bytes.slice());
      parts.set(key, arr);
    },
    async read(key) {
      const arr = parts.get(key) ?? [];
      const total = arr.reduce((n, b) => n + b.byteLength, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const b of arr) {
        out.set(b, o);
        o += b.byteLength;
      }
      return out;
    },
    async keys() {
      return [...parts.keys()];
    },
    async clear() {
      // Whole-store clear: the one-pass fast path re-spills after a rejected
      // bounds guess, and only runs on a store that can be cleared.
      parts.clear();
    },
  };
}

/** Best-of-N wall time in ms for an async body, plus every run for the spread. */
async function bestOf(runs: number, body: () => Promise<void>): Promise<number[]> {
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    await body();
    times.push(performance.now() - t0);
  }
  return times;
}

const fmt = (n: number, w = 6) => n.toFixed(0).padStart(w);

// Write directly to stdout: the printed table is this benchmark's whole output,
// and vitest buffers `console.log` away for a passing test, so the numbers would
// never reach the terminal on the (expected) green run.
const print = (line: string) => process.stdout.write(line + '\n');

describe('OOC rebuild cost (decode + index, in-memory spill)', () => {
  const PDAL = ENABLED ? pdalPath() : null;
  const runLas = ENABLED ? it : it.skip;
  const runLaz = ENABLED && PDAL !== null ? it : it.skip;

  runLas(
    'LAS: measures full rebuild across a size ladder',
    async () => {
      print(`\nOOC rebuild — LAS — cores=${cpus().length}, sizes=${SIZES_M.join(',')}M`);
      for (const m of SIZES_M) {
        const n = Math.round(m * 1e6);
        const las = writeLas14(makeCloud(n));
        const ab = las.buffer.slice(las.byteOffset, las.byteOffset + las.byteLength) as ArrayBuffer;
        const lasMB = ab.byteLength / 1e6;
        const src = () => new ArrayBufferRangeSource(ab, `c-${n}.las`);

        const decode = await bestOf(3, async () => {
          const sliced = await openSlicedLasSource(src());
          // Drain one pass over the source; this is decode alone, no bucketing.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _batch of sliced.source.batches()) {
            /* count nothing; just pull every batch through */
          }
        });

        let peak = 0;
        let points = 0;
        const buildFast = await bestOf(3, async () => {
          const built = await buildTileStoreFromLas(src(), memoryStore(), {
            memoryBudgetBytes: BUILD_MEMORY_BUDGET_BYTES,
          });
          peak = built.peakBufferedBytes;
          points = built.reader.manifest.pointCount;
        });
        expect(points, `rebuilt point count for ${m}M`).toBeGreaterThan(n * 0.99);
        expect(peak, `peak staging under budget for ${m}M`).toBeLessThanOrEqual(
          BUILD_MEMORY_BUDGET_BYTES,
        );

        const buildSlow = await bestOf(3, async () => {
          await buildTileStoreFromLas(src(), memoryStore(), {
            memoryBudgetBytes: BUILD_MEMORY_BUDGET_BYTES,
            forceSlowPath: true,
          });
        });

        const dBest = Math.min(...decode);
        const fBest = Math.min(...buildFast);
        const sBest = Math.min(...buildSlow);
        print(
          `  ${m.toString().padStart(3)}M | las ${lasMB.toFixed(1).padStart(6)} MB | ` +
            `decode ${fmt(dBest)} ms | build ${fmt(fBest)} ms (slow ${fmt(sBest)}) | ` +
            `${(m / (fBest / 1000)).toFixed(2).padStart(6)} M pts/s | ` +
            `${(fBest / m).toFixed(1).padStart(6)} ms/Mpts | ` +
            `${(fBest / lasMB).toFixed(1).padStart(6)} ms/MB | ` +
            `peak ${(peak / 1e6).toFixed(1).padStart(6)} MB`,
        );
      }
    },
    600_000,
  );

  runLaz(
    'LAZ: measures full rebuild across a size ladder',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'olv-ooc-rebuild-bench-'));
      print(`\nOOC rebuild — LAZ — cores=${cpus().length}, sizes=${SIZES_M.join(',')}M`);
      for (const m of SIZES_M) {
        const n = Math.round(m * 1e6);
        const lasPath = join(dir, `c-${n}.las`);
        const lazPath = join(dir, `c-${n}.laz`);
        writeFileSync(lasPath, writeLas14(makeCloud(n)));
        if (existsSync(lazPath)) rmSync(lazPath);
        execFileSync(PDAL!, ['translate', lasPath, lazPath], { stdio: 'ignore' });
        const bytes = readFileSync(lazPath);
        const ab = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const lazMB = ab.byteLength / 1e6;
        const src = () => new ArrayBufferRangeSource(ab, `c-${n}.laz`);

        const decode = await bestOf(3, async () => {
          const chunked = await openChunkedLazSource(src());
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _batch of chunked.source.batches()) {
            /* pull every batch through */
          }
        });

        let peak = 0;
        let points = 0;
        const build = await bestOf(3, async () => {
          const built = await buildTileStoreFromLaz(src(), memoryStore(), {
            memoryBudgetBytes: BUILD_MEMORY_BUDGET_BYTES,
          });
          peak = built.peakBufferedBytes;
          points = built.reader.manifest.pointCount;
        });
        expect(points, `rebuilt point count for ${m}M`).toBeGreaterThan(n * 0.99);

        rmSync(lasPath, { force: true });
        rmSync(lazPath, { force: true });

        const dBest = Math.min(...decode);
        const bBest = Math.min(...build);
        print(
          `  ${m.toString().padStart(3)}M | laz ${lazMB.toFixed(1).padStart(6)} MB | ` +
            `decode ${fmt(dBest)} ms | build ${fmt(bBest)} ms | ` +
            `${(m / (bBest / 1000)).toFixed(2).padStart(6)} M pts/s | ` +
            `${(bBest / m).toFixed(1).padStart(6)} ms/Mpts | ` +
            `peak ${(peak / 1e6).toFixed(1).padStart(6)} MB`,
        );
      }
    },
    600_000,
  );
});
