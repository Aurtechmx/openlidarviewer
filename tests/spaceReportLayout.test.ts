/**
 * spaceReportLayout.test.ts
 *
 * The pure Space / Object report content builder: interior vs object field sets,
 * m+ft values, the dedicated provenance + not-survey-grade line, and graceful
 * handling when a metric is null. No pdf-lib is touched.
 */

import { describe, it, expect } from 'vitest';
import { buildSpaceReportContent } from '../src/terrain/space/spaceReportLayout';
import { knownUnit, unknownUnit } from '../src/units/units';
import { spaceMetrics } from '../src/terrain/spaceMetrics';
import { classifyScanShape } from '../src/terrain/scanShape';
import { NOT_SURVEY_GRADE_NOTE } from '../src/terrain/export/exportProvenance';
import { evidenceNote } from '../src/validation/exportEvidenceNote';
import {
  objectMetrics,
  ANGULAR_COVERAGE_LABEL,
  ANGULAR_COVERAGE_HINT,
  OBJECT_ENVELOPE_VOLUME_HINT,
  OBJECT_SURFACE_AREA_HINT,
  type ObjectMetrics,
} from '../src/terrain/objectMetrics';

function room(W = 14, D = 29, H = 5, step = 0.5): Float32Array {
  const t: number[] = [];
  const push = (x: number, y: number, z: number): void => { t.push(x, y, z); };
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) { push(x, y, 0); push(x, y, H); }
  for (let z = 0; z <= H; z += step)
    for (let x = 0; x <= W; x += step) { push(x, 0, z); push(x, D, z); }
  for (let z = 0; z <= H; z += step)
    for (let y = 0; y <= D; y += step) { push(0, y, z); push(W, y, z); }
  return Float32Array.from(t);
}

function cubeShell(): Float32Array {
  const cube: number[] = [];
  for (let u = 0; u <= 4; u += 0.5)
    for (let w = 0; w <= 4; w += 0.5) {
      cube.push(u, w, 0, u, w, 4, u, 0, w, u, 4, w, 0, u, w, 4, u, w);
    }
  return Float32Array.from(cube);
}

const allText = (c: ReturnType<typeof buildSpaceReportContent>): string =>
  [
    c.title,
    c.subtitle,
    ...c.sections.flatMap((s) => [s.title, ...s.rows.flatMap((r) => [r.label, r.value])]),
    ...c.provenanceLines,
    ...c.caveats,
  ].join(' | ');

describe('buildSpaceReportContent — interior', () => {
  const pos = room();
  const shape = classifyScanShape(pos);
  // A DECLARED metre CRS (`unitKnown: true`), so the m + ft rows below are
  // asserted against a scan whose scale the CRS authority actually resolved.
  // Without the flag the scale is unverified and the rows print source units.
  const space = spaceMetrics(pos, {
    upAxis: shape.up, spaceKind: 'interior', hasRgb: true,
    unitToMetres: 1, unitKnown: true,
  });
  const content = buildSpaceReportContent({
    space,
    name: 'House 360',
    softwareVersion: '0.4.3',
    metricVersion: 'v0.4.1',
    generatedAt: new Date('2026-06-08T10:00:00Z'),
  });

  it('names the interior type and the interior field set', () => {
    expect(content.subtitle).toBe('Interior space');
    const text = allText(content);
    for (const field of [
      'House 360', 'Dimensions', 'L x W x H', 'Floor area', 'Ceiling height',
      'Enclosed volume', 'Storeys', 'Planes', 'Floor', 'Ceiling', 'Walls',
      'Capture quality', 'Density', 'Bounding area filled', 'Colour (RGB)',
    ]) {
      expect(text, `missing "${field}"`).toContain(field);
    }
  });

  it('shows m + ft values for the dimensions', () => {
    const text = allText(content);
    expect(text).toMatch(/m\b/);
    expect(text).toMatch(/ft\)/);
  });

  it('carries the dedicated provenance + not-survey-grade line', () => {
    const text = allText(content);
    expect(text).toContain('OpenLiDARViewer 0.4.3');
    expect(text).toContain('v0.4.1');
    expect(text).toContain('Interior space'); // scan type in provenance
    expect(content.provenance.notSurveyGrade).toBe(NOT_SURVEY_GRADE_NOTE);
    expect(content.provenanceLines.join(' ')).toContain(NOT_SURVEY_GRADE_NOTE);
  });
});

