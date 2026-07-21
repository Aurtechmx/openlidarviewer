/**
 * contourPurposeExportBytes.test.ts
 *
 * END-TO-END proof that selecting a Contour Studio purpose changes the BYTES a
 * user downloads — the release-notes contract "Selecting a purpose is real: it
 * regenerates the exported contour geometry (Survey Review = exact analytical
 * isolines; the cartographic purposes = generalized)".
 *
 * This test emulates the REAL production export path, not just the intent
 * mapping:
 *
 *   1. The on-screen result is built at the panel's default shape style
 *      (`defaultContourShapeStyle` — AnalysePanel._contourStyle's initial value).
 *   2. Each purpose derives its export intent via
 *      `contourExportIntentFromState(applyPurpose(base, purpose))` — the same
 *      call contourStudioMount makes at click time.
 *   3. The export result reproduces AnalysePanel._resultForExport EXACTLY:
 *      reuse the on-screen result when the intent's style matches its style,
 *      otherwise regenerate from the cached core at the intent's style
 *      (= terrainAnalysisRunner.buildResultForExport → contoursFromCore).
 *   4. The bytes compared are the real serialized GeoJSON geometry
 *      (`serializeContours`), with no provenance block, so any difference IS a
 *      geometry difference — the thing the user sees in a GIS.
 *
 * The regression this pins: the cartographic purposes must NOT collapse onto
 * the on-screen default geometry (which would make purpose selection a no-op
 * for every purpose except Survey Review).
 */

import { describe, it, expect } from 'vitest';
import {
  computeTerrainCore,
  contoursFromCore,
  type AnalyseContoursResult,
} from '../src/terrain/contour/analyseContours';
import { serializeContours } from '../src/terrain/contour/contourDownload';
import { defaultContourShapeStyle } from '../src/terrain/contour/contourShapeStyle';
import { buildExportProvenance } from '../src/terrain/export/exportProvenance';
import { contourExportIntentFromState } from '../src/terrain/contourStudio/contourExportIntent';
import { applyPurpose } from '../src/terrain/contourStudio/contourStudioPurpose';
import {
  baseContourStudioState,
  type ContourStudioPurpose,
} from '../src/terrain/contourStudio/contourStudioState';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/**
 * A well-supported synthetic hill with MULTI-SCALE roughness (a broad Gaussian
 * plus a few higher-frequency ripples). A pure Gaussian is too smooth to test
 * this feature: its contour lines deviate from their chords by far less than a
 * quarter-cell, so Douglas–Peucker saturates identically at every tolerance and
 * the light/moderate/strong purposes collapse to byte-identical geometry. Real
 * LiDAR terrain carries roughness at many scales; these ripples put contour
 * deviations across the 0.25–1.0-cell band, so each purpose's tolerance keeps a
 * genuinely different vertex set — the distinctness this test is here to prove.
 * Dense + all-ground ⇒ solid confidence, so the honesty gates pin nothing but
 * the ring anchors and the simplifier is free to drop redundant vertices.
 */
function roughHill(nx = 48, ny = 48, amplitude = 8): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;
  const sigma = (nx - 1) / 3;
  const twoS2 = 2 * sigma * sigma;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i;
      const y = j;
      const base = amplitude * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / twoS2);
      const ripple =
        1.2 * Math.sin(x * 0.55) * Math.cos(y * 0.5) +
        0.7 * Math.sin(x * 1.15 + y * 0.9) +
        0.4 * Math.cos(x * 0.3 - y * 1.4);
      pts.push({ x, y, z: base + ripple });
    }
  }
  return pts;
}

const points = roughHill();
const CORE_PARAMS = { cellSizeM: 1, crs: 'EPSG:32610' } as const;
const INTERVAL_M = 1;

const core = computeTerrainCore(points, CORE_PARAMS);

// The on-screen analysis result: the panel renders at defaultContourShapeStyle.
const onScreen = contoursFromCore(core, {
  intervalM: INTERVAL_M,
  shapeStyle: defaultContourShapeStyle,
});

/** AnalysePanel._resultForExport, faithfully: reuse on style match, else regen. */
function resultForPurpose(purpose: ContourStudioPurpose): {
  result: AnalyseContoursResult;
  intent: ReturnType<typeof contourExportIntentFromState>;
} {
  const intent = contourExportIntentFromState(applyPurpose(baseContourStudioState(), purpose));
  const result =
    intent.shapeStyle === onScreen.model.contourStyle
      ? onScreen
      : contoursFromCore(core, {
          intervalM: INTERVAL_M,
          shapeStyle: intent.shapeStyle,
          // The per-purpose tolerance is what makes the geometry genuinely differ.
          generalizeToleranceCells: intent.generalizeToleranceCells,
        });
  return { result, intent };
}

/** The exact serialized GeoJSON a purpose export downloads (geometry only). */
function geojsonBytes(purpose: ContourStudioPurpose): string {
  const { result } = resultForPurpose(purpose);
  return serializeContours(result.model, 'geojson-native', { basename: 'contours' }).content;
}

const defaultBytes = serializeContours(onScreen.model, 'geojson-native', {
  basename: 'contours',
}).content;

