/**
 * On a geographic (degree) CRS the live Measure tool refuses every kind except
 * a pure-vertical height: degree X/Y mixed with a linear Z gives grades,
 * angles and 3D lengths that are wrong as physical figures. Every published
 * surface (PDF rows, CSV, GeoJSON, KML, findings, integrity report) must make
 * the same refusal instead of printing the number.
 */
import { describe, expect, it } from 'vitest';
import type { Measurement, MeasurementKind, Vec3 } from '../src/render/measure/types';
import {
  gradeMeasurement,
  geographicRefusesKind,
} from '../src/render/measure/measurementTrust';
import { GEOGRAPHIC_NOT_AVAILABLE } from '../src/render/measure/types';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import {
  measurementsToCsv,
  measurementsToGeoJSON,
  type MeasurementExportContext,
} from '../src/export/measurementExport';
import {
  findingsReportFile,
  integrityReportFile,
  measurementsToFindings,
} from '../src/export/measurementReport';
import { buildKml, type KmlExportInput } from '../src/export/kmlExport';
import { verifyReportManifest, type ReportManifest } from '../src/render/measure/reportManifest';

const UP: Vec3 = [0, 0, 1];

function mk(id: string, kind: MeasurementKind, points: Vec3[], extra: Partial<Measurement> = {}): Measurement {
  return { id, kind, name: '', points, ...extra } as Measurement;
}

// The audit fixture: 0.001 degrees across, 1 unit up.
const SLOPE = mk('s1', 'slope', [[0, 0, 0], [0.001, 0, 1]]);
const ANGLE = mk('a1', 'angle', [[0.001, 0, 0], [0, 0, 0], [0, 0, 1]]);
const DIST = mk('d1', 'distance', [[0, 0, 0], [0.001, 0, 1]]);
const PROFILE = mk('p1', 'profile', [[0, 0, 0], [0.001, 0, 1]]);
const HEIGHT = mk('h1', 'height', [[0, 0, 0], [0, 0, 1]]);

/** One complete fixture per kind. `Record` makes tsc fail when a kind is added. */
const FIXTURE_BY_KIND: Record<MeasurementKind, Measurement> = {
  distance: DIST,
  polyline: mk('l1', 'polyline', [[0, 0, 0], [0.001, 0, 1], [0.002, 0, 0]]),
  area: mk('r1', 'area', [[0, 0, 0], [0.001, 0, 1], [0.001, 0.001, 1]], { closed: true }),
  height: HEIGHT,
  angle: ANGLE,
  slope: SLOPE,
  profile: PROFILE,
  box: mk('b1', 'box', [[0, 0, 0], [0.001, 0.001, 1]]),
  volume: mk('v1', 'volume', [[0, 0, 0], [0.001, 0, 0], [0.001, 0.001, 0]], {
    volume: { cut: 0.5, fill: 1, net: 0.5, footprintArea: 0.0000005 },
  } as Partial<Measurement>),
};
const ALL_KINDS = Object.keys(FIXTURE_BY_KIND) as MeasurementKind[];

/** Kinds the live grade refuses on a geographic frame, derived from the grader itself. */
const REFUSED_KINDS = ALL_KINDS.filter(
  (kind) =>
    !gradeMeasurement({
      vertices: [{ snappedToPoint: true, pointsWithinRadius: 100 }],
      crsKnown: false,
      geographicCrs: geographicRefusesKind(kind),
    }).presentable,
);

/** Pure-vertical figures stay in the Z unit alone and may still be published. */
const VERTICAL_KEYS = new Set(['vertical_m', 'rise_m', 'height_m', 'vertical_source', 'rise_source', 'height_source']);
const IDENTITY_COLS = new Set(['id', 'name', 'kind', 'source', 'vertices', 'evidence', 'grid_authority']);

const GEO_CTX: MeasurementExportContext = {
  toOutput: (p) => [p[0], p[1], p[2]],
  up: UP,
  unitToMetres: 1,
  verticalUnitToMetres: 1,
  crsName: 'WGS 84 (EPSG:4326)',
  geographic: true,
  unitsVerified: false,
};