describe('buildSpaceReportContent — object', () => {
  const pos = cubeShell();
  const space = spaceMetrics(pos, {
    upAxis: 'z', spaceKind: 'object', hasRgb: true, unitToMetres: 1, unitKnown: true,
  });
  const content = buildSpaceReportContent({
    space,
    object: objectMetrics(pos),
    name: 'Sculpture',
    softwareVersion: '0.4.3',
    metricVersion: 'v0.4.1',
  });

  it('names the object type and the object field set', () => {
    expect(content.subtitle).toBe('Object');
    const text = allText(content);
    for (const field of [
      'Sculpture', 'Oriented', 'Axis-aligned', 'Largest dimension',
      'Envelope volume', 'Bounding surface area', 'Angular coverage', 'Capture quality',
    ]) {
      expect(text, `missing "${field}"`).toContain(field);
    }
    // No interior-only sections in the object report.
    expect(text).not.toContain('Storeys');
  });

  it('shows m³ + ft³ and m² + ft² values', () => {
    const text = allText(content);
    expect(text).toContain('ft³'); // envelope volume shows feet³ alongside metres³
    expect(text).toContain('ft²'); // surface area shows feet² alongside metres²
  });
});

describe('buildSpaceReportContent — graceful', () => {
  it('returns a near-empty but valid report when space is null', () => {
    const content = buildSpaceReportContent({ space: null, name: 'Empty' });
    expect(content.title).toBe('Empty');
    expect(content.sections.length).toBeGreaterThan(0);
    expect(content.provenance.notSurveyGrade).toBe(NOT_SURVEY_GRADE_NOTE);
    expect(content.caveats).toEqual([]);
  });

  it('every provenance line keeps at least two spaces between key and value', () => {
    // Guards the kv gutter: a future key at or past the column width must not
    // jam into its value (the terrain provenance kv had exactly this bug).
    const lines = buildSpaceReportContent({ space: null, name: 'Empty' }).provenanceLines;
    for (const line of lines) expect(line).toMatch(/^\S.*?\s{2,}\S/);
  });
});

// ── Source-unit honesty on the provenance "Units" line ──────────────────────
// The report used to label EVERY factor-of-1 scan "metres (assumed)", so an
// unknown / local scan (factor defaults to 1) asserted metres it never knew.
// The scale is now discriminated: unknown units make NO metre claim; a known
// metre CRS still says metres; a known foot CRS says feet.
describe('buildSpaceReportContent — source-unit honesty', () => {
  type UnitOpts = { linearUnit?: ReturnType<typeof knownUnit>; unitToMetres?: number };
  const unitsOf = (opts: UnitOpts): string =>
    buildSpaceReportContent({ space: null, name: 'Scan', ...opts }).provenance.units;

  it('an UNKNOWN unit scale makes no metre claim', () => {
    const u = unitsOf({ linearUnit: unknownUnit() });
    expect(u).toBe('source units (scale unverified — not asserted as metres)');
    // Never the old false claim, and never a bare positive "metres" assertion.
    expect(u).not.toContain('metres (assumed)');
    expect(u).not.toMatch(/^metres\b/);
    // The provenance footer line must not smuggle the metre claim back either.
    const lines = buildSpaceReportContent({ space: null, linearUnit: unknownUnit() }).provenanceLines;
    expect(lines.join(' ')).not.toContain('metres (assumed)');
  });

  it('a KNOWN metre CRS still shows metres', () => {
    expect(unitsOf({ linearUnit: knownUnit(1) })).toBe('metres');
  });

  it('a KNOWN foot CRS shows feet, converted to metres', () => {
    expect(unitsOf({ linearUnit: knownUnit(0.3048) })).toBe('feet (source) → metres');
    expect(unitsOf({ linearUnit: knownUnit(1200 / 3937) })).toBe('feet (source) → metres');
  });

  it('the legacy factor-of-1 path no longer asserts "metres (assumed)"', () => {
    // This is the exact shape the production caller passes for an unknown /
    // local scan (crsService factor defaults to 1).
    const u = unitsOf({ unitToMetres: 1 });
    expect(u).not.toContain('metres (assumed)');
    expect(u).toBe('source units (scale unverified — not asserted as metres)');
  });

  it('the legacy numeric path still reports a known foot factor honestly', () => {
    expect(unitsOf({ unitToMetres: 0.3048 })).toBe('feet (source) → metres');
  });
});

