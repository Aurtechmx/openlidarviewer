/**
 * localOpenPooled.test.ts: the pooled decoder on the local-open ladder.
 *
 * `localOpenBaseline` shows the single reader is the open below the pool
 * threshold. This leg measures the alternative on the same PDAL-compressed
 * ladder: the chunk table read from the file, and `decodeLazParallel` across
 * the real `lazChunkWorker` running in Node `worker_threads`, injected through
 * the pool's `workerFactory` seam. Nothing in the decode path is stubbed; the
 * worker module is the one the browser loads, bundled for Node with the
 * project's own bundler and given a `self` that forwards to `parentPort`.
 *
 * Two pooled timings per rung. COLD builds a fresh pool per decode and disposes
 * it after, which is what `decodeLazPooled` does for every file, so it carries
 * the worker start and the per-worker laz-perf instantiation. WARM reuses a
 * pool that has already decoded once, so the difference between the two is the
 * pool's fixed cost. The routing threshold (`PARALLEL_DECODE_MIN_POINTS`) is a
 * cold question.
 *
 * Every rung asserts the pooled output is byte-identical to the single reader's
 * before its time is printed. A faster path that changed a point would not be
 * a result.
 *
 * Threads are not browser Workers: a module worker in the browser fetches and
 * compiles its script and its WASM on each start, which threads do not model.
 * The browser leg of item B measures that; this file bounds it from below.
 *
 * Gated the same way as the other two: `LAZ_DECODE_BENCH=1` and PDAL on the
 * path. Best of N per phase, every run printed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { build } from 'vite';
import { parseLasHeader } from '../../src/io/lasHeader';
import { computeOrigin } from '../../src/io/coordinateBridge';
import { decodeLaz } from '../../src/io/lazDecode';
import { decodeLazParallel } from '../../src/io/heavy/decodeLazChunked';
import { readLazChunkTable } from '../../src/io/heavy/lazChunkTable';
import { LocalFileRangeSource } from '../../src/io/range/LocalFileRangeSource';
import {
  LazChunkWorkerClient,
  PARALLEL_DECODE_MIN_POINTS,
  type WorkerLike,
} from '../../src/io/heavy/worker/lazChunkWorkerClient';
import { DECODE_POOL_HARD_CAP } from '../../src/io/workerPool/decodePoolSize';
import type { RawPoints } from '../../src/io/lasDecodeShared';
import {
  LAZ_BENCH_ENABLED,
  LADDER_ORIGIN,
  benchSizesM,
  pdalPath,
  removeLadderRung,
  writeLadderRung,
} from '../helpers/lazLadder';

const ENABLED = LAZ_BENCH_ENABLED;
const PDAL = ENABLED ? pdalPath() : null;
/** Sizes in millions of points; override with LAZ_DECODE_BENCH_SIZES=1,2,5,10. */
const SIZES_M = benchSizesM('1,2,5,10');
/** Pool size; defaults to the policy's hard cap, which is what a large file gets. */
const POOL_SIZE = Number(process.env.LAZ_DECODE_BENCH_POOL ?? DECODE_POOL_HARD_CAP);
const RUNS = 3;

/**
 * Bundle the browser chunk worker for Node. The worker reads `self`; the banner
 * gives it one whose `onmessage` and `postMessage` forward to `parentPort`, in
 * the event shape the worker checks (`origin` empty, as a dedicated worker's
 * messages are). laz-perf's Node glue reads `__dirname`, which an ES module
 * lacks; the banner supplies it.
 */
async function bundleWorkerForNode(outDir: string): Promise<string> {
  const banner = [
    "import { parentPort as __olvPort } from 'node:worker_threads';",
    "import { fileURLToPath as __olvFileUrl } from 'node:url';",
    "import { dirname as __olvDirname } from 'node:path';",
    'globalThis.__filename = __olvFileUrl(import.meta.url);',
    'globalThis.__dirname = __olvDirname(globalThis.__filename);',
    'globalThis.self = {',
    "  location: { origin: '' },",
    "  set onmessage(fn) { __olvPort.on('message', (data) => fn({ data, origin: '' })); },",
    '  postMessage: (m, t) => __olvPort.postMessage(m, t),',
    '};',
  ].join('\n');
  await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: 'src/io/heavy/worker/lazChunkWorker.ts',
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rolldownOptions: { output: { entryFileNames: 'lazChunkWorker.mjs', format: 'es', banner } },
    },
  });
  return join(outDir, 'lazChunkWorker.mjs');
}

/** A Node worker thread behind the pool's `WorkerLike` contract. */
class NodeThreadWorker implements WorkerLike {
  private readonly _w: Worker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(file: string) {
    this._w = new Worker(file, { execArgv: [] });
    this._w.on('message', (data: unknown) => this.onmessage?.({ data } as MessageEvent));
    this._w.on('error', (err: unknown) => this.onerror?.(err));
  }
  postMessage(message: unknown, transfer?: Transferable[]): void {
    this._w.postMessage(message, transfer as ArrayBuffer[] | undefined);
  }
  terminate(): void {
    void this._w.terminate();
  }
}

