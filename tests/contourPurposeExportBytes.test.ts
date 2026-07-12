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
import { contourExportIntentFromState } from '../src/terrain/contourStudio/contourExportIntent';
import { applyPurpose } from '../src/terrain/contourStudio/contourStudioPurpose';
import {
  baseContourStudioState,
  type ContourStudioPurpose,
} from '../src/terrain/contourStudio/contourStudioState';
import { gaussianHill } from './fixtures/terrainScenes';

// A smooth, well-supported synthetic hill — solid confidence, so both the
// smoother and the simplifier are genuinely allowed to move/drop vertices
// (nothing is pinned by the honesty gates except the ring anchors).
const points = gaussianHill({ nx: 40, ny: 40, spacing: 1, amplitude: 8 });
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
  methodId: string;
} {
  const intent = contourExportIntentFromState(applyPurpose(baseContourStudioState(), purpose));
  const result =
    intent.shapeStyle === onScreen.model.contourStyle
      ? onScreen
      : contoursFromCore(core, { intervalM: INTERVAL_M, shapeStyle: intent.shapeStyle });
  return { result, methodId: intent.methodId };
}

/** The exact serialized GeoJSON a purpose export downloads (geometry only). */
function geojsonBytes(purpose: ContourStudioPurpose): string {
  const { result } = resultForPurpose(purpose);
  return serializeContours(result.model, 'geojson', { basename: 'contours' }).content;
}

const defaultBytes = serializeContours(onScreen.model, 'geojson', {
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

  it('a purpose stamped with the generalize method actually regenerates (no stamp without the method)', () => {
    for (const p of ['engineering-plan', 'terrain-research', 'presentation-map'] as const) {
      const { result, methodId } = resultForPurpose(p);
      if (methodId === 'olv.contour.generalize.terrain-adaptive') {
        // A file stamped "generalized" must not carry the untouched default-style
        // geometry — that would be a provenance overclaim.
        expect(result.model.contourStyle).not.toBe(defaultContourShapeStyle);
      }
    }
  });
});
