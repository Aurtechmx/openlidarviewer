/**
 * mapSheetLanePurpose.test.ts
 *
 * Export › Contours › "Contour map sheet (PDF)" runs through the Contour
 * Studio adapter. It sent the Studio's starting purpose (Custom) even after the
 * user picked another one in the Studio, so the sheet read "Deliverable -
 * Custom". It now sends the purpose chosen in the Studio mounted for the same
 * result, and the starting purpose when the Studio was never opened.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { computeTerrainCore, contoursFromCore } from '../src/terrain/contour/analyseContours';
import { defaultContourShapeStyle } from '../src/terrain/contour/contourShapeStyle';
import { defaultContourExport, mountContourStudio } from '../src/ui/contourStudioMount';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import { installRecordingDom } from './helpers/recordingDom';

beforeAll(() => {
  installRecordingDom();
});

function hill(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let j = 0; j < 60; j++) for (let i = 0; i < 60; i++) {
    const x = i / 2, y = j / 2;
    pts.push({ x, y, z: 5 * Math.exp(-((x - 15) ** 2 + (y - 15) ** 2) / 120) });
  }
  return pts;
}

const result = contoursFromCore(computeTerrainCore(hill(), { cellSizeM: 1, crs: 'EPSG:32610' }), {
  intervalM: 1, shapeStyle: defaultContourShapeStyle,
});
const ctx = { streaming: false, crsProjected: true, verticalUnitsKnown: true, verticalUnitToMetres: 1, verticalUnitLabel: 'm', precision: null };

describe('map sheet from the Export lane', () => {
  it('uses the starting purpose when the Studio was not opened', () => {
    expect(defaultContourExport(result, ctx).intent.purpose).toBe('custom');
  });

  it('uses the purpose chosen in the Studio for the same result', () => {
    // The deliverable host only has to take the workspace; nothing reads it back.
    const host = Object.assign(document.createElement('div'), { querySelector: () => null });
    const controller = mountContourStudio({
      result, ctx, launcherHost: document.createElement('div'), deliverableHost: host, onLaunch: () => {},
    });
    controller.dispatch({ type: 'set-purpose', purpose: 'engineering-plan' });
    expect(defaultContourExport(result, ctx).intent.purpose).toBe('engineering-plan');
  });
});