describe('buildSpaceReportContent — graceful (ceiling)', () => {
  it('handles a missing ceiling height (null) without throwing', () => {
    // An open object scan presented as interior: ceilingHeightM can be null.
    const pos = cubeShell();
    const space = spaceMetrics(pos, { upAxis: 'z', spaceKind: 'interior' });
    const content = buildSpaceReportContent({ space, name: 'Partial' });
    const ceilingRow = content.sections
      .flatMap((s) => s.rows)
      .find((r) => r.label === 'Ceiling height');
    expect(ceilingRow).toBeDefined();
    // null metric renders as an em-dash, never a fabricated zero.
    if (space.ceilingHeightM == null) expect(ceilingRow!.value).toBe('—');
  });
});

// ── Unit suffixes must follow the SCALE, not the row ────────────────────────
// Field defect: a real EPSG:6339 export printed "1270.87 x 977.35 x 268.22 m
// (4169.5 x 3206.5 x 880.0 ft)" on the same page as
// "Units  source units (scale unverified ...)". Every length / area / volume
// row stamped m + ft with no reference to the scale at all, so an unverified
// unit was published as metres AND converted to feet on top of it.
const rowValues = (c: ReturnType<typeof buildSpaceReportContent>): string[] =>
  c.sections.flatMap((s) => s.rows.map((r) => r.value));

/** Any physical-unit suffix a scale-unverified report must never print. */
const UNIT_CLAIM = /\b(m|ft|cm)\b|m²|m³|ft²|ft³/;