const best = (runs: number[]): number => Math.min(...runs);
const ms = (v: number): string => v.toFixed(0).padStart(6);
const mb = (b: number): string => (b / 1e6).toFixed(1).padStart(6);
const same = (a: ArrayBufferView, b: ArrayBufferView): boolean =>
  Buffer.compare(
    Buffer.from(a.buffer, a.byteOffset, a.byteLength),
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  ) === 0;

function expectIdentical(pooled: RawPoints, single: RawPoints, label: string): void {
  expect(pooled.positions.length, `${label} count`).toBe(single.positions.length);
  expect(same(pooled.positions, single.positions), `${label} positions`).toBe(true);
  expect(same(pooled.intensity, single.intensity), `${label} intensity`).toBe(true);
  expect(same(pooled.classification, single.classification), `${label} classification`).toBe(true);
  expect(same(pooled.returnNumber, single.returnNumber), `${label} returnNumber`).toBe(true);
}

describe.skipIf(!ENABLED || PDAL === null)('local LAZ open, pooled decoder (chunk table + worker_threads pool)', () => {
  it(
    'measures the pooled decode across a size ladder against the single reader',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'olv-local-open-pooled-'));
      const workerFile = await bundleWorkerForNode(join(dir, 'worker'));
      const factory = (): WorkerLike => new NodeThreadWorker(workerFile);
      const origin = computeOrigin(LADDER_ORIGIN);

      // eslint-disable-next-line no-console
      console.log(
        `\nLocal LAZ open, pooled: cores=${cpus().length}, node=${process.version}, pool=${POOL_SIZE}, ` +
          `threshold=${PARALLEL_DECODE_MIN_POINTS / 1e6}M, sizes=${SIZES_M.join(',')}M, best of ${RUNS}`,
      );
      // eslint-disable-next-line no-console
      console.log(
        '  size | laz MB | chunks | table ms | single ms | pooled cold ms | pooled warm ms | fixed cost ms | cold speed-up',
      );

      for (const m of SIZES_M) {
        const rung = writeLadderRung(dir, m, PDAL!);
        const n = rung.n;
        const bytes = readFileSync(rung.lazPath);
        const file = new File([bytes], `c-${n}.laz`);
        const buf = await file.arrayBuffer();
        const header = parseLasHeader(buf);

        // The chunk table as item C would read it: from the file, by range.
        const table: number[] = [];
        let chunkCount = 0;
        for (let r = 0; r < RUNS; r++) {
          const t0 = performance.now();
          const result = await readLazChunkTable(new LocalFileRangeSource(file));
          table.push(performance.now() - t0);
          expect(result.supported, `chunk table for ${m}M`).toBe(true);
          if (result.supported) chunkCount = result.chunks.length;
        }

        // The single reader, in this process, for a like-for-like comparison.
        const single: number[] = [];
        let singleRaw: RawPoints | null = null;
        for (let r = 0; r < RUNS; r++) {
          const t0 = performance.now();
          singleRaw = await decodeLaz(buf, header, origin, 1);
          single.push(performance.now() - t0);
        }

        // COLD: a fresh pool per decode, disposed after, as production does.
        const cold: number[] = [];
        for (let r = 0; r < RUNS; r++) {
          const client = new LazChunkWorkerClient({ poolSize: POOL_SIZE, workerFactory: factory });
          try {
            const t0 = performance.now();
            const raw = await decodeLazParallel(buf, header, origin, client.decode, { stride: 1 });
            cold.push(performance.now() - t0);
            expect(raw, `pooled decode engaged for ${m}M`).not.toBeNull();
            if (r === 0) expectIdentical(raw!, singleRaw!, `${m}M`);
          } finally {
            client.dispose();
          }
        }

        // WARM: one pool, one throw-away decode, then timed decodes.
        const warm: number[] = [];
        const client = new LazChunkWorkerClient({ poolSize: POOL_SIZE, workerFactory: factory });
        try {
          await decodeLazParallel(buf, header, origin, client.decode, { stride: 1 });
          for (let r = 0; r < RUNS; r++) {
            const t0 = performance.now();
            await decodeLazParallel(buf, header, origin, client.decode, { stride: 1 });
            warm.push(performance.now() - t0);
          }
        } finally {
          client.dispose();
        }

        removeLadderRung(rung);

        const fixed = best(cold) - best(warm);
        const speedup = best(single) / best(cold);
        // eslint-disable-next-line no-console
        console.log(
          `  ${m.toString().padStart(3)}M | ${mb(bytes.byteLength)} | ${chunkCount.toString().padStart(6)} | ` +
            `${ms(best(table))} | ${ms(best(single))} | ${ms(best(cold))} | ${ms(best(warm))} | ` +
            `${ms(fixed)} | ${speedup.toFixed(2).padStart(5)}x` +
            `   runs table[${table.map((x) => x.toFixed(1)).join(',')}] single[${single.map((x) => x.toFixed(0)).join(',')}] ` +
            `cold[${cold.map((x) => x.toFixed(0)).join(',')}] warm[${warm.map((x) => x.toFixed(0)).join(',')}]`,
        );
      }
      rmSync(dir, { recursive: true, force: true });
    },
    3_600_000,
  );
});
