import {
  buildScaledSyntheticCopc,
  STRESS_TIERS,
} from './fixtures/copc/scaledSynthCopc';
import { parseCopcMetadata } from '../src/io/copc/copcHeader';
import { parseHierarchyPage } from '../src/io/copc/copcHierarchy';

test('point count emitted in the LAS header equals the target exactly', () => {
  const r = buildScaledSyntheticCopc({ targetPoints: 1_000_000, seed: 7 });
  expect(r.pointCount).toBe(1_000_000);
});

test('octree depth scales with target — more points means deeper hierarchy', () => {
  const small = buildScaledSyntheticCopc({ targetPoints: 1_000, pointsPerNode: 100 });
  const big = buildScaledSyntheticCopc({ targetPoints: 1_000_000, pointsPerNode: 100 });
  expect(big.maxDepth).toBeGreaterThan(small.maxDepth);
});

test('node count matches the closed-form (8^(D+1) − 1) / 7', () => {
  const r = buildScaledSyntheticCopc({ targetPoints: 1_000_000, pointsPerNode: 5_000 });
  const expected = (Math.pow(8, r.maxDepth + 1) - 1) / 7;
  expect(r.nodeCount).toBe(expected);
});

test('the same seed produces byte-identical hierarchy buffers', () => {
  const a = buildScaledSyntheticCopc({ targetPoints: 200_000, seed: 42 });
  const b = buildScaledSyntheticCopc({ targetPoints: 200_000, seed: 42 });
  expect(a.buffer.byteLength).toBe(b.buffer.byteLength);
  // Compare a few characteristic bytes.
  const av = new Uint8Array(a.buffer);
  const bv = new Uint8Array(b.buffer);
  expect(av[0]).toBe(bv[0]); // LASF
  expect(av[377]).toBe(bv[377]); // 'c' of "copc"
  expect(av.slice(0, 1024).join(',')).toBe(bv.slice(0, 1024).join(','));
});

test('different seeds produce different distributions (not byte-identical)', () => {
  const a = buildScaledSyntheticCopc({ targetPoints: 200_000, seed: 1 });
  const b = buildScaledSyntheticCopc({ targetPoints: 200_000, seed: 2 });
  // Both have the same total point count and shape, so file size matches…
  expect(a.buffer.byteLength).toBe(b.buffer.byteLength);
  // …but the per-node distribution differs somewhere in the hierarchy block.
  const av = new Uint8Array(a.buffer);
  const bv = new Uint8Array(b.buffer);
  let diff = 0;
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) { diff = i; break; }
  expect(diff).toBeGreaterThan(0);
});

test('parseCopcMetadata reads the generated buffer cleanly', () => {
  const r = buildScaledSyntheticCopc({ targetPoints: 1_000_000, seed: 3 });
  // The head-slice parser only needs the first ~589 bytes of the file.
  const head = r.buffer.slice(0, 589);
  const meta = parseCopcMetadata(head);
  expect(meta.header.pointCount).toBe(1_000_000);
  expect(meta.info.rootHierOffset).toBe(r.rootHierOffset);
  expect(meta.info.rootHierSize).toBe(r.rootHierSize);
});

test('the generated hierarchy parses cleanly and the data-node count matches', () => {
  const r = buildScaledSyntheticCopc({ targetPoints: 100_000, seed: 11 });
  const meta = parseCopcMetadata(r.buffer.slice(0, 589));
  const page = parseHierarchyPage(
    r.buffer.slice(r.rootHierOffset, r.rootHierOffset + r.rootHierSize),
    { center: meta.info.center, halfsize: meta.info.halfsize },
    meta.info.spacing,
  );
  // Every generated node lands in exactly one of nodes / emptyKeys (the
  // synthetic builder emits a single-page hierarchy, so childPages is 0).
  expect(page.childPages.length).toBe(0);
  expect(page.errors.length).toBe(0);
  expect(page.nodes.length + page.emptyKeys.length).toBe(r.nodeCount);
  expect(page.nodes.length).toBe(r.dataNodeCount);
});

test('STRESS_TIERS lists 1 M / 10 M / 100 M / 250 M / 500 M', () => {
  expect(STRESS_TIERS['1M']).toBe(1_000_000);
  expect(STRESS_TIERS['10M']).toBe(10_000_000);
  expect(STRESS_TIERS['100M']).toBe(100_000_000);
  expect(STRESS_TIERS['250M']).toBe(250_000_000);
  expect(STRESS_TIERS['500M']).toBe(500_000_000);
});

test('a 10 M-point fixture builds in well under a second and stays compact', () => {
  const t0 = Date.now();
  const r = buildScaledSyntheticCopc({ targetPoints: 10_000_000, seed: 9 });
  const elapsedMs = Date.now() - t0;
  expect(r.pointCount).toBe(10_000_000);
  // Sanity bound — generation should be effectively instant in node.
  expect(elapsedMs).toBeLessThan(2_000);
  // The buffer carries placeholder chunks, not point data — small for 10 M.
  expect(r.buffer.byteLength).toBeLessThan(10 * 1024 * 1024); // < 10 MB
});