describe('buildSpaceReportContent — unit suffixes follow the scale', () => {
  const pos = room();
  const shape = classifyScanShape(pos);
  const obj = cubeShell();

  const unknownInterior = buildSpaceReportContent({
    space: spaceMetrics(pos, {
      upAxis: shape.up, spaceKind: 'interior', hasRgb: true, unitKnown: false,
    }),
    name: 'Unverified scan',
  });
  const unknownObject = buildSpaceReportContent({
    space: spaceMetrics(obj, { upAxis: 'z', spaceKind: 'object', hasRgb: true, unitKnown: false }),
    object: objectMetrics(obj),
    name: 'Unverified object',
  });

  it('an UNKNOWN scale prints no metre, foot or centimetre suffix anywhere', () => {
    for (const content of [unknownInterior, unknownObject]) {
      for (const value of rowValues(content)) {
        expect(value, `unit claim in "${value}"`).not.toMatch(UNIT_CLAIM);
      }
    }
  });

  it('an UNKNOWN scale states the numbers are in source units', () => {
    for (const content of [unknownInterior, unknownObject]) {
      expect(rowValues(content).join(' | ')).toContain('source unit');
      expect(content.provenance.units).toContain('source units');
    }
  });

  it('an UNKNOWN scale never converts to feet', () => {
    for (const content of [unknownInterior, unknownObject]) {
      expect(rowValues(content).join(' | ')).not.toContain('ft');
    }
  });

  it('a KNOWN metre CRS prints metres and does NOT disclaim the scale', () => {
    const content = buildSpaceReportContent({
      space: spaceMetrics(pos, {
        upAxis: shape.up, spaceKind: 'interior', hasRgb: true,
        unitToMetres: 1, unitKnown: true,
      }),
      name: 'NAD83(2011) / UTM 10N',
    });
    expect(content.provenance.units).toBe('metres');
    expect(content.provenance.units).not.toContain('scale unverified');
    const values = rowValues(content).join(' | ');
    expect(values).toMatch(/\bm\b/);
    expect(values).toMatch(/ft\)/);
  });

  it('a KNOWN foot CRS keeps the existing metre + foot conversion', () => {
    const content = buildSpaceReportContent({
      space: spaceMetrics(obj, {
        upAxis: 'z', spaceKind: 'object', hasRgb: true,
        unitToMetres: 0.3048, unitKnown: true,
      }),
      object: objectMetrics(obj),
      name: 'Foot CRS',
    });
    expect(content.provenance.units).toBe('feet (source) → metres');
    const values = rowValues(content).join(' | ');
    expect(values).toMatch(/\bm\b/);
    expect(values).toMatch(/ft³/);
    expect(values).toMatch(/ft²/);
  });

  // The invariant that failed in the field, asserted directly.
  it('never disclaims the scale and stamps a unit suffix on the same report', () => {
    const cases = [
      { unitKnown: false, unitToMetres: 1 },
      { unitKnown: true, unitToMetres: 1 },
      { unitKnown: true, unitToMetres: 0.3048 },
      { unitKnown: undefined, unitToMetres: undefined },
    ] as const;
    for (const c of cases) {
      const content = buildSpaceReportContent({
        space: spaceMetrics(pos, {
          upAxis: shape.up, spaceKind: 'interior', hasRgb: true,
          unitToMetres: c.unitToMetres, unitKnown: c.unitKnown,
        }),
        name: 'Invariant',
      });
      const disclaims = content.provenance.units.includes('scale unverified');
      const claims = rowValues(content).some((v) => UNIT_CLAIM.test(v));
      expect(
        disclaims && claims,
        `units="${content.provenance.units}" but a row still stamps a unit`,
      ).toBe(false);
    }
  });
});

// ── The "source" population was the LOADED display sample, not the file ─────
// The field export read "59,029 / 1,888,921" while the file held 37,333,283
// points, so "source" named the resident display sample and the notes called
// it "the full scan".
describe('buildSpaceReportContent — point populations are named honestly', () => {
  const pos = room();
  const shape = classifyScanShape(pos);
  const content = buildSpaceReportContent({
    space: spaceMetrics(pos, {
      upAxis: shape.up, spaceKind: 'interior', hasRgb: true,
      unitToMetres: 1, unitKnown: true, sourcePointCount: 1_888_921,
    }),
    name: 'Populations',
  });
  const pointsRow = content.sections
    .flatMap((s) => s.rows)
    .find((r) => r.label.startsWith('Points'))!;

  it('names the measured subset and the loaded sample distinctly', () => {
    expect(pointsRow).toBeDefined();
    expect(`${pointsRow.label} ${pointsRow.value}`).toMatch(/measured/i);
    expect(`${pointsRow.label} ${pointsRow.value}`).toMatch(/loaded/i);
  });

  it('never calls the loaded sample "source"', () => {
    expect(`${pointsRow.label} ${pointsRow.value}`).not.toMatch(/source/i);
    const pointsLine = content.provenanceLines.find((l) => l.startsWith('Points'))!;
    expect(pointsLine).toBeDefined();
    expect(pointsLine).not.toMatch(/source/i);
    expect(pointsLine).toMatch(/loaded/i);
  });

  it('never calls the loaded sample "the full scan"', () => {
    const notes = content.caveats.join(' | ');
    expect(notes).not.toContain('full 1,888,921-point scan');
    expect(notes).not.toMatch(/full [\d,]+-point scan/);
  });
});

