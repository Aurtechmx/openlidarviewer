/**
 * coconinoArtifacts.test.ts — the shipped Coconino files say what the
 * measurement says, or the release fails.
 *
 * The universe was rebuilt to 60 checkpoints across 57 tiles (2026-08-14),
 * replacing a 13-point, 8-tile study (2026-08-09). The metrics block, the
 * validation summary, the results CSV and the README table kept describing the
 * study it replaced: the rebuild script carried the old `metrics` key forward
 * with `prev.update(...)`, and the accuracy gate logged its numbers to the
 * console instead of writing a file, so nothing in the repo could notice. One
 * JSON file stated both populations at once.
 *
 * Every artifact here is written from tests/coconinoMeasurement.ts, the same
 * module the accuracy gate measures with, and this file asserts that what is
 * committed equals what that module computes. An ingest that grows the universe
 * turns this test red until the artifacts are regenerated:
 *
 *     COCONINO_WRITE=1 npx vitest run tests/coconinoArtifacts.test.ts
 *
 * then commit the diff. That path is the only writer of these files, so
 * "regenerate" cannot quietly mean "hand-edit the number that failed".
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  PATHS, CELL_M, computeCoconino, rmseOf, percentileAbs, residualsOf,
  type CheckpointResult, type CoconinoMetrics,
} from './coconinoMeasurement';

const WRITE = process.env.COCONINO_WRITE === '1';

/** USGS/NDEP-ASPRS vertical-accuracy classes for this project. Spec, not fitted. */
const CLASS_M = { NVA: 0.3, VVA: 0.6 } as const;

/** Files SHA256SUMS pins, in the order the digest file lists them. */
const PINNED = [
  PATHS.results, PATHS.eligibility, PATHS.metrics, PATHS.summary,
  PATHS.universe, PATHS.requiredTiles,
];

interface PublishedCheckpoint {
  id: string; type: 'NVA' | 'VVA'; albersE: number; albersN: number; z: number;
}
interface Tile {
  tileId: string;
  boundsAlbers: { xmin: number; xmax: number; ymin: number; ymax: number };
}
interface Universe {
  study: unknown; source: unknown; horizontalCrs: unknown; verticalDatum: unknown;
  geoid: unknown; checkpointSource: unknown; checkpointReferenceSha256: unknown;
  independence: unknown; matchRule: unknown;
  evidenceIndependence: unknown;
  evidenceDetermination: { conclusion: string };
  downloadedTiles: Tile[];
  matchedCheckpointCount: number;
  matchedCheckpoints: Array<{ id: string; type: 'NVA' | 'VVA'; tile: string }>;
}

const readJson = <T = unknown>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const serialize = (v: unknown): string => `${JSON.stringify(v, null, 1)}\n`;
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * The eligibility record: every published checkpoint, and the one documented
 * reason it does or does not reach the reported metric. Machine-readable,
 * because "why is the denominator 58 and not 121?" should be answerable without
 * reading prose.
 */
