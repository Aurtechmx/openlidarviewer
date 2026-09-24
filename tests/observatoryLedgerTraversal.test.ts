/**
 * observatoryLedgerTraversal.test.ts — OB-LED-01..05 (docs/observatory/SPEC.md
 * §5.2, phase O4). F8 (against the frozen Python oracle), F9 (chunk order and
 * partition count) and the budget-refusal test, phase O4's exit evidence.
 *
 * F9's worker-count axis is read as in-process PARTITION count (1, 2, 5), per
 * the maintainer's 2026-09-23 decision recorded in
 * `docs/observatory/methods.md`'s `olv.observation.ledger` Determinism
 * paragraph: no Web Worker exists yet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AcquisitionStation } from '../src/model/AcquisitionStations';
import { buildF1Scene } from '../scripts/generate-observatory-fixtures.mjs';
import type { ObservationRayChunk, ObservationReturnTable } from '../src/observation/rays';
import { isSourcePresent } from '../src/observation/types';
import {
  checkVoxelDomainBudget,
  clipRayToDomain,
  computeFieldDigest,
  domainGrid,
  ledgerBuilderWorstCaseBytesPerVoxel,
  measureLedgerBuilderBytesPerVoxel,
  mergePartialLedgers,
  mergeRejectionTelemetry,
  packVoxelKey,
  unpackVoxelKey,
  runObservationLedger,
  traverseRayChunks,
  traverseVoxels,
  type ObservationDomain,
  type PartialLedger,
  type RayPartitionChunkEntry,
  type RayPartitionInput,
} from '../src/observation/ledger';

const ROOT = join(__dirname, '..');
const F8_EXPECTED_PATH = join(ROOT, 'validation', 'observatory', 'expected', 'f8-dda-cases.expected.json');

interface F8ExpectedRecord {
  readonly caseId: string;
  readonly input: {
    readonly origin: readonly number[];
    readonly direction: readonly number[];
    readonly tMax: number;
    readonly domain: { readonly minCorner: readonly number[]; readonly maxCorner: readonly number[] };
    readonly voxelEdge: number;
  };
  readonly clip: readonly [string, string] | null;
  readonly voxels: readonly (readonly number[])[];
}

// ---------------------------------------------------------------------------
// domain / grid / key-packing unit checks
// ---------------------------------------------------------------------------

describe('OB-LED-03 — domainGrid / packVoxelKey', () => {
  it('grid size is the ceiling of extent over voxel edge, per axis', () => {
    const domain: ObservationDomain = { min: [0, 0, 0], max: [4, 4, 4] };
    expect(domainGrid(domain, 1)).toEqual({ nx: 4, ny: 4, nz: 4 });
    expect(domainGrid(domain, 0.5)).toEqual({ nx: 8, ny: 8, nz: 8 });
    // Extent not an exact multiple of the edge still ceilings up.
    expect(domainGrid({ min: [0, 0, 0], max: [1, 1, 1] }, 0.3)).toEqual({ nx: 4, ny: 4, nz: 4 });
  });

  it('refuses a degenerate domain or edge (F17-style)', () => {
    expect(() => domainGrid({ min: [0, 0, 0], max: [4, 4, 4] }, 0)).toThrow();
    expect(() => domainGrid({ min: [0, 0, 0], max: [4, 4, 4] }, -1)).toThrow();
    expect(() => domainGrid({ min: [4, 0, 0], max: [4, 4, 4] }, 1)).toThrow(); // min === max on x
    expect(() => domainGrid({ min: [5, 0, 0], max: [4, 4, 4] }, 1)).toThrow(); // inverted x
    expect(() => domainGrid({ min: [Number.NaN, 0, 0], max: [4, 4, 4] }, 1)).toThrow();
  });

  it('packVoxelKey is a plain row-major flat index, distinct for every in-grid voxel', () => {
    const { nx, ny } = domainGrid({ min: [0, 0, 0], max: [3, 3, 3] }, 1);
    const seen = new Set<number>();
    for (let iz = 0; iz < 3; iz++) {
      for (let iy = 0; iy < 3; iy++) {
        for (let ix = 0; ix < 3; ix++) {
          const key = packVoxelKey(ix, iy, iz, nx, ny);
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
    expect(seen.size).toBe(27);
  });
});

// ---------------------------------------------------------------------------
// F8 — the TypeScript DDA against the frozen Python oracle
// ---------------------------------------------------------------------------

describe('F8 — traverseVoxels matches validation/observatory/oracle/ray_aabb_traversal.py (OB-LED-01/02)', () => {
  const expected = JSON.parse(readFileSync(F8_EXPECTED_PATH, 'utf8')) as { cases: F8ExpectedRecord[] };

  it.each(expected.cases)('$caseId: clip + traverse reproduces the frozen voxel list exactly', (record) => {
    const domain: ObservationDomain = { min: [...record.input.domain.minCorner] as [number, number, number], max: [...record.input.domain.maxCorner] as [number, number, number] };
    const origin = [...record.input.origin] as [number, number, number];
    const direction = [...record.input.direction] as [number, number, number];

    const clip = clipRayToDomain(origin, direction, 0, record.input.tMax, domain);
    if (record.clip === null) {
      expect(clip).toBeNull();
      expect(record.voxels).toEqual([]);
      return;
    }
    expect(clip).not.toBeNull();
    // The oracle's clip bounds are exact rationals ("5/2"); every F8 fixture
    // coordinate is a dyadic rational, so Float64 arithmetic on them is exact
    // and a direct numeric comparison needs no tolerance (would not
    // generalize to arbitrary coordinates — see this file's own F8 fixture).
    const [expectedEntry, expectedExit] = record.clip.map(parseRationalToNumber);
    expect(clip!.tEntry).toBe(expectedEntry);
    expect(clip!.tExit).toBe(expectedExit);

    const voxels = traverseVoxels(origin, direction, clip!.tEntry, clip!.tExit, domain, record.input.voxelEdge);
    expect(voxels.map((v) => [v.ix, v.iy, v.iz])).toEqual(record.voxels.map((v) => [...v]));
  });
});

/** "5/2" -> 2.5, "0" -> 0 — the oracle's exact-rational clip bounds, on this fixture's dyadic-rational inputs only. */
function parseRationalToNumber(s: string): number {
  const [num, den] = s.split('/');
  return den === undefined ? Number(num) : Number(num) / Number(den);
}

