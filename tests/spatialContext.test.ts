/**
 * spatialContext.test.ts
 *
 * The cross-product matrix the coordinate-integrity roadmap asks for, encoded as
 * a table. `spatialContextFrom` is a façade over already-tested predicates, so
 * these tests do not re-check unit parsing or the ladder — they pin that the
 * façade fans them into one object correctly and, above all, that the single
 * fail-closed gate `metricClaimsPermitted` lands on the right value in every
 * cell of:
 *
 *   linear unit  { metre, international-foot, US-survey-foot, unknown, geographic-degrees }
 *   × up axis     { Z-up, Y-up }
 *   × vertical    { known-orthometric, known-ellipsoidal, unknown-vertical-datum }
 *
 * = 5 × 2 × 3 = 30 cases, plus the closed edges (missing CRS, non-finite unit,
 * project-frame placement, defaulted up-axis).
 */

import { describe, it, expect } from 'vitest';
import type { CrsInfo, CrsLinearUnit } from '../src/io/crs';
import type { CrsValidity } from '../src/geo/CrsValidation';
import type { VerticalReference } from '../src/geo/height';
import type { SpatialUpAxis } from '../src/geo/SpatialContext';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { createProjectFrame, layerTransform } from '../src/geo/ProjectSpatialFrame';
import { resolvedFromCrsInfo, localCrs, unknownCrs } from '../src/geo/CoordinateTypes';

// ─────────────────────────────────────────────────────────────────────────────
// Matrix dimensions
// ─────────────────────────────────────────────────────────────────────────────

type UnitCol = 'metre' | 'intl-foot' | 'us-survey-foot' | 'unknown' | 'geographic';
type VertCol = 'orthometric' | 'ellipsoidal' | 'unknown';

interface UnitSpec {
  readonly linearUnit: CrsLinearUnit;
  readonly linearUnitToMetres: number;
  readonly isGeographic: boolean;
  /** Expected `linearUnitKnown` for this column. */
  readonly expectKnown: boolean;
  /** Expected `metricClaimsPermitted` — independent of axis and vertical datum. */
  readonly expectPermitted: boolean;
  /** Expected ladder verdict. */
  readonly expectValidity: CrsValidity;
}

const US_SURVEY_FOOT = 1200 / 3937;

const UNIT_COLS: Record<UnitCol, UnitSpec> = {
  metre: {
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    isGeographic: false,
    expectKnown: true,
    expectPermitted: true,
    expectValidity: 'safe-metric',
  },
  'intl-foot': {
    linearUnit: 'foot',
    linearUnitToMetres: 0.3048,
    isGeographic: false,
    expectKnown: true,
    expectPermitted: true,
    expectValidity: 'safe-metric',
  },
  'us-survey-foot': {
    linearUnit: 'us-survey-foot',
    linearUnitToMetres: US_SURVEY_FOOT,
    isGeographic: false,
    expectKnown: true,
    expectPermitted: true,
    expectValidity: 'safe-metric',
  },
  // Projected but the unit is not one we can honour (e.g. a British-foot GeoTIFF
  // code). The ladder alone would pass this — kind is still 'projected' — so the
  // cell exists to prove `isLinearUnitKnown` is what closes it.
  unknown: {
    linearUnit: 'unknown',
    linearUnitToMetres: 1,
    isGeographic: false,
    expectKnown: false,
    expectPermitted: false,
    expectValidity: 'safe-metric',
  },
  // Geographic (lat/lon in degrees). The ladder refuses it (requires-projection)
  // and the unit gate refuses it too; both must agree on "not permitted".
  geographic: {
    linearUnit: 'unknown',
    linearUnitToMetres: 1,
    isGeographic: true,
    expectKnown: false,
    expectPermitted: false,
    expectValidity: 'requires-projection',
  },
};

interface VertSpec {
  readonly verticalEpsg?: number;
  readonly verticalDatum?: string;
  readonly expectReference: VerticalReference;
}

const VERT_COLS: Record<VertCol, VertSpec> = {
  orthometric: { verticalEpsg: 5703, verticalDatum: 'NAVD88', expectReference: 'orthometric' },
  ellipsoidal: { verticalEpsg: 4979, verticalDatum: 'EPSG:4979', expectReference: 'ellipsoidal' },
  unknown: { expectReference: 'unknown' },
};

const UP_AXES: readonly Exclude<SpatialUpAxis, 'unknown'>[] = ['z', 'y'];