/** Split one RFC 4180 line (quoted cells may hold commas). */
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function csvRows(text: string): Record<string, string>[] {
  const [head, ...rows] = text.split('\n');
  const cols = csvCells(head);
  return rows.map((r) => {
    const cells = csvCells(r);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

function kmlInput(ms: readonly Measurement[], geographic: boolean): KmlExportInput {
  return {
    annotations: [],
    measurements: ms,
    viewpoints: [],
    crsName: 'WGS 84',
    unitLabel: 'source units (scale unverified)',
    up: UP,
    unitToMetres: 1,
    toLonLat: (p) => [p[0], p[1], p[2]],
    notSurveyGradeNote: 'Estimates only.',
    geographic,
  };
}

describe('geographic CRS: the audit fixture', () => {
  it('the PDF rows print no grade, angle or mixed length', () => {
    const rows = buildMeasurementRows([SLOPE, ANGLE, DIST, PROFILE, HEIGHT], 'metric', 1, UP, 1, false, true);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    for (const k of ['slope', 'angle', 'distance', 'profile']) {
      expect(byKind[k].value).toBe(GEOGRAPHIC_NOT_AVAILABLE);
      expect(byKind[k].value).not.toMatch(/%|°|\d/);
    }
    expect(byKind.profile.profileExtras).toBeUndefined();
    // A height is pure vertical: still printed, in source units.
    expect(byKind.height.value).toBe('1.0000 source units');
  });

  it('the PDF rows are unchanged on a projected frame', () => {
    const rows = buildMeasurementRows([SLOPE, ANGLE], 'metric', 1, UP, 1, true);
    expect(rows[0].value).toBe('100000.00%');
    expect(rows[1].value).toBe('90.0°');
  });

  it('the CSV blanks grade, angle and mixed lengths and says why', () => {
    const rows = csvRows(measurementsToCsv([SLOPE, ANGLE, DIST, PROFILE, HEIGHT], GEO_CTX));
    const [slope, angle, dist, profile, height] = rows;
    expect(slope.grade_pct).toBe('');
    expect(slope.angle_deg).toBe('');
    expect(slope.rise_source).toBe('1');
    expect(angle.angle_deg).toBe('');
    expect(dist.length_source).toBe('');
    expect(profile.length_source).toBe('');
    expect(profile.grade_pct).toBe('');
    expect(slope.evidence).toContain('geographic CRS');
    expect(height.vertical_source).toBe('1');
    expect(height.evidence).not.toContain('geographic CRS');
  });

  it('the GeoJSON nulls the refused figures and names the frame in its evidence', () => {
    const fc = JSON.parse(measurementsToGeoJSON([SLOPE, ANGLE, DIST, HEIGHT], GEO_CTX));
    const [slope, angle, dist, height] = fc.features.map((f: { properties: Record<string, unknown> }) => f.properties);
    expect(slope.grade_pct).toBeNull();
    expect(slope.angle_deg).toBeNull();
    expect(slope.rise_source).toBe(1);
    expect(slope.not_available).toBe(GEOGRAPHIC_NOT_AVAILABLE);
    expect(angle.angle_deg).toBeNull();
    expect(dist.length_source).toBeNull();
    expect(height.vertical_source).toBe(1);
    expect(height.not_available).toBeUndefined();
    expect(fc.evidence).toMatch(/geographic CRS/i);
    expect(fc.evidence).toMatch(/grades/);
    expect(fc.evidence).toMatch(/angles/);
  });

  it('the findings carry a null value, no unit, and the reason', () => {
    const f = measurementsToFindings([SLOPE, ANGLE, DIST, HEIGHT], UP, 1, 1, { geographic: true, unitsVerified: false });
    for (const finding of f.slice(0, 3)) {
      expect(finding.value).toBeNull();
      expect(finding.unit).toBe('');
      expect(finding.caveats).toContain(GEOGRAPHIC_NOT_AVAILABLE);
    }
    // The height survives, but an unverified length is not called metres.
    expect(f[3].value).toBe(1);
    expect(f[3].unit).toBe('source units');
  });

  it('an unverified length finding off a geographic frame is not called metres', () => {
    const f = measurementsToFindings([mk('d', 'distance', [[0, 0, 0], [3, 0, 0]])], UP, 1, 1, { unitsVerified: false });
    expect(f[0].value).toBe(3);
    expect(f[0].unit).toBe('source units');
  });

  it('the integrity report records null, carries the notice, and verifies', () => {
    const file = integrityReportFile(
      [SLOPE, ANGLE, DIST, HEIGHT], UP, 1, 1, 'scan', 'WGS 84', '2026-10-08T00:00:00Z', 0,
      '0.7.0', false, undefined, undefined, true,
    );
    const manifest = JSON.parse(file.text) as ReportManifest;
    expect(verifyReportManifest(manifest)).toBe(true);
    expect(manifest.findings.slice(0, 3).map((x) => x.value)).toEqual([null, null, null]);
    expect(manifest.findings[3].value).toBe(1);
    expect(file.text).not.toMatch(/"unit": "%"|"unit": "°"|"unit": "m"/);
    expect(manifest.notes?.join(' ')).toMatch(/geographic CRS/i);
  });

  it('the findings-ledger report carries the notice and verifies', () => {
    const findings = measurementsToFindings([SLOPE], UP, 1, 1, { geographic: true, unitsVerified: false });
    const file = findingsReportFile(findings, 'scan', 'WGS 84', '2026-10-08T00:00:00Z', 0, '0.7.0', false, undefined, undefined, true);
    const manifest = JSON.parse(file.text) as ReportManifest;
    expect(verifyReportManifest(manifest)).toBe(true);
    expect(manifest.findings[0].value).toBeNull();
    expect(manifest.notes?.join(' ')).toMatch(/geographic CRS/i);
  });

  it('the KML description drops the refused figures', () => {
    const kml = buildKml(kmlInput([SLOPE, HEIGHT], true));
    expect(kml).not.toMatch(/grade_pct=|angle_deg=/);
    expect(kml).toContain(GEOGRAPHIC_NOT_AVAILABLE);
    expect(kml).toMatch(/rise_m=1/);
    expect(kml).toMatch(/vertical_m=1/);
  });
});

describe('contract: every kind the live grade refuses is refused in every export', () => {
  it('derives a non-empty refused set that excludes height', () => {
    expect(REFUSED_KINDS.length).toBe(ALL_KINDS.length - 1);
    expect(REFUSED_KINDS).not.toContain('height');
  });

  for (const kind of ALL_KINDS) {
    const m = FIXTURE_BY_KIND[kind];
    const refused = REFUSED_KINDS.includes(kind);
    it(`${kind}: ${refused ? 'refused' : 'published'} in PDF, CSV, GeoJSON, KML, findings and integrity report`, () => {
      const row = buildMeasurementRows([m], 'metric', 1, UP, 1, false, true)[0];
      const csv = csvRows(measurementsToCsv([m], GEO_CTX))[0];
      const props = JSON.parse(measurementsToGeoJSON([m], GEO_CTX)).features[0].properties as Record<string, unknown>;
      const finding = measurementsToFindings([m], UP, 1, 1, { geographic: true, unitsVerified: false })[0];
      const kml = buildKml(kmlInput([m], true));
      const report = JSON.parse(
        integrityReportFile([m], UP, 1, 1, 'scan', 'WGS 84', '2026-10-08T00:00:00Z', 0, '0.7.0', false, undefined, undefined, true).text,
      ) as ReportManifest;
      if (refused) {
        expect(row.value).toBe(GEOGRAPHIC_NOT_AVAILABLE);
        for (const [col, v] of Object.entries(csv)) {
          if (IDENTITY_COLS.has(col) || VERTICAL_KEYS.has(col)) continue;
          expect(v, `${kind} CSV ${col}`).toBe('');
        }
        for (const [k, v] of Object.entries(props)) {
          if (!/_(m|m2|m3|source|source2|source3|pct|deg)$/.test(k) || VERTICAL_KEYS.has(k)) continue;
          expect(v, `${kind} GeoJSON ${k}`).toBeNull();
        }
        expect(finding.value).toBeNull();
        expect(report.findings[0].value).toBeNull();
        expect(verifyReportManifest(report)).toBe(true);
        expect(kml).toContain(GEOGRAPHIC_NOT_AVAILABLE);
        expect(kml).not.toMatch(/(length|area|perimeter|grade|angle|volume|cut|fill|net|horizontal|width|depth)_[a-z0-9]+=/);
      } else {
        expect(row.value).not.toBe(GEOGRAPHIC_NOT_AVAILABLE);
        expect(finding.value).not.toBeNull();
        expect(props.not_available).toBeUndefined();
      }
    });
  }
});

describe('a linear compound CRS keeps its physical grade and angle', () => {
  // Metre horizontal over US-foot-style vertical: rise 1 ft = 0.3048 m over a 1 m run.
  const V = 0.3048;
  const slope = mk('s', 'slope', [[0, 0, 0], [1, 0, 1]]);
  const angle = mk('a', 'angle', [[1, 0, 0], [0, 0, 0], [1, 0, 1]]);
  const grade = 30.48;
  const deg = (Math.atan(V) * 180) / Math.PI;

  it('PDF', () => {
    const rows = buildMeasurementRows([slope, angle], 'metric', 1, UP, V, true, false);
    expect(rows[0].value).toBe(`${grade.toFixed(2)}%`);
    expect(rows[1].value).toBe(`${deg.toFixed(1)}°`);
  });

  it('CSV and GeoJSON', () => {
    const ctx: MeasurementExportContext = { ...GEO_CTX, verticalUnitToMetres: V, geographic: false, unitsVerified: true };
    const [s, a] = csvRows(measurementsToCsv([slope, angle], ctx));
    expect(Number(s.grade_pct)).toBeCloseTo(grade, 3);
    expect(Number(a.angle_deg)).toBeCloseTo(deg, 3);
    const fc = JSON.parse(measurementsToGeoJSON([slope], ctx));
    expect(fc.features[0].properties.grade_pct).toBeCloseTo(grade, 3);
  });

  it('findings', () => {
    const f = measurementsToFindings([slope, angle], UP, 1, V, { geographic: false, unitsVerified: true });
    expect(f[0].value).toBeCloseTo(grade, 3);
    expect(f[0].unit).toBe('%');
    expect(f[1].value).toBeCloseTo(deg, 3);
  });
});
