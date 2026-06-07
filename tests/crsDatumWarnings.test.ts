/**
 * crsDatumWarnings.test.ts
 *
 * VALIDATION of CRS / vertical-datum warning PROPAGATION through the
 * contour pipeline. An export that silently drops its georeferencing is
 * worse than no export — a GIS user can't tell it's unusable. This suite
 * pins three things, end to end:
 *
 *   1. The known-good case (real CRS + real vertical datum) produces NO
 *      CRS / datum warning, the GeoJSON carries a `crs` member, and the
 *      metadata records the vertical datum with no warnings.
 *   2. An unknown / null CRS surfaces the specific model warning AND the
 *      GeoJSON omits the `crs` member while propagating the warning into
 *      metadata.warnings.
 *   3. An unknown / null vertical datum surfaces the specific model
 *      warning AND propagates it into metadata.warnings (with a null
 *      metadata.verticalDatum).
 *
 * The exact warning strings are pinned (read from contourFeatureModel.ts,
 * not invented) so a wording change is a deliberate, reviewed event.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { describe, it, expect } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import {
  buildFeatureModel,
  type ContourFeatureModel,
} from '../src/terrain/contour/contourFeatureModel';
import { toGeoJSON } from '../src/terrain/contour/geojsonContours';
import { groundWithOverlay } from './fixtures/terrainScenes';

// Exact warning text the model emits (pinned to contourFeatureModel.ts).
const CRS_WARNING =
  'CRS unknown — this export is not georeferenced and may be unusable downstream';
const DATUM_WARNING =
  'Vertical datum unknown — contour elevations are not tied to a known datum';

const KNOWN_CRS = 'EPSG:32610';
const KNOWN_DATUM = 'NAVD88';

const EXTENT = { nx: 24, ny: 24, spacing: 1 } as const;

/**
 * A scene with real relief so contour features actually exist and the
 * GeoJSON has geometry to carry provenance on. A bare-earth slope (built
 * via the building overlay sitting on a flat ground would be flat); we
 * tilt the ground by giving it varying groundZ through a manual slope is
 * unnecessary — groundWithOverlay's flat ground still yields a valid
 * model (the warnings live on the model regardless of feature count), but
 * we add relief so the integration path exercises real contours.
 */
function reliefScene(): ReturnType<typeof groundWithOverlay> {
  // groundWithOverlay produces a flat ground; to get relief for contours we
  // post-process the ground nodes into a gentle ramp. The classification and
  // overlay remain intact so the pipeline's class filter still runs.
  const scene = groundWithOverlay({
    ...EXTENT,
    groundZ: 100,
    building: { i0: 8, i1: 14, j0: 8, j1: 14, heightM: 8 },
  });
  const ramped = scene.points.map((p) => ({ x: p.x, y: p.y, z: p.z + 0.3 * p.x }));
  return { points: ramped, classification: scene.classification };
}

/** Geometry-free model with the given CRS/datum (fast, exercises buildFeatureModel). */
function modelWith(crs: string | null, verticalDatum: string | null): ContourFeatureModel {
  return buildFeatureModel([], [], { crs, verticalDatum, intervalM: 1 });
}

describe('CRS / datum warnings — buildFeatureModel (direct)', () => {
  it('known CRS + known datum emit no CRS/datum warning', () => {
    const model = modelWith(KNOWN_CRS, KNOWN_DATUM);
    expect(model.crs).toBe(KNOWN_CRS);
    expect(model.verticalDatum).toBe(KNOWN_DATUM);
    expect(model.warnings).not.toContain(CRS_WARNING);
    expect(model.warnings).not.toContain(DATUM_WARNING);
  });

  it('unknown CRS emits exactly the CRS warning', () => {
    const model = modelWith(null, KNOWN_DATUM);
    expect(model.crs).toBeNull();
    expect(model.warnings).toContain(CRS_WARNING);
    expect(model.warnings).not.toContain(DATUM_WARNING);
  });

  it('unknown vertical datum emits exactly the datum warning', () => {
    const model = modelWith(KNOWN_CRS, null);
    expect(model.verticalDatum).toBeNull();
    expect(model.warnings).toContain(DATUM_WARNING);
    expect(model.warnings).not.toContain(CRS_WARNING);
  });

  it('both unknown emit both warnings', () => {
    const model = modelWith(null, null);
    expect(model.warnings).toEqual([CRS_WARNING, DATUM_WARNING]);
  });
});