// ── The report may only claim what it actually measures ─────────────────────
// The footer stamped `evidenceNote('MEAS-AREA')`, and MEAS-AREA is E4, so the
// space report printed "cross-implementation validated against an independent
// implementation" over a PCA envelope volume, an oriented-box surface area, an
// angular-coverage ratio and a sampled density. MEAS-AREA is the shoelace area
// of a user polygon; it covers none of those figures.
describe('buildSpaceReportContent - evidence claim matches the product', () => {
  const obj = cubeShell();
  const content = buildSpaceReportContent({
    space: spaceMetrics(obj, {
      upAxis: 'z', spaceKind: 'object', hasRgb: true, unitToMetres: 1, unitKnown: true,
    }),
    object: objectMetrics(obj),
    name: 'Claim',
  });
  const evidenceLine = (): string =>
    content.provenanceLines.find((l) => l.startsWith('Evidence'))!;

  it('still stamps an Evidence line', () => {
    expect(evidenceLine()).toBeDefined();
  });

  it('never asserts cross-implementation or independent-implementation validation', () => {
    const line = evidenceLine();
    // The MEAS-AREA strong branch, in both of its affirmative shapes.
    expect(line).not.toMatch(/cross-implementation validated/i);
    expect(line).not.toMatch(/validated against an independent implementation/i);
    expect(line).not.toMatch(/\bfield-validated\b/i);
    // What it says instead: the absence of both, stated outright.
    expect(line).toMatch(/no cross-implementation/i);
  });

  it('is not the MEAS-AREA polygon note', () => {
    expect(evidenceLine()).not.toContain(evidenceNote('MEAS-AREA'));
  });

  it('says plainly that the figures are unvalidated envelope estimates', () => {
    const line = evidenceLine();
    expect(line).toMatch(/unvalidated/i);
    expect(line).toMatch(/envelope/i);
  });
});

// ── "Scan completeness" measured angular coverage, not capture completeness ──
// 24x12 direction bins about the centroid: a sheet occupies only the
// near-equatorial band, so the ratio is a shape signature, not missing data.
describe('buildSpaceReportContent - the coverage row is named for what it measures', () => {
  const obj = cubeShell();
  const rows = buildSpaceReportContent({
    space: spaceMetrics(obj, {
      upAxis: 'z', spaceKind: 'object', hasRgb: true, unitToMetres: 1, unitKnown: true,
    }),
    object: objectMetrics(obj),
    name: 'Coverage',
  }).sections.flatMap((s) => s.rows);

  it('no row calls the ratio a completeness', () => {
    for (const r of rows) {
      expect(`${r.label} ${r.value} ${r.hint ?? ''}`).not.toMatch(/completeness/i);
    }
  });

  it('names it angular coverage about the centroid', () => {
    const row = rows.find((r) => r.label === ANGULAR_COVERAGE_LABEL);
    expect(row, 'angular-coverage row missing').toBeDefined();
    expect(row!.value).toMatch(/%/);
    expect(row!.hint).toBe(ANGULAR_COVERAGE_HINT);
  });
});