function buildEligibility(
  published: readonly PublishedCheckpoint[],
  universe: Universe,
  results: readonly CheckpointResult[],
): unknown {
  const tileOf = new Map(universe.matchedCheckpoints.map((c) => [c.id, c.tile]));
  const stateOf = new Map(results.map((r) => [r.id, r.state]));
  const coveringTile = (c: PublishedCheckpoint): string | null => {
    for (const t of universe.downloadedTiles) {
      const b = t.boundsAlbers;
      if (c.albersE >= b.xmin && c.albersE <= b.xmax && c.albersN >= b.ymin && c.albersN <= b.ymax) {
        return t.tileId;
      }
    }
    return null;
  };
  const checkpoints = published.map((c) => {
    const tile = tileOf.get(c.id) ?? coveringTile(c);
    const state = stateOf.get(c.id);
    if (state === 'measured') {
      return { id: c.id, type: c.type, tile, state, reason: 'In a downloaded tile; its 1 m DTM cell carried classified ground.' };
    }
    if (state === 'rejected-no-ground') {
      return { id: c.id, type: c.type, tile, state, reason: 'In the frozen universe and in the crop, but its 1 m DTM cell carried no classified ground, so there is no DTM elevation to compare against. Rejected and reported, not dropped.' };
    }
    if (tile !== null) {
      return { id: c.id, type: c.type, tile, state: 'excluded-no-ground-in-crop', reason: 'Inside a downloaded tile, but that tile carried no class-2 ground within the crop radius of the checkpoint, so it never entered the matched crop.' };
    }
    return { id: c.id, type: c.type, tile, state: 'excluded-outside-downloaded-tiles', reason: 'Its Albers (E,N) falls outside every downloaded tile, so it is not in the frozen universe. Membership follows tile coverage alone and is fixed before any residual is computed.' };
  });
  const stateTally: Record<string, number> = {};
  for (const c of checkpoints) stateTally[c.state] = (stateTally[c.state] ?? 0) + 1;
  return {
    purpose: 'Why each published Coconino checkpoint does or does not enter the reported metric. One entry per checkpoint in the project-report table. No checkpoint is excluded for the size of its residual.',
    publishedCheckpointTable: `validation/terrain-field/references/${basename(PATHS.published)}`,
    publishedCheckpointCount: published.length,
    exclusionRule: "A checkpoint enters the frozen universe iff its Albers (E,N) falls inside a downloaded tile's header bounds and that tile carried class-2 ground at the checkpoint. Of those, any whose 1 m DTM cell holds no classified ground is rejected and reported; the rest are the usable, evaluated subset. Membership and rejection are both decided without reference to the residual.",
    stateTally,
    checkpoints,
  };
}

/**
 * How the rejections fall across the strata.
 *
 * The rejection rule is "no classified ground in the cell", which is the
 * condition the VVA class exists to measure, so a rejection that lands only on
 * VVA points is informative missingness rather than an incidental gap: the VVA
 * figures are conditional on a ground return existing at all. That is a limit on
 * what the VVA number means. It is recomputed from the results on every run, so
 * it tracks the data instead of going stale the way a written-in caveat would.
 */
function rejectionCaveat(results: readonly CheckpointResult[]): string | null {
  const rejected = results.filter((r) => r.state === 'rejected-no-ground');
  if (rejected.length === 0) return null;
  const tally = new Map<string, number>();
  for (const r of rejected) tally.set(r.type, (tally.get(r.type) ?? 0) + 1);
  const parts = [...tally].map(([t, n]) => `${n} ${t}`).join(', ');
  const onlyVVA = tally.size === 1 && tally.has('VVA');
  return `${rejected.length} of ${results.length} checkpoints (${parts}) were rejected for carrying no classified ground in their 1 m DTM cell.`
    + (onlyVVA
      ? ' Every rejection is VVA, and the rule that rejects them is the absence of a ground return, which is the condition the VVA class exists to test. The missingness is therefore informative: the VVA statistics are conditional on a ground return existing at the checkpoint, so they describe vegetated ground the bare-earth surface reached rather than vegetated ground in general.'
      : ' The rejection rule is the absence of a ground return, so treat the per-stratum figures as conditional on a ground return existing.');
}