// ---------------------------------------------------------------------------
// F9 — chunk order and partition count (the maintainer's resolved reading)
// ---------------------------------------------------------------------------

function f1Station(scene: ReturnType<typeof buildF1Scene>): AcquisitionStation {
  return {
    id: scene.station.id,
    source: 'ptx-block',
    pose: { worldTranslation: [...scene.station.origin] as [number, number, number], localPositionSource: 'not-applicable' },
    recordRange: { start: 0, end: 0 },
    originStatus: 'DECLARED',
  };
}

/**
 * A small, deterministic ray set built directly from F1's own declared wall
 * box: a fixed azimuth x elevation grid within F1's `angularExtent`, each ray
 * either striking the wall (finite range, from `clipRayToDomain` against the
 * wall's own AABB — the wall's own nearest-face intersection distance) or
 * clearing it with no return (`NaN`). Deliberately small (well under
 * `RAY_CHUNK_SIZE`): F9 tests the merge's order-independence, not chunking.
 */
function buildF9RaySet(scene: ReturnType<typeof buildF1Scene>): { readonly dx: number; readonly dy: number; readonly dz: number; readonly range: number }[] {
  const azimuthsDeg = [0, 8, -8, 16, -16, 90, 180, -170];
  const elevationsDeg = [5, 15, 25];
  const wallDomain: ObservationDomain = { min: [...scene.wall.minCorner] as [number, number, number], max: [...scene.wall.maxCorner] as [number, number, number] };
  const origin: [number, number, number] = [0, 0, 0];

  const rays: { dx: number; dy: number; dz: number; range: number }[] = [];
  for (const azDeg of azimuthsDeg) {
    for (const elDeg of elevationsDeg) {
      const az = (azDeg * Math.PI) / 180;
      const el = (elDeg * Math.PI) / 180;
      const dx = Math.cos(el) * Math.cos(az);
      const dy = Math.cos(el) * Math.sin(az);
      const dz = Math.sin(el);
      const wallClip = clipRayToDomain(origin, [dx, dy, dz], 0, Infinity, wallDomain);
      const range = wallClip !== null && wallClip.tEntry > 0 ? wallClip.tEntry : Number.NaN;
      rays.push({ dx, dy, dz, range });
    }
  }
  return rays;
}

/** Packs a ray group into one bounded `ObservationRayChunk` (OB-RAY-04 shape; small, test-scoped, well under RAY_CHUNK_SIZE). */
function packChunk(rays: readonly { readonly dx: number; readonly dy: number; readonly dz: number; readonly range: number }[]): ObservationRayChunk {
  const n = rays.length;
  const originIndex = new Uint16Array(n);
  const direction = new Float32Array(n * 3);
  const range = new Float32Array(n);
  const returnOffset = new Uint32Array(n);
  rays.forEach((r, k) => {
    direction[k * 3] = r.dx;
    direction[k * 3 + 1] = r.dy;
    direction[k * 3 + 2] = r.dz;
    range[k] = r.range;
  });
  return { originIndex, direction, range, returnOffset };
}

/** Groups a flat ray list into `chunkCount` roughly-even bounded chunks — the deterministic ray-chunk list F9 permutes and re-partitions. */
function buildF9Chunks(rays: readonly { readonly dx: number; readonly dy: number; readonly dz: number; readonly range: number }[], chunkCount: number): ObservationRayChunk[] {
  const chunks: ObservationRayChunk[] = [];
  const perChunk = Math.ceil(rays.length / chunkCount);
  for (let i = 0; i < rays.length; i += perChunk) {
    chunks.push(packChunk(rays.slice(i, i + perChunk)));
  }
  return chunks;
}

