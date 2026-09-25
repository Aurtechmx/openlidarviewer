/**
 * observatoryFixturesO10.test.ts — F11, F12 and F15 (docs/observatory/SPEC.md
 * §9.1) for phase O10.
 *
 * F11 and F12 run twice. First over the declared field in
 * `validation/observatory/fixtures/f11-coverage-gain.json`, where every term
 * is compared with `validation/observatory/oracle/coverage_gain.py`'s frozen
 * output (exact rational traversal and sums). Then end to end: a wall on open
 * ground, as station 1 recorded it, through the ray builder, ledger,
 * classifier and planning in `runObservatoryOverCloud`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildF11Scene } from '../scripts/generate-observatory-fixtures.mjs';
import { planStations } from '../src/observation/stationSuggestion';
import { traceCandidateVisibility, type CandidateGainTerms } from '../src/observation/coverageGain';
import { runObservatoryOverCloud } from '../src/app/observatoryFromCloud';
import { E2E_WALL, f11PlanningField, wallAndGroundCloud } from './helpers/observatoryPlanningFixtures';

const EXPECTED = JSON.parse(readFileSync(join(__dirname, '..', 'validation', 'observatory', 'expected', 'f11-coverage-gain.expected.json'), 'utf8'));

function expectTermsMatch(actual: CandidateGainTerms, expected: Record<string, unknown>): void {
  expect(actual.candidateIndex).toBe(expected.candidateIndex);
  expect(actual.visibleVoxelCount).toBe(expected.visibleVoxelCount);
  expect(actual.weightedCounts).toEqual(expected.weightedCounts);
  expect(actual.redundantCount).toBe(expected.redundantCount);
  expect(actual.excludedVoxelCount).toBe(expected.excludedVoxelCount);
  expect(actual.weightedVisibilitySum).toBeCloseTo(expected.weightedVisibilitySum as number, 9);
  expect(actual.redundantPenalty).toBeCloseTo(expected.redundantPenalty as number, 9);
  expect(actual.gain).toBeCloseTo(expected.gain as number, 9);
}

function planF11() {
  const scene = buildF11Scene();
  const field = f11PlanningField(scene);
  const result = planStations({
    field,
    model: scene.instrumentModel,
    declaredBySource: [null],
    parameters: { ...scene.parameters, candidateSpacing: 1, candidateCap: scene.candidates.length, maxNormalAngleFromVerticalDegrees: 20 },
    stationCount: scene.stationCount,
    basis: 'full',
    stations: [{ id: scene.station.id, originStatus: scene.station.status }],
    candidates: scene.candidates.map((c) => ({ candidateIndex: c.candidateIndex, position: c.position, standingVoxelKey: null })),
  });
  return { scene, field, result };
}

describe('F11 — Coverage Gain over the declared field, against coverage_gain.py', () => {
  const { field, result } = planF11();

  it('expands the same field the oracle expands', () => {
    const counts: Record<string, number> = {};
    for (const s of field.stateByKey.values()) counts[s] = (counts[s] ?? 0) + 1;
    expect(Object.fromEntries(Object.entries(counts).sort())).toEqual(EXPECTED.stateCounts);
    expect([field.grid.nx, field.grid.ny, field.grid.nz]).toEqual(EXPECTED.grid);
    expect(result.planningRayCount).toBe(EXPECTED.planningRayCount);
  });

  it('every term of every candidate matches the oracle', () => {
    expect(result.candidateTerms).toHaveLength(EXPECTED.candidateTerms.length);
    result.candidateTerms.forEach((t, i) => expectTermsMatch(t, EXPECTED.candidateTerms[i]));
  });

  it('the candidate behind the wall ranks first, ahead of the one beside station 1', () => {
    const ranked = [...result.candidateTerms].sort((a, b) => b.gain - a.gain || a.candidateIndex - b.candidateIndex);
    expect(ranked[0]!.candidateIndex).toBe(1);
    const behind = result.candidateTerms[1]!;
    const beside = result.candidateTerms[0]!;
    expect(behind.gain).toBeGreaterThan(beside.gain);
    expect(behind.weightedCounts.SHADOWED).toBeGreaterThan(beside.weightedCounts.SHADOWED);
  });

  it('NOT_READ voxels weigh 0, are counted, and keep planning at preview (OB-GAIN-05)', () => {
    expect(result.authority.authority).toBe('preview');
    expect(result.authority.reasons).toEqual([`${result.notReadVoxelCount} voxel(s) not read in this load`]);
    expect(result.notReadVoxelCount).toBe(EXPECTED.stateCounts.NOT_READ);
  });
});

describe('F12 — greedy second suggestion after the first', () => {
  const { scene, field, result } = planF11();

  it('selection order and every term at selection match the oracle', () => {
    expect(result.suggestion.selectedCandidateIndices).toEqual(EXPECTED.selectedCandidateIndices);
    expect(result.suggestion.stopReason).toBe(EXPECTED.stopReason);
    result.suggestion.termsAtSelection.forEach((t, i) => expectTermsMatch(t, EXPECTED.termsAtSelection[i]));
  });

  it('the second station covers shadow the first leaves behind', () => {
    const [first, second] = result.suggestion.selectedCandidateIndices as [number, number];
    const c = (i: number) => scene.candidates[i]!.position;
    const visFirst = new Set(traceCandidateVisibility(field, first, c(first), scene.instrumentModel, scene.parameters.p_solid).keys);
    const visSecond = traceCandidateVisibility(field, second, c(second), scene.instrumentModel, scene.parameters.p_solid);
    const residual = [...visSecond.keys].filter((k) => !visFirst.has(k) && field.stateByKey.get(k) === 'SHADOWED');
    expect(residual.length).toBeGreaterThan(0);
    expect(result.suggestion.termsAtSelection[1]!.weightedCounts.SHADOWED).toBe(residual.length);
  });

  it('the canonical field is unchanged by the search', () => {
    const fresh = f11PlanningField(scene);
    expect([...field.stateByKey]).toEqual([...fresh.stateByKey]);
    expect(JSON.stringify([...field.rowByKey])).toBe(JSON.stringify([...fresh.rowByKey]));
  });
});

const RUN = { voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: null, metresPerUnit: 1, buildTag: 'test' } as const;

describe('F11/F12 end to end — wall on open ground through runObservatoryOverCloud', () => {
  const out = runObservatoryOverCloud(wallAndGroundCloud(), { ...RUN, planning: { candidateCap: 64 } });
  if (out.status !== 'ok' || !out.planning) throw new Error('test setup: the run must succeed with planning');
  const planning = out.planning;

  it('generates candidates on level, clear ground', () => {
    expect(planning.candidates.length).toBeGreaterThan(4);
    for (const c of planning.candidates) expect(c.position[2]).toBeCloseTo(-0.24 + 1.5, 9);
  });

  it('the top-ranked candidate stands behind the wall and sees more shadow than the one beside station 1', () => {
    const ranked = [...planning.candidateTerms].sort((a, b) => b.gain - a.gain || a.candidateIndex - b.candidateIndex);
    const top = planning.candidates[ranked[0]!.candidateIndex]!;
    expect(top.position[0]).toBeGreaterThan(E2E_WALL.max[0]);
    const beside = [...planning.candidates].sort((a, b) => Math.hypot(a.position[0], a.position[1]) - Math.hypot(b.position[0], b.position[1]))[0]!;
    const besideTerms = planning.candidateTerms[beside.candidateIndex]!;
    expect(ranked[0]!.gain).toBeGreaterThan(besideTerms.gain);
    expect(ranked[0]!.weightedCounts.SHADOWED).toBeGreaterThan(besideTerms.weightedCounts.SHADOWED);
    expect(planning.suggestion.selectedCandidateIndices[0]).toBe(ranked[0]!.candidateIndex);
  });

  it('the second suggestion still reaches shadow the first did not', () => {
    expect(planning.suggestion.selectedCandidateIndices).toHaveLength(2);
    expect(planning.suggestion.termsAtSelection[1]!.weightedCounts.SHADOWED).toBeGreaterThan(0);
  });

  it('planning never changes the ledger: fieldDigest and state counts match a run without planning', () => {
    const bare = runObservatoryOverCloud(wallAndGroundCloud(), { ...RUN, planning: false });
    if (bare.status !== 'ok') throw new Error('test setup');
    expect(bare.planning).toBeNull();
    expect(out.record.fieldDigest).toBe(bare.record.fieldDigest);
    expect(out.record.stateCounts).toEqual(bare.record.stateCounts);
    expect(out.rows).toHaveLength(bare.rows.length);
  });

  it('a suggested station never becomes a source (OB-INV-05)', () => {
    expect(out.record.stations.map((s) => s.id)).toEqual(['station-1']);
    expect(out.record.methods).toContain('olv.observation.coverage-gain@1');
    expect(out.record.methods).toContain('olv.observation.station-suggestion@1');
  });
});

describe('F15 — assumed origin', () => {
  it('planning over an assumed origin carries authority preview and names the station', () => {
    const out = runObservatoryOverCloud(wallAndGroundCloud('ASSUMED'), { ...RUN, planning: { candidateCap: 8 } });
    if (out.status !== 'ok' || !out.planning) throw new Error('test setup');
    expect(out.planning.authority.authority).toBe('preview');
    expect(out.planning.authority.reasons).toContain('assumed origin: station-1');
    expect(out.record.stations[0]!.originStatus).toBe('ASSUMED');
  });
});
