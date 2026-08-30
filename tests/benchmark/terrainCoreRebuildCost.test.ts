/**
 * terrainCoreRebuildCost.test.ts — the honest recompute cost of a TerrainCore,
 * and whether persisting one to reuse across reopens could ever pay for itself.
 *
 * This is the Phase-0 GATE for a possible persistent scientific-analysis cache
 * that would keep the interval-independent TerrainCore (DTM + surface +
 * validation grids) and reuse it on reopen instead of recomputing it. The cache
 * is only worth building if a recompute is genuinely more expensive than reading
 * a persisted core back and integrity-verifying it. This benchmark measures the
 * recompute so that go/no-go rests on numbers, not an assumption — mirroring the
 * OOC rebuild-cost gate (tests/benchmark/oocRebuildCost.test.ts).
 *
 * WHAT IT MEASURES.
 *   1. Recompute: best-of-3 wall time for `computeTerrainCore` over deterministic
 *      synthetic terrain (a smooth height field + fixed-PRNG noise) at a size
 *      ladder. No external data file.
 *   2. Product size: the summed byteLength of the typed-array grids a cache would
 *      have to store (DTM z/confidence/coverage/counts/interpDistance + the
 *      surface relief slope/aspect/synthesised).
 *   3. Reuse-cost proxy: the cost to SHA-256 those bytes (the integrity-verify a
 *      persisted hit must pay) plus a read-time estimate from the byte size
 *      against a DOCUMENTED OPFS read-throughput assumption.
 *
 * WHAT IT CANNOT MEASURE. Real OPFS read latency and parse cost are browser-only
 * and are NOT measured here — the read term is an explicit throughput ASSUMPTION,
 * stated below and swept across a range so the break-even is a band, not a point.
 * This benchmark bounds the recompute side and gives an OPTIMISTIC lower bound on
 * the reuse side (hash + idealised sequential read only); a real reuse would also
 * pay deserialization, allocation and GPU-side costs, so if reuse does not win
 * here it cannot win in the browser.
 *
 * It runs a 100k/500k/1M ladder by default (the 1M row recomputes a core three
 * times, so a default run is not instant) and prints its table straight to
 * stdout — vitest buffers console.log away for passing tests. Override the
 * ladder with TERRAIN_CORE_BENCH_SIZES=100000,500000.
 *
 * READING THE PER-SIZE ROWS. The grid EXTENT is fixed (1000 m span / 2 m cell ≈
 * 500×500 cells) regardless of point count, so the ladder conflates two opposing
 * costs: SMRF work rises with points while geodesic void-fill FALLS as the grid
 * fills in. A sparse pairing (100k points onto a 2 m grid ≈ 0.1 pt/m²) therefore
 * does MORE fill work and can time slower than a denser one — real terrain-core
 * cost, not a measurement artefact. The GO/NO-GO rests on recompute dwarfing
 * reuse at every size, which holds regardless of that ordering.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { computeTerrainCore } from '../../src/terrain/contour/analyseContours';
import type { TerrainCore, TerrainCoreParams } from '../../src/terrain/contour/analyseContours';

/** Point-count ladder; override with TERRAIN_CORE_BENCH_SIZES=100000,500000,1000000. */
const SIZES = (process.env.TERRAIN_CORE_BENCH_SIZES ?? '100000,500000,1000000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/**
 * OPFS read-throughput assumption, in MB/s. OPFS sync-access-handle reads on a
 * warm SSD land roughly in this band across desktop browsers; there is no single
 * published number, so we STATE it as an assumption and sweep the break-even
 * across the whole range rather than pick one figure. Reads faster than this only
 * strengthen the case for the cache; slower only weakens it.
 */
const OPFS_READ_MBPS_LOW = 500; // conservative — near a spinning-disk-backed profile
const OPFS_READ_MBPS_HIGH = 1000; // optimistic — warm NVMe-backed OPFS

/** A deterministic terrain-like cloud: a smooth rolling surface plus small noise. */
function makeCloud(n: number): Float32Array {
  const xyz = new Float32Array(n * 3);
  let s = 123456789 >>> 0;
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const side = Math.ceil(Math.sqrt(n));
  const span = 1000;
  for (let i = 0; i < n; i++) {
    const gx = (i % side) / side;
    const gy = Math.floor(i / side) / side;
    xyz[i * 3] = gx * span + (rnd() - 0.5) * 0.5;
    xyz[i * 3 + 1] = gy * span + (rnd() - 0.5) * 0.5;
    xyz[i * 3 + 2] = 200 + 8 * Math.sin(gx * 12) * Math.cos(gy * 9) + (rnd() - 0.5) * 0.3;
  }
  return xyz;
}

/** Minimal valid params: a projected metre frame, cell size in source units. */
const PARAMS: TerrainCoreParams = {
  cellSizeM: 2,
  crs: 'EPSG:32610',
  verticalUnitToMetres: 1,
  horizontalUnitToMetres: 1,
};

/** The typed-array grids a persistent cache would have to store, in order. */
function coreGrids(core: TerrainCore): ReadonlyArray<ArrayBufferView> {
  return [
    core.dtm.z,
    core.dtm.confidence,
    core.dtm.coverage,
    core.dtm.counts,
    core.dtm.interpDistanceCells,
    core.surface.relief.slope,
    core.surface.relief.aspect,
    core.surface.relief.synthesised,
  ];
}

/** Concatenate the grid bytes exactly as a serializer would hand them to storage. */
function serialiseGrids(grids: ReadonlyArray<ArrayBufferView>): Uint8Array {
  const total = grids.reduce((n, g) => n + g.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const g of grids) {
    out.set(new Uint8Array(g.buffer, g.byteOffset, g.byteLength), o);
    o += g.byteLength;
  }
  return out;
}

/** Best-of-N wall time in ms for a body; returns every run for the spread. */
function bestOf(runs: number, body: () => void): number[] {
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    body();
    times.push(performance.now() - t0);
  }
  return times;
}

