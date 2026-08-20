/**
 * The persistent location banner's truth model.
 *
 * Each block below pins one of the five rules the banner exists to keep: the
 * active CRS is the only CRS read, units come from the spatial context, an
 * empty cursor invents no coordinate, a Y-up scan is read against its own
 * vertical, and lat/lon appears only when a conversion actually produced one.
 */
import { activeReadoutCrs, cursorReadout } from '../src/geo/cursorReadout';
import type { CursorReadoutInput } from '../src/geo/cursorReadout';
import type { ConversionResult } from '../src/geo/CoordinateConverter';
import type { GeographicPoint, ResolvedCrs } from '../src/geo/CoordinateTypes';
import { localCrs, unknownCrs } from '../src/geo/CoordinateTypes';
import type { RawPointInfo } from '../src/render/pointInfo';

/** International foot, exactly. */
const M_PER_FT = 0.3048;
/** US survey foot, exactly — about 2 ppm longer than the international foot. */
const M_PER_US_FT = 1200 / 3937;

/** A projected CRS with an explicit unit. */
function projected(
  epsg: number,
  name: string,
  linearUnit: ResolvedCrs['linearUnit'],
  linearUnitToMetres: number,
): ResolvedCrs {
  return {
    kind: 'projected',
    name,
    epsg,
    linearUnit,
    linearUnitToMetres,
    source: 'las-vlr',
    confidence: 'high',
    userConfirmed: false,
  };
}

const UTM12N = projected(32612, 'WGS 84 / UTM zone 12N', 'metre', 1);
const NAD83_UTM12N = projected(26912, 'NAD83 / UTM zone 12N', 'metre', 1);
const CA3_FTUS = projected(
  2227,
  'NAD83 / California zone 3 (ftUS)',
  'us-survey-foot',
  M_PER_US_FT,
);
const CA3_FT = projected(2231, 'NAD83 / Colorado Central (ft)', 'foot', M_PER_FT);

/** A picked point: large survey origin, small recentred residual. */
function pick(): RawPointInfo {
  return {
    layer: 'survey.laz',
    index: 12,
    local: [0.42, 0.71, 0.38],
    origin: [506283, 3214882, 226],
    distance: 31.2,
    intensity: null,
    classification: null,
    rgb: null,
  };
}

/** A readout over a Z-up scan with a point under the cursor. */
function readAt(crs: ResolvedCrs | undefined, extra: Partial<CursorReadoutInput> = {}) {
  return cursorReadout({ crs: { active: crs }, point: pick(), upAxis: 'z', ...extra });
}

// ── RULE 1: the active resolved CRS, never the declaration ─────────────────

test('a source CRS resolved to another CRS reads the RESOLVED one', () => {
  const r = cursorReadout({
    crs: { declared: NAD83_UTM12N, active: UTM12N },
    point: pick(),
    upAxis: 'z',
  });
  expect(r.crsLabel).toBe('EPSG:32612');
  expect(r.text).toContain('EPSG:32612');
  // The declaration is provenance, not a second answer on screen.
  expect(r.text).not.toContain('26912');
  expect(activeReadoutCrs({ declared: NAD83_UTM12N, active: UTM12N })).toBe(UTM12N);
});

test('a source CRS resolved to Local does NOT resurrect the source CRS', () => {
  const local = localCrs();
  const r = cursorReadout({
    crs: { declared: UTM12N, active: local },
    point: pick(),
    upAxis: 'z',
  });
  expect(r.status).toBe('local');
  expect(r.crsLabel).toBe('Local coordinates (no CRS)');
  // The tempting bug: a Local frame carries no EPSG, so the declared code
  // looks like helpful extra information. It is a coordinate system nothing in
  // the session is using.
  expect(r.text).not.toContain('EPSG');
  expect(r.text).not.toContain('32612');
  expect(activeReadoutCrs({ declared: UTM12N, active: local })).toBe(local);
});

test('an unresolved CRS reads as unresolved, not as the declaration', () => {
  const r = cursorReadout({
    crs: { declared: UTM12N, active: unknownCrs() },
    point: pick(),
    upAxis: 'z',
  });
  expect(r.status).toBe('unresolved');
  expect(r.statusNote).toBe('CRS not resolved');
  expect(r.text).not.toContain('32612');
});

// ── RULE 2: units come from the spatial context ────────────────────────────

test('metre CRS: values are suffixed m and the factor is 1', () => {
  const r = readAt(UTM12N);
  expect(r.unit).toMatchObject({ token: 'metre', metresPerUnit: 1, label: 'm', known: true });
  expect(r.unit.suffix).toBe(' m');
  expect(r.position!.axes.map((a) => a.text)).toEqual([
    '506,283.42 m',
    '3,214,882.71 m',
    '226.38 m',
  ]);
  expect(r.unitNote).toBeNull();
});

test('international-foot CRS: feet, never metres', () => {
  const r = readAt(CA3_FT);
  expect(r.unit).toMatchObject({ token: 'foot', metresPerUnit: M_PER_FT, label: 'ft' });
  expect(r.unit.suffix).toBe(' ft');
  expect(r.text).toContain(' ft');
  expect(r.text).not.toContain(' m ');
  expect(r.text.endsWith(' m')).toBe(false);
});

