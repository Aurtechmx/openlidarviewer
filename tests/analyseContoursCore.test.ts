/**
 * analyseContoursCore.test.ts — proves the core/interval split is a PURE
 * refactor.
 *
 * Three properties:
 *   1. Equivalence — `analyseContours` (now = contoursFromCore∘computeTerrainCore)
 *      produces the same key fields as a direct two-step run for several scenes.
 *   2. Split property — `computeTerrainCore` runs once and is reused for two
 *      different intervals; the heavy core (dtm/quality/surface) is byte-identical
 *      across both, while the contour products differ by interval.
 *   3. Float32Array vs TerrainPoint[] entry produce identical results.
 *
 * Pure data: no DOM, no I/O. Deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  analyseContours,
  computeTerrainCore,
  contoursFromCore,
  type AnalyseContoursParams,
  type AnalyseContoursResult,
  type TerrainCore,
} from '../src/terrain/contour/analyseContours';
import {
  gaussianHill,
  ridge,
  terrace,
  pit,
} from './fixtures/terrainScenes';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/** Pack a TerrainPoint[] into a Float32Array of XYZ triples (length 3N). */
function toPositions(points: ReadonlyArray<TerrainPoint>): Float32Array {
  const f = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    f[i * 3] = points[i].x;
    f[i * 3 + 1] = points[i].y;
    f[i * 3 + 2] = points[i].z;
  }
  return f;
}

/**
 * Box a Float32Array of XYZ triples into TerrainPoint[] exactly as the old
 * main.ts did — reading the SAME float32 values. This makes the two entry
 * forms numerically identical so the comparison isolates the entry path, not
 * float64→float32 rounding (which is intrinsic to the typed-array store and
 * already present in the production cloud, which is a Float32Array).
 */
function fromPositions(f: Float32Array): TerrainPoint[] {
  const n = (f.length / 3) | 0;
  const pts: TerrainPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    pts[i] = { x: f[i * 3], y: f[i * 3 + 1], z: f[i * 3 + 2] };
  }
  return pts;
}

/** The interval-independent fields that must NEVER change with the interval. */
function coreFingerprint(r: AnalyseContoursResult) {
  return {
    dtmZ: Array.from(r.dtm.z),
    dtmCoverage: Array.from(r.dtm.coverage),
    dtmConfidence: Array.from(r.dtm.confidence),
    meanConfidence: r.dtm.meanConfidence,
    qualityReadiness: r.quality.readiness,
    qualityExportReadiness: r.quality.exportReadiness,
    qualityScore: r.qualityScore.score,
    accuracyStandards: r.accuracyStandards,
    surfaceDsm: r.surface.dsm,
    surfaceSlope: r.surface.slope,
    surfaceHillshade: Array.from(r.surface.hillshade.shade),
    cellMetrics: r.cellMetrics,
    cellStatusTally: r.cellStatusTally,
    validationRmse: r.validation.rmse,
    accuracyNva95: r.accuracy.nva95,
    elevationRangeM: r.elevationRangeM,
    excludedByClassification: r.excludedByClassification,
    gate: r.gate,
  };
}

/** The interval-dependent contour fields. */
function contourFingerprint(r: AnalyseContoursResult) {
  return {
    intervalM: r.intervalM,
    contourCount: r.contours.levels.length,
    contourValues: r.contours.levels.map((l) => l.value),
    stitchedCount: r.stitched.length,
    styleCount: r.style.levels.length,
    modelFeatures: r.model.features.length,
    tally: r.tally,
    labelCount: r.labels.length,
    gridRecommendation: r.gridRecommendation,
  };
}

const SCENES: ReadonlyArray<[string, TerrainPoint[]]> = [
  ['gaussianHill', gaussianHill({ amplitude: 12 })],
  ['ridge', ridge({ amplitude: 10 })],
  ['terrace', terrace({ stepHeight: 4 })],
  ['pit', pit({ depth: 9 })],
];

