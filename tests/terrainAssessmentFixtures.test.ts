/**
 * terrainAssessmentFixtures.test.ts — known-truth VERDICT specs.
 *
 * The companion to tests/terrainTruth.*.test.ts: where those assert the
 * numeric DTM/DSM/CHM/slope/hillshade VALUES against the analytic surfaces in
 * tests/fixtures/terrainScenes.ts, this file runs the SAME synthetic fixtures
 * through the LIVE pipeline (analyseContours) and asserts the top-level
 * VERDICTS — the DTM quality gate readiness (ready / previewOnly / blocked),
 * the plain-language Terrain Assessment status (Good / Preview / Limited /
 * Blocked), and the contour-readiness / interval gate outcome.
 *
 * Every expectation here is an INDEPENDENT, CONSERVATIVE invariant derived
 * from the known geometry of the fixture — never "assert it equals whatever it
 * returns". The honesty contract under test:
 *   - genuinely poor data (sparse, heavy interpolation, edge-clipped, unknown
 *     CRS / datum) can NEVER read as Good / ready, and the reasons say why;
 *   - genuinely clean, georeferenced, contourable data is NOT forced to
 *     Blocked — it is allowed to read well (ready, an interval is offered);
 *   - canopy / buildings are stripped before the bare-earth assessment, so an
 *     overlay never wrecks (nor flatters) the underlying ground verdict.
 *
 * A note on flat fixtures: flatPlane, edgeClipped and groundWithOverlay carry
 * ZERO relief, so the interval gate honestly offers no contour interval and the
 * gate blocks them. That is correct conservative behaviour (a perfectly flat
 * surface has no contours to draw), NOT a bug — so the "clean reads well" case
 * uses a gentle SLOPE, which has real relief to contour.
 *
 * Pure data: no DOM, no I/O. Deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  analyseContours,
  type AnalyseContoursParams,
  type AnalyseContoursResult,
} from '../src/terrain/contour/analyseContours';
import {
  terrainAssessment,
  type SupportingMetric,
} from '../src/terrain/contour/terrainAssessment';
import { flatPlane, uniformSlope, sparse, edgeClipped, groundWithOverlay } from './fixtures/terrainScenes';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const EXTENT = { nx: 32, ny: 32, spacing: 1 } as const;

/** Fully-georeferenced params (known CRS + vertical datum), 1 m cells. */
const KNOWN: AnalyseContoursParams = {
  cellSizeM: 1,
  crs: 'EPSG:32610',
  verticalDatum: 'EPSG:5703',
};

function metric(metrics: ReadonlyArray<SupportingMetric>, label: string): SupportingMetric {
  const m = metrics.find((x) => x.label === label);
  expect(m, `supporting metric "${label}" must exist`).toBeDefined();
  return m as SupportingMetric;
}

/** All the human-readable verdict text, lower-cased, for reason assertions.
 *  Includes BOTH axes — the surface reason/reasons AND the export-readiness
 *  reason(s) — so a georeferencing gap (CRS/datum) is findable on the export
 *  axis where it now lives. */
function verdictText(r: AnalyseContoursResult): string {
  const a = terrainAssessment(r);
  return [
    a.reason,
    a.bestFor,
    a.useCaution,
    a.notRecommendedFor,
    a.exportReason,
    ...r.quality.reasons,
    ...r.quality.exportReasons,
    ...r.warnings,
  ]
    .join(' ')
    .toLowerCase();
}

/** Min / max DTM elevation over covered cells (NaN when no coverage). */
function coveredZRange(r: AnalyseContoursResult): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < r.dtm.z.length; i++) {
    if (r.dtm.coverage[i] === 0 || !Number.isFinite(r.dtm.z[i])) continue;
    if (r.dtm.z[i] < min) min = r.dtm.z[i];
    if (r.dtm.z[i] > max) max = r.dtm.z[i];
  }
  return Number.isFinite(min) ? { min, max } : { min: NaN, max: NaN };
}