/** The study's conclusion, derived from the universe it cites rather than copied. */
function buildSummary(
  universe: Universe,
  metrics: CoconinoMetrics,
  publishedCount: number,
  universeSha256: string,
  rejectionNote: string | null,
): unknown {
  const matchedNVA = universe.matchedCheckpoints.filter((c) => c.type === 'NVA').length;
  return {
    study: universe.study,
    source: universe.source,
    horizontalCrs: universe.horizontalCrs,
    verticalDatum: universe.verticalDatum,
    geoid: universe.geoid,
    checkpointSource: universe.checkpointSource,
    checkpointReferenceSha256: universe.checkpointReferenceSha256,
    independence: universe.independence,
    matchRule: universe.matchRule,
    // The membership record is cited, not copied. Both files used to carry the
    // tile list and the checkpoint list; one was regenerated and the other was
    // not, and each then described a different study.
    inputUniverse: {
      file: `validation/terrain-field/coconino/${basename(PATHS.universe)}`,
      sha256: universeSha256,
      downloadedTileCount: universe.downloadedTiles.length,
      matchedCheckpointCount: universe.matchedCheckpointCount,
      matchedNVA,
      matchedVVA: universe.matchedCheckpointCount - matchedNVA,
    },
    checkpointFunnel: {
      publishedInProjectReport: publishedCount,
      inFrozenUniverse: metrics.candidate,
      rejectedNoGroundInCell: metrics.rejected,
      usableEvaluated: metrics.usable,
      note: `The metrics below are computed over the ${metrics.usable} usable checkpoints. That is the evaluated subset, not the total checkpoint population. Per-checkpoint reasons: ${basename(PATHS.eligibility)}.`,
    },
    dtm: {
      cellSizeM: CELL_M,
      method: 'Production rasterizeDtm, point-in-cell mean over class-2 ground. Each checkpoint is compared to the cell containing it: nearest cell, no interpolation.',
    },
    metrics,
    accuracyStatement: {
      basis: 'USGS/NDEP-ASPRS vertical accuracy. NVA at the 95% confidence level (1.96 x RMSEz, errors approximately Gaussian on open ground); VVA at the 95th percentile, which by definition tolerates the top 5% of vegetated returns as a non-Gaussian tail.',
      nvaClassM: CLASS_M.NVA,
      vvaClassM: CLASS_M.VVA,
      percentileMethod: 'Linear interpolation between order statistics of |residual|, the same function the accuracy gate judges against.',
    },
    limitations: [
      ...(rejectionNote === null ? [] : [rejectionNote]),
      `The universe holds ${universe.downloadedTiles.length} of the 109 tiles the frozen checkpoint table requires, so it covers part of the project rather than all of it. Which tiles are required is a pure function of the checkpoint table and the tiling rule (required-tiles.json); no tile is selected by its result, and membership is fixed before any residual is computed.`,
      'Found third-party checkpoints, not a survey preregistered against an OLV protocol. This caps the determination below E5 regardless of sample size.',
    ],
    evidenceIndependence: universe.evidenceIndependence,
    evidenceDetermination: universe.evidenceDetermination,
  };
}

/** The Coconino leg of the terrain-field README, without its neighbours. */
function coconinoSection(readme: string): string {
  const start = readme.indexOf('## The Coconino leg');
  expect(start, 'the terrain-field README has no Coconino leg section').toBeGreaterThan(-1);
  const next = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
}

