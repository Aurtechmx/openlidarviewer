/**
 * oocReopen.bench.ts — the browser half of the persistent-OOC-cache gate.
 *
 * The Node benchmark (`tests/benchmark/oocRebuildCost.test.ts`) measures what a
 * rebuild costs. This one measures what a *reopen* would cost: read a persisted
 * index back from real OPFS instead of decoding and indexing the file again.
 * That number can only come from a real browser — OPFS read latency, quota, and
 * the async file APIs have no faithful Node stand-in — so it runs under
 * Playwright against the dev server, which serves the real `/src` modules for an
 * in-page dynamic import.
 *
 * WHAT IT MEASURES. In one page context it builds a deterministic synthetic
 * cloud, runs the real decode+index build once (COLD — the rebuild baseline),
 * persists every tile plus the manifest and hierarchy to a real OPFS directory,
 * then times two reopens: WARM-FULL reads every tile back from OPFS (a
 * conservative upper bound — production streams tiles lazily, so a real reopen
 * reads less), and WARM-FIRST reads only the manifest, hierarchy, root and
 * level-1 tiles (the first-paint latency a user would feel). The ratio of COLD
 * to each WARM is the payoff the cache buys.
 *
 * HONEST SCOPE. COLD here runs on the main thread; production builds in a worker,
 * so this COLD is indicative, not the production build time (use the Node ladder
 * for that). The tiles are the same packed float32 regardless of source format,
 * so the reopen cost is format-independent; the rebuild it is compared against is
 * larger for LAZ (~3x, per the Node ladder). The point of this harness is the
 * order-of-magnitude reopen-vs-rebuild gap, and it is decisive at that scale.
 *
 * GATED. Runs only under OOC_REOPEN_BENCH=1 (sizes via OOC_REOPEN_BENCH_SIZES);
 * a normal e2e run skips it. Reported via stdout so the numbers survive a pass.
 */
import { test, expect } from '@playwright/test';

const ENABLED = process.env.OOC_REOPEN_BENCH === '1';
const SIZES_M = (process.env.OOC_REOPEN_BENCH_SIZES ?? '1,5,10')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const print = (line: string) => process.stdout.write(line + '\n');

type Row = {
  m: number;
  lasMB: number;
  tiles: number;
  tileBytesMB: number;
  coldMs: number;
  warmFullMs: number;
  warmFirstMs: number;
  speedupFull: number;
  speedupFirst: number;
};