/** Splits a chunk LIST into `partitionCount` contiguous groups, at whole-chunk granularity (never mid-chunk). */
function splitIntoPartitions<T>(items: readonly T[], partitionCount: number): T[][] {
  const groups: T[][] = Array.from({ length: partitionCount }, () => []);
  const perGroup = Math.ceil(items.length / partitionCount);
  items.forEach((item, i) => {
    const g = Math.min(Math.floor(i / perGroup), partitionCount - 1);
    groups[g].push(item);
  });
  return groups;
}

describe('F9 — mergePartialLedgers is order-independent under chunk-order permutation and partition count', () => {
  const scene = buildF1Scene();
  const domain: ObservationDomain = { min: [...scene.domain.minCorner] as [number, number, number], max: [...scene.domain.maxCorner] as [number, number, number] };
  const stations = [f1Station(scene)];
  const rays = buildF9RaySet(scene);
  // Sanity: the synthetic scene actually exercises both counters F9 needs to
  // merge across a boundary (a wall hit AND a no-return miss).
  const finiteCount = rays.filter((r) => Number.isFinite(r.range)).length;
  const noReturnCount = rays.filter((r) => Number.isNaN(r.range)).length;

  it('the synthetic ray set has both a finite-range hit and a no-return ray (sanity, not itself an F9 assertion)', () => {
    expect(finiteCount).toBeGreaterThan(0);
    expect(noReturnCount).toBeGreaterThan(0);
  });

  // tau_abs = h/2, tau_rel = tan(angularStep/2), preregistered formulas
  // (validation/protocols/observatory/OB-ST-THRESHOLDS.protocol.json).
  const tauAbs = scene.voxelEdge / 2;
  const angularStepRad = (1 * Math.PI) / 180; // an arbitrary small declared angular step for this synthetic source
  const tauRel = Math.tan(angularStepRad / 2);

  const chunks = buildF9Chunks(rays, 5);
  expect(chunks.length).toBe(5);

  function partitionInputFor(chunkGroup: readonly ObservationRayChunk[]): RayPartitionInput {
    const returnedChunks: RayPartitionChunkEntry[] = chunkGroup.map((chunk) => ({ sourceIndex: 0, chunk, tauAbs, tauRel }));
    return { domain, voxelEdge: scene.voxelEdge, stations, returnedChunks, notReadChunks: [] };
  }

  const fullInput = partitionInputFor(chunks);

  it('chunk order permuted at a fixed partition count (2): merging the same partials in reversed order gives the identical fieldDigest', () => {
    const groups = splitIntoPartitions(chunks, 2);
    const partials: PartialLedger[] = groups.map((g) => traverseRayChunks(partitionInputFor(g)));

    const forwardRows = mergePartialLedgers(partials);
    const reversedRows = mergePartialLedgers([...partials].reverse());

    const digestForward = computeFieldDigest(fullInput, forwardRows);
    const digestReversed = computeFieldDigest(fullInput, reversedRows);
    expect(digestForward).toBe(digestReversed);
    // Not vacuous: the run actually produced occupied voxels.
    expect(forwardRows.length).toBeGreaterThan(0);
  });

  it('partition count varied (1, 2, 5) over the SAME ray-chunk list gives the identical fieldDigest', () => {
    const digestFor = (partitionCount: number): string => {
      const groups = splitIntoPartitions(chunks, partitionCount);
      const partials = groups.filter((g) => g.length > 0).map((g) => traverseRayChunks(partitionInputFor(g)));
      const rows = mergePartialLedgers(partials);
      return computeFieldDigest(fullInput, rows);
    };

    const digest1 = digestFor(1);
    const digest2 = digestFor(2);
    const digest5 = digestFor(5);

    expect(digest1).toBe(digest2);
    expect(digest1).toBe(digest5);
  });

  it('a single-partition run goes through mergePartialLedgers too (a no-op merge over one input), not a separate code path', () => {
    const onePartial = traverseRayChunks(fullInput);
    const merged = mergePartialLedgers([onePartial]);
    expect(merged.length).toBe(onePartial.rows.length);
    // Every row's counters are unchanged by the no-op merge.
    const byKey = new Map(onePartial.rows.map((r) => [r.key, r]));
    for (const row of merged) {
      const original = byKey.get(row.key)!;
      expect(row.counters).toEqual(original.counters);
    }
  });

  it('some voxel actually accumulated a hit and some voxel accumulated a noReturn (the merge is exercising real, distinguishable evidence, not two empty tables)', () => {
    const partial = traverseRayChunks(fullInput);
    const merged = mergePartialLedgers([partial]);
    expect(merged.some((r) => r.counters.hit > 0)).toBe(true);
    expect(merged.some((r) => r.counters.noReturn > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Budget refusal (OB-LED-03/04) — no O4 F-number; its own dedicated evidence.
// ---------------------------------------------------------------------------

describe('OB-LED-03 — checkVoxelDomainBudget refuses before any allocation', () => {
  const domain: ObservationDomain = { min: [0, 0, 0], max: [100, 100, 100] };

  it('a small, well-within-budget domain reads ready', () => {
    const result = checkVoxelDomainBudget(domain, 10); // 10x10x10 = 1000 cells
    expect(result.verdict).toBe('ready');
    expect(result.cellCount).toBe(1000);
  });

  it('a domain whose cell count exceeds the hard ceiling reads blocked', () => {
    const result = checkVoxelDomainBudget(domain, 0.01, { hardMaxCells: 1000 }); // 100/0.01=10000 per axis -> 1e12 cells
    expect(result.verdict).toBe('blocked');
  });

  it('a domain over the soft ceiling but under the hard one reads coarsen', () => {
    const result = checkVoxelDomainBudget(domain, 1, { softMaxCells: 500_000, hardMaxCells: 2_000_000 }); // 100^3 = 1,000,000
    expect(result.verdict).toBe('coarsen');
  });

  it('is a pure function of domain and voxelEdge alone — no ray data needed to check it', () => {
    const a = checkVoxelDomainBudget(domain, 5);
    const b = checkVoxelDomainBudget(domain, 5);
    expect(a).toEqual(b);
  });
});

describe('OB-LED-03/04 — runObservationLedger refuses before traversal, per an explicit user choice', () => {
  const scene = buildF1Scene();
  const domain: ObservationDomain = { min: [...scene.domain.minCorner] as [number, number, number], max: [...scene.domain.maxCorner] as [number, number, number] };
  const stations = [f1Station(scene)];
  const rays = buildF9RaySet(scene);
  const tauAbs = scene.voxelEdge / 2;
  const tauRel = Math.tan(((1 * Math.PI) / 180) / 2);
  const chunk = packChunk(rays);
  const input: RayPartitionInput = {
    domain,
    voxelEdge: scene.voxelEdge,
    stations,
    returnedChunks: [{ sourceIndex: 0, chunk, tauAbs, tauRel }],
    notReadChunks: [],
  };

  it('a voxel budget that BLOCKS refuses with reason voxel-budget, and never reaches the step-budget or traversal', () => {
    const result = runObservationLedger(input, { declaredStepBudget: 1_000_000, voxelBudget: { hardMaxCells: 10 } });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toBe('voxel-budget');
      expect(result.voxelBudget?.verdict).toBe('blocked');
      expect(result.stepBudget).toBeUndefined();
      expect(result.suggestions.length).toBeGreaterThan(0);
    }
  });

  it('a voxel budget that only COARSENS refuses by default, but proceeds under an explicit allowOverBudget', () => {
    const refused = runObservationLedger(input, { declaredStepBudget: 1_000_000, voxelBudget: { softMaxCells: 10, hardMaxCells: 1_000_000_000 } });
    expect(refused.status).toBe('refused');
    if (refused.status === 'refused') expect(refused.voxelBudget?.verdict).toBe('coarsen');

    const allowed = runObservationLedger(input, {
      declaredStepBudget: 1_000_000,
      voxelBudget: { softMaxCells: 10, hardMaxCells: 1_000_000_000 },
      allowOverBudget: true,
    });
    expect(allowed.status).toBe('ok');
  });

  it('an over-estimate step budget refuses with reason step-budget when the voxel budget itself is ready', () => {
    const result = runObservationLedger(input, { declaredStepBudget: 0 });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toBe('step-budget');
      expect(result.voxelBudget).toBeUndefined();
      expect(result.stepBudget?.withinBudget).toBe(false);
    }
  });

  it('within both budgets, the run completes with rows and a fieldDigest', () => {
    const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.fieldDigest).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC §2.4 rule 1 — not-read rays (accumulateNotReadRay), driven end-to-end
// through traverseRayChunks: no test in this phase exercised notReadChunks
// before this addition.
// ---------------------------------------------------------------------------

describe('SPEC §2.4 rule 1 — a not-read ray adds presence and notDecoded but bumps no counter', () => {
  // origin (0,0,0), direction +x, a domain spanning x in [0,10] with y/z margin
  // either side of 0: the ray crosses exactly ten 1-unit voxels at iy=1, iz=1
  // (floor((0 - (-1)) / 1) = 1 on both axes), ix = 0..9.
  const domain: ObservationDomain = { min: [0, -1, -1], max: [10, 1, 1] };
  const voxelEdge = 1;
  const station: AcquisitionStation = {
    id: 'not-read-station',
    source: 'ptx-block',
    pose: { worldTranslation: [0, 0, 0], localPositionSource: 'not-applicable' },
    recordRange: { start: 0, end: 0 },
    originStatus: 'DECLARED',
  };

  it('every touched voxel gets presence + notDecoded and all-zero counters, for both the aggregate row and the per-source entry', () => {
    const chunk: ObservationRayChunk = {
      originIndex: new Uint16Array([0]),
      direction: new Float32Array([1, 0, 0]),
      range: new Float32Array([Number.NaN]),
      returnOffset: new Uint32Array([0]),
    };
    const input: RayPartitionInput = { domain, voxelEdge, stations: [station], returnedChunks: [], notReadChunks: [{ sourceIndex: 0, chunk }] };

    const partial = traverseRayChunks(input);
    expect(partial.rows.length).toBe(10);
    for (const row of partial.rows) {
      expect(row.counters).toEqual({ hit: 0, pass: 0, behind: 0, noReturn: 0, saturated: false });
      expect(isSourcePresent(row.presence, 0)).toBe(true);
      expect(row.perSource.length).toBe(1);
      expect(row.perSource[0].notDecoded).toBe(true);
      expect(row.perSource[0]).toMatchObject({ hit: 0, pass: 0, behind: 0, noReturn: 0, saturated: false });
    }
  });
});

// ---------------------------------------------------------------------------
// OB-RAY-03 multi-return continuity, driven through traverseRayChunks with a
// populated returnTable/returnCounts (no test in this phase exercised this
// path before this addition): hit for the first, a middle, and the last
// return's own window, pass before the first, behind after the last, and — the
// case this test exists for — a voxel strictly between two returns' windows
// gets NO row at all (no counter, no presence), a deliberate reading recorded
// on accumulateReturnedRay's own doc comment.
// ---------------------------------------------------------------------------

describe('OB-RAY-03 — multi-return hit/pass/behind/gap classification (returnTable, three returns)', () => {
  const domain: ObservationDomain = { min: [0, -1, -1], max: [10, 1, 1] };
  const voxelEdge = 1;
  const station: AcquisitionStation = {
    id: 'multi-return-station',
    source: 'ptx-block',
    pose: { worldTranslation: [0, 0, 0], localPositionSource: 'not-applicable' },
    recordRange: { start: 0, end: 0 },
    originStatus: 'DECLARED',
  };

  it('classifies each of the ten crossed voxels correctly, including the two gap voxels between windows', () => {
    // Three returns at r = 2, 5, 8 with tauAbs = 0.4, tauRel = 0 (a fixed
    // +-0.4 window regardless of range, for an easily hand-checked layout):
    // windows [1.6,2.4], [4.6,5.4], [7.6,8.4] over ten 1-unit voxels (ix 0..9,
    // tEnter/tLeave = [ix, ix+1]).
    const returnTable: ObservationReturnTable = {
      range: new Float32Array([2, 5, 8]),
      countByRay: new Uint16Array([3]),
    };
    const chunk: ObservationRayChunk = {
      originIndex: new Uint16Array([0]),
      direction: new Float32Array([1, 0, 0]),
      range: new Float32Array([2]), // the first return's range; unused once returnCounts[k] > 0
      returnOffset: new Uint32Array([0]),
    };
    const entry: RayPartitionChunkEntry = { sourceIndex: 0, chunk, tauAbs: 0.4, tauRel: 0, returnTable, returnCounts: new Uint16Array([3]) };
    const input: RayPartitionInput = { domain, voxelEdge, stations: [station], returnedChunks: [entry], notReadChunks: [] };

    const partial = traverseRayChunks(input);
    const grid = domainGrid(domain, voxelEdge);
    const rowsByKey = new Map(partial.rows.map((r) => [r.key, r]));
    const rowAt = (ix: number) => rowsByKey.get(packVoxelKey(ix, 1, 1, grid.nx, grid.ny));

    expect(partial.rows.length).toBe(8); // ten crossed voxels minus the two gap voxels (ix 3 and 6)

    expect(rowAt(0)?.counters).toMatchObject({ pass: 1, hit: 0, behind: 0 });
    expect(rowAt(1)?.counters).toMatchObject({ hit: 1, pass: 0, behind: 0 }); // first return's window
    expect(rowAt(2)?.counters).toMatchObject({ hit: 1, pass: 0, behind: 0 }); // first return's window
    expect(rowAt(3)).toBeUndefined(); // gap: strictly between the first and middle window
    expect(rowAt(4)?.counters).toMatchObject({ hit: 1, pass: 0, behind: 0 }); // middle return's own window (non-first, non-last)
    expect(rowAt(5)?.counters).toMatchObject({ hit: 1, pass: 0, behind: 0 }); // middle return's own window
    expect(rowAt(6)).toBeUndefined(); // gap: strictly between the middle and last window
    expect(rowAt(7)?.counters).toMatchObject({ hit: 1, pass: 0, behind: 0 }); // last return's window
    expect(rowAt(8)?.counters).toMatchObject({ hit: 1, pass: 0, behind: 0 }); // last return's window
    expect(rowAt(9)?.counters).toMatchObject({ behind: 1, hit: 0, pass: 0 });

    // Presence follows the same rule as the counters: set wherever a row exists, absent where it doesn't.
    for (const ix of [0, 1, 2, 4, 5, 7, 8, 9]) expect(isSourcePresent(rowAt(ix)!.presence, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OB-LED-02 — rejection-ratio telemetry (no test in this phase covered it
// before this addition, since the field did not exist).
// ---------------------------------------------------------------------------

describe('OB-LED-02 — rejection-ratio telemetry', () => {
  const domain: ObservationDomain = { min: [0, -1, -1], max: [10, 1, 1] };
  const voxelEdge = 1;
  const station: AcquisitionStation = {
    id: 'telemetry-station',
    source: 'ptx-block',
    pose: { worldTranslation: [0, 0, 0], localPositionSource: 'not-applicable' },
    recordRange: { start: 0, end: 0 },
    originStatus: 'DECLARED',
  };
  // ray 0: a valid direction, crosses the domain (processed). ray 1: a
  // degenerate (zero-length) direction, rejected before any voxel step.
  const chunk: ObservationRayChunk = {
    originIndex: new Uint16Array([0, 0]),
    direction: new Float32Array([1, 0, 0, 0, 0, 0]),
    range: new Float32Array([Number.NaN, Number.NaN]),
    returnOffset: new Uint32Array([0, 0]),
  };
  const input: RayPartitionInput = {
    domain,
    voxelEdge,
    stations: [station],
    returnedChunks: [{ sourceIndex: 0, chunk, tauAbs: 0.4, tauRel: 0 }],
    notReadChunks: [],
  };

  it('traverseRayChunks tallies one rejected ray out of two', () => {
    const partial = traverseRayChunks(input);
    expect(partial.telemetry).toEqual({ totalRays: 2, rejectedRays: 1 });
  });

  it('mergeRejectionTelemetry sums plain integers across partitions, regardless of order', () => {
    const a = traverseRayChunks(input);
    const b = traverseRayChunks(input);
    const forward = mergeRejectionTelemetry([a, b]);
    const reversed = mergeRejectionTelemetry([b, a]);
    expect(forward).toEqual({ totalRays: 4, rejectedRays: 2 });
    expect(reversed).toEqual(forward);
  });

  it('runObservationLedger exposes the same ratio on its ok result', () => {
    const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.rejectionRatio).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// types.ts COUNTER_SATURATION_MAX — bump() sets `saturated` only on a
// REFUSED increment (a counter already at the ceiling), not on the increment
// that lands exactly on it. No test in this phase exercised the exact
// boundary before this addition.
// ---------------------------------------------------------------------------

describe('types.ts COUNTER_SATURATION_MAX — the exact saturation boundary', () => {
  // A domain that is exactly one voxel, (0,0,0); a station placed so its ray
  // crosses that single voxel and nothing else, so every ray bumps `noReturn`
  // exactly once.
  const domain: ObservationDomain = { min: [0, 0, 0], max: [1, 1, 1] };
  const voxelEdge = 1;
  const station: AcquisitionStation = {
    id: 'saturation-station',
    source: 'ptx-block',
    pose: { worldTranslation: [-1, 0.5, 0.5], localPositionSource: 'not-applicable' },
    recordRange: { start: 0, end: 0 },
    originStatus: 'DECLARED',
  };

  function runIdenticalNoReturnRays(n: number): PartialLedger {
    const originIndex = new Uint16Array(n);
    const direction = new Float32Array(n * 3);
    const range = new Float32Array(n).fill(Number.NaN);
    const returnOffset = new Uint32Array(n);
    for (let k = 0; k < n; k++) direction[k * 3] = 1; // +x, straight through the one voxel
    const chunk: ObservationRayChunk = { originIndex, direction, range, returnOffset };
    const input: RayPartitionInput = {
      domain,
      voxelEdge,
      stations: [station],
      returnedChunks: [{ sourceIndex: 0, chunk, tauAbs: 0.1, tauRel: 0 }],
      notReadChunks: [],
    };
    return traverseRayChunks(input);
  }

  it('65,535 identical rays: an exact, lossless Uint16 value, not saturated', () => {
    const partial = runIdenticalNoReturnRays(65535);
    expect(partial.rows.length).toBe(1);
    expect(partial.rows[0].counters).toEqual({ hit: 0, pass: 0, behind: 0, noReturn: 65535, saturated: false });
    expect(partial.rows[0].perSource[0]).toMatchObject({ noReturn: 65535, saturated: false });
  });

  it('65,536 identical rays: the 65,536th is refused, the counter stays capped at 65,535, saturated true', () => {
    const partial = runIdenticalNoReturnRays(65536);
    expect(partial.rows.length).toBe(1);
    expect(partial.rows[0].counters).toEqual({ hit: 0, pass: 0, behind: 0, noReturn: 65535, saturated: true });
    expect(partial.rows[0].perSource[0]).toMatchObject({ noReturn: 65535, saturated: true });
  });
});

// ---------------------------------------------------------------------------
// OB-LED-03 — LedgerBuilder's measured bytes/voxel (the typed-array
// open-addressing table replacing the retired Map-keyed builder; see this
// module's header and docs/observatory/methods.md for the full account).
// ---------------------------------------------------------------------------

describe('OB-LED-03 — LedgerBuilder measured bytes/voxel never exceeds the analytic worst case', () => {
  // Occupancies straddling at least two doubling boundaries (capacity starts
  // at 1024 and doubles: 1024, 2048, 4096, 8192, ...): one point mid-cycle
  // and one point right after each doubling, where the worst case actually
  // sits (this module's header explains why). A single favourable sample
  // (e.g. 1.5M, deep into a cycle) under-measures the true worst case.
  const occupancies = [1000, 4096, 4097, 8193, 65_537, 2_097_153];
  const sourceCounts = [1, 4, 16];

  it.each(sourceCounts.flatMap((sourceCount) => occupancies.map((occupied) => ({ sourceCount, occupied }))))(
    'sourceCount=$sourceCount, occupied=$occupied: measured bytes/voxel never exceeds ledgerBuilderWorstCaseBytesPerVoxel',
    ({ sourceCount, occupied }) => {
      const measured = measureLedgerBuilderBytesPerVoxel(occupied, sourceCount);
      const analytic = ledgerBuilderWorstCaseBytesPerVoxel(sourceCount);
      expect(measured).toBeGreaterThan(0);
      expect(measured).toBeLessThanOrEqual(analytic);
    },
  );

  it('the analytic formula matches the measured worst case (just after a doubling) at 1 and 4 sources', () => {
    // capacity 4096, occupied 2049 = 4096/2 + 1: the exact just-after-doubling point.
    expect(ledgerBuilderWorstCaseBytesPerVoxel(1)).toBe(110);
    expect(measureLedgerBuilderBytesPerVoxel(2049, 1)).toBeCloseTo(110, 0);
    expect(ledgerBuilderWorstCaseBytesPerVoxel(4)).toBe(170);
    expect(measureLedgerBuilderBytesPerVoxel(2049, 4)).toBeCloseTo(170, 0);
  });

  it('per-source columns scale the estimate linearly with sourceCount, so more sources are never underestimated', () => {
    expect(ledgerBuilderWorstCaseBytesPerVoxel(16)).toBeGreaterThan(ledgerBuilderWorstCaseBytesPerVoxel(4));
    expect(ledgerBuilderWorstCaseBytesPerVoxel(4)).toBeGreaterThan(ledgerBuilderWorstCaseBytesPerVoxel(1));
  });

  it('an order of magnitude below the retired Map-keyed builder\'s measured 650-990 B/voxel range, even at the analytic worst case', () => {
    expect(ledgerBuilderWorstCaseBytesPerVoxel(4)).toBeLessThan(650);
  });
});

// ---------------------------------------------------------------------------
// OB-LED-03 — a large domain the retired Map-keyed builder's own scaled-down
// ceilings (187,500 soft / 3,000,000 hard, at 1024 B/voxel) refused, but the
// typed-array table's restored, analytic, per-sourceCount ceilings accept —
// direct evidence the restoration is real, not just a constant edit, and
// that the memory envelope (not a fixed cell count) is what is held fixed.
// ---------------------------------------------------------------------------

describe('OB-LED-03 — a large domain: refused under the retired Map-era budget, accepted under the restored one', () => {
  // 80^3 = 512,000 cells: over the retired builder's own 187,500-cell soft
  // ceiling (so it would have refused by default without an explicit
  // allowOverBudget), but under the typed-array table's restored,
  // single-source soft ceiling (1,744,449 cells at 110 B/voxel).
  const domain: ObservationDomain = { min: [0, 0, 0], max: [80, 80, 80] };
  const voxelEdge = 1;

  it('was refused (coarsen) under the retired Map-era defaults (187,500 soft / 3,000,000 hard @ 1024 B/voxel)', () => {
    const result = checkVoxelDomainBudget(domain, voxelEdge, { bytesPerVoxel: 1024, softMaxCells: 187_500, hardMaxCells: 3_000_000 });
    expect(result.cellCount).toBe(512_000);
    expect(result.verdict).toBe('coarsen');
  });

  it('reads ready under the restored, analytic single-source default, with no override needed', () => {
    const result = checkVoxelDomainBudget(domain, voxelEdge);
    expect(result.cellCount).toBe(512_000);
    expect(result.verdict).toBe('ready');
  });

  it('a higher sourceCount lowers the same domain\'s cell ceiling: this domain stays ready at 1 source but needs coarsening at 16', () => {
    const oneSource = checkVoxelDomainBudget(domain, voxelEdge, { sourceCount: 1 });
    const sixteenSources = checkVoxelDomainBudget(domain, voxelEdge, { sourceCount: 16 });
    expect(oneSource.verdict).toBe('ready');
    expect(oneSource.estimatedBytes).toBeLessThan(sixteenSources.estimatedBytes);
    // Same domain, same 512,000 cells: at 16 sources the worst-case bytes/voxel
    // is high enough that this domain no longer fits the same fixed byte
    // envelope without coarsening — exactly the "more sources are worse
    // still" sensitivity the fixed single-source default used to miss.
    expect(sixteenSources.verdict).toBe('coarsen');
  });

  it('runObservationLedger completes such a domain end-to-end, no allowOverBudget needed, within a generous step budget', () => {
    const station: AcquisitionStation = {
      id: 'large-domain-station',
      source: 'ptx-block',
      pose: { worldTranslation: [-1, 40, 40], localPositionSource: 'not-applicable' },
      recordRange: { start: 0, end: 0 },
      originStatus: 'DECLARED',
    };
    const chunk: ObservationRayChunk = {
      originIndex: new Uint16Array([0]),
      direction: new Float32Array([1, 0, 0]),
      range: new Float32Array([Number.NaN]),
      returnOffset: new Uint32Array([0]),
    };
    const input: RayPartitionInput = { domain, voxelEdge, stations: [station], returnedChunks: [{ sourceIndex: 0, chunk, tauAbs: 0.5, tauRel: 0 }], notReadChunks: [] };
    const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.fieldDigest).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// RayPartitionChunkEntry.maxRange (phase O5's F7 regression) — a no-return
// ray's own traversal stops at a declared maxRange, not the domain bound.
// ---------------------------------------------------------------------------

describe('RayPartitionChunkEntry.maxRange bounds a no-return ray\'s own traversal (SPEC §2.1: "up to the declared maximum range")', () => {
  const domain: ObservationDomain = { min: [0, -1, -1], max: [20, 1, 1] };
  const voxelEdge = 1;
  const station: AcquisitionStation = {
    id: 'range-capped-station',
    source: 'ptx-block',
    pose: { worldTranslation: [0, 0, 0], localPositionSource: 'not-applicable' },
    recordRange: { start: 0, end: 0 },
    originStatus: 'DECLARED',
  };
  const chunk: ObservationRayChunk = {
    originIndex: new Uint16Array([0]),
    direction: new Float32Array([1, 0, 0]),
    range: new Float32Array([Number.NaN]), // no-return
    returnOffset: new Uint32Array([0]),
  };

  // The ray runs along y=0, z=0, which the domain's [-1, 1] range on both
  // axes puts in cell index 1 on each (floor((0 - -1) / 1) = 1).
  const RAY_IY = 1;
  const RAY_IZ = 1;

  it('without maxRange, a no-return ray traverses all the way to the domain bound (the pre-existing reading, unchanged)', () => {
    const input: RayPartitionInput = { domain, voxelEdge, stations: [station], returnedChunks: [{ sourceIndex: 0, chunk, tauAbs: 0, tauRel: 0 }], notReadChunks: [] };
    const partial = traverseRayChunks(input);
    const grid = domainGrid(domain, voxelEdge);
    const keys = new Set(partial.rows.map((r) => r.key));
    // Voxel at x=[18,19), well past any reasonable maxRange, still gets noReturn.
    expect(keys.has(packVoxelKey(18, RAY_IY, RAY_IZ, grid.nx, grid.ny))).toBe(true);
  });

  it('with maxRange=5, the same ray never touches a voxel past x=5, but still covers voxels up to it', () => {
    const input: RayPartitionInput = { domain, voxelEdge, stations: [station], returnedChunks: [{ sourceIndex: 0, chunk, tauAbs: 0, tauRel: 0, maxRange: 5 }], notReadChunks: [] };
    const partial = traverseRayChunks(input);
    const grid = domainGrid(domain, voxelEdge);
    const nearKey = packVoxelKey(2, RAY_IY, RAY_IZ, grid.nx, grid.ny);
    const farKey = packVoxelKey(10, RAY_IY, RAY_IZ, grid.nx, grid.ny);
    const rowsByKey = new Map(partial.rows.map((r) => [r.key, r] as const));
    expect(rowsByKey.get(nearKey)?.counters.noReturn).toBeGreaterThan(0);
    expect(rowsByKey.has(farKey)).toBe(false);
    // Every touched voxel's x-index is strictly less than maxRange/voxelEdge = 5.
    for (const row of partial.rows) {
      const { ix } = unpackVoxelKey(row.key, grid.nx, grid.ny);
      expect(ix).toBeLessThan(5);
    }
  });

  it('a maxRange that closes before the ray even enters the domain produces no rows and is not counted as a rejected ray', () => {
    const farStation: AcquisitionStation = { ...station, pose: { worldTranslation: [-10, 0, 0], localPositionSource: 'not-applicable' } };
    const input: RayPartitionInput = { domain, voxelEdge, stations: [farStation], returnedChunks: [{ sourceIndex: 0, chunk, tauAbs: 0, tauRel: 0, maxRange: 5 }], notReadChunks: [] };
    // The domain starts at x=0; the station sits at x=-10, so the ray only
    // enters the domain at t=10, past its own maxRange of 5.
    const partial = traverseRayChunks(input);
    expect(partial.rows.length).toBe(0);
    expect(partial.telemetry.rejectedRays).toBe(0); // the ray itself was valid; its own window just closed first
  });

  it('omitting maxRange on one entry and setting it on another in the same run does not cross-contaminate (per-entry, not global)', () => {
    const uncappedInput: RayPartitionInput = { domain, voxelEdge, stations: [station], returnedChunks: [{ sourceIndex: 0, chunk, tauAbs: 0, tauRel: 0 }], notReadChunks: [] };
    const cappedInput: RayPartitionInput = { domain, voxelEdge, stations: [station], returnedChunks: [{ sourceIndex: 0, chunk, tauAbs: 0, tauRel: 0, maxRange: 5 }], notReadChunks: [] };
    const uncapped = traverseRayChunks(uncappedInput);
    const capped = traverseRayChunks(cappedInput);
    expect(uncapped.rows.length).toBeGreaterThan(capped.rows.length);
  });
});