describe('terrain VERDICT truth — clean, georeferenced, contourable scene', () => {
  // A gentle uniform slope with a known CRS + vertical datum and full coverage.
  // EXPECTED: the gate lets it through (readiness 'ready'); the plain-language
  // status is NOT Blocked; and contour readiness offers a real interval.
  // WHY: a genuinely clean, georeferenced surface with real relief must be
  // ALLOWED to read well — the gate is conservative, not punitive. (The status
  // is capped at Preview rather than Good only because a 32×32 synthetic has a
  // large boundary-edge fraction; that cap is asserted elsewhere — here we only
  // assert the conservative floor "not Blocked".)
  const r = analyseContours(uniformSlope({ ...EXTENT, gradient: 0.1, z0: 50 }), KNOWN);
  const a = terrainAssessment(r);

  it('DTM quality is ready (certainly not blocked)', () => {
    expect(r.quality.readiness).toBe('ready');
    expect(r.quality.readiness).not.toBe('blocked');
    expect(r.quality.exportReadiness).not.toBe('blocked');
  });

  it('Terrain Assessment is NOT Blocked and is georeferenced', () => {
    expect(a.status).not.toBe('Blocked');
    expect(metric(a.supportingMetrics, 'CRS').rating).toBe('good');
    expect(metric(a.supportingMetrics, 'Vertical datum').rating).toBe('good');
  });

  it('contour readiness offers a reliable interval', () => {
    expect(r.gate.recommendedM).not.toBeNull();
    expect(r.gate.recommendedM as number).toBeGreaterThan(0);
    expect(Number.isFinite(r.gate.recommendedM as number)).toBe(true);
    expect(r.intervalM).not.toBeNull();
    expect(r.intervalM as number).toBeGreaterThan(0);
    expect(r.contours.levels.length).toBeGreaterThan(0);
  });
});

describe('terrain VERDICT truth — sparse scene cannot read well', () => {
  // A flat plane sampled at only every 3rd node in each axis: most of the grid
  // is interpolated/extrapolated guesswork.
  // EXPECTED: NOT ready, NOT Good; and the reasons name the thin measured
  // ground (coverage/interpolation). WHY: too little real ground to contour
  // honestly — the gate must not let guesswork read as a usable surface.
  const r = analyseContours(sparse(50, 3, EXTENT), KNOWN);
  const a = terrainAssessment(r);

  it('is neither ready nor Good', () => {
    expect(r.quality.readiness).not.toBe('ready');
    expect(a.status).not.toBe('Good');
  });

  it('the interpolation supporting metric is rated poor', () => {
    // The vast majority of covered cells are interpolated, never measured.
    expect(metric(a.supportingMetrics, 'Interpolation').rating).toBe('poor');
  });

  it('reasons mention density / coverage / measured ground', () => {
    expect(verdictText(r)).toMatch(/measured ground|interpolat|sparse|no data|coverage/);
  });
});

describe('terrain VERDICT truth — edge-clipped coverage is reflected', () => {
  // Half the extent carries no returns at all. EXPECTED: never Good, and the
  // edge-risk it introduces is visible (higher than the same fixture with full
  // coverage, and the Edge-risk metric is not 'good'). WHY: a long reach from
  // real data to the clipped boundary is exactly the risk the assessment must
  // surface rather than hide.
  const clipped = analyseContours(edgeClipped(50, 0.5, EXTENT), KNOWN);
  const full = analyseContours(flatPlane(50, EXTENT), KNOWN);
  const a = terrainAssessment(clipped);

  it('is not Good', () => {
    expect(a.status).not.toBe('Good');
  });

  it('introduces more edge risk than full coverage of the same extent', () => {
    expect(clipped.cellMetrics.edgeRiskRatio).toBeGreaterThan(full.cellMetrics.edgeRiskRatio);
    expect(metric(a.supportingMetrics, 'Edge risk').rating).not.toBe('good');
  });
});

describe('terrain VERDICT truth — unknown CRS gates EXPORT, not surface', () => {
  // A clean gentle slope, but no horizontal CRS supplied. TWO-AXIS truth:
  //   - SURFACE quality is NOT capped by the missing CRS — the surface gate
  //     still reads `ready`, and the surface STATUS is identical to the same
  //     scene WITH a CRS (geometry didn't change).
  //   - EXPORT readiness IS capped to preview, with a reason that names the CRS.
  // This is the new-correct behaviour: an ungeoreferenced but clean surface is
  // still fine to inspect/measure; only the georeferenced hand-off is gated.
  const r = analyseContours(uniformSlope({ ...EXTENT, gradient: 0.1, z0: 50 }), {
    ...KNOWN,
    crs: null,
  });
  const known = analyseContours(uniformSlope({ ...EXTENT, gradient: 0.1, z0: 50 }), KNOWN);
  const a = terrainAssessment(r);

  it('surface quality is NOT capped by the missing CRS (ready, same status as georeferenced)', () => {
    expect(r.quality.readiness).toBe('ready');
    expect(r.quality.crsKnown).toBe(false);
    // Same surface as the georeferenced run — CRS did not demote it.
    expect(a.status).toBe(terrainAssessment(known).status);
  });

  it('EXPORT readiness is preview-only with a reason that names the CRS', () => {
    expect(r.quality.exportReadiness).toBe('previewOnly');
    expect(r.quality.exportReasons.join(' ')).toMatch(/crs/i);
    expect(a.exportReadiness).not.toBe('Ready');
    const crs = metric(a.supportingMetrics, 'CRS');
    expect(crs.value).toMatch(/unknown/i);
    expect(crs.rating).toBe('unknown');
    expect(verdictText(r)).toMatch(/crs|coordinate/);
  });
});