describe('CRS / datum warnings — GeoJSON export propagation', () => {
  it('known CRS + datum: crs member present, datum in metadata, no warnings', () => {
    const gj = toGeoJSON(modelWith(KNOWN_CRS, KNOWN_DATUM)) as {
      crs?: { type: string; properties: { name: string } };
      metadata: { verticalDatum: string | null; warnings: string[] };
    };
    expect(gj.crs).toBeDefined();
    // EPSG codes are emitted as the OGC URN QGIS reads.
    expect(gj.crs?.properties.name).toBe('urn:ogc:def:crs:EPSG::32610');
    expect(gj.metadata.verticalDatum).toBe(KNOWN_DATUM);
    expect(gj.metadata.warnings).not.toContain(CRS_WARNING);
    expect(gj.metadata.warnings).not.toContain(DATUM_WARNING);
  });

  it('unknown CRS: crs member omitted, warning in metadata.warnings', () => {
    const gj = toGeoJSON(modelWith(null, KNOWN_DATUM)) as {
      crs?: unknown;
      metadata: { warnings: string[] };
    };
    expect(gj.crs).toBeUndefined();
    expect(gj.metadata.warnings).toContain(CRS_WARNING);
  });

  it('unknown datum: null verticalDatum, warning in metadata.warnings', () => {
    const gj = toGeoJSON(modelWith(KNOWN_CRS, null)) as {
      metadata: { verticalDatum: string | null; warnings: string[] };
    };
    expect(gj.metadata.verticalDatum).toBeNull();
    expect(gj.metadata.warnings).toContain(DATUM_WARNING);
  });
});

describe('CRS / datum warnings — full analyseContours integration', () => {
  const scene = reliefScene();
  const base = {
    cellSizeM: 1,
    classification: scene.classification,
  } as const;

  it('known CRS + datum: model + GeoJSON carry no CRS/datum warning', () => {
    const res = analyseContours(scene.points, {
      ...base,
      crs: KNOWN_CRS,
      verticalDatum: KNOWN_DATUM,
    });
    expect(res.model.crs).toBe(KNOWN_CRS);
    expect(res.model.verticalDatum).toBe(KNOWN_DATUM);
    expect(res.model.warnings).not.toContain(CRS_WARNING);
    expect(res.model.warnings).not.toContain(DATUM_WARNING);

    const gj = toGeoJSON(res.model) as {
      crs?: { properties: { name: string } };
      metadata: { verticalDatum: string | null; warnings: string[] };
    };
    expect(gj.crs?.properties.name).toBe('urn:ogc:def:crs:EPSG::32610');
    expect(gj.metadata.verticalDatum).toBe(KNOWN_DATUM);
    expect(gj.metadata.warnings).not.toContain(CRS_WARNING);
  });

  it('null CRS: warning appears in model + propagates to GeoJSON metadata, crs omitted', () => {
    const res = analyseContours(scene.points, {
      ...base,
      crs: null,
      verticalDatum: KNOWN_DATUM,
    });
    expect(res.model.crs).toBeNull();
    expect(res.model.warnings).toContain(CRS_WARNING);

    const gj = toGeoJSON(res.model) as { crs?: unknown; metadata: { warnings: string[] } };
    expect(gj.crs).toBeUndefined();
    expect(gj.metadata.warnings).toContain(CRS_WARNING);
  });

  it('null vertical datum: warning appears in model + propagates to GeoJSON metadata', () => {
    const res = analyseContours(scene.points, {
      ...base,
      crs: KNOWN_CRS,
      verticalDatum: null,
    });
    expect(res.model.verticalDatum).toBeNull();
    expect(res.model.warnings).toContain(DATUM_WARNING);

    const gj = toGeoJSON(res.model) as {
      metadata: { verticalDatum: string | null; warnings: string[] };
    };
    expect(gj.metadata.verticalDatum).toBeNull();
    expect(gj.metadata.warnings).toContain(DATUM_WARNING);
  });
});