test('US-survey-foot CRS keeps its own factor — the 2 ppm is not absorbed', () => {
  const us = readAt(CA3_FTUS);
  const intl = readAt(CA3_FT);
  expect(us.unit.token).toBe('us-survey-foot');
  expect(us.unit.metresPerUnit).toBe(M_PER_US_FT);
  expect(us.unit.label).toBe('ftUS');
  // The two feet must not collapse into one another.
  expect(us.unit.metresPerUnit).not.toBe(intl.unit.metresPerUnit);
  expect(us.unit.label).not.toBe(intl.unit.label);
  const ratio = us.unit.metresPerUnit! / intl.unit.metresPerUnit!;
  expect(ratio - 1).toBeGreaterThan(1e-6); // ~2 ppm apart, and in the right direction
  expect(ratio - 1).toBeLessThan(3e-6);
});

test('an unresolved unit is stated as source units and never as metres', () => {
  for (const crs of [localCrs(), unknownCrs(), undefined]) {
    const r = readAt(crs);
    expect(r.unit).toMatchObject({ token: 'unknown', metresPerUnit: null, label: null, known: false });
    expect(r.unit.suffix).toBe('');
    expect(r.unitNote).toBe('source units, no linear unit declared');
    expect(r.text).toContain('source units');
    // No axis may carry a metre (or any) suffix.
    for (const axis of r.position!.axes) {
      expect(axis.unit).toBe('');
      expect(axis.text).not.toContain('m');
    }
    expect(/\d\s*m\b/.test(r.text)).toBe(false);
  }
});

// ── RULE 3: no point under the cursor ──────────────────────────────────────

test('with no point the frame is still reported and no coordinate is invented', () => {
  const r = cursorReadout({ crs: { active: UTM12N }, upAxis: 'z' });
  expect(r.position).toBeNull();
  expect(r.geographic).toBeNull();
  expect(r.crsLabel).toBe('EPSG:32612');
  expect(r.text).toBe('EPSG:32612 | no point under the cursor');
  // Nothing that could be read as an easting/northing.
  expect(/\d{3},\d{3}/.test(r.text)).toBe(false);
});

test('with no point a local frame still states its status', () => {
  const r = cursorReadout({ crs: { active: localCrs() }, upAxis: 'z' });
  expect(r.text).toBe('Local coordinates (no CRS) | local frame, no CRS | no point under the cursor');
  expect(r.position).toBeNull();
});

// ── RULE 4: a Y-up scan is read against its own vertical ───────────────────

test('Y-up: the height is the Y component, not the Z component', () => {
  const zUp = readAt(UTM12N);
  const yUp = cursorReadout({ crs: { active: UTM12N }, point: pick(), upAxis: 'y' });

  expect(zUp.position!.vertical!.axis).toBe('z');
  expect(zUp.position!.vertical!.value).toBe(226.38);

  expect(yUp.position!.upAxis).toBe('y');
  expect(yUp.position!.vertical!.axis).toBe('y');
  expect(yUp.position!.vertical!.value).toBe(3214882.71);
  // Reading a Y-up scan as Z-up is exactly the failure this pins.
  expect(yUp.position!.vertical!.value).not.toBe(zUp.position!.vertical!.value);
  // The elevation axis is displayed last, and the remaining pair is X/Z.
  expect(yUp.position!.axes.map((a) => a.axis)).toEqual(['x', 'z', 'y']);
});

test('Y-up: the horizontal pair is not labelled easting/northing', () => {
  const yUp = cursorReadout({ crs: { active: UTM12N }, point: pick(), upAxis: 'y' });
  const labels = yUp.position!.axes.map((a) => a.label);
  expect(labels.slice(0, 2)).toEqual(['X', 'Z']);
  expect(labels).not.toContain('Easting');
  expect(labels).not.toContain('Northing');
});

test('an undetermined up axis names no height', () => {
  const r = cursorReadout({ crs: { active: UTM12N }, point: pick(), upAxis: 'unknown' });
  expect(r.position!.vertical).toBeNull();
  expect(r.position!.axes.map((a) => a.axis)).toEqual(['x', 'y', 'z']);
});

// ── RULE 5: lat/lon only from a conversion that ran ────────────────────────

const CONVERTED: ConversionResult<GeographicPoint> = {
  ok: true,
  value: { lat: 29.05123, lon: -111.00234 },
  method: 'vendored-utm',
};

test('no conversion supplied → no latitude or longitude', () => {
  const r = readAt(UTM12N);
  expect(r.geographic).toBeNull();
  expect(r.text).not.toContain('Lat');
});

test('a failed conversion is not turned into a guess', () => {
  const r = readAt(UTM12N, {
    geographic: { ok: false, code: 'unsupported-pair', reason: 'no converter for this pair' },
  });
  expect(r.geographic).toBeNull();
  expect(r.text).not.toContain('Lat');
});

test('a successful conversion is shown, with its method', () => {
  const r = readAt(UTM12N, { geographic: CONVERTED });
  expect(r.geographic).toMatchObject({ lat: 29.05123, lon: -111.00234, method: 'vendored-utm' });
  expect(r.geographic!.text).toBe('Lat 29.051230° Lon -111.002340°');
  expect(r.text).toContain('Lat 29.051230°');
});

test('a conversion is withheld when the frame has no horizontal pair to convert', () => {
  // Y-up and undetermined frames: the converter reads X/Y as easting/northing,
  // which in those frames is a vertical slice of the site.
  for (const upAxis of ['y', 'unknown'] as const) {
    const r = cursorReadout({
      crs: { active: UTM12N },
      point: pick(),
      upAxis,
      geographic: CONVERTED,
    });
    expect(r.geographic).toBeNull();
  }
});

test('with no point under the cursor a conversion result is not displayed', () => {
  const r = cursorReadout({ crs: { active: UTM12N }, upAxis: 'z', geographic: CONVERTED });
  expect(r.geographic).toBeNull();
});