test.describe('OOC reopen cost (real OPFS)', () => {
  test.skip(!ENABLED, 'set OOC_REOPEN_BENCH=1 to run');

  test('reopen-from-OPFS vs cold rebuild across a size ladder', async ({ page }) => {
    test.setTimeout(600_000);
    await page.goto('/');

    // The harness runs entirely in the page: it imports the real build modules,
    // writes tiles to real OPFS, and times the reopen. Returned as plain data.
    const rows: Row[] = await page.evaluate(async (sizes: number[]) => {
      const now = () => performance.now();
      // The dev server resolves these `/src` module URLs at runtime; a variable
      // specifier keeps the test's tsc from trying to resolve them as Node paths.
      const imp = (spec: string): Promise<any> => import(/* @vite-ignore */ spec);
      const [{ writeLas14 }, { ArrayBufferRangeSource }, tsb] = await Promise.all([
        imp('/src/convert/writeLas.ts'),
        imp('/src/io/range/ArrayBufferRangeSource.ts'),
        imp('/src/io/heavy/tileStoreBuilder.ts'),
      ]);
      const { buildTileStoreFromLas, openTileStore } = tsb as {
        buildTileStoreFromLas: (r: unknown, s: unknown, o: unknown) => Promise<any>;
        openTileStore: (m: string, h: string) => { leaves: () => Array<{ key: string; pointCount: number }> };
      };

      const mem = () => {
        const p = new Map<string, Uint8Array[]>();
        return {
          async append(k: string, b: Uint8Array) { const a = p.get(k) ?? []; a.push(b.slice()); p.set(k, a); },
          async read(k: string) { const a = p.get(k) ?? []; const t = a.reduce((s, b) => s + b.byteLength, 0); const o = new Uint8Array(t); let q = 0; for (const b of a) { o.set(b, q); q += b.byteLength; } return o; },
          async keys() { return [...p.keys()]; },
          async clear() { p.clear(); },
        };
      };

      const BUDGET = 128 * 1024 * 1024;
      const out: any[] = [];

      for (const m of sizes) {
        const n = Math.round(m * 1e6);
        const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
        let s = 123456789 >>> 0; const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
        const side = Math.ceil(Math.sqrt(n)), span = 1000;
        for (let i = 0; i < n; i++) {
          const gx = (i % side) / side, gy = Math.floor(i / side) / side;
          x[i] = 500000 + gx * span + (rnd() - 0.5) * 0.5;
          y[i] = 4100000 + gy * span + (rnd() - 0.5) * 0.5;
          z[i] = 200 + 8 * Math.sin(gx * 12) * Math.cos(gy * 9) + (rnd() - 0.5) * 0.3;
        }
        const las = writeLas14({ count: n, x, y, z });
        const ab = las.buffer.slice(las.byteOffset, las.byteOffset + las.byteLength);
        const lasMB = ab.byteLength / 1e6;

        let cold = Infinity, built: any;
        for (let r = 0; r < 3; r++) {
          const t0 = now();
          built = await buildTileStoreFromLas(new ArrayBufferRangeSource(ab, `c-${n}.las`), mem(), { memoryBudgetBytes: BUDGET });
          cold = Math.min(cold, now() - t0);
        }
        const leaves = built.reader.leaves() as Array<{ key: string; pointCount: number }>;

        const root = await navigator.storage.getDirectory();
        try { await root.removeEntry('olv-reopen-bench', { recursive: true }); } catch { /* first run */ }
        const dir = await root.getDirectoryHandle('olv-reopen-bench', { create: true });
        const nameOf = (k: string) => 'tile_' + (k === '' ? '_root' : k) + '.bin';
        let totalBytes = 0;
        for (const leaf of leaves) {
          const bytes = await built.tiles.read(leaf.key); totalBytes += bytes.byteLength;
          const fh = await dir.getFileHandle(nameOf(leaf.key), { create: true }); const w = await fh.createWritable(); await w.write(bytes); await w.close();
        }
        for (const [nm, txt] of [['manifest.json', built.manifestJson], ['hierarchy.txt', built.hierarchy]] as const) {
          const fh = await dir.getFileHandle(nm, { create: true }); const w = await fh.createWritable(); await w.write(txt); await w.close();
        }

        const readText = async (nm: string) => new TextDecoder().decode(await (await (await dir.getFileHandle(nm)).getFile()).arrayBuffer());
        const readTile = async (k: string) => new Uint8Array(await (await (await dir.getFileHandle(nameOf(k))).getFile()).arrayBuffer());

        let warmFull = Infinity;
        for (let r = 0; r < 3; r++) {
          const t0 = now();
          const reader2 = openTileStore(await readText('manifest.json'), await readText('hierarchy.txt'));
          for (const leaf of reader2.leaves()) { await readTile(leaf.key); }
          warmFull = Math.min(warmFull, now() - t0);
        }

        let warmFirst = Infinity;
        for (let r = 0; r < 3; r++) {
          const t0 = now();
          const reader2 = openTileStore(await readText('manifest.json'), await readText('hierarchy.txt'));
          for (const leaf of reader2.leaves().filter((l) => l.key.length <= 1)) { await readTile(leaf.key); }
          warmFirst = Math.min(warmFirst, now() - t0);
        }

        try { await root.removeEntry('olv-reopen-bench', { recursive: true }); } catch { /* best effort */ }

        out.push({
          m, lasMB: +lasMB.toFixed(1), tiles: leaves.length, tileBytesMB: +(totalBytes / 1e6).toFixed(1),
          coldMs: Math.round(cold), warmFullMs: Math.round(warmFull), warmFirstMs: Math.round(warmFirst),
          speedupFull: +(cold / warmFull).toFixed(1), speedupFirst: +(cold / warmFirst).toFixed(1),
        });
      }
      return out;
    }, SIZES_M);

    print(`\nOOC reopen — real OPFS, best-of-3, sizes=${SIZES_M.join(',')}M`);
    for (const r of rows) {
      print(
        `  ${r.m.toString().padStart(3)}M | las ${r.lasMB.toFixed(0).padStart(4)} MB | ` +
          `${r.tiles} tiles ${r.tileBytesMB.toFixed(0).padStart(4)} MB | ` +
          `cold ${r.coldMs.toString().padStart(5)} ms | reopen-full ${r.warmFullMs.toString().padStart(4)} ms (${r.speedupFull}x) | ` +
          `first-paint ${r.warmFirstMs.toString().padStart(3)} ms (${r.speedupFirst}x)`,
      );
      // The gate: reopen must be materially cheaper than a rebuild, or the cache
      // is not worth building. A conservative full read-back beats it comfortably.
      expect(r.warmFullMs, `reopen must beat rebuild at ${r.m}M`).toBeLessThan(r.coldMs);
    }
  });
});
