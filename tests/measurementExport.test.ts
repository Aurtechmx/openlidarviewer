/**
 * measurementExport.test.ts
 *
 * Pins the GeoJSON + CSV measurement serializers: geometry types per kind,
 * closed polygon rings, CRS handling, unit conversion, and honest blanks.
 */

import { describe, it, expect } from 'vitest';
import {
  measurementsToGeoJSON,
  measurementsToCsv,
  measurementMetrics,
  type MeasurementExportContext,
} from '../src/export/measurementExport';
import type { Measurement, Vec3 } from '../src/render/measure/types';

const UP: Vec3 = [0, 0, 1];
/** Identity output frame, metric, projected with a CRS name. */
const CTX: MeasurementExportContext = {
  toOutput: (p) => [p[0], p[1], p[2]],
  up: UP,
  unitToMetres: 1,
  crsName: 'EPSG:32612',
};

function mk(kind: Measurement['kind'], points: Vec3[], extra: Partial<Measurement> = {}): Measurement {
  return { id: `m-${kind}`, kind, name: `${kind} 1`, points, ...extra };
}

const DISTANCE = mk('distance', [[0, 0, 0], [3, 4, 0]]);
const AREA = mk('area', [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], { closed: true });
const BOX = mk('box', [[0, 0, 0], [2, 3, 4]]);
const VOLUME = mk('volume', [[0, 0, 0], [10, 0, 0], [10, 10, 0]], {
  volume: {
    fill: 120, cut: 30, net: 90, referenceZ: 0, footprintArea: 50,
    pointsInPolygon: 800, densityNative: 16, confidence: 'medium',
  },
});

