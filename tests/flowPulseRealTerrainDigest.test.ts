/**
 * flowPulseRealTerrainDigest.test.ts: TF-8 — routing over real terrain is
 * deterministic, not just over the hand-written analytic fixtures.
 *
 * Every other fixture in `validation/field-simulation/fixtures/` was written
 * by hand for this project. `sl-field-real-terrain.json` is not: it is a 40 x
 * 40 m crop of OLV's own bincell DTM over the VT StREAM Lab riparian survey
 * (OpenTopography DOI 10.5069/G9NZ85W7), already committed under
 * `validation/terrain-field/` for that harness's own cross-implementation
 * checks, carried in here as a z-grid so the SAME real ground with real
 * survey NoData gaps exercises D8 and accumulation too.
 *
 * `fieldSimulationOracleAgreement.test.ts` already checks this fixture field
 * by field against the Python oracle. What that test does not pin is a single
 * comparable identity for the whole routed field — the thing a reader
 * actually quotes to say "this is the same run". That is `flowFieldDigest`,
 * so this file runs the routing twice from the committed JSON and checks the
 * digest agrees with itself, then pins the value the way
 * `flowPulseFieldDigest.test.ts` already pins one for a synthetic 2x2 grid.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { d8Flow } from '../src/simulation/flowPulse/d8Flow';
import { flowAccumulation } from '../src/simulation/flowPulse/flowAccumulation';
import { flowFieldDigest } from '../src/simulation/flowPulse/flowFieldDigest';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'validation', 'field-simulation',
  'fixtures', 'sl-field-real-terrain.json',
);

interface Fixture {
  readonly cellMetresX: number;
  readonly cellMetresY: number;
  readonly z: readonly (readonly (number | null)[])[];
}

function gridOf(f: Fixture): FlowGrid {
  const rows = f.z.length;
  const cols = f.z[0].length;
  const z = new Float32Array(cols * rows);
  const valid = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = f.z[r][c];
      if (v === null) continue;
      z[r * cols + c] = v;
      valid[r * cols + c] = 1;
    }
  }
  return { z, valid, cols, rows, cellMetresX: f.cellMetresX, cellMetresY: f.cellMetresY };
}

function routeFrom(fixture: Fixture): string {
  const grid = gridOf(fixture);
  const routed = d8Flow(grid);
  const accumulation = flowAccumulation(grid, routed);
  return flowFieldDigest(grid, routed, accumulation, null);
}

describe('TF-8: a real, licensed terrain fixture routes deterministically', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

  it('is a 40x40 grid with real survey NoData gaps, not a hand-written toy', () => {
    expect(fixture.z).toHaveLength(40);
    expect(fixture.z[0]).toHaveLength(40);
    const gaps = fixture.z.flat().filter((v) => v === null).length;
    expect(gaps).toBeGreaterThan(0);
  });

  it('gives the same field digest on two independent runs from the committed JSON', () => {
    expect(routeFrom(fixture)).toBe(routeFrom(fixture));
  });

  it('reproduces the pinned digest for this exact committed grid', () => {
    // Changes if the fixture, the routing method, the accumulation method or
    // the digest encoding changes — any of which is a real finding, not a
    // reason to update this string without checking which one moved.
    expect(routeFrom(fixture)).toBe(
      'dc80c9adbbad7c0cdfa748a2dc3498ca22fcd66958140bc4c2dcdc79549ee047',
    );
  });
});
