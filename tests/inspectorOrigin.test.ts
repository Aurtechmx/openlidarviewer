/**
 * Regression tests for the v0.4.3 inspector double-origin bug.
 *
 * `makePointInfo` adds the load-time origin back, so `PointInfo.x/y/z` ARE
 * world coordinates. The inspector card must therefore render the World
 * group straight from `info.x/y/z` and derive Local as `info − origin` —
 * adding the origin a second time doubled every easting/northing and fed
 * the doubled values into the WGS-84 projection.
 */
import {
  makePointInfo,
  splitPointCoords,
  worldCoordLabels,
  pointVerticalReference,
  pointHeight,
  heightRowLabel,
} from '../src/render/pointInfo';
import type { RawPointInfo } from '../src/render/pointInfo';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

/** A georeferenced pick: large UTM origin, small local residual. */
function georefRaw(): RawPointInfo {
  return {
    layer: 'survey.laz',
    index: 7,
    local: [0.789, 0.105, 0.34],
    origin: [412345, 4587234, 118],
    distance: 25.5,
    intensity: null,
    classification: null,
    rgb: null,
  };
}

test('makePointInfo with a non-zero origin yields WORLD coordinates', () => {
  const info = makePointInfo(georefRaw());
  // info.x/y/z are local + origin — the absolute survey position.
  expect(info.x).toBe(412345.789);
  expect(info.y).toBe(4587234.105);
  expect(info.z).toBe(118.34);
});

test('splitPointCoords: world is info verbatim, local is info minus origin', () => {
  const info = makePointInfo(georefRaw());
  const split = splitPointCoords(info, [412345, 4587234, 118]);
  // World comes straight from info — NOT info + origin (the v0.4.3 bug
  // would have produced x ≈ 824690.789 here).
  expect(split.world).toEqual({ x: 412345.789, y: 4587234.105, z: 118.34 });
  // Local recovers the recentred render-buffer position. Precision 8:
  // subtracting a ~4.6e6 origin from a double leaves up to ~5e-10 of
  // representation error, right at the 9-digit tolerance boundary.
  expect(split.local).not.toBeNull();
  expect(split.local!.x).toBeCloseTo(0.789, 8);
  expect(split.local!.y).toBeCloseTo(0.105, 8);
  expect(split.local!.z).toBeCloseTo(0.34, 8);
});

test('splitPointCoords: no origin → single frame (local is null)', () => {
  const info = makePointInfo({ ...georefRaw(), local: [1, 2, 3], origin: [0, 0, 0] });
  const split = splitPointCoords(info, undefined);
  expect(split.world).toEqual({ x: 1, y: 2, z: 3 });
  // local == world when no origin shift exists; the card shows one group.
  expect(split.local).toBeNull();
});

test('splitPointCoords never doubles the origin (world stays < 2x origin)', () => {
  const info = makePointInfo(georefRaw());
  const split = splitPointCoords(info, [412345, 4587234, 118]);
  // Guard against the exact failure mode: world must be near the origin
  // magnitude, not near twice it.
  expect(Math.abs(split.world.x - 412345)).toBeLessThan(10);
  expect(Math.abs(split.world.y - 4587234)).toBeLessThan(10);
});

// ── World-group label-vs-value drift (units) ───────────────────────────────
// The inspector renders `worldCoordLabels(crs).{x,y,z}Unit` next to the World
// coordinate values. A GEOGRAPHIC CRS's eastings/northings are DEGREES, not
// metres — the card used to hardcode " m" for all three axes, so a lon/lat
// scan printed "Longitude: -122.4 m". Pin the per-frame unit suffixes.

function crs(kind: ResolvedCrs['kind'], name = 'test'): ResolvedCrs {
  return {
    kind,
    name,
    epsg: kind === 'geographic' ? 4326 : 32610,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    source: 'las-vlr',
    confidence: 'high',
    userConfirmed: false,
  };
}