describe('terrain VERDICT truth — unknown vertical datum gates EXPORT, not surface', () => {
  // Same clean slope, known CRS, but no vertical datum. TWO-AXIS truth: the
  // surface gate still reads `ready` (datum does not change the geometry), but
  // EXPORT readiness is capped to preview with a reason that names the datum.
  // WHY: heights with no vertical reference are not safe to hand off as a
  // georeferenced deliverable, even though the surface itself is sound.
  const r = analyseContours(uniformSlope({ ...EXTENT, gradient: 0.1, z0: 50 }), {
    ...KNOWN,
    verticalDatum: null,
  });
  const known = analyseContours(uniformSlope({ ...EXTENT, gradient: 0.1, z0: 50 }), KNOWN);
  const a = terrainAssessment(r);

  it('surface quality is NOT capped by the missing datum (ready, same status as georeferenced)', () => {
    expect(r.quality.readiness).toBe('ready');
    expect(r.quality.datumKnown).toBe(false);
    expect(a.status).toBe(terrainAssessment(known).status);
  });

  it('EXPORT readiness is preview-only with a reason that names the datum', () => {
    expect(r.quality.exportReadiness).toBe('previewOnly');
    expect(r.quality.exportReasons.join(' ')).toMatch(/datum/i);
    expect(a.exportReadiness).not.toBe('Ready');
    const datum = metric(a.supportingMetrics, 'Vertical datum');
    expect(datum.value).toMatch(/unknown/i);
    expect(datum.rating).toBe('unknown');
    expect(verdictText(r)).toMatch(/datum/);
  });
});

describe('terrain VERDICT truth — Surface-Quality vs Export-Readiness separation', () => {
  // The headline separation, end-to-end through the live pipeline. A dense,
  // clean, well-covered slope large enough that no surface cap applies, so the
  // SURFACE reads Good. Run it twice — fully georeferenced, then with the
  // vertical datum dropped:
  //   - known CRS + datum  → Surface Good AND Export Ready (no export reason)
  //   - SAME scene, datum=null → Surface STILL Good; Export only Preview, with
  //     the reason "vertical datum unknown".
  // This proves the two axes move independently: dropping the datum changes the
  // export verdict WITHOUT touching surface quality.
  const SCENE = { nx: 96, ny: 96, spacing: 1, gradient: 0.1, z0: 50 } as const;
  const georeferenced = analyseContours(uniformSlope(SCENE), KNOWN);
  const aGeo = terrainAssessment(georeferenced);
  const datumless = analyseContours(uniformSlope(SCENE), { ...KNOWN, verticalDatum: null });
  const aNull = terrainAssessment(datumless);

  it('georeferenced: Surface Quality Good AND Export Readiness Ready', () => {
    expect(aGeo.status).toBe('Good');
    expect(georeferenced.quality.readiness).toBe('ready');
    expect(aGeo.exportReadiness).toBe('Ready');
    expect(aGeo.exportReason).toBe('');
    expect(georeferenced.quality.exportReadiness).toBe('available');
  });

  it('same scene, datum dropped: Surface Quality STILL Good; Export Readiness only Preview', () => {
    // Surface quality is byte-for-byte unaffected by the datum.
    expect(aNull.status).toBe('Good');
    expect(aNull.status).toBe(aGeo.status);
    expect(datumless.quality.readiness).toBe('ready');
    expect(datumless.quality.readiness).toBe(georeferenced.quality.readiness);
    // Only the export axis drops, and the reason names the datum.
    expect(aNull.exportReadiness).toBe('Preview');
    expect(aNull.exportReason).toMatch(/vertical datum unknown/i);
    expect(datumless.quality.exportReadiness).toBe('previewOnly');
    expect(datumless.quality.exportReasons.join(' ')).toMatch(/vertical datum unknown/i);
  });
});

describe('terrain VERDICT truth — heavy interpolation cannot read well', () => {
  // A gentle slope (real relief, so it is contourable) sampled at every 2nd
  // node: ~3/4 of covered cells are interpolated, not measured. EXPECTED: NOT
  // ready, NOT Good, and the reason names the interpolation. WHY: a surface
  // that is mostly filled-in guesswork must be held below 'ready' even when it
  // is otherwise georeferenced and has relief.
  function sparseSlope(grad: number, z0: number, nx: number, ny: number, keep: number): TerrainPoint[] {
    const pts: TerrainPoint[] = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (i % keep !== 0 || j % keep !== 0) continue;
        pts.push({ x: i, y: j, z: z0 + grad * i });
      }
    }
    return pts;
  }
  const r = analyseContours(sparseSlope(0.2, 50, 64, 64, 2), KNOWN);
  const a = terrainAssessment(r);

  it('a majority of covered cells are interpolated (sanity on the fixture)', () => {
    const t = r.cellStatusTally;
    const covered = t.measured + t.interpolated + t.lowConfidence + t.edgeRisk;
    const interpFrac = covered > 0 ? 1 - t.measured / covered : 1;
    expect(interpFrac).toBeGreaterThan(0.5);
  });

  it('is neither ready nor Good and the reason names interpolation', () => {
    expect(r.quality.readiness).not.toBe('ready');
    expect(a.status).not.toBe('Good');
    expect(metric(a.supportingMetrics, 'Interpolation').rating).toBe('poor');
    expect(verdictText(r)).toMatch(/interpolat/);
  });
});

