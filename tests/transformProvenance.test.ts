/**
 * transformProvenance.test.ts — provenance for a coordinate transform (P1 #7).
 *
 * A reprojection RESULT should be able to say which operation produced it, its
 * accuracy, the source/target datum + realization, and the source coordinate
 * epoch — derived from real signals, never fabricated. This pins:
 *
 *   1. buildTransformProvenance — table-driven over the four cases the roadmap
 *      names: same-datum (no shift, epoch absent), a known-caveat datum shift
 *      (accuracy + realization surfaced), a realization-distinct pair
 *      (NAD83 vs NAD83(2011)), and an unknown pair (fields null / absent).
 *   2. datumShiftAccuracyMetres is the machine-readable companion of the caveat:
 *      the SAME pairs are flagged, and the magnitude matches the caveat prose.
 *   3. coordinateEpochFromWkt reads the WKT EPOCH node, ignores FRAMEEPOCH.
 *   4. reprojectGlobal stamps the provenance on every outcome without moving a
 *      coordinate.
 *   5. ExportProvenance discloses a supplied transform in both formatters, and
 *      carries nothing when the path reprojected nothing (behaviour-preserving).
 */

import { describe, it, expect } from 'vitest';
import {
  buildTransformProvenance,
  coordinateEpochFromWkt,
  type TransformProvenance,
} from '../src/convert/transformProvenance';
import { datumShiftCaveat, datumShiftAccuracyMetres } from '../src/convert/epsg';
import { reprojectGlobal } from '../src/convert/reproject';
import { crsFromWkt, type CrsInfo } from '../src/io/crs';
import {
  buildExportProvenance,
  provenanceLines,
  provenanceJson,
} from '../src/terrain/export/exportProvenance';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

function points(x: number, y: number, z = 0) {
  return {
    count: 1,
    x: Float64Array.from([x]),
    y: Float64Array.from([y]),
    z: Float64Array.from([z]),
  };
}