describe('purpose selection changes the exported contour bytes (release-notes contract)', () => {
  it('the fixture yields real contour geometry to compare', () => {
    expect(onScreen.model.features.length).toBeGreaterThan(0);
  });

  it('Survey Review exports exact analytical isolines — different bytes from the default', () => {
    expect(geojsonBytes('survey-review')).not.toBe(defaultBytes);
  });

  it('a cartographic purpose exports GENERALIZED geometry — different bytes from the default', () => {
    // Release notes: "the cartographic purposes = generalized". If this equals
    // the on-screen default, purpose selection changed nothing but a label.
    expect(geojsonBytes('presentation-map')).not.toBe(defaultBytes);
  });

  it('Survey Review and Presentation Map genuinely serialize different vertices', () => {
    expect(geojsonBytes('survey-review')).not.toBe(geojsonBytes('presentation-map'));
  });

  it('the four distinct-purpose exports are PAIRWISE-DISTINCT GeoJSON geometry', () => {
    // The core contract of this change: Survey (exact), Terrain Research (light),
    // Engineering (moderate) and Presentation (strong) each generalise at their
    // own tolerance, so no two share a byte-identical vertex stream.
    const purposes = ['survey-review', 'terrain-research', 'engineering-plan', 'presentation-map'] as const;
    const bytes = purposes.map((p) => geojsonBytes(p));
    for (let i = 0; i < bytes.length; i++) {
      for (let j = i + 1; j < bytes.length; j++) {
        expect(bytes[i], `${purposes[i]} vs ${purposes[j]}`).not.toBe(bytes[j]);
      }
    }
    // All four are genuinely different from each other AND from the on-screen default.
    expect(new Set([...bytes, defaultBytes]).size).toBe(bytes.length + 1);
  });

  it('stronger generalization yields fewer vertices (monotonic within the generalized style)', () => {
    const vertexCount = (purpose: ContourStudioPurpose): number =>
      resultForPurpose(purpose).result.model.features.reduce(
        (sum, f) => sum + f.coordinates.length,
        0,
      );
    // Compared WITHIN the 'generalized' style (all three run simplify → Chaikin ×2,
    // so counts are directly comparable — unlike crisp Survey, which skips both):
    // a larger tolerance drops at least as many vertices. Terrain (0.25) ≥
    // Engineering (0.5) ≥ Presentation (1.0).
    const terrain = vertexCount('terrain-research');
    const engineering = vertexCount('engineering-plan');
    const presentation = vertexCount('presentation-map');
    expect(terrain).toBeGreaterThanOrEqual(engineering);
    expect(engineering).toBeGreaterThanOrEqual(presentation);
    // The extremes genuinely differ (not a degenerate all-equal chain).
    expect(terrain).toBeGreaterThan(presentation);
  });

  it('Custom legitimately SHARES Engineering Plan geometry (both at the neutral 0.5 base)', () => {
    // Documented coincidence: Custom rides the neutral base tolerance (0.5), which
    // equals Engineering Plan's, until the user adjusts it. Same tolerance ⇒ same
    // style ⇒ byte-identical geometry. This is honest, not a collapse bug.
    expect(resultForPurpose('custom').intent.generalizeToleranceCells).toBe(
      resultForPurpose('engineering-plan').intent.generalizeToleranceCells,
    );
    expect(geojsonBytes('custom')).toBe(geojsonBytes('engineering-plan'));
  });

  it('provenance records the per-purpose tolerance and the HONEST method id', () => {
    const expected: Record<string, { method: string; tol: number | null }> = {
      'survey-review': { method: 'olv.contour.analytical@1', tol: null },
      'terrain-research': { method: 'olv.contour.generalize@1', tol: 0.25 },
      'engineering-plan': { method: 'olv.contour.generalize@1', tol: 0.5 },
      'presentation-map': { method: 'olv.contour.generalize@1', tol: 1.0 },
    };
    for (const [purpose, exp] of Object.entries(expected)) {
      const { result, intent } = resultForPurpose(purpose as ContourStudioPurpose);
      const prov = buildExportProvenance(result, {
        contourMethod: intent.methodTag,
        deliverablePurpose: intent.purpose,
      });
      // Honest method id — never the unwired terrain-adaptive module.
      expect(prov.contourMethod).toBe(exp.method);
      expect(prov.contourMethod).not.toContain('terrain-adaptive');
      // The exact tolerance the geometry was generalised at (null for exact/crisp).
      expect(prov.contourGeneralizeToleranceCells).toBe(exp.tol);
    }
  });

  it('a generalized-stamped export is genuinely regenerated (never the on-screen default)', () => {
    for (const p of ['engineering-plan', 'terrain-research', 'presentation-map'] as const) {
      const { result, intent } = resultForPurpose(p);
      expect(intent.methodId).toBe('olv.contour.generalize');
      // A file stamped "generalized" must not carry the untouched default-style
      // geometry — that would be the "all purposes export the same file" bug.
      expect(result.model.contourStyle).not.toBe(defaultContourShapeStyle);
      expect(result.model.contourStyle).toBe('generalized');
    }
  });
});