test('worldCoordLabels: geographic CRS uses degrees on X/Y, metres on Z', () => {
  const l = worldCoordLabels(crs('geographic', 'WGS 84'));
  expect(l.heading).toBe('World (geographic)');
  expect([l.x, l.y, l.z]).toEqual(['Longitude', 'Latitude', 'Elevation']);
  // The drift fix: lon/lat are degrees, never " m".
  expect(l.xUnit).toBe('°');
  expect(l.yUnit).toBe('°');
  expect(l.zUnit).toBe(' m');
});

test('worldCoordLabels: projected CRS uses metres on all three axes', () => {
  const l = worldCoordLabels(crs('projected', 'UTM zone 10N'));
  expect(l.heading).toBe('World (UTM zone 10N)');
  expect([l.x, l.y, l.z]).toEqual(['Easting', 'Northing', 'Elevation']);
  expect([l.xUnit, l.yUnit, l.zUnit]).toEqual([' m', ' m', ' m']);
});

test('worldCoordLabels: local / unknown / undefined assert NO unit (source units, not metres)', () => {
  // HONESTY: an unknown-scale scan must not print " m" — that contradicts the
  // inspector's own "shown in source units only" note. Bare X/Y/Z, no suffix.
  for (const c of [undefined, crs('local'), crs('unknown')]) {
    const l = worldCoordLabels(c);
    expect(l.heading).toBe('World');
    expect([l.x, l.y, l.z]).toEqual(['X', 'Y', 'Z']);
    expect([l.xUnit, l.yUnit, l.zUnit]).toEqual(['', '', '']);
  }
});

test('worldCoordLabels: a foot-based projected CRS shows feet, never metres', () => {
  // The old hardcoded " m" printed a US-survey-foot survey's eastings as metres.
  const footCrs: ResolvedCrs = {
    kind: 'projected',
    name: 'NAD83 / California zone 3 (ftUS)',
    epsg: 2227,
    linearUnit: 'us-survey-foot',
    linearUnitToMetres: 1200 / 3937,
    source: 'las-vlr',
    confidence: 'high',
    userConfirmed: false,
  };
  const l = worldCoordLabels(footCrs);
  expect([l.x, l.y, l.z]).toEqual(['Easting', 'Northing', 'Elevation']);
  expect([l.xUnit, l.yUnit, l.zUnit]).toEqual([' ft', ' ft', ' ft']);
});

// ── Distinct VERTICAL unit — the axis the v0.5.8 horizontal fix left hardcoded ──
// The elevation used to print " m" unconditionally (geographic) or inherit the
// horizontal linear unit (projected). A CRS that DECLARES a distinct vertical
// unit must report the elevation in that unit — a foot height is " ft", never
// silently metres; an unrecognised vertical scale asserts NO suffix.

test('worldCoordLabels: geographic CRS with a declared FOOT height shows ft on Z, never m', () => {
  const geoFootHeight: ResolvedCrs = {
    kind: 'geographic',
    name: 'WGS 84 + NAVD88 height (ftUS)',
    epsg: 4326,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    verticalUnitToMetres: 1200 / 3937, // US survey foot
    source: 'las-vlr',
    confidence: 'high',
    userConfirmed: false,
  };
  const l = worldCoordLabels(geoFootHeight);
  // Horizontal stays degrees; the DECLARED foot height must not read metres.
  expect([l.xUnit, l.yUnit]).toEqual(['°', '°']);
  expect(l.zUnit).toBe(' ft');
});

test('worldCoordLabels: metre-projected CRS with a declared FOOT height shows ft on Z', () => {
  const metreXYFootZ: ResolvedCrs = {
    kind: 'projected',
    name: 'UTM 10N + foot height',
    epsg: 32610,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    verticalUnitToMetres: 0.3048, // international foot
    source: 'las-vlr',
    confidence: 'high',
    userConfirmed: false,
  };
  const l = worldCoordLabels(metreXYFootZ);
  expect([l.xUnit, l.yUnit]).toEqual([' m', ' m']);
  expect(l.zUnit).toBe(' ft');
});

test('worldCoordLabels: foot-projected CRS with a declared METRE height shows m on Z', () => {
  const footXYMetreZ: ResolvedCrs = {
    kind: 'projected',
    name: 'State plane (ftUS) + metre height',
    epsg: 2227,
    linearUnit: 'us-survey-foot',
    linearUnitToMetres: 1200 / 3937,
    verticalUnitToMetres: 1,
    source: 'las-vlr',
    confidence: 'high',
    userConfirmed: false,
  };
  const l = worldCoordLabels(footXYMetreZ);
  expect([l.xUnit, l.yUnit]).toEqual([' ft', ' ft']);
  expect(l.zUnit).toBe(' m');
});