describe('buildTransformProvenance — table-driven derivation', () => {
  it('same datum, projection-only change: no accuracy, no epoch, realization surfaced', () => {
    // WGS84/UTM11N → WGS84 geographic — one datum family, so there is no
    // cross-datum leg to characterise and no caveat pair.
    const p = buildTransformProvenance(32611, 4326);
    expect(p.operation).toBe('WGS 84 / UTM zone 11N → WGS 84 (geographic)');
    expect(p.sourceDatum).toBe('WGS84');
    expect(p.targetDatum).toBe('WGS84');
    // Same family ⇒ no datum-shift figure (null, never a fabricated 0).
    expect(p.accuracyMetres).toBeNull();
    // No source WKT ⇒ epoch genuinely absent, reported null.
    expect(p.coordinateEpoch).toBeNull();
    // Realization filled from the curated registry generic.
    expect(p.sourceRealization).toBe('WGS 84');
    expect(p.targetRealization).toBe('WGS 84');
  });

  it('identical CRS: a "no transform" label, still honest metadata', () => {
    const p = buildTransformProvenance(32611, 32611);
    expect(p.operation).toMatch(/^no transform \(identical CRS /);
    expect(p.accuracyMetres).toBeNull();
    expect(p.coordinateEpoch).toBeNull();
  });

  it('known-caveat datum shift (NAD83 → WGS84): accuracy + both realizations surfaced', () => {
    const p = buildTransformProvenance(26915, 32615); // NAD83/UTM15N → WGS84/UTM15N
    expect(p.operation).toBe('NAD83 / UTM zone 15N → WGS 84 / UTM zone 15N');
    expect(p.sourceDatum).toBe('NAD83');
    expect(p.targetDatum).toBe('WGS84');
    // Identity-to-WGS84 leg is ≈ 1–2 m; the machine-readable figure is the
    // conservative top of that range, and it agrees with the caveat pair.
    expect(p.accuracyMetres).toBe(2);
    expect(datumShiftCaveat(26915, 32615)).not.toBeNull();
    expect(p.sourceRealization).toBe('NAD83');
    expect(p.targetRealization).toBe('WGS 84');
  });

  it('GDA94 → GDA2020: surfaces the 1.8 m plate-motion figure the caveat states', () => {
    const p = buildTransformProvenance(28355, 7855);
    expect(p.accuracyMetres).toBe(1.8);
    expect(p.sourceDatum).toBe('GDA94');
    expect(p.targetDatum).toBe('GDA2020');
  });

  it('realization-distinct pair: NAD83(2011) is kept apart from the NAD83 family', () => {
    // A source WKT that declares the realization; the family is still NAD83.
    const src: CrsInfo = crsFromWkt(
      'PROJCS["NAD83(2011) / UTM zone 12N",GEOGCS["NAD83(2011)",DATUM["NAD83_2011"]],UNIT["metre",1]]',
    );
    expect(src.horizontalDatum).toBe('NAD83(2011)');
    const p = buildTransformProvenance(26912, 32612, { sourceCrs: src });
    // Realization preserves the WKT's specific frame …
    expect(p.sourceRealization).toBe('NAD83(2011)');
    // … while the coarse datum FAMILY stays the generic NAD83 the shift logic uses.
    expect(p.sourceDatum).toBe('NAD83');
    expect(p.sourceRealization).not.toBe(p.sourceDatum);
    // The target has no WKT hint, so its realization comes from the registry.
    expect(p.targetRealization).toBe('WGS 84');
  });

  it('unknown pair: datum + realization ABSENT, accuracy + epoch null — never fabricated', () => {
    const p = buildTransformProvenance(999999, 4326);
    expect(p.operation).toBe('EPSG:999999 → WGS 84 (geographic)');
    // Unresolvable source ⇒ omit (not null) the datum + realization strings.
    expect('sourceDatum' in p).toBe(false);
    expect('sourceRealization' in p).toBe(false);
    expect(p.accuracyMetres).toBeNull();
    expect(p.coordinateEpoch).toBeNull();
    // The resolvable target is still reported honestly.
    expect(p.targetDatum).toBe('WGS84');
    expect(p.targetRealization).toBe('WGS 84');
  });

  it('threads the source coordinate epoch from the source WKT', () => {
    const src: CrsInfo = crsFromWkt(
      'GEOGCS["WGS 84",DATUM["WGS_1984"]]',
    );
    const withEpoch: CrsInfo = { ...src, wkt: 'COORDINATEMETADATA[GEOGCRS["WGS 84 (G1762)",DATUM["x"]],EPOCH[2005.0]]' };
    const p = buildTransformProvenance(4326, 32615, { sourceCrs: withEpoch });
    expect(p.coordinateEpoch).toBe(2005.0);
  });
});

describe('datumShiftAccuracyMetres — parity with the caveat, magnitude matches prose', () => {
  const pairs: ReadonlyArray<[number, number]> = [
    [26715, 26915], // NAD27 → NAD83 UTM 15
    [4326, 4267], // WGS84 → NAD27
    [28355, 7855], // GDA94 → GDA2020
    [7844, 4283], // GDA2020 → GDA94
    [26915, 32615], // NAD83 → WGS84
    [4269, 4326], // NAD83 geo → WGS84
    [32611, 4326], // WGS84 → WGS84 (clean)
    [25831, 4326], // ETRS89 → WGS84 (coincident)
    [26715, 4267], // NAD27 UTM → NAD27 geographic (same family)
    [999999, 4326], // unknown
  ];

  it('a caveat exists exactly when an accuracy figure exists', () => {
    for (const [a, b] of pairs) {
      const hasCaveat = datumShiftCaveat(a, b) != null;
      const hasAccuracy = datumShiftAccuracyMetres(a, b) != null;
      expect(hasAccuracy).toBe(hasCaveat);
    }
  });

  it('the concrete magnitudes match the figures the caveat prose asserts', () => {
    expect(datumShiftAccuracyMetres(26715, 26915)).toBe(10); // "10 m or more"
    expect(datumShiftAccuracyMetres(28355, 7855)).toBe(1.8); // "≈ 1.8 m"
    expect(datumShiftAccuracyMetres(26915, 32615)).toBe(2); // top of "≈ 1–2 m"
    expect(datumShiftAccuracyMetres(32611, 4326)).toBeNull(); // clean
    expect(datumShiftAccuracyMetres(26715, 4267)).toBeNull(); // same family
    expect(datumShiftAccuracyMetres(999999, 4326)).toBeNull(); // unknown
  });
});

describe('coordinateEpochFromWkt', () => {
  it('reads a WKT2 EPOCH node', () => {
    expect(
      coordinateEpochFromWkt('COORDINATEMETADATA[GEOGCRS["WGS 84 (G1762)",DATUM["x"]],EPOCH[2010.0]]'),
    ).toBe(2010.0);
  });

  it('reads the older COORDINATEEPOCH spelling', () => {
    expect(coordinateEpochFromWkt('GEOGCRS["x",DATUM["y"],COORDINATEEPOCH[2015.5]]')).toBe(2015.5);
  });

  it('ignores a dynamic-datum FRAMEEPOCH (a datum property, not the coordinate epoch)', () => {
    expect(coordinateEpochFromWkt('GEODCRS["x",DYNAMIC[FRAMEEPOCH[2010.0]],DATUM["y"]]')).toBeNull();
  });

  it('returns null for a static CRS with no epoch, and for empty input', () => {
    expect(coordinateEpochFromWkt('PROJCS["NAD83 / UTM zone 10N",GEOGCS["NAD83"],UNIT["metre",1]]')).toBeNull();
    expect(coordinateEpochFromWkt(undefined)).toBeNull();
    expect(coordinateEpochFromWkt('')).toBeNull();
  });
});

describe('reprojectGlobal — the result carries provenance without moving a coordinate', () => {
  it('a clean transform stamps the operation + datums', () => {
    const r = reprojectGlobal(points(500000, 4000000), 32611, 4326);
    expect(r.transformed).toBe(true);
    expect(r.provenance.operation).toBe('WGS 84 / UTM zone 11N → WGS 84 (geographic)');
    expect(r.provenance.sourceDatum).toBe('WGS84');
    expect(r.provenance.accuracyMetres).toBeNull();
  });

  it('a degenerate-datum transform surfaces the accuracy figure alongside the caveat', () => {
    const r = reprojectGlobal(points(500000, 6000000), 28355, 7855);
    expect(r.datumCaveat).toMatch(/GDA94/);
    expect(r.provenance.accuracyMetres).toBe(1.8);
    expect(r.provenance.sourceDatum).toBe('GDA94');
    expect(r.provenance.targetDatum).toBe('GDA2020');
  });

  it('a skipped (unresolvable) transform still discloses the attempted operation', () => {
    const r = reprojectGlobal(points(0, 0), 999999, 4326);
    expect(r.transformed).toBe(false);
    expect(r.provenance.operation).toBe('EPSG:999999 → WGS 84 (geographic)');
    expect(r.provenance.accuracyMetres).toBeNull();
  });

  it('the identical-CRS no-op carries the "no transform" provenance', () => {
    const r = reprojectGlobal(points(1, 2, 3), 32611, 32611);
    expect(r.transformed).toBe(false);
    expect(r.provenance.operation).toMatch(/^no transform/);
    // Coordinate untouched.
    expect(r.points.x[0]).toBe(1);
  });
});

describe('ExportProvenance — discloses a supplied transform, carries none otherwise', () => {
  function readyResult(): AnalyseContoursResult {
    return {
      dtm: { crs: 'EPSG:32615', verticalDatum: 'EPSG:5703', coverageMode: 'full', meanConfidence: 82 },
      intervalM: 1,
      model: { crs: 'EPSG:32615', verticalDatum: 'EPSG:5703', intervalM: 1, contourStyle: 'smooth', coverageMode: 'full' },
      accuracyStandards: {
        rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
        densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref',
      },
      quality: {
        readiness: 'ready', exportReadiness: 'available',
        crsKnown: true, datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
      },
      qualityScore: { score: 85 },
      cellMetrics: { meanDensity: 4.2, boundaryMeasuredRatio: 0.02 },
      cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
      generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
      warnings: [],
    } as unknown as AnalyseContoursResult;
  }
  const OPTS = { basename: 'site', generatedAt: '2026-06-05T00:00:00.000Z', softwareVersion: '9.9.9', metricVersion: 'v0.4.1', verticalUnitToMetres: 1 } as const;

  const transform: TransformProvenance = buildTransformProvenance(26915, 32615);

  it('when no transform is supplied the export discloses none (behaviour-preserving)', () => {
    const p = buildExportProvenance(readyResult(), OPTS);
    expect(p.transform ?? null).toBeNull();
    const text = provenanceLines(p).join('\n');
    expect(text).not.toMatch(/Transform operation/);
    expect(provenanceJson(p).transform).toBeNull();
    // The single-Manifest-line invariant other exporters rely on still holds.
    expect(provenanceLines(p).filter((l) => l.startsWith('Manifest'))).toHaveLength(1);
  });

  it('a supplied transform is disclosed in both the lines and the JSON', () => {
    const p = buildExportProvenance(readyResult(), { ...OPTS, transform });
    const text = provenanceLines(p).join('\n');
    expect(text).toMatch(/Transform operation\s+NAD83 \/ UTM zone 15N → WGS 84 \/ UTM zone 15N/);
    expect(text).toMatch(/Source realization\s+NAD83/);
    expect(text).toMatch(/Target realization\s+WGS 84/);
    expect(text).toMatch(/Transform accuracy\s+≈ 2 m/);
    const j = provenanceJson(p).transform as Record<string, unknown>;
    expect(j.operation).toBe('NAD83 / UTM zone 15N → WGS 84 / UTM zone 15N');
    expect(j.accuracyMetres).toBe(2);
    expect(j.sourceRealization).toBe('NAD83');
    expect(j.targetRealization).toBe('WGS 84');
  });

  it('every provenance line keeps the two-space key/value gutter, even with a transform', () => {
    const p = buildExportProvenance(readyResult(), { ...OPTS, transform });
    for (const line of provenanceLines(p)) {
      expect(line).toMatch(/^\S.*?\s{2,}\S/);
    }
  });
});