describe('computeTerrainCore + contoursFromCore (pure split)', () => {
  describe('equivalence: analyseContours = contoursFromCore∘computeTerrainCore', () => {
    for (const [name, pts] of SCENES) {
      it(`matches a manual two-step run for ${name}`, () => {
        const params: AnalyseContoursParams = {
          cellSizeM: 2,
          crs: 'EPSG:32610',
          verticalDatum: 'EPSG:5703',
        };
        const oneShot = analyseContours(pts, params);
        const twoStep = contoursFromCore(computeTerrainCore(pts, params), params);
        expect(coreFingerprint(twoStep)).toEqual(coreFingerprint(oneShot));
        expect(contourFingerprint(twoStep)).toEqual(contourFingerprint(oneShot));
        expect(twoStep.warnings).toEqual(oneShot.warnings);
        expect(twoStep.generationParams).toEqual(oneShot.generationParams);
      });
    }
  });

  describe('split property: one core, two intervals', () => {
    const pts = gaussianHill({ amplitude: 14 });
    const params: AnalyseContoursParams = {
      cellSizeM: 2,
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
    };
    const core: TerrainCore = computeTerrainCore(pts, params);

    const A = contoursFromCore(core, { intervalM: 1 });
    const B = contoursFromCore(core, { intervalM: 4 });

    it('reuses the SAME core object (no recompute)', () => {
      // The heavy products are passed through by reference from the one core.
      expect(A.dtm).toBe(core.dtm);
      expect(B.dtm).toBe(core.dtm);
      expect(A.surface).toBe(core.surface);
      expect(B.surface).toBe(core.surface);
      expect(A.validation).toBe(core.validation);
      expect(A.quality).toBe(core.quality);
      expect(A.gate).toBe(core.gate);
    });

    it('keeps the dtm/quality/surface IDENTICAL across intervals', () => {
      expect(coreFingerprint(A)).toEqual(coreFingerprint(B));
    });

    it('produces DIFFERENT contours per interval', () => {
      expect(A.intervalM).toBe(1);
      expect(B.intervalM).toBe(4);
      // A finer interval yields strictly more contour levels here.
      expect(A.contours.levels.length).toBeGreaterThan(B.contours.levels.length);
      expect(contourFingerprint(A)).not.toEqual(contourFingerprint(B));
    });

    it('matches a fresh single-pass run for each interval', () => {
      const freshA = analyseContours(pts, { ...params, intervalM: 1 });
      const freshB = analyseContours(pts, { ...params, intervalM: 4 });
      expect(contourFingerprint(A)).toEqual(contourFingerprint(freshA));
      expect(contourFingerprint(B)).toEqual(contourFingerprint(freshB));
      expect(coreFingerprint(A)).toEqual(coreFingerprint(freshA));
    });
  });

  describe('Float32Array entry equals TerrainPoint[] entry', () => {
    for (const [name, pts] of SCENES) {
      it(`identical results for ${name}`, () => {
        const params = { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' };
        // Compare the two entry forms on the SAME float32 numbers (the typed
        // array is the source of truth; the object array boxes its values).
        const positions = toPositions(pts);
        const fromObjects = analyseContours(fromPositions(positions), params);
        const fromTyped = analyseContours(positions, params);
        expect(coreFingerprint(fromTyped)).toEqual(coreFingerprint(fromObjects));
        expect(contourFingerprint(fromTyped)).toEqual(contourFingerprint(fromObjects));
        expect(fromTyped.warnings).toEqual(fromObjects.warnings);
      });
    }

    it('computeTerrainCore accepts both forms identically', () => {
      const pts = gaussianHill({ amplitude: 10 });
      const params = { cellSizeM: 2, crs: 'EPSG:32610' };
      const positions = toPositions(pts);
      const coreObj = computeTerrainCore(fromPositions(positions), params);
      const coreTyped = computeTerrainCore(positions, params);
      expect(Array.from(coreTyped.dtm.z)).toEqual(Array.from(coreObj.dtm.z));
      expect(coreTyped.qualityScore.score).toBe(coreObj.qualityScore.score);
      expect(coreTyped.gate).toEqual(coreObj.gate);
      expect(coreTyped.coreWarnings).toEqual(coreObj.coreWarnings);
    });
  });

  describe('flat scene: no interval, core still complete', () => {
    const flat: TerrainPoint[] = [];
    for (let x = 0; x <= 10; x++) for (let y = 0; y <= 10; y++) flat.push({ x, y, z: 5 });
    const core = computeTerrainCore(flat, { cellSizeM: 2, crs: 'EPSG:32610' });

    it('core has a usable dtm but the contour stage yields no interval', () => {
      const r = contoursFromCore(core, {});
      expect(r.intervalM).toBeNull();
      expect(r.contours.levels.length).toBe(0);
      expect(r.warnings.join(' ')).toMatch(/no reliable contour interval/i);
      // The "no interval" warning is appended AFTER the core warnings.
      expect(r.warnings.slice(0, core.coreWarnings.length)).toEqual([...core.coreWarnings]);
    });

    it('equals the one-shot flat run', () => {
      const r = contoursFromCore(core, {});
      const oneShot = analyseContours(flat, { cellSizeM: 2, crs: 'EPSG:32610' });
      expect(r.warnings).toEqual(oneShot.warnings);
      expect(contourFingerprint(r)).toEqual(contourFingerprint(oneShot));
    });
  });
});