describe('terrain VERDICT truth — overlay never wrecks the bare-earth verdict', () => {
  // A ground plane (class 2) with a building (class 6) and canopy (class 5)
  // placed on top. EXPECTED: the non-ground returns are dropped before ground
  // filtering, the bare-earth DTM stays at the ground elevation (NOT pulled up
  // to roof/canopy height), and the verdict matches the SAME ground with no
  // overlay. WHY: classification must strip vegetation/buildings so canopy can
  // neither flatter nor wreck the underlying terrain assessment.
  const groundZ = 100;
  const overlay = groundWithOverlay({
    ...EXTENT,
    groundZ,
    building: { i0: 8, i1: 16, j0: 8, j1: 16, heightM: 10 },
    canopy: { i0: 20, i1: 28, j0: 20, j1: 28, heightM: 6 },
  });
  const withOverlay = analyseContours(overlay.points, { ...KNOWN, classification: overlay.classification });
  const bareGround = analyseContours(flatPlane(groundZ, EXTENT), KNOWN);

  it('drops exactly the non-ground (building + canopy) returns', () => {
    const buildingCount = (16 - 8) * (16 - 8); // 64
    const canopyCount = (28 - 20) * (28 - 20); // 64
    expect(withOverlay.excludedByClassification).toBe(buildingCount + canopyCount);
  });

  it('the bare-earth DTM stays at ground elevation, not roof/canopy height', () => {
    const z = coveredZRange(withOverlay);
    expect(z.min).toBeCloseTo(groundZ, 3);
    expect(z.max).toBeCloseTo(groundZ, 3); // never 110 (roof) or 106 (canopy)
  });

  it('the verdict matches the same ground with no overlay (canopy did not change it)', () => {
    expect(withOverlay.quality.readiness).toBe(bareGround.quality.readiness);
    expect(terrainAssessment(withOverlay).status).toBe(terrainAssessment(bareGround).status);
    const o = coveredZRange(withOverlay);
    const g = coveredZRange(bareGround);
    expect(o.min).toBeCloseTo(g.min, 3);
    expect(o.max).toBeCloseTo(g.max, 3);
  });

  it('on a contourable (sloped) bare earth, an overlay leaves the verdict identical', () => {
    // Same comparison on real relief: a sloped ground with vs without a building
    // overlay must yield the SAME readiness / status / interval — the overlay is
    // stripped, the bare-earth assessment is unaffected.
    const buildOverlay = (withBuilding: boolean): { points: TerrainPoint[]; classification: Uint8Array } => {
      const pts: TerrainPoint[] = [];
      const cls: number[] = [];
      for (let j = 0; j < EXTENT.ny; j++) {
        for (let i = 0; i < EXTENT.nx; i++) {
          pts.push({ x: i, y: j, z: groundZ + 0.1 * i });
          cls.push(2);
        }
      }
      if (withBuilding) {
        for (let j = 10; j < 18; j++) {
          for (let i = 10; i < 18; i++) {
            pts.push({ x: i, y: j, z: groundZ + 0.1 * i + 12 });
            cls.push(6);
          }
        }
      }
      return { points: pts, classification: Uint8Array.from(cls) };
    };
    const plain = buildOverlay(false);
    const built = buildOverlay(true);
    const rPlain = analyseContours(plain.points, { ...KNOWN, classification: plain.classification });
    const rBuilt = analyseContours(built.points, { ...KNOWN, classification: built.classification });
    expect(rBuilt.excludedByClassification).toBe((18 - 10) * (18 - 10)); // 64 building returns
    expect(rBuilt.quality.readiness).toBe(rPlain.quality.readiness);
    expect(terrainAssessment(rBuilt).status).toBe(terrainAssessment(rPlain).status);
    expect(rBuilt.intervalM).toBe(rPlain.intervalM);
    // Bare earth identical: the building never raised the surface.
    const zb = coveredZRange(rBuilt);
    const zp = coveredZRange(rPlain);
    expect(zb.min).toBeCloseTo(zp.min, 3);
    expect(zb.max).toBeCloseTo(zp.max, 3);
  });
});