// ── Per-row qualifiers must survive into the PDF content model ──────────────
// The panel disclosed "Bounding envelope, not a solid volume" and "the
// envelope's skin, not the object's true (mesh) surface"; ReportRow had no
// hint field, so neither reached the export.
describe('buildSpaceReportContent - envelope rows carry their qualifier', () => {
  const obj = cubeShell();
  const rows = buildSpaceReportContent({
    space: spaceMetrics(obj, {
      upAxis: 'z', spaceKind: 'object', hasRgb: true, unitToMetres: 1, unitKnown: true,
    }),
    object: objectMetrics(obj),
    name: 'Qualifiers',
  }).sections.flatMap((s) => s.rows);

  it('envelope volume states it is not a solid volume', () => {
    const row = rows.find((r) => r.label === 'Envelope volume')!;
    expect(row.hint).toBe(OBJECT_ENVELOPE_VOLUME_HINT);
    expect(row.hint).toMatch(/not a solid volume/);
  });

  it('bounding surface area states it is the envelope skin, not a mesh surface', () => {
    const row = rows.find((r) => r.label === 'Bounding surface area')!;
    expect(row.hint).toBe(OBJECT_SURFACE_AREA_HINT);
    expect(row.hint).toMatch(/skin/);
  });
});

// ── Printed precision follows the magnitude ─────────────────────────────────
// Two decimals unconditionally put ten significant figures on a 333 million m3
// envelope derived from a 59k-point sample.
describe('buildSpaceReportContent - fine precision follows the magnitude', () => {
  const shell = cubeShell();
  const metricSpace = spaceMetrics(shell, {
    upAxis: 'z', spaceKind: 'object', hasRgb: true, unitToMetres: 1, unitKnown: true,
  });
  const box = (L: number, W: number, H: number, pointCount: number): ObjectMetrics => ({
    pointCount,
    obb: { lengthM: L, widthM: W, heightM: H },
    aabb: { lengthM: L, widthM: W, heightM: H },
    longestDimensionM: L,
    envelopeVolumeM3: L * W * H,
    surfaceAreaM2: 2 * (L * W + L * H + W * H),
    medianSpacingM: 0.42,
    completenessPct: 56,
  });
  const valueOf = (object: ObjectMetrics, label: string): string =>
    buildSpaceReportContent({ space: metricSpace, object, name: 'Precision' })
      .sections.flatMap((s) => s.rows)
      .find((r) => r.label === label)!.value;

  // The field case: a 1270 x 977 x 268 m terrain envelope over a 59k sample.
  const huge = box(1270.87, 977.35, 268.22, 59_029);
  // A compact object scan, where two decimals are the whole figure.
  const small = box(1, 0.7, 0.6, 41_000);

  it('a hundred-million-cubic-metre envelope prints no decimals', () => {
    const v = valueOf(huge, 'Envelope volume');
    expect(v).toContain('333,151,984');
    expect(v).not.toMatch(/\d\.\d\d\s*m³/);
  });

  it('a large bounding surface area prints no decimals either', () => {
    const v = valueOf(huge, 'Bounding surface area');
    expect(v).toContain('3,690,205');
    expect(v).not.toMatch(/\d\.\d\d\s*m²/);
  });

  it('a sub-cubic-metre object still keeps two decimals', () => {
    expect(valueOf(small, 'Envelope volume')).toMatch(/^0\.42 m³/);
  });

  it('the VALUE is unchanged, only the printed digits', () => {
    // 0.42 m3 rounds to 0 at zero decimals; the small branch must not.
    expect(valueOf(small, 'Envelope volume')).not.toMatch(/^0 m³/);
  });
});

// ── The provenance footer must not fabricate zeros ──────────────────────────
// `space?.quality.sampledPointCount ?? 0` rendered "Points  0 measured /
// 0 loaded" for the no-measurements branch, against the file's own rule that an
// absent value reads as a dash.
describe('buildSpaceReportContent - absent counts are dashes, never zeros', () => {
  const content = buildSpaceReportContent({ space: null, name: 'Empty' });

  it('carries null counts rather than fabricated zeros', () => {
    expect(content.provenance.measuredPointCount).toBeNull();
    expect(content.provenance.loadedPointCount).toBeNull();
  });

  it('renders the Points line with dashes', () => {
    const line = content.provenanceLines.find((l) => l.startsWith('Points'))!;
    expect(line).toContain('—');
    expect(line).not.toMatch(/\b0\b/);
  });
});