const pad = (s: string | number, w: number) => String(s).padStart(w);
// vitest buffers console.log away for a passing test, so write the table to stdout.
const print = (line: string) => process.stdout.write(line + '\n');

describe('TerrainCore recompute vs reuse (Phase-0 gate)', () => {
  it(
    'measures recompute cost and compares it to a persisted-reuse estimate',
    () => {
      print(`\nTerrainCore recompute vs reuse — cellSize=${PARAMS.cellSizeM} — sizes=${SIZES.join(',')}`);
      print(
        `  assumptions: OPFS read ${OPFS_READ_MBPS_LOW}-${OPFS_READ_MBPS_HIGH} MB/s (documented, swept); ` +
          `reuse = read_est + SHA-256(bytes); recompute best-of-3; reuse cost is an OPTIMISTIC lower bound`,
      );
      print(
        '  ' +
          [
            pad('points', 9),
            pad('recompute ms', 13),
            pad('product MB', 11),
            pad('hash ms', 8),
            pad('read ms(hi..lo)', 16),
            pad('reuse ms(hi..lo)', 17),
            pad('verdict', 9),
          ].join(' | '),
      );

      let anyWin = false;
      for (const n of SIZES) {
        const cloud = makeCloud(n);

        let core: TerrainCore | null = null;
        const recompute = bestOf(3, () => {
          core = computeTerrainCore(cloud, PARAMS);
        });
        expect(core, `core computed for ${n}`).not.toBeNull();
        const grids = coreGrids(core!);
        const bytes = serialiseGrids(grids);
        expect(bytes.byteLength, `product has bytes for ${n}`).toBeGreaterThan(0);

        const productMB = bytes.byteLength / 1e6;
        const hash = bestOf(3, () => {
          createHash('sha256').update(bytes).digest();
        });

        const recomputeMs = Math.min(...recompute);
        const hashMs = Math.min(...hash);
        // Read estimate from the documented throughput band.
        const readHiMs = (productMB / OPFS_READ_MBPS_HIGH) * 1000; // fast OPFS -> low read time
        const readLoMs = (productMB / OPFS_READ_MBPS_LOW) * 1000; // slow OPFS -> high read time
        const reuseHiMs = readHiMs + hashMs; // best case for the cache
        const reuseLoMs = readLoMs + hashMs; // worst case for the cache

        // Reuse "wins" only where recompute clearly exceeds even the WORST-case
        // reuse estimate (slow read). Marginal within the band = no clear win.
        const clearWin = recomputeMs > reuseLoMs * 1.5;
        const marginal = recomputeMs > reuseHiMs && !clearWin;
        anyWin = anyWin || clearWin;
        const verdict = clearWin ? 'REUSE' : marginal ? 'MARGINAL' : 'RECOMP';

        print(
          '  ' +
            [
              pad(n, 9),
              pad(recomputeMs.toFixed(1), 13),
              pad(productMB.toFixed(3), 11),
              pad(hashMs.toFixed(2), 8),
              pad(`${readHiMs.toFixed(2)}..${readLoMs.toFixed(2)}`, 16),
              pad(`${reuseHiMs.toFixed(2)}..${reuseLoMs.toFixed(2)}`, 17),
              pad(verdict, 9),
            ].join(' | '),
        );
      }

      print(
        `\n  GATE: ${anyWin ? 'GO (conditional)' : 'NO-GO'} — ` +
          (anyWin
            ? 'recompute clearly exceeds even worst-case reuse at one or more sizes; ' +
              'persisting the core could pay off. A browser measurement of real OPFS ' +
              'read + deserialization must confirm before any storage code is written.'
            : 'recompute is comparable to or cheaper than the optimistic reuse estimate ' +
              'at every measured size, so a persistent core cache is a net loss — do not build it.'),
      );

      // The gate is honest either way: the test asserts only that it produced
      // real, non-degenerate numbers, never that the cache is worthwhile.
      expect(SIZES.length).toBeGreaterThan(0);
    },
    600_000,
  );
});