describe('measurementsToCsv — formula-injection neutralisation', () => {
  it('neutralises a name that begins with a spreadsheet formula trigger', () => {
    const evil = mk('distance', [[0, 0, 0], [3, 4, 0]], { name: '=HYPERLINK("http://evil","x")' });
    const csv = measurementsToCsv([evil], CTX);
    // Prefixed with a literal apostrophe and force-quoted (quotes doubled).
    expect(csv).toContain('"\'=HYPERLINK(""http://evil"",""x"")"');
    // The raw, un-neutralised formula must NOT appear at a cell boundary.
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it('neutralises @, +, and - leading names too', () => {
    for (const name of ['@SUM(1+1)', '+1+2', '-2+3']) {
      const csv = measurementsToCsv([mk('distance', [[0, 0, 0], [1, 0, 0]], { name })], CTX);
      expect(csv).toContain(`"'${name}"`);
    }
  });

  it('leaves a benign name and negative numeric cells untouched', () => {
    const csv = measurementsToCsv([mk('distance', [[0, 0, 0], [3, 4, 0]], { name: 'Polyline 2' })], CTX);
    const row = csv.split('\n')[1];
    expect(row.split(',')).toContain('Polyline 2');
    // A negative numeric value (downhill vertical) must NOT be apostrophe-prefixed.
    const slopeCsv = measurementsToCsv([mk('distance', [[0, 0, 0], [3, 0, -4]])], CTX);
    expect(slopeCsv).not.toContain("'-");
  });
});

describe('measurementMetrics', () => {
  it('distance → length in metres', () => {
    expect(measurementMetrics(DISTANCE, UP, 1)).toEqual({ length_m: 5 });
  });

  it('area → planar area + perimeter', () => {
    const m = measurementMetrics(AREA, UP, 1);
    expect(m.area_m2).toBe(100);
    expect(m.perimeter_m).toBe(40);
  });

  it('compound CRS: slope/distance computed in a physical metric frame (M2)', () => {
    // metre horizontal (unitToMetres=1) over foot vertical (verticalToMetres=0.3048).
    // A 1-unit run with a 1-unit (= 1 ft) rise.
    const slope = measurementMetrics(mk('slope', [[0, 0, 0], [1, 0, 1]]), UP, 1, 0.3048);
    // Physical grade 0.3048 m / 1 m = 30.48 %, NOT the raw-coordinate 100 %.
    expect(slope.grade_pct).toBeCloseTo(30.48, 1);
    expect(slope.rise_m).toBeCloseTo(0.3048, 3);
    expect(slope.run_m).toBeCloseTo(1, 3);
    // And the 3D distance scales each axis by its own factor.
    const dist = measurementMetrics(mk('distance', [[0, 0, 0], [1, 0, 1]]), UP, 1, 0.3048);
    expect(dist.length_m).toBeCloseTo(Math.hypot(1, 0.3048), 3); // 1.0453, not 1.4142
  });

  it('area_m2 is the PLANAR (live) area, with the map footprint alongside (M4)', () => {
    // A vertical 10×10 wall in the XZ plane: its true tilted-plane area is 100
    // (what the live headline shows), but its horizontal projection is ~0. The
    // export used to write the projection as `area_m2`, contradicting the screen.
    const wall = mk('area', [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]], { closed: true });
    const m = measurementMetrics(wall, UP, 1);
    expect(m.area_m2).toBeCloseTo(100, 6);
    expect(m.horizontal_area_m2).toBeCloseTo(0, 6);
  });

  it('box → width / depth / height / volume', () => {
    expect(measurementMetrics(BOX, UP, 1)).toMatchObject({
      width_m: 2, depth_m: 3, height_m: 4, volume_m3: 24,
    });
  });

  it('volume → cut / fill / net, no scaling at metric scale (×1)', () => {
    const m = measurementMetrics(VOLUME, UP, 1);
    expect(m.cut_m3).toBe(30);
    expect(m.fill_m3).toBe(120);
    expect(m.net_m3).toBe(90);
  });

  // a switched lasso record's fill/cut/net are the grid figure; the
  // point-sample cross-check rides alongside under its own column names.
  const GRID_VOLUME = mk('volume', [[0, 0, 0], [10, 0, 0], [10, 10, 0]], {
    volume: {
      fill: 100, cut: 5, net: 95, referenceZ: 0, footprintArea: 50,
      pointsInPolygon: 800, densityNative: 16, confidence: 'medium',
      method: 'olv.volume.stockpile-area-grid@3', gridAuthority: 'measured', gridAuthorityReason: '',
      crossCheck: { fill: 120, cut: 30, net: 90, method: 'olv.volume.stockpile@1' }, // method-literal-ok: a record stored at an earlier version
    },
  });

  it('a switched record exports the grid figure under cut_m3/fill_m3/net_m3 and the cross-check separately', () => {
    const m = measurementMetrics(GRID_VOLUME, UP, 1);
    expect(m.fill_m3).toBe(100);
    expect(m.cut_m3).toBe(5);
    expect(m.net_m3).toBe(95);
    expect(m.pointsample_fill_m3).toBe(120);
    expect(m.pointsample_cut_m3).toBe(30);
    expect(m.pointsample_net_m3).toBe(90);
  });

  it('a withheld grid record exports no cut_m3/fill_m3/net_m3, only the cross-check', () => {
    const withheld = mk('volume', [[0, 0, 0], [10, 0, 0], [10, 10, 0]], {
      volume: {
        referenceZ: 0, footprintArea: 50, pointsInPolygon: 800, densityNative: 16,
        confidence: 'high', method: 'olv.volume.stockpile-area-grid@3',
        gridAuthority: 'withheld', gridAuthorityReason: 'insufficient observations',
        crossCheck: { fill: 120, cut: 30, net: 90, method: 'olv.volume.stockpile@1' }, // method-literal-ok: a record stored at an earlier version
      },
    } as never);
    const m = measurementMetrics(withheld, UP, 1);
    expect(m.fill_m3).toBeUndefined();
    expect(m.cut_m3).toBeUndefined();
    expect(m.net_m3).toBeUndefined();
    expect(m.pointsample_fill_m3).toBe(120);
  });

  it('applies unitToMetres to lengths (×), areas (×²), and volumes (×³)', () => {
    expect(measurementMetrics(DISTANCE, UP, 0.3048).length_m).toBeCloseTo(5 * 0.3048, 3);
    // Export rounds to 3 decimals, so compare at that precision.
    expect(measurementMetrics(AREA, UP, 0.3048).area_m2).toBeCloseTo(100 * 0.3048 ** 2, 3);
    // Regression: a foot-CRS stockpile volume must export in cubic metres, not
    // native ft³ mislabelled as m³. cut/fill/net are stored native → ×0.3048³.
    const v = measurementMetrics(VOLUME, UP, 0.3048);
    expect(v.cut_m3).toBeCloseTo(30 * 0.3048 ** 3, 3);
    expect(v.fill_m3).toBeCloseTo(120 * 0.3048 ** 3, 3);
    expect(v.net_m3).toBeCloseTo(90 * 0.3048 ** 3, 3);
  });

  it('an INCOMPLETE measurement emits no metrics (never zero-filled)', () => {
    expect(measurementMetrics(mk('area', [[0, 0, 0], [1, 0, 0]]), UP, 1)).toEqual({});
    expect(measurementMetrics(mk('distance', [[0, 0, 0]]), UP, 1)).toEqual({});
  });

  it('a compound CRS scales vertical quantities by the vertical factor, horizontals by the linear', () => {
    // Metre eastings (unitToMetres = 1) over US-survey-foot heights (vertical ≈
    // 0.3048). Vertical quantities must match the panel headline, which already
    // uses the vertical factor; horizontals stay in metres.
    const box = measurementMetrics(BOX, UP, 1, 0.3048); // UP = +Z, so height is the Z span (4)
    expect(box.width_m).toBeCloseTo(2, 3); // horizontal — linear factor (1)
    expect(box.depth_m).toBeCloseTo(3, 3); // horizontal — linear factor (1)
    expect(box.height_m).toBeCloseTo(4 * 0.3048, 3); // vertical — vertical factor
    expect(box.volume_m3).toBeCloseTo(24 * 1 * 1 * 0.3048, 3); // linear²·vertical, NOT linear³
    // cut/fill/net use the same linear²·vertical volume factor.
    const vol = measurementMetrics(VOLUME, UP, 1, 0.3048);
    expect(vol.cut_m3).toBeCloseTo(30 * 0.3048, 3);
  });

  it('the vertical factor defaults to unitToMetres (single-unit CRS byte-identical)', () => {
    expect(measurementMetrics(BOX, UP, 0.3048)).toEqual(measurementMetrics(BOX, UP, 0.3048, 0.3048));
  });
});

describe('measurementsToGeoJSON', () => {
  it('emits a FeatureCollection with one feature per complete measurement', () => {
    const fc = JSON.parse(measurementsToGeoJSON([DISTANCE, AREA, BOX, VOLUME], CTX));
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(4);
  });

  it('line kinds → LineString; polygon kinds → closed Polygon', () => {
    const fc = JSON.parse(measurementsToGeoJSON([DISTANCE, AREA], CTX));
    const dist = fc.features.find((f: { properties: { kind: string } }) => f.properties.kind === 'distance');
    const area = fc.features.find((f: { properties: { kind: string } }) => f.properties.kind === 'area');
    expect(dist.geometry.type).toBe('LineString');
    expect(dist.geometry.coordinates).toEqual([[0, 0, 0], [3, 4, 0]]);
    expect(area.geometry.type).toBe('Polygon');
    // Ring is closed: last coord equals the first.
    const ring = area.geometry.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('carries metrics + crs in feature properties', () => {
    const fc = JSON.parse(measurementsToGeoJSON([DISTANCE], CTX));
    expect(fc.features[0].properties).toMatchObject({ kind: 'distance', length_m: 5, crs: 'EPSG:32612' });
  });

  it('projected export carries a named-CRS member; geographic does not', () => {
    const projected = JSON.parse(measurementsToGeoJSON([DISTANCE], CTX));
    // The member carries a resolvable IDENTIFIER, not the label: emitting the
    // raw name left a reader unable to resolve it and silently defaulting to
    // WGS84. The per-feature `crs` property above keeps the human label.
    expect(projected.crs).toMatchObject({
      type: 'name',
      properties: { name: 'urn:ogc:def:crs:EPSG::32612' },
    });
    const geo = JSON.parse(
      measurementsToGeoJSON([DISTANCE], { ...CTX, geographic: true }),
    );
    expect(geo.crs).toBeUndefined();
  });

  it('applies the toOutput transform to coordinates', () => {
    const fc = JSON.parse(
      measurementsToGeoJSON([DISTANCE], { ...CTX, toOutput: (p) => [p[0] + 100, p[1] + 200, p[2]] }),
    );
    expect(fc.features[0].geometry.coordinates[0]).toEqual([100, 200, 0]);
  });

  it('drops measurements with too few vertices', () => {
    const fc = JSON.parse(measurementsToGeoJSON([mk('area', [[0, 0, 0], [1, 0, 0]])], CTX));
    expect(fc.features).toHaveLength(0);
  });
});

describe('measurementsToCsv', () => {
  it('header lists every column; one row per measurement', () => {
    const csv = measurementsToCsv([DISTANCE, AREA], CTX);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('id,name,kind,vertices');
    expect(lines).toHaveLength(3); // header + 2 rows
  });

  it('fills only the applicable metric columns, leaving others blank', () => {
    const csv = measurementsToCsv([DISTANCE], CTX);
    const header = csv.split('\n')[0].split(',');
    const row = csv.split('\n')[1].split(',');
    const cell = (col: string): string => row[header.indexOf(col)];
    expect(cell('length_m')).toBe('5');
    expect(cell('area_m2')).toBe(''); // not applicable to a distance
    expect(cell('kind')).toBe('distance');
  });

  it('escapes a name containing a comma', () => {
    const csv = measurementsToCsv([mk('distance', [[0, 0, 0], [1, 0, 0]], { name: 'A, B' })], CTX);
    expect(csv).toContain('"A, B"');
  });
});

describe('measurementsToCsv — grid-canonical lasso volumes', () => {
  const gridVol = mk('volume', [[0, 0, 0], [10, 0, 0], [10, 10, 0]], {
    volume: {
      fill: 100, cut: 5, net: 95, referenceZ: 0, footprintArea: 50,
      pointsInPolygon: 800, densityNative: 16, confidence: 'medium',
      method: 'olv.volume.stockpile-area-grid@3', gridAuthority: 'preview', gridAuthorityReason: 'display sample',
      crossCheck: { fill: 120, cut: 30, net: 90, method: 'olv.volume.stockpile@1' }, // method-literal-ok: a record stored at an earlier version
    },
  });

  it('carries grid_authority and the pointsample_* cross-check columns beside cut_m3/fill_m3/net_m3', () => {
    const csv = measurementsToCsv([gridVol], CTX);
    const header = csv.split('\n')[0].split(',');
    const row = csv.split('\n')[1].split(',');
    const cell = (col: string): string => row[header.indexOf(col)];
    expect(header).toEqual(expect.arrayContaining([
      'grid_authority', 'pointsample_cut_m3', 'pointsample_fill_m3', 'pointsample_net_m3',
    ]));
    expect(cell('fill_m3')).toBe('100');
    expect(cell('grid_authority')).toBe('preview');
    expect(cell('pointsample_fill_m3')).toBe('120');
  });

  it('a plain (non-grid) volume leaves grid_authority and the cross-check columns blank', () => {
    const csv = measurementsToCsv([VOLUME], CTX);
    const header = csv.split('\n')[0].split(',');
    const row = csv.split('\n')[1].split(',');
    const cell = (col: string): string => row[header.indexOf(col)];
    expect(cell('grid_authority')).toBe('');
    expect(cell('pointsample_fill_m3')).toBe('');
  });

  it('renames the cross-check columns to source units too when the scale is unverified', () => {
    const csv = measurementsToCsv([gridVol], { ...CTX, unitsVerified: false });
    const header = csv.split('\n')[0].split(',');
    expect(header).toContain('pointsample_fill_source3');
    for (const col of header) {
      expect(col, `${col} asserts a metric unit on an unverified scale`).not.toMatch(/_m[23]?$/);
    }
  });
});

/**
 * The named-CRS member must carry an identifier a reader can resolve, not a
 * label a human can read. `ctx.crsName` in production is the display string the
 * CRS parsers build — "NAD83 / UTM zone 13N (EPSG:26913)" — and emitting that
 * as the crs name left QGIS/OGR unable to resolve it, falling back to RFC 7946's
 * default WGS84: easting 500000 read as longitude 500000. The earlier test
 * injected an idealized 'EPSG:32612', which is why this survived.
 */
describe('measurementsToGeoJSON — a resolvable CRS identifier', () => {
  const ctx = (crsName?: string) => ({
    toOutput: (p: readonly number[]) => [p[0], p[1], p[2]] as [number, number, number],
    up: [0, 0, 1] as [number, number, number],
    unitToMetres: 1,
    crsName,
    geographic: false,
  });
  const m = [{ id: 'm1', kind: 'distance', name: '', points: [[0, 0, 0], [3, 0, 0]] }] as never;

  it('emits an OGC URN for the display string the parsers actually build', () => {
    const fc = JSON.parse(measurementsToGeoJSON(m, ctx('NAD83 / UTM zone 13N (EPSG:26913)') as never));
    expect(fc.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::26913');
  });

  it('emits an OGC URN for a bare authority string too', () => {
    const fc = JSON.parse(measurementsToGeoJSON(m, ctx('EPSG:32612') as never));
    expect(fc.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::32612');
  });

  it('omits the crs member when no code can be recovered', () => {
    // Naming an unresolvable CRS is worse than naming none: a reader silently
    // falls back to WGS84 and places projected coordinates in the ocean.
    const fc = JSON.parse(measurementsToGeoJSON(m, ctx('Some unnamed local grid') as never));
    expect(fc.crs).toBeUndefined();
  });

  it('still omits the crs member for geographic output', () => {
    const fc = JSON.parse(measurementsToGeoJSON(m, { ...ctx('EPSG:4326'), geographic: true } as never));
    expect(fc.crs).toBeUndefined();
  });
});

// ── M1: unknown scale must not silently claim metres ─────────────────────────
// A local / unknown-unit scan has an inert unitToMetres of 1, so the `_m`
// columns are nominal render units, not confirmed metres. The evidence note on
// each surface must say so; a georeferenced export (unitsVerified true / unset)
// is byte-identical to before.
describe('unverified units caveat (M1)', () => {
  it('GeoJSON evidence carries the caveat only when the scale is unverified', () => {
    const verified = JSON.parse(measurementsToGeoJSON([DISTANCE], CTX));
    expect(verified.evidence).not.toMatch(/units unverified/i);

    const unverified = JSON.parse(
      measurementsToGeoJSON([DISTANCE], { ...CTX, unitsVerified: false }),
    );
    expect(unverified.evidence).toMatch(/units unverified/i);
    // The value is still emitted — the geometry is real — but under a name that
    // does not assert metres. The row used to read `length_m: 5` beside an
    // evidence string saying the units were unverified: a human read both, a
    // parser read metres.
    const props = unverified.features[0].properties as Record<string, unknown>;
    expect(props.length_source).toBe(5);
    expect(props.length_m).toBeUndefined();
    for (const key of Object.keys(props)) {
      expect(key, `${key} asserts a metric unit on an unverified scale`).not.toMatch(/_m[23]?$/);
    }
  });

  it('renames every unit-bearing column when the scale is unresolved, and only then', () => {
    // Area and volume carry the squared and cubed suffixes, which must not be
    // matched as a bare `_m`; unitless columns are untouched.
    const csv = measurementsToCsv([DISTANCE], { ...CTX, unitsVerified: false });
    const header = csv.split('\n')[0].split(',');
    expect(header).toContain('length_source');
    expect(header).toContain('area_source2');
    expect(header).toContain('volume_source3');
    expect(header).toContain('grade_pct');
    expect(header).toContain('angle_deg');
    for (const col of header) {
      expect(col, `${col} asserts a metric unit on an unverified scale`).not.toMatch(/_m[23]?$/);
    }
    // A resolved scale keeps the metric names exactly as before.
    const known = measurementsToCsv([DISTANCE], CTX).split('\n')[0].split(',');
    expect(known).toContain('length_m');
    expect(known).toContain('area_m2');
    expect(known).toContain('volume_m3');
    expect(known).not.toContain('length_source');
  });

  it('CSV evidence column carries the caveat only when the scale is unverified', () => {
    const verified = measurementsToCsv([DISTANCE], CTX);
    expect(verified).not.toMatch(/units-unverified/);

    const unverified = measurementsToCsv([DISTANCE], { ...CTX, unitsVerified: false });
    expect(unverified).toMatch(/units-unverified/);
  });
});

// A CSV or GeoJSON holds mixed kinds, and one hardcoded `MEAS-DISTANCE`
// stamped all of them: a profile row carried the distance claim's exploratory
// verdict although MEAS-PROFILE meets its required level, and a volume row was
// stamped with a claim that never evaluated a volume.
describe('the evidence stamp names the claim behind each figure', () => {
  const ctx = {
    toOutput: (p: readonly number[]) => [p[0], p[1], p[2]] as [number, number, number],
    up: [0, 0, 1] as [number, number, number],
    unitToMetres: 1,
    verticalUnitToMetres: 1,
    crsName: 'EPSG:26913',
    geographic: false,
    unitsVerified: true,
  } as never;
  const dist = { id: 'd', kind: 'distance', name: 'd', points: [[0, 0, 0], [3, 0, 0]] } as never;
  const prof = { id: 'p', kind: 'profile', name: 'p', points: [[0, 0, 0], [3, 0, 1]] } as never;

  it('gives a profile row a different verdict from a distance row', () => {
    const csv = measurementsToCsv([dist, prof], ctx);
    const [, dRow, pRow] = csv.split('\n');
    expect(dRow).not.toBe(pRow);
    // MEAS-PROFILE meets its required level; MEAS-DISTANCE does not.
    expect(pRow).toMatch(/validated/i);
    expect(dRow).toMatch(/exploratory/i);
  });

  it('names every claim a mixed collection draws on, once each', () => {
    const note = JSON.parse(measurementsToGeoJSON([dist, prof, dist], ctx)).evidence as string;
    expect(note).toContain('MEAS-DISTANCE');
    expect(note).toContain('MEAS-PROFILE');
    expect(note.match(/MEAS-DISTANCE/g)).toHaveLength(1);
  });

  // a lasso volume whose record switched to the area-weighted grid draws
  // on VOL-STOCKPILE, not VOL-POINT-SAMPLE — the same defect this describe
  // block's own header names, one level down (a claim per INSTANCE, not kind).
  const gridVol = {
    id: 'g', kind: 'volume', name: 'g', points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]],
    volume: {
      fill: 100, cut: 5, net: 95, referenceZ: 0, footprintArea: 50,
      pointsInPolygon: 800, densityNative: 16, confidence: 'medium',
      method: 'olv.volume.stockpile-area-grid@3', gridAuthority: 'measured', gridAuthorityReason: '',
    },
  } as never;
  const psVol = {
    id: 'v', kind: 'volume', name: 'v', points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]],
    volume: {
      fill: 100, cut: 5, net: 95, referenceZ: 0, footprintArea: 50,
      pointsInPolygon: 800, densityNative: 16, confidence: 'medium',
    },
  } as never;

  it('a grid-canonical volume draws on VOL-STOCKPILE', () => {
    const note = JSON.parse(measurementsToGeoJSON([gridVol], ctx)).evidence as string;
    expect(note).toContain('VOL-STOCKPILE');
    expect(note).not.toContain('VOL-POINT-SAMPLE');
  });

  it('an un-switched volume still draws on VOL-POINT-SAMPLE, and both appear when mixed', () => {
    const note = JSON.parse(measurementsToGeoJSON([gridVol, psVol], ctx)).evidence as string;
    expect(note).toContain('VOL-STOCKPILE');
    expect(note).toContain('VOL-POINT-SAMPLE');
  });

  // A withheld grid published no figure at all; the row's only numbers are
  // the point-sample cross-check, so the claim it draws on must say so too.
  const withheldGridVol = {
    id: 'w', kind: 'volume', name: 'w', points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]],
    volume: {
      referenceZ: 0, footprintArea: 50, pointsInPolygon: 800, densityNative: 16,
      confidence: 'high', method: 'olv.volume.stockpile-area-grid@3',
      gridAuthority: 'withheld', gridAuthorityReason: 'insufficient observations',
      crossCheck: { fill: 120, cut: 30, net: 90, method: 'olv.volume.stockpile@1' }, // method-literal-ok: a record stored at an earlier version
    },
  } as never;

  it('a withheld grid record draws on VOL-POINT-SAMPLE, not VOL-STOCKPILE', () => {
    const note = JSON.parse(measurementsToGeoJSON([withheldGridVol], ctx)).evidence as string;
    expect(note).toContain('VOL-POINT-SAMPLE');
    expect(note).not.toContain('VOL-STOCKPILE');
  });
});

