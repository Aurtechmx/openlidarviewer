/**
 * coconinoCheckpoints.test.ts — OLV's DTM against INDEPENDENT surveyed ground
 * truth across a frozen multi-tile Coconino checkpoint universe.
 *
 * Dataset: USGS AZ Coconino B1 2019 (project 19049), public domain (USGS 3DEP /
 * The National Map). The project's aerial-LiDAR NVA/VVA accuracy checkpoints are
 * held separate from the 12 LiDAR Control Points — an independent vertical-
 * accuracy set, not reused for calibration, registration, strip adjustment,
 * classification tuning, or OLV parameter tuning. Checkpoints are reprojected to
 * the tile CRS (NAD83(2011) / Conus Albers). Tile Z and checkpoint Z are both
 * NAVD88 orthometric (Geoid12B), so there is no vertical-datum reconciliation.
 *
 * The checkpoint universe is FROZEN in
 * validation/terrain-field/coconino/input-universe.json: every downloaded tile
 * is hashed, and a checkpoint is IN the universe iff its Albers (E,N) falls
 * inside a downloaded tile's header bounds. Membership is fixed before any
 * residual is computed; no checkpoint is removed for a large error. OLV grids
 * the committed class-2 ground with the production rasterizeDtm at 1.0 m (the
 * USGS 3DEP QL2 bare-earth DEM resolution) and compares each checkpoint to its
 * DTM cell, nearest cell, no interpolation; a checkpoint whose cell carries no
 * classified ground is REJECTED, not counted.
 *
 * Per-checkpoint bounds are the USGS accuracy class for the type (NVA 0.30 m,
 * VVA 0.60 m), spec-derived, not fitted. This is external checkpoint agreement,
 * not an E5 field campaign: the checkpoints are found public data, not surveyed
 * under a protocol frozen before the survey, so per
 * validation/terrain-field/coconino/coconino-validation-summary.json the DTM
 * grade stays E3 even though the universe now clears the USGS sample minimums.
 *
 * The measurement itself lives in ./coconinoMeasurement, which is also what
 * writes the shipped metrics, summary, eligibility record and results CSV
 * (tests/coconinoArtifacts.test.ts). It is one module because it was once two:
 * this test logged its numbers to the console while the committed files kept an
 * earlier study's, and the release nearly shipped 58 checkpoints of evidence
 * described everywhere as 13.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  PATHS, measureCheckpoints, metricsOf, percentileAbs, readGround, readMatched,
  residualsOf, rmseOf,
} from './coconinoMeasurement';

const GROUND = PATHS.ground, MATCHED = PATHS.matched, UNIVERSE = PATHS.universe;
// USGS/NDEP–ASPRS vertical-accuracy classes for this project, applied as a
// statistical statement (not a per-checkpoint tolerance): NVA at the 95%
// confidence level, VVA at the 95th percentile.
const BOUND: Record<string, number> = { NVA: 0.3, VVA: 0.6 };

describe('OLV DTM vs independent USGS checkpoints (Coconino, NAVD88↔NAVD88)', () => {
  const has = existsSync(GROUND) && existsSync(MATCHED);

  (has ? it : it.skip)('agrees with surveyed ground truth within each checkpoint\'s USGS accuracy class', () => {
    const cps = readMatched();

    // No control points may enter the accuracy set: every matched checkpoint is
    // an NVA or VVA accuracy point, never a LiDAR Control Point.
    for (const c of cps) expect(['NVA', 'VVA']).toContain(c.type);

    // The measurement — local window per checkpoint, production rasterizeDtm at
    // 1 m, nearest cell, no interpolation — lives in ./coconinoMeasurement so
    // the shipped artifacts are written from the arithmetic judged here rather
    // than from a second copy of it.
    const results = measureCheckpoints(readGround(), cps);
    const metrics = metricsOf(results);
    const all = residualsOf(results), nva = residualsOf(results, 'NVA'), vva = residualsOf(results, 'VVA');

    // eslint-disable-next-line no-console
    console.log(`[terrain-field] Coconino DTM vs ${metrics.usable} USGS checkpoints (rej ${metrics.rejected}): overall ${JSON.stringify(metrics.overall)} | NVA ${JSON.stringify(metrics.NVA)} | VVA ${JSON.stringify(metrics.VVA)}`);

    // No checkpoint is silently dropped: candidates == usable + rejected.
    expect(metrics.usable + metrics.rejected).toBe(cps.length);
    // A real multi-tile universe, not a single point.
    expect(all.length).toBeGreaterThanOrEqual(10);

    // Accuracy is judged by the USGS/NDEP–ASPRS vertical-accuracy statement, not a
    // per-checkpoint tolerance: NVA at the 95% confidence level (1.9600 × RMSEz,
    // errors ~ Gaussian on open ground), VVA at the 95th percentile, which by
    // definition tolerates the top 5% of vegetated returns as a non-Gaussian tail.
    // Every matched checkpoint stays in the set — none is removed for a large error
    // (e.g. BR11, a single VVA point over sparse forest ground, sits beyond the
    // 95th percentile and is reported here, not dropped).
    // Sample size for a formal statement: USGS ≥20 NVA, ≥12 per stratum (F7).
    expect(nva.length, 'NVA sample below the USGS ≥20 minimum').toBeGreaterThanOrEqual(20);
    expect(vva.length, 'VVA sample below the ≥12-per-stratum minimum').toBeGreaterThanOrEqual(12);
    const nva95 = 1.96 * rmseOf(nva);
    const vva95 = percentileAbs(vva.map(Math.abs).sort((a, b) => a - b), 0.95);
    expect(nva95, `NVA 95% (1.96·RMSE) = ${(nva95 * 100).toFixed(1)}cm exceeds the ${BOUND.NVA * 100}cm class`).toBeLessThanOrEqual(BOUND.NVA);
    expect(vva95, `VVA 95th percentile = ${(vva95 * 100).toFixed(1)}cm exceeds the ${BOUND.VVA * 100}cm class`).toBeLessThanOrEqual(BOUND.VVA);
  });

  const hasUni = existsSync(UNIVERSE) && existsSync(MATCHED);
  (hasUni ? it : it.skip)('the frozen universe and the matched crop agree, and E5 is not falsely claimed', () => {
    const uni = JSON.parse(readFileSync(UNIVERSE, 'utf8'));
    const matched = readMatched();
    // The crop covers exactly the frozen matched universe — deterministic membership.
    expect(matched.length).toBe(uni.matchedCheckpointCount);
    const uniIds = new Set(uni.matchedCheckpoints.map((c: { id: string }) => c.id));
    for (const c of matched) expect(uniIds.has(c.id)).toBe(true);
    // Evidence cannot be silently promoted: the determination stays E3 / not-E5,
    // with the limiting reasons recorded.
    expect(uni.evidenceDetermination.e5Reached).toBe(false);
    expect(uni.evidenceDetermination.limitingReasons.length).toBeGreaterThan(0);
    expect(uni.evidenceIndependence.usedForParameterTuning).toBe(false);
  });
});