describe('the shipped Coconino artifacts agree with the measurement', () => {
  const inputsPresent = existsSync(PATHS.ground) && existsSync(PATHS.matched) && existsSync(PATHS.universe);

  (inputsPresent ? it : it.skip)('metrics, universe, summary, eligibility, results and README state one population', () => {
    const { results, metrics } = computeCoconino();
    const universe = readJson<Universe>(PATHS.universe);
    const published = readJson<{ checkpoints: PublishedCheckpoint[] }>(PATHS.published).checkpoints;

    // The universe is the membership record; the measurement runs over exactly it.
    expect(metrics.candidate).toBe(universe.matchedCheckpointCount);
    expect(metrics.usable + metrics.rejected).toBe(metrics.candidate);

    const csvOut = `${[
      'id,type,e,n,z_surveyed,z_olv,residual_m,state',
      ...results.map((r) => [
        r.id, r.type, r.e.toFixed(3), r.n.toFixed(3), String(r.zSurveyed),
        r.zOlv === null ? '' : r.zOlv.toFixed(3),
        r.residualM === null ? '' : r.residualM.toFixed(3),
        r.state,
      ].join(',')),
    ].join('\n')}\n`;
    const eligibilityOut = buildEligibility(published, universe, results);

    if (WRITE) {
      // input-universe.json is deliberately absent: it is the membership record
      // and the ingest script owns it. Two writers for one file is how the
      // stale block survived a rebuild in the first place.
      writeFileSync(PATHS.metrics, serialize(metrics));
      writeFileSync(PATHS.results, csvOut);
      writeFileSync(PATHS.eligibility, serialize(eligibilityOut));
      // The summary cites the universe by digest, so it is written after it.
      writeFileSync(PATHS.summary, serialize(
        buildSummary(universe, metrics, published.length, sha256(PATHS.universe), rejectionCaveat(results)),
      ));
      const pins = [...PINNED].sort((a, b) => (basename(a) < basename(b) ? -1 : 1));
      writeFileSync(PATHS.sums, `${pins.map((p) => `${sha256(p)}  ${basename(p)}`).join('\n')}\n`);
    }

    // ── every committed artifact equals what the measurement produced ────────
    expect(readJson(PATHS.metrics)).toEqual(metrics);
    // The universe states membership, never statistics. A "metrics" key here is
    // the defect itself: one population and a set of numbers over a different
    // population, in one file, with no writer able to reconcile them.
    expect(readJson<Record<string, unknown>>(PATHS.universe)).not.toHaveProperty('metrics');
    expect(readFileSync(PATHS.results, 'utf8')).toBe(csvOut);
    expect(readJson(PATHS.eligibility)).toEqual(eligibilityOut);

    const summary = readJson<{
      checkpointFunnel: Record<string, number>;
      inputUniverse: { sha256: string; matchedCheckpointCount: number; downloadedTileCount: number };
      metrics: CoconinoMetrics;
      evidenceDetermination: unknown;
    }>(PATHS.summary);
    expect(summary.metrics).toEqual(metrics);
    // The summary's denominators are the funnel, not a second opinion about it.
    expect(summary.checkpointFunnel.publishedInProjectReport).toBe(published.length);
    expect(summary.checkpointFunnel.inFrozenUniverse).toBe(metrics.candidate);
    expect(summary.checkpointFunnel.rejectedNoGroundInCell).toBe(metrics.rejected);
    expect(summary.checkpointFunnel.usableEvaluated).toBe(metrics.usable);
    expect(summary.inputUniverse.matchedCheckpointCount).toBe(universe.matchedCheckpointCount);
    expect(summary.inputUniverse.downloadedTileCount).toBe(universe.downloadedTiles.length);
    // It cites THIS universe, not the one it happened to be written against.
    expect(summary.inputUniverse.sha256).toBe(sha256(PATHS.universe));
    // One determination, not two readings of it.
    expect(summary.evidenceDetermination).toEqual(universe.evidenceDetermination);

    // ── SHA256SUMS pins the bytes that are actually committed ───────────────
    const pinned = readFileSync(PATHS.sums, 'utf8').trim().split('\n')
      .map((line) => line.split(/\s+/));
    expect(pinned.map(([, name]) => name).sort())
      .toEqual(PINNED.map((p) => basename(p)).sort());
    for (const [digest, name] of pinned) {
      expect(digest, `SHA256SUMS is stale for ${name}`)
        .toBe(sha256(join(dirname(PATHS.sums), name)));
    }

    // ── the required-tile manifest describes THIS universe ─────────────────
    // required-tiles.json sat at "13 checkpoints covered, F7 not met" through
    // the whole 60-point rebuild. Its `--check` mode catches that and was wired
    // into no gate, so nothing ran it. The tile RULE stays in the generator;
    // what is asserted here is only that the two committed files describe one
    // study, which is the part that drifted.
    const required = readJson<{
      totals: { requiredTiles: number; checkpoints: number };
      coverageNow: Record<string, number>;
      f7Gate: { minTotal: number; minPerStratum: number; totalMet: boolean; perStratumMet: boolean };
      tiles: Array<{ tileId: string; downloaded: boolean }>;
    }>(PATHS.requiredTiles);
    const universeTiles = new Set(universe.downloadedTiles.map((t) => t.tileId));
    const matchedNVA = universe.matchedCheckpoints.filter((c) => c.type === 'NVA').length;
    expect(required.totals.checkpoints, 'required-tiles totals disagree with the checkpoint table')
      .toBe(published.length);
    expect(required.coverageNow.checkpointsCovered).toBe(universe.matchedCheckpointCount);
    expect(required.coverageNow.nvaCovered).toBe(matchedNVA);
    expect(required.coverageNow.vvaCovered).toBe(universe.matchedCheckpointCount - matchedNVA);
    expect(
      required.tiles.filter((t) => t.downloaded).map((t) => t.tileId).sort(),
      'the manifest\'s downloaded flags disagree with the universe\'s tile list',
    ).toEqual([...universeTiles].sort());
    // The sample-size verdict follows from the counts; it is not a stored opinion.
    expect(required.f7Gate.totalMet).toBe(universe.matchedCheckpointCount >= required.f7Gate.minTotal);
    expect(required.f7Gate.perStratumMet).toBe(
      matchedNVA >= required.f7Gate.minPerStratum
      && universe.matchedCheckpointCount - matchedNVA >= required.f7Gate.minPerStratum,
    );

    // ── the summary states what the rejections mean ────────────────────────
    const limitations = readJson<{ limitations: string[] }>(PATHS.summary).limitations;
    expect(limitations, 'the summary records no limitations').toBeInstanceOf(Array);
    if (metrics.rejected > 0) {
      expect(limitations.join(' '), 'the summary does not say how many were rejected, or why')
        .toContain(`${metrics.rejected} of ${metrics.candidate} checkpoints`);
    }

    // ── the README publishes the same population ───────────────────────────
    // Not "no other number may appear": the funnel legitimately names 121 and
    // 60. What may not appear twice is a STRATUM PAIR or a tile count, which is
    // the shape the stale text drifted in ("6 NVA + 7 VVA … 8 project tiles").
    const section = coconinoSection(readFileSync(PATHS.readme, 'utf8'));
    const strata = `${metrics.NVA.n} NVA + ${metrics.VVA.n} VVA`;
    const pairs = [...section.matchAll(/(\d+) NVA \+ (\d+) VVA/g)].map((m) => `${m[1]} NVA + ${m[2]} VVA`);
    expect(pairs.length, 'the README\'s Coconino leg states no NVA/VVA split').toBeGreaterThan(0);
    for (const pair of pairs) expect(pair, 'a stale stratum split survives in the README').toBe(strata);
    for (const tiles of [...section.matchAll(/(\d+) project tiles/g)].map((m) => Number(m[1]))) {
      expect(tiles, 'a stale tile count survives in the README').toBe(universe.downloadedTiles.length);
    }
    for (const claim of [
      `${metrics.usable} checkpoints (${strata})`,
      `${metrics.candidate} / ${metrics.rejected} / ${metrics.usable} (${strata}, ${universe.downloadedTiles.length} project tiles)`,
      `${metrics.overall.rmse_cm.toFixed(2)} cm`,
      `${metrics.NVA.rmse_cm.toFixed(2)} cm`,
      `${metrics.VVA.p95_cm.toFixed(2)} cm`,
      `${metrics.overall.max_cm.toFixed(2)} cm`,
    ]) {
      expect(section, `the README's Coconino leg does not state "${claim}"`).toContain(claim);
    }

    // ── the accuracy statement the summary publishes is the one that passed ─
    const nva95M = 1.96 * rmseOf(residualsOf(results, 'NVA'));
    const vva95M = percentileAbs(residualsOf(results, 'VVA').map(Math.abs).sort((a, b) => a - b), 0.95);
    expect(nva95M).toBeLessThanOrEqual(CLASS_M.NVA);
    expect(vva95M).toBeLessThanOrEqual(CLASS_M.VVA);
    // One definition of p95: the reported number is the number that was judged.
    expect(metrics.VVA.p95_cm).toBe(Math.round(vva95M * 100 * 100) / 100);
  });
});