// Deriving the stamp from the kinds present meant an EMPTY collection produced
// an empty string, where a reader expects a statement. A collection with
// nothing in it makes no claim, so the member is absent rather than blank.
describe('an empty collection carries no verdict', () => {
  const emptyCtx = (unitsVerified: boolean): never => ({
    toOutput: (p: readonly number[]) => [p[0], p[1], p[2]] as [number, number, number],
    up: [0, 0, 1] as [number, number, number],
    unitToMetres: 1, verticalUnitToMetres: 1,
    crsName: 'EPSG:26913', geographic: false, unitsVerified,
  }) as never;

  it('omits the evidence member rather than writing an empty one', () => {
    const fc = JSON.parse(measurementsToGeoJSON([], emptyCtx(true)));
    expect(fc.features).toHaveLength(0);
    expect('evidence' in fc).toBe(false);
  });

  it('still carries the units caveat when there is one to carry', () => {
    const fc = JSON.parse(measurementsToGeoJSON([], emptyCtx(false)));
    expect(fc.evidence).toMatch(/units unverified/i);
  });
});


// The claim stamp's order is part of a provenance record, so it must be the
// same on every machine. Sonar flags a bare `.sort()` and suggests
// `localeCompare` — which would be the wrong fix here, because it is
// locale-dependent and would let the same measurement set stamp differently
// under a different locale.
describe('the claim stamp orders the same way everywhere', () => {
  const ctx = {
    toOutput: (p: readonly number[]) => [p[0], p[1], p[2]] as [number, number, number],
    up: [0, 0, 1] as [number, number, number],
    unitToMetres: 1, verticalUnitToMetres: 1,
    crsName: 'EPSG:26913', geographic: false, unitsVerified: true,
  } as never;
  const m = (id: string, kind: string) =>
    ({ id, kind, name: id, points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] }) as never;

  it('does not depend on the order the measurements were placed in', () => {
    const forward = [m('a', 'volume'), m('b', 'area'), m('c', 'distance'), m('d', 'profile')];
    const reversed = [...forward].reverse();
    const a = JSON.parse(measurementsToGeoJSON(forward, ctx)).evidence as string;
    const b = JSON.parse(measurementsToGeoJSON(reversed, ctx)).evidence as string;
    expect(b).toBe(a);
  });

  it('puts the ids in code-unit order, which no locale can change', () => {
    const note = JSON.parse(
      measurementsToGeoJSON([m('v', 'volume'), m('d', 'distance'), m('a', 'area')], ctx),
    ).evidence as string;
    const ids = [...note.matchAll(/\b([A-Z][A-Z0-9-]+):/g)].map((x) => x[1]);
    expect(ids).toEqual([...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    expect(ids).toEqual(['MEAS-AREA', 'MEAS-DISTANCE', 'VOL-POINT-SAMPLE']);
  });
});
