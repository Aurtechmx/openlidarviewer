/**
 * terrainAccessOracleAgreement.test.ts: two implementations, one answer.
 *
 * `validation/terrain-access/oracle/terrain_access_oracle.py` computes Horn
 * slope/aspect, VRM, hard eligibility, width dilation, directional grade and
 * a least-cost route for the frozen fixtures, in another language and by a
 * different search algorithm: it runs Dijkstra where the viewer runs A*.
 * This compares the viewer against those frozen records.
 *
 * What agreement buys is narrow and worth stating, exactly as
 * `fieldSimulationOracleAgreement.test.ts` states it for Flow Pulse. It
 * catches transcription slips, a sign error in the gradient/aspect
 * convention, and a mistake in scaling the two axes to metres, because those
 * would have to occur identically in two independently written routines to
 * go unnoticed. It is not external validation: both implementations were
 * written in this project, so a shared misreading of the method survives
 * agreement. The fixtures are small enough to check by hand (see each
 * fixture's own `why`), which is the backstop for that.
 *
 * `cost`, `outcome` and `eligibleCount`/`blockedReasonCounts` are compared on
 * every fixture — cost agreement across two DIFFERENT search algorithms and
 * two DIFFERENT tie-break rules is what actually verifies the cost graph
 * itself is the same graph, independent of which specific among several
 * equal-cost paths either search happens to prefer.
 *
 * `path` is compared EXACTLY only on the fixtures in {@link TIE_FREE}: those
 * were checked (see each one's `why`) to have a single lowest-cost route, so
 * A*'s tie-break and Dijkstra's tie-break — which are deliberately DIFFERENT
 * rules, see aStarTerrain.ts's header — have nothing to disagree about. The
 * rest carry a genuine tie between two or more equal-cost routes (e.g. two
 * symmetric detours around one excluded cell); there the two searches are
 * not required or expected to pick the same one, and asserting exact
 * equality would pin an artefact of two independently-chosen deterministic
 * orderings rather than a property of the method. Those fixtures still get
 * the strictly stronger set of checks below: same cost, same length, and the
 * viewer's own path never touches a cell the oracle also excluded.
 *
 * The Python is not run here. The expectations are committed, so this test
 * needs no interpreter and the gate gains no dependency; regenerating them is
 * a deliberate act (`terrain_access_oracle.py --write`) that shows up in the
 * diff.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aStarTerrain } from '../src/simulation/terrainAccess/aStarTerrain';
import {
  DEFAULT_COST_WEIGHTS, applyWidthClearance, nodeEligibility, prepareTerrainAccessFeatures,
} from '../src/simulation/terrainAccess/traversabilityCost';
import type { TerrainAccessGrid, TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'validation', 'terrain-access');
const FIXTURES = join(ROOT, 'fixtures');
const EXPECTED = join(ROOT, 'expected');

interface Fixture {
  readonly name: string;
  readonly why: string;
  readonly cellMetresX: number;
  readonly cellMetresY: number;
  readonly z: readonly (readonly (number | null)[])[];
  readonly confidence?: readonly (readonly number[])[];
  readonly allowed?: readonly (readonly number[])[];
  readonly heightAboveGround?: readonly (readonly number[])[];
  readonly profile: TerrainAccessProfile;
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
}

interface Expected {
  readonly outcome: string;
  readonly path: readonly number[];
  readonly cost: number | null;
  readonly eligibleCount: number;
  readonly blockedReasonCounts: Readonly<Record<string, number>>;
}

const read = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

function gridOf(f: Fixture): TerrainAccessGrid {
  const rows = f.z.length;
  const cols = f.z[0].length;
  const n = cols * rows;
  const z = new Float32Array(n).fill(Number.NaN);
  const valid = new Uint8Array(n);
  const confidence = new Float32Array(n).fill(100);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = f.z[r][c];
      const i = r * cols + c;
      if (v === null) continue;
      z[i] = v;
      valid[i] = 1;
      if (f.confidence) confidence[i] = f.confidence[r][c];
    }
  }
  let allowed: Uint8Array | null = null;
  if (f.allowed) {
    allowed = new Uint8Array(n);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) allowed[r * cols + c] = f.allowed[r][c];
  }
  let heightAboveGround: Float32Array | null = null;
  if (f.heightAboveGround) {
    heightAboveGround = new Float32Array(n);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heightAboveGround[r * cols + c] = f.heightAboveGround[r][c];
  }
  return {
    z, valid, confidence, coverage: null, heightAboveGround, allowed,
    cols, rows, cellMetresX: f.cellMetresX, cellMetresY: f.cellMetresY,
  };
}

const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();

/**
 * Fixtures verified (see each one's `why`) to have a single lowest-cost
 * route, so an exact path comparison is meaningful rather than pinning one
 * arbitrary choice among several equally-valid ones.
 */
