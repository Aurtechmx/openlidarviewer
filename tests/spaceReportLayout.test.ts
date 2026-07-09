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
import { objectMetrics } from '../src/terrain/objectMetrics';
import { classifyScanShape } from '../src/terrain/scanShape';
import { NOT_SURVEY_GRADE_NOTE } from '../src/terrain/export/exportProvenance';

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
  const space = spaceMetrics(pos, { upAxis: shape.up, spaceKind: 'interior', hasRgb: true });
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
  const space = spaceMetrics(pos, { upAxis: 'z', spaceKind: 'object', hasRgb: true });
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
      'Envelope volume', 'Bounding surface area', 'Scan completeness', 'Capture quality',
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