test('worldCoordLabels: an unrecognised vertical scale asserts NO suffix (never fabricates metres)', () => {
  const oddVertical: ResolvedCrs = {
    kind: 'projected',
    name: 'Projected + unknown-scale height',
    epsg: 32610,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    verticalUnitToMetres: 0.9, // not metre, not foot → do not assert a unit
    source: 'las-vlr',
    confidence: 'low',
    userConfirmed: false,
  };
  expect(worldCoordLabels(oddVertical).zUnit).toBe('');
});

// ── Z-row datum honesty (the inspector's height label) ─────────────────────
// The unit-suffix tests above pin what unit the Z value is shown in. These pin
// what REFERENCE the label claims. The failure they guard: a georeferenced scan
// with a KNOWN horizontal CRS but NO declared vertical datum printed
// "Elevation", asserting a sea-level datum the file never carried. The label is
// now built from an explicit HeightValue whose reference is honestly 'unknown'.

/** A projected/geographic CRS carrying explicit vertical fields. */
function crsWithVertical(kind: ResolvedCrs['kind'], vertical: Partial<ResolvedCrs>): ResolvedCrs {
  return { ...crs(kind), ...vertical };
}

test('heightRowLabel: known horizontal CRS, NO vertical datum → "Height (datum unknown)", never "Elevation"', () => {
  // The common, dangerous case: a UTM survey with no vertical CRS declared.
  const projected = crs('projected', 'UTM zone 10N');
  expect(projected.verticalDatum).toBeUndefined();
  expect(heightRowLabel(projected)).toBe('Height (datum unknown)');
  expect(heightRowLabel(projected)).not.toBe('Elevation');
  // A geographic scan with no vertical datum is equally undeclared.
  expect(heightRowLabel(crs('geographic', 'WGS 84'))).toBe('Height (datum unknown)');
});

test('heightRowLabel: a declared orthometric datum still reads "Elevation"', () => {
  expect(heightRowLabel(crsWithVertical('projected', { verticalEpsg: 5703 }))).toBe('Elevation');
  expect(heightRowLabel(crsWithVertical('projected', { verticalDatum: 'NAVD88' }))).toBe(
    'Elevation',
  );
});

test('heightRowLabel: an ellipsoidal (WGS 84 3D) height is labelled as such, not "Elevation"', () => {
  const label = heightRowLabel(crsWithVertical('geographic', { verticalEpsg: 4979 }));
  expect(label).toBe('Ellipsoidal height');
});

test('heightRowLabel: local / unknown / undefined scans keep the neutral "Z"', () => {
  for (const c of [undefined, crs('local'), crs('unknown')]) {
    expect(heightRowLabel(c)).toBe('Z');
  }
});

test('pointVerticalReference maps CRS kind + datum to an honest reference', () => {
  expect(pointVerticalReference(undefined)).toBe('unknown');
  expect(pointVerticalReference(crs('unknown'))).toBe('unknown');
  expect(pointVerticalReference(crs('local'))).toBe('local');
  // Known horizontal CRS, undeclared vertical datum → unknown, not a guess.
  expect(pointVerticalReference(crs('projected'))).toBe('unknown');
  expect(pointVerticalReference(crsWithVertical('projected', { verticalEpsg: 5703 }))).toBe(
    'orthometric',
  );
});

test('pointHeight carries the world Z with its reference and the CRS vertical scale', () => {
  const footZ = crsWithVertical('projected', { verticalEpsg: 5703, verticalUnitToMetres: 0.3048 });
  const h = pointHeight(500, footZ);
  expect(h.value).toBe(500);
  expect(h.reference).toBe('orthometric');
  expect(h.metresPerUnit).toBe(0.3048);
  // No vertical datum declared → the height is honestly datum-unknown.
  expect(pointHeight(500, crs('projected')).reference).toBe('unknown');
});
