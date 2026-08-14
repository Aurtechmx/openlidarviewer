/**
 * measureAreaCrossCheck.test.ts
 *
 * MEAS-AREA cross-implementation check (E4). The candidate polygon-area core
 * `polygonAreaPlanar` (half the Newell-normal magnitude) is compared against an
 * independent implementation — GDAL/OGR's `OGR_GEOM_AREA` — over the committed
 * planar-polygon fixture, and against each polygon's closed-form area. The
 * reference values were produced by ogrinfo and committed under
 * validation/cross-implementation/meas-area/; the study manifest
 * validation/cross-implementation/studies/MEAS-AREA-OGR-PLANAR.study.json and
 * the frozen protocol PROTO-AREA-OGR-PLANAR carry the record and the tolerance.
 *
 * This is cross-implementation agreement on planar polygons, not survey-grade
 * accuracy: both implementations are exact double-precision shoelace/Newell area
 * on the same coplanar rings, so the check witnesses that our formula matches a
 * second one, and stops at the E4 boundary.
 *
 * The gate mirrors the protocol: at least MIN_COMPARABLE polygons must compare,
 * every one within TOLERANCE_ABS of OGR. The tolerance is coarse against the
 * ~1e-9 the two implementations actually reach, yet far tighter than any real
 * area-formula error (a missing half, a dropped term, an unsigned-winding bug).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { polygonAreaPlanar } from '../src/render/measure/geometry';
import type { Vec3 } from '../src/render/navMath';

const DIR = new URL('../validation/cross-implementation/meas-area/', import.meta.url);
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, DIR)), 'utf8');

/** Frozen in PROTO-AREA-OGR-PLANAR; kept in sync with the study manifest. */
const TOLERANCE_ABS = 1e-6; // coordinate units squared (metre² on the local grid)
const MIN_COMPARABLE = 6;

interface Feature {
  properties: { id: string; analyticArea: number };
  geometry: { coordinates: number[][][] };
}
interface RefAreas {
  areas: { id: string; ogrArea: number }[];
}

const fc = JSON.parse(read('input-polygons.geojson')) as { features: Feature[] };
const ref = JSON.parse(read('ogr-reference-areas.json')) as RefAreas;
const ogrById = new Map(ref.areas.map((a) => [a.id, a.ogrArea]));

/** A GeoJSON polygon's outer ring, lifted to z=0 and de-duplicated of its close. */
function ringToVec3(feature: Feature): Vec3[] {
  const ring = feature.geometry.coordinates[0];
  const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1)
    : ring;
  return open.map(([x, y]) => [x, y, 0] as Vec3);
}

describe('MEAS-AREA cross-implementation: polygonAreaPlanar vs GDAL/OGR OGR_GEOM_AREA', () => {
  it('has enough comparable polygons and a reference area for each', () => {
    expect(fc.features.length).toBeGreaterThanOrEqual(MIN_COMPARABLE);
    for (const f of fc.features) {
      expect(ogrById.has(f.properties.id), `OGR area for ${f.properties.id}`).toBe(true);
    }
  });

  for (const f of fc.features) {
    const id = f.properties.id;
    it(`${id}: agrees with OGR and with the closed form within ±${TOLERANCE_ABS}`, () => {
      const ours = polygonAreaPlanar(ringToVec3(f));
      const ogr = ogrById.get(id) as number;
      // candidate ↔ OGR: the cross-implementation leg (the E4 evidence).
      expect(Math.abs(ours - ogr)).toBeLessThanOrEqual(TOLERANCE_ABS);
      // candidate ↔ closed form: guards both implementations against agreeing
      // on a wrong number (the middle leg of the triangle).
      expect(Math.abs(ours - f.properties.analyticArea)).toBeLessThanOrEqual(TOLERANCE_ABS);
    });
  }

  it('the worst candidate-vs-OGR disagreement is non-zero float noise, far inside the tolerance', () => {
    let maxAbsDiff = 0;
    for (const f of fc.features) {
      const ours = polygonAreaPlanar(ringToVec3(f));
      const ogr = ogrById.get(f.properties.id) as number;
      maxAbsDiff = Math.max(maxAbsDiff, Math.abs(ours - ogr));
    }
    // The irrational-coordinate triangle makes the two implementations diverge at
    // the ULP level, so the comparison exercises real double-precision agreement
    // rather than a trivial 0 on exact coordinates — yet the divergence is still
    // orders of magnitude tighter than the registered gate.
    expect(maxAbsDiff).toBeGreaterThan(0);
    expect(maxAbsDiff).toBeLessThan(TOLERANCE_ABS / 100);
  });
});
