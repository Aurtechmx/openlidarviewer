import { describe, it, expect } from 'vitest';
import type { CrsInfo, CrsLinearUnit } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { UNIT_FACTORS } from '../src/units/units';
import { spacingUnit, workplaneFigureNote, workplaneReadout, workplaneUnits } from '../src/render/workplane/workplaneReadout';

function ctx(linearUnit: CrsLinearUnit, linearUnitToMetres: number, extra: Partial<CrsInfo> = {}) {
  return spatialContextFrom({
    source: 'wkt',
    name: 'Test CRS',
    epsg: 32612,
    linearUnit,
    linearUnitToMetres,
    isGeographic: false,
    ...extra,
  });
}

describe('unit labels follow the spatial context', () => {
  it('metres only when the CRS resolves metres', () => {
    expect(workplaneUnits(ctx('metre', 1))).toMatchObject({ horizontal: 'm', vertical: 'm', note: null });
  });

  it('feet for an international or US survey foot CRS', () => {
    expect(workplaneUnits(ctx('foot', UNIT_FACTORS.M_PER_FT)).horizontal).toBe('ft');
    expect(workplaneUnits(ctx('us-survey-foot', UNIT_FACTORS.M_PER_US_FT)).horizontal).toBe('ft');
  });

  it('"units" for an unresolved unit, with the reason', () => {
    const u = workplaneUnits(ctx('unknown', 1));
    expect(u.horizontal).toBe('units');
    expect(u.vertical).toBe('units');
    expect(u.note).toMatch(/not resolved/);
  });

  it('geographic degrees are not metric', () => {
    const u = workplaneUnits(ctx('unknown', 1, { isGeographic: true, epsg: 4326 }));
    expect(u.horizontal).toBe('units');
    expect(u.note).toMatch(/degrees/);
  });

  it('no context at all reads "units"', () => {
    expect(workplaneUnits(null)).toMatchObject({ horizontal: 'units', vertical: 'units' });
  });

  it('a declared vertical unit labels the elevation on its own', () => {
    const u = workplaneUnits(ctx('metre', 1, { verticalUnitToMetres: UNIT_FACTORS.M_PER_US_FT }));
    expect(u.horizontal).toBe('m');
    expect(u.vertical).toBe('ft');
    // A vertical plane spans both axes: no single unit names its spacing.
    expect(spacingUnit(u, 'horizontal')).toBe('m');
    expect(spacingUnit(u, 'vertical-x')).toBe('units');
    expect(spacingUnit(u, 'three-point')).toBe('units');
  });
});

describe('readout', () => {
  const units = workplaneUnits(ctx('metre', 1));
  const base = {
    orientation: 'horizontal' as const,
    axisNames: ['X', 'Y'] as const,
    originH: [500000, 4100000] as const,
    elevation: 1234.5,
    elevationSource: 'scan-minimum' as const,
    spacing: { major: 5, minor: 1, showMinor: true, fixed: false },
    units,
    datumKnown: true,
  };

  it('states orientation, origin, elevation with its source, spacing and units', () => {
    const lines = workplaneReadout(base);
    expect(lines[0]).toBe('Orientation: Horizontal');
    expect(lines[1]).toBe('Origin: X 500000.000 m, Y 4100000.000 m');
    expect(lines[2]).toBe('Elevation: 1234.500 m (lowest point in the scan, not ground)');
    expect(lines[3]).toBe('Grid 5 m, minor 1 m');
  });

  it('never calls an unset elevation anything but unset', () => {
    const lines = workplaneReadout({ ...base, elevation: null, elevationSource: null, spacing: null });
    expect(lines[2]).toBe('Elevation: not set');
    expect(lines[3]).toMatch(/not drawn/);
  });

  it('marks a fixed spacing, hidden minors, a three-point dip and a missing datum', () => {
    const lines = workplaneReadout({
      ...base,
      orientation: 'three-point',
      dipDeg: 12.34,
      elevationSource: 'plane',
      spacing: { major: 2, minor: 0.5, showMinor: false, fixed: true },
      datumKnown: false,
    });
    expect(lines[0]).toBe('Orientation: Through 3 picked points, dip 12.3°');
    expect(lines[3]).toBe('Grid 2 m, minor lines hidden at this zoom (fixed)');
    expect(lines).toContain('The open layers share no datum, so these are scene coordinates.');
  });

  it('the snapshot note says what the plane is and is not', () => {
    expect(workplaneFigureNote(workplaneReadout(base))).toMatch(/^Reference plane, not measured terrain\. Orientation: Horizontal; /);
  });
});