function crsInfoFor(unit: UnitSpec, vert: VertSpec): CrsInfo {
  return {
    source: 'wkt',
    name: 'Matrix CRS',
    epsg: 32000,
    linearUnit: unit.linearUnit,
    linearUnitToMetres: unit.linearUnitToMetres,
    isGeographic: unit.isGeographic,
    verticalEpsg: vert.verticalEpsg,
    verticalDatum: vert.verticalDatum,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The 30-cell cross product
// ─────────────────────────────────────────────────────────────────────────────

interface Case {
  readonly name: string;
  readonly unitKey: UnitCol;
  readonly unit: UnitSpec;
  readonly upAxis: Exclude<SpatialUpAxis, 'unknown'>;
  readonly vertKey: VertCol;
  readonly vert: VertSpec;
}

const CASES: Case[] = [];
for (const unitKey of Object.keys(UNIT_COLS) as UnitCol[]) {
  for (const upAxis of UP_AXES) {
    for (const vertKey of Object.keys(VERT_COLS) as VertCol[]) {
      CASES.push({
        name: `${unitKey} × ${upAxis}-up × ${vertKey}`,
        unitKey,
        unit: UNIT_COLS[unitKey],
        upAxis,
        vertKey,
        vert: VERT_COLS[vertKey],
      });
    }
  }
}

describe('spatialContextFrom — unit × up-axis × vertical-datum matrix', () => {
  it('covers the full 5 × 2 × 3 cross product', () => {
    expect(CASES).toHaveLength(30);
  });

  it.each(CASES)('$name', ({ unit, upAxis, vert }) => {
    const ctx = spatialContextFrom(crsInfoFor(unit, vert), undefined, { upAxis });

    // Horizontal unit is carried verbatim and the known-gate matches the column.
    expect(ctx.linearUnit).toBe(unit.linearUnit);
    expect(ctx.linearUnitToMetres).toBe(unit.linearUnitToMetres);
    expect(ctx.linearUnitKnown).toBe(unit.expectKnown);
    expect(ctx.isGeographic).toBe(unit.isGeographic);

    // The ladder verdict is carried through.
    expect(ctx.metricValidity).toBe(unit.expectValidity);

    // THE gate — depends only on the unit column, never on axis or datum.
    expect(ctx.metricClaimsPermitted).toBe(unit.expectPermitted);

    // Up axis is carried verbatim, independent of everything else.
    expect(ctx.upAxis).toBe(upAxis);

    // Vertical reference is the datum column, independent of unit and axis.
    expect(ctx.verticalReference).toBe(vert.expectReference);
    expect(ctx.verticalDatum).toBe(vert.verticalDatum);
    expect(ctx.verticalEpsg).toBe(vert.verticalEpsg);
  });

  // The separation the matrix asserts, stated as a property: within one unit
  // column the gate never changes as axis or datum vary.
  it('metricClaimsPermitted is a pure function of the unit column', () => {
    for (const unitKey of Object.keys(UNIT_COLS) as UnitCol[]) {
      const permitted = new Set(
        CASES.filter((c) => c.unitKey === unitKey).map(
          (c) => spatialContextFrom(crsInfoFor(c.unit, c.vert), undefined, { upAxis: c.upAxis }).metricClaimsPermitted,
        ),
      );
      expect(permitted.size).toBe(1);
      expect([...permitted][0]).toBe(UNIT_COLS[unitKey].expectPermitted);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Closed edges
// ─────────────────────────────────────────────────────────────────────────────

describe('spatialContextFrom — fail-closed edges', () => {
  it('a missing CRS resolves to unknown and forbids metric claims', () => {
    const ctx = spatialContextFrom(null);
    expect(ctx.kind).toBe('unknown');
    expect(ctx.linearUnitKnown).toBe(false);
    expect(ctx.metricValidity).toBe('unknown-needs-confirmation');
    expect(ctx.metricClaimsPermitted).toBe(false);
    // No axis supplied ⇒ honest 'unknown', not a guessed default.
    expect(ctx.upAxis).toBe('unknown');
    expect(ctx.verticalReference).toBe('unknown');
    expect(ctx.inProjectFrame).toBe(false);
  });

  it('undefined behaves like null', () => {
    expect(spatialContextFrom(undefined).metricClaimsPermitted).toBe(false);
  });

  it('a non-finite linear-unit factor is blocked even with a named unit', () => {
    const crs: CrsInfo = {
      source: 'wkt',
      name: 'Corrupt unit',
      linearUnit: 'metre',
      linearUnitToMetres: 0,
      isGeographic: false,
    };
    const ctx = spatialContextFrom(crs);
    expect(ctx.metricValidity).toBe('non-finite-unit');
    expect(ctx.metricClaimsPermitted).toBe(false);
  });

  it('an undeclared vertical unit stays undefined (not read as metres)', () => {
    const crs: CrsInfo = {
      source: 'wkt',
      name: 'No vertical unit',
      linearUnit: 'foot',
      linearUnitToMetres: 0.3048,
      isGeographic: false,
    };
    const ctx = spatialContextFrom(crs);
    expect(ctx.verticalUnitToMetres).toBeUndefined();
  });

  it('carries a distinct declared vertical unit', () => {
    const crs: CrsInfo = {
      source: 'wkt',
      name: 'Metre grid, foot height',
      linearUnit: 'metre',
      linearUnitToMetres: 1,
      isGeographic: false,
      verticalUnitToMetres: 0.3048,
    };
    expect(spatialContextFrom(crs).verticalUnitToMetres).toBe(0.3048);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Project-frame placement
// ─────────────────────────────────────────────────────────────────────────────

describe('spatialContextFrom — project-frame placement', () => {
  const crs: CrsInfo = {
    source: 'wkt',
    name: 'Placed CRS',
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    isGeographic: false,
  };

  it('surfaces frame membership and the Float64 source→project transform', () => {
    const frame = createProjectFrame([1_000_000, 2_000_000, 10]);
    const lt = layerTransform(frame, [1_000_005, 2_000_007, 12]);
    const ctx = spatialContextFrom(crs, frame, { upAxis: 'z', layerTransform: lt });

    expect(ctx.inProjectFrame).toBe(true);
    expect(ctx.projectFrame).toBe(frame);
    expect(ctx.layerTransform).toBe(lt);
    // Exact Float64 translation, recovered without loss.
    expect(ctx.sourceToProject).toEqual([5, 7, 2]);
    // Placement does not change the metric gate.
    expect(ctx.metricClaimsPermitted).toBe(true);
  });

  it('is not in a project frame when no frame is supplied', () => {
    const ctx = spatialContextFrom(crs, undefined, { upAxis: 'z' });
    expect(ctx.inProjectFrame).toBe(false);
    expect(ctx.projectFrame).toBeUndefined();
    expect(ctx.sourceToProject).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ResolvedCrs input — the shape most consumers (e.g. the inspector) actually
// hold. The façade accepts it directly so those consumers can route without
// hand-building a CrsInfo. A ResolvedCrs must yield the same context a CrsInfo
// with the equivalent fields would, AND it can express `kind` a CrsInfo cannot
// ('local' / 'unknown').
// ─────────────────────────────────────────────────────────────────────────────

describe('spatialContextFrom — accepts a ResolvedCrs directly', () => {
  it('a resolved projected CRS yields the same context as its CrsInfo', () => {
    const info: CrsInfo = {
      source: 'wkt',
      name: 'NAD83 / UTM 12N + NAVD88',
      epsg: 32000,
      linearUnit: 'foot',
      linearUnitToMetres: 0.3048,
      isGeographic: false,
      verticalEpsg: 5703,
      verticalDatum: 'NAVD88',
      verticalUnitToMetres: 0.3048,
    };
    const resolved = resolvedFromCrsInfo(info, 'las-vlr');
    expect(resolved).not.toBeNull();
    const fromInfo = spatialContextFrom(info);
    const fromResolved = spatialContextFrom(resolved);

    for (const key of [
      'kind', 'isGeographic', 'linearUnit', 'linearUnitToMetres', 'linearUnitKnown',
      'verticalReference', 'verticalDatum', 'verticalEpsg', 'verticalUnitToMetres',
      'metricValidity', 'metricClaimsPermitted',
    ] as const) {
      expect(fromResolved[key]).toEqual(fromInfo[key]);
    }
    expect(fromResolved.metricClaimsPermitted).toBe(true);
    expect(fromResolved.verticalReference).toBe('orthometric');
  });

  it('honours a resolved kind a CrsInfo cannot express (local / unknown)', () => {
    const local = spatialContextFrom(localCrs());
    expect(local.kind).toBe('local');
    expect(local.linearUnitKnown).toBe(false);
    expect(local.metricClaimsPermitted).toBe(false);
    // The ladder classifies a local frame as safe-explicit-local, not projected.
    expect(local.metricValidity).toBe('safe-explicit-local');

    const unknown = spatialContextFrom(unknownCrs());
    expect(unknown.kind).toBe('unknown');
    expect(unknown.metricClaimsPermitted).toBe(false);
  });

  it('a resolved geographic CRS fails the gate closed', () => {
    const geo = resolvedFromCrsInfo(
      { source: 'wkt', name: 'WGS 84', linearUnit: 'unknown', linearUnitToMetres: 1, isGeographic: true },
      'las-vlr',
    );
    const ctx = spatialContextFrom(geo);
    expect(ctx.isGeographic).toBe(true);
    expect(ctx.metricValidity).toBe('requires-projection');
    expect(ctx.metricClaimsPermitted).toBe(false);
  });
});
