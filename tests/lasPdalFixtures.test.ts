/**
 * tests/lasPdalFixtures.test.ts
 *
 * Two LAS files from the PDAL project's own test corpus (PDAL/PDAL
 * `test/data/las/`, BSD-3-Clause, (c) Hobu Inc.), read here by a second
 * implementation:
 *
 *   • `utm15.las` (472 bytes) was written by libLAS 1.2 in 2008, years before
 *     PDAL existed. Its CRS travels in GeoTIFF VLRs (34735 GeoKeyDirectoryTag,
 *     34737 GeoAsciiParamsTag) and the file carries no WKT VLR at all, so it
 *     exercises the legacy LAS 1.2 GeoTIFF branch of `parseCrsFromVlrs`. Every
 *     other georeferenced LAS fixture in this tree takes the 1.4 WKT branch.
 *
 *   • `synthetic_test.las` (261 bytes) was written by PDAL 2.0.0 with ZERO
 *     VLRs, so it declares no CRS of any kind. It is the natural fixture for
 *     the fail-closed unit gate: a file that declares nothing must report the
 *     linear unit as unknown, and every claim gated on a known unit must stay
 *     closed for it.
 *
 * Both files hold exactly one point, so every bounding box has zero extent on
 * all three axes. That is the degenerate input for the code that divides by an
 * extent (density, spacing, camera fit, in-memory precision), and the last
 * section pins that those stay finite.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLasHeader } from '../src/io/lasHeader';
import { loadLas } from '../src/io/loadLas';
import { isLinearUnitKnown } from '../src/geo/CoordinateTypes';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { getCrsEntry, resolveHorizontalDatum } from '../src/geo/CrsRegistry';
import { estimateInMemoryPrecision } from '../src/geo/inMemoryPrecision';
import { scanReport } from '../src/analysis/modules/scanReport';
import { deriveScanFacts } from '../src/process/scanFacts';
import { capabilityFor, evaluateCapabilities } from '../src/process/processCapabilities';
import { fitBoxDistance } from '../src/render/camera/cameraPresets';
import type { PointCloud } from '../src/model/PointCloud';
import type { ProductId } from '../src/process/ProcessPlan';

/** Read a fixture as a tightly-sliced ArrayBuffer (no pooled Node padding). */
function loadFixture(name: string): ArrayBuffer {
  const file = readFileSync(
    fileURLToPath(new URL(`./fixtures/las-pdal/${name}`, import.meta.url)),
  );
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

/** The capability plan for one loaded fixture, treated as a full static scan. */
function planFor(cloud: PointCloud) {
  return evaluateCapabilities({
    scans: [
      deriveScanFacts({
        kind: 'static',
        coverage: 'full',
        crs: cloud.metadata?.crs ?? null,
        pointCount: cloud.pointCount,
      }),
    ],
  });
}

/** The products whose verdict is gated on a known linear unit. */
const UNIT_GATED: readonly ProductId[] = [
  'classify-gaps',
  'dtm',
  'dsm',
  'contours',
  'building-footprints',
];

// ─────────────────────────────────────────────────────────────────────────────
// utm15.las: the GeoTIFF-keyed CRS path (no WKT VLR)
// ─────────────────────────────────────────────────────────────────────────────

describe('utm15.las — CRS resolved from GeoTIFF keys', () => {
  const header = parseLasHeader(loadFixture('utm15.las'));

  test('the file is LAS 1.2, point format 3, one point', () => {
    expect(header.versionMinor).toBe(2);
    expect(header.pointFormat).toBe(3);
    expect(header.pointCount).toBe(1);
  });

  test('the CRS comes from the GeoTIFF keys, not from a WKT VLR', () => {
    expect(header.crs).not.toBeNull();
    expect(header.crs!.source).toBe('geotiff');
    // A GeoTIFF-only file has no WKT to keep, so the raw-WKT field stays empty.
    expect(header.crs!.wkt).toBeUndefined();
  });

  test('ProjectedCSTypeGeoKey (3072) resolves to UTM zone 15 on NAD83', () => {
    expect(header.crs!.epsg).toBe(26915);
    expect(header.crs!.isGeographic).toBe(false);
    // The registry is what names the datum for a GeoTIFF file: the GeoTIFF path
    // fills no `horizontalDatum` (only a WKT DATUM/GEOGCS clause does), and
    // `resolveHorizontalDatum` falls back to the curated entry for the EPSG.
    expect(header.crs!.horizontalDatum).toBeUndefined();
    expect(resolveHorizontalDatum(header.crs!.horizontalDatum, header.crs!.epsg)).toBe('NAD83');
    expect(getCrsEntry(26915)?.label).toBe('NAD83 / UTM zone 15N');
  });

  test('ProjLinearUnitsGeoKey (3076) code 9001 reports metre, and metre is KNOWN', () => {
    expect(header.crs!.linearUnit).toBe('metre');
    expect(header.crs!.linearUnitToMetres).toBe(1);
    expect(isLinearUnitKnown(header.crs)).toBe(true);
  });

  test('the name falls back to the EPSG code: the file carries no 3073 citation', () => {
    // The two ASCII citations this file does carry are GTCitationGeoKey (1026,
    // "UTM Zone 15, Northern Hemisphere") and GeogCitationGeoKey (2049,
    // "NAD83"). Neither is read as the projected CRS name: 2049 names the
    // geographic base, and 1026 is not among the keys the parser collects.
    expect(header.crs!.name).toBe('EPSG:26915');
  });

  test('the spatial context permits metric claims', () => {
    const ctx = spatialContextFrom(header.crs);
    expect(ctx.kind).toBe('projected');
    expect(ctx.epsg).toBe(26915);
    expect(ctx.linearUnit).toBe('metre');
    expect(ctx.linearUnitKnown).toBe(true);
    expect(ctx.metricClaimsPermitted).toBe(true);
  });

  test('no unit-gated product is withheld for an unknown unit', async () => {
    const cloud = await loadLas(loadFixture('utm15.las'), 'las', 'utm15.las');
    const plan = planFor(cloud);
    for (const product of UNIT_GATED) {
      expect(capabilityFor(plan, product)?.reasonCode).not.toBe('UNIT_UNKNOWN');
    }
  });

  test('the loaded cloud carries the parsed CRS in its metadata', async () => {
    const cloud = await loadLas(loadFixture('utm15.las'), 'las', 'utm15.las');
    expect(cloud.metadata?.crs?.epsg).toBe(26915);
    expect(cloud.metadata?.crs?.linearUnit).toBe('metre');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// utm15.las: coordinate decode at the file's 0.01 scale
// ─────────────────────────────────────────────────────────────────────────────

describe('utm15.las — decoded coordinate at scale 0.01', () => {
  const header = parseLasHeader(loadFixture('utm15.las'));

  test('scale is 0.01 on all axes and offset is zero', () => {
    expect(header.scale).toEqual([0.01, 0.01, 0.01]);
    expect(header.offset).toEqual([0, 0, 0]);
  });

  test('the header bounding box holds the full-precision source coordinate', () => {
    // The public header stores bounds as float64, so libLAS wrote the source
    // coordinate there at full precision. min === max: one point.
    expect(header.min).toEqual([470692.447538, 4602888.904642, 16]);
    expect(header.max).toEqual([470692.447538, 4602888.904642, 16]);
  });

  test('the point record is the header coordinate truncated onto the 0.01 lattice', async () => {
    // The record holds int32 X/Y/Z of 47069244 / 460288890 / 1600, which at
    // scale 0.01 and offset 0 decode to 470692.44 / 4602888.90 / 16. The header
    // bbox above is 0.0075 m further east and 0.0046 m further north: those
    // values are not on the 0.01 lattice, and libLAS truncated toward zero when
    // it quantized the record. The decoded point is the file's point; the
    // difference is inherent to the fixture, not to the decode.
    const cloud = await loadLas(loadFixture('utm15.las'), 'las', 'utm15.las');
    expect(cloud.pointCount).toBe(1);
    expect(cloud.origin).toEqual([470692, 4602888, 16]);
    const global = [
      cloud.positions[0] + cloud.origin[0],
      cloud.positions[1] + cloud.origin[1],
      cloud.positions[2] + cloud.origin[2],
    ];
    const expected = [470692.44, 4602888.9, 16];
    for (let axis = 0; axis < 3; axis++) {
      expect(Math.abs(global[axis] - expected[axis])).toBeLessThanOrEqual(1e-6);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// synthetic_test.las: zero VLRs, so the unit gate must stay closed
// ─────────────────────────────────────────────────────────────────────────────

describe('synthetic_test.las — a file with no CRS fails closed', () => {
  const header = parseLasHeader(loadFixture('synthetic_test.las'));

  test('no VLR means no CRS at all, not an assumed one', () => {
    expect(header.crs).toBeNull();
  });

  test('the linear unit is UNKNOWN', () => {
    expect(isLinearUnitKnown(header.crs)).toBe(false);
  });

  test('the spatial context refuses metric claims', () => {
    const ctx = spatialContextFrom(header.crs);
    expect(ctx.kind).toBe('unknown');
    expect(ctx.epsg).toBeUndefined();
    expect(ctx.linearUnit).toBe('unknown');
    expect(ctx.linearUnitKnown).toBe(false);
    expect(ctx.metricClaimsPermitted).toBe(false);
  });

  test('the loaded cloud carries no CRS in its metadata', async () => {
    const cloud = await loadLas(
      loadFixture('synthetic_test.las'),
      'las',
      'synthetic_test.las',
    );
    expect(cloud.metadata?.crs).toBeUndefined();
    expect(isLinearUnitKnown(cloud.metadata?.crs)).toBe(false);
  });

  test('every unit-gated product is withheld with UNIT_UNKNOWN', async () => {
    const cloud = await loadLas(
      loadFixture('synthetic_test.las'),
      'las',
      'synthetic_test.las',
    );
    const plan = planFor(cloud);
    for (const product of UNIT_GATED) {
      const verdict = capabilityFor(plan, product);
      expect(verdict?.reasonCode).toBe('UNIT_UNKNOWN');
      expect(verdict?.readiness).not.toBe('ready');
    }
  });

  test('the scan report shows source units and never stamps metres', async () => {
    const cloud = await loadLas(
      loadFixture('synthetic_test.las'),
      'las',
      'synthetic_test.las',
    );
    const rows = scanReport.run(cloud).rows;
    for (const label of ['Width', 'Depth', 'Height']) {
      const row = rows.find((r) => r.label === label);
      expect(row).toBeDefined();
      expect(row!.value).toContain('(source units)');
      expect(row!.value).not.toMatch(/\bm\b/);
    }
  });

  test('the single point decodes to 1, 2, 3', async () => {
    const cloud = await loadLas(
      loadFixture('synthetic_test.las'),
      'las',
      'synthetic_test.las',
    );
    expect(cloud.pointCount).toBe(1);
    expect(header.scale).toEqual([0.01, 0.01, 0.01]);
    for (let axis = 0; axis < 3; axis++) {
      const global = cloud.positions[axis] + cloud.origin[axis];
      expect(Math.abs(global - [1, 2, 3][axis])).toBeLessThanOrEqual(1e-6);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Both fixtures: one point, so every extent is zero on every axis
// ─────────────────────────────────────────────────────────────────────────────

describe.each(['utm15.las', 'synthetic_test.las'])(
  '%s — a zero-extent bounding box stays finite',
  (name) => {
    test('bounds are finite and min equals max on all three axes', async () => {
      const cloud = await loadLas(loadFixture(name), 'las', name);
      const { min, max } = cloud.bounds();
      for (let axis = 0; axis < 3; axis++) {
        expect(Number.isFinite(min[axis])).toBe(true);
        expect(Number.isFinite(max[axis])).toBe(true);
        expect(max[axis] - min[axis]).toBe(0);
      }
    });

    test('no decoded position is NaN', async () => {
      const cloud = await loadLas(loadFixture(name), 'las', name);
      for (let i = 0; i < cloud.positions.length; i++) {
        expect(Number.isFinite(cloud.positions[i])).toBe(true);
      }
    });

    test('density and spacing report a degenerate footprint, not a division result', async () => {
      // Footprint area is 0, so `count / area` would be Infinity and
      // `sqrt(area / count)` would be 0. The report branches before either.
      const cloud = await loadLas(loadFixture(name), 'las', name);
      const rows = scanReport.run(cloud).rows;
      for (const label of ['Density', 'Spacing']) {
        const row = rows.find((r) => r.label === label);
        expect(row?.value).toBe('N/A (degenerate footprint)');
        expect(row?.status).toBe('warn');
      }
    });

    test('no scan-report row prints NaN or Infinity', async () => {
      const cloud = await loadLas(loadFixture(name), 'las', name);
      for (const row of scanReport.run(cloud).rows) {
        expect(row.value).not.toMatch(/NaN|Infinity/);
      }
    });

    test('the camera box fit returns a finite positive distance', async () => {
      const cloud = await loadLas(loadFixture(name), 'las', name);
      const { min, max } = cloud.bounds();
      const dist = fitBoxDistance({
        boxMin: { x: min[0], y: min[1], z: min[2] },
        boxMax: { x: max[0], y: max[1], z: max[2] },
        look: { x: 0, y: -1, z: -1 },
        worldUp: { x: 0, y: 0, z: 1 },
        fovDeg: 60,
        aspect: 1.5,
      });
      expect(Number.isFinite(dist)).toBe(true);
      expect(dist).toBeGreaterThan(0);
    });

    test('the in-memory precision estimate is finite on a zero reach', async () => {
      const cloud = await loadLas(loadFixture(name), 'las', name);
      const { min, max } = cloud.bounds();
      const so = cloud.sourceOrigin;
      const ctx = spatialContextFrom(cloud.metadata?.crs);
      const precision = estimateInMemoryPrecision({
        extent: {
          min: [min[0] + so[0], min[1] + so[1], min[2] + so[2]],
          max: [max[0] + so[0], max[1] + so[1], max[2] + so[2]],
        },
        strategy: { kind: 'shared-origin', origin: [so[0], so[1], so[2]] },
        unit: {
          linearUnitKnown: ctx.linearUnitKnown,
          linearUnitToMetres: ctx.linearUnitToMetres,
        },
      });
      expect(Number.isFinite(precision.worstCaseSpacing)).toBe(true);
      expect(Number.isFinite(precision.typicalSpacing)).toBe(true);
      expect(precision.worstCaseSpacing).toBeGreaterThan(0);
      // The metre figures exist only when the unit is established, which is the
      // same fail-closed rule the report rows above follow.
      expect(precision.metres === null).toBe(!ctx.linearUnitKnown);
    });
  },
);