const TIE_FREE = new Set([
  'TA-1-flat-plane.json',
  'TA-2-tilted-plane-directional.json',
  'TA-3-cross-slope-trap.json', // NO_ROUTE either way; path is trivially []
  'TA-4-step-barrier.json',
  'TA-5-width-clearance-wide.json', // NO_ROUTE either way; path is trivially []
  'TA-6-nodata-corridor.json', // NO_ROUTE either way; path is trivially []
  'TA-8-ruggedness.json',
  'TA-8-ruggedness-unset.json',
  // TA-10: brute-forced over every monotone lattice path from start to end
  // (E/S/SE steps). The anisotropic tilt makes the diagonal route strictly
  // cheaper than every alternative, not tied with one.
  'TA-10-anisotropic-grid.json',
]);

describe('the fixture set is present', () => {
  it('has fixtures to compare, so the agreement below is not vacuous', () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it('has a frozen expectation for every fixture', () => {
    const frozen = new Set(readdirSync(EXPECTED).filter((f) => f.endsWith('.json')));
    for (const n of names) expect(frozen.has(n)).toBe(true);
  });
});

describe.each(names)('%s', (name) => {
  const fixture = read<Fixture>(join(FIXTURES, name));
  const want = read<Expected>(join(EXPECTED, name));
  const grid = gridOf(fixture);
  const features = prepareTerrainAccessFeatures(grid, fixture.profile);
  const eligibility = applyWidthClearance(grid, nodeEligibility(grid, features, fixture.profile), fixture.profile);
  const startIndex = fixture.start[0] * grid.cols + fixture.start[1];
  const endIndex = fixture.end[0] * grid.cols + fixture.end[1];
  const result = aStarTerrain(grid, features, eligibility, fixture.profile, startIndex, endIndex, DEFAULT_COST_WEIGHTS);

  it('agrees on the search outcome', () => {
    expect(result.outcome).toBe(want.outcome);
  });

  it('agrees on the route cost, from a different search algorithm', () => {
    if (want.cost == null) {
      expect(result.cost).toBeNull();
    } else {
      expect(result.cost as number).toBeCloseTo(want.cost, 6);
    }
  });

  it('agrees on how many cells are eligible after hard blocking and width clearance', () => {
    let eligible = 0;
    for (const b of eligibility.blocked) if (b === 0) eligible++;
    expect(eligible).toBe(want.eligibleCount);
  });

  it('agrees on the tally of block reasons', () => {
    const counts: Record<string, number> = {};
    for (const r of eligibility.reason) if (r) counts[r] = (counts[r] ?? 0) + 1;
    expect(counts).toEqual(want.blockedReasonCounts);
  });

  if (TIE_FREE.has(name)) {
    it('agrees on the exact path (verified tie-free)', () => {
      expect([...result.path]).toEqual([...want.path]);
    });
  } else {
    it('agrees on the path length, even though a genuine tie means the specific cells may differ', () => {
      expect(result.path.length).toBe(want.path.length);
    });
  }

  it('never crosses a cell the oracle also found ineligible', () => {
    for (const cell of result.path) expect(eligibility.blocked[cell]).toBe(0);
  });
});
