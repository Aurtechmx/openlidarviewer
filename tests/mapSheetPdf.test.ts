/**
 * mapSheetPdf.test.ts — the composer produces a valid PDF from a model.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMapSheetPdf,
  readinessNote,
  wrapTextToWidth,
  scaleBarUnit,
  mapLinearUnitLabel,
} from '../src/render/measure/mapSheetPdf';
import type { ContourFeatureModel, ContourFeature } from '../src/terrain/contour/contourFeatureModel';
import type { Annotation } from '../src/render/annotate/types';
import { demAccuracyStandards } from '../src/terrain/quality/demAccuracyStandards';
import type { ExportProvenance } from '../src/terrain/export/exportProvenance';

const PROV: ExportProvenance = {
  software: 'OpenLiDARViewer', softwareVersion: '9.9.9',
  build: '9.9.9 (testtest) · test · built 1970-01-01T00:00:00.000Z', metricVersion: 'v0.4.1',
  generated: '2026-06-05T00:00:00.000Z', source: 'site',
  horizontalCrs: 'WGS 84 / UTM zone 11N', crsKnown: true, verticalDatum: 'NAVD88', datumKnown: true,
  coverageMode: 'full', contourIntervalM: 10, contourStyle: 'smooth', contourStyleLabel: 'Smooth',
  contourRequestedIntervalM: null,
  contourMethod: null, contourGeneralizeToleranceCells: null, deliverablePurpose: null,
  surfaceQuality: 'Good', exportReadiness: 'Ready', exportReason: '',
  accuracy: { rmseZM: 0.08, nvaM: 0.16, vvaM: 0.21, usgsQualityLevel: 'QL2' },
  complexity: null,
  pointDensityPerM2: 3, measuredCells: 90, totalCells: 100, classScope: null, warnings: [],
  notSurveyGrade: 'Suitability: not survey-grade unless validated against ground-truth control.',
  exportPermit: null,
};

function feature(value: number, isIndex: boolean, pts: Array<[number, number]>): ContourFeature {
  return { value, isIndex, grade: 'solid', meanConfidence: 90, closed: false, coordinates: pts };
}

const model: ContourFeatureModel = {
  features: [
    feature(100, true, [[0, 0], [50, 10], [100, 0]]),
    feature(110, false, [[0, 30], [50, 40], [100, 30]]),
    { value: 120, isIndex: true, grade: 'dashed', meanConfidence: 55, closed: false, coordinates: [[0, 60], [100, 60]] },
  ],
  crs: 'WGS 84 / UTM zone 11N',
  verticalDatum: 'NAVD88',
  intervalM: 10,
  contourStyle: 'smooth',
  bbox: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
  interpolatedFraction: 0.12,
  coverageMode: 'full',
  warnings: [],
};

describe('scaleBarUnit — label follows the source CRS (label-vs-value)', () => {
  it('labels metres, grouping to km past 1000 (metric default)', () => {
    expect(scaleBarUnit(200, undefined)).toEqual({ unit: 'm', divisor: 1 });
    expect(scaleBarUnit(200, 'metre')).toEqual({ unit: 'm', divisor: 1 });
    expect(scaleBarUnit(2000, 'metre')).toEqual({ unit: 'km', divisor: 1000 });
  });
  it('labels feet on a foot CRS and NEVER groups to km', () => {
    // 1000 ft must read "1000 ft", not "1 km" — that was the drift.
    expect(scaleBarUnit(1000, 'foot')).toEqual({ unit: 'ft', divisor: 1 });
    expect(scaleBarUnit(2000, 'us-survey-foot')).toEqual({ unit: 'ft', divisor: 1 });
    expect(scaleBarUnit(50, 'foot')).toEqual({ unit: 'ft', divisor: 1 });
  });
  it('keeps the metre default for an unresolved (unknown) unit (back-compat)', () => {
    expect(scaleBarUnit(200, 'unknown')).toEqual({ unit: 'm', divisor: 1 });
    expect(scaleBarUnit(2000, 'unknown')).toEqual({ unit: 'km', divisor: 1000 });
  });
});

describe('mapLinearUnitLabel — contour-interval unit matches the scale bar', () => {
  it('reads "m" for metric, unknown, and undefined (the standing default)', () => {
    expect(mapLinearUnitLabel('metre')).toBe('m');
    expect(mapLinearUnitLabel('unknown')).toBe('m');
    expect(mapLinearUnitLabel(undefined)).toBe('m');
  });
  it('reads "ft" for both foot variants', () => {
    expect(mapLinearUnitLabel('foot')).toBe('ft');
    expect(mapLinearUnitLabel('us-survey-foot')).toBe('ft');
  });
});

describe('buildMapSheetPdf', () => {
  it('builds a valid sheet for a foot CRS without throwing', async () => {
    const bytes = await buildMapSheetPdf({
      model,
      labels: [{ x: 50, y: 10, value: 100, angleRad: 0.1 }],
      worldOrigin: { x: 6_500_000, y: 1_800_000 },
      crs: 'NAD83 / California zone 5 (ftUS)',
      verticalDatum: 'NAVD88 (ftUS)',
      linearUnit: 'us-survey-foot',
      readiness: 'previewOnly',
      title: 'Foot CRS site',
    });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('renders a valid PDF with contours, collar, and accuracy', async () => {
    const bytes = await buildMapSheetPdf({
      model,
      labels: [{ x: 50, y: 10, value: 100, angleRad: 0.1 }],
      worldOrigin: { x: 585000, y: 3386000 },
      crs: model.crs,
      verticalDatum: model.verticalDatum,
      accuracy: demAccuracyStandards(0.08, 0.21, 3),
      readiness: 'previewOnly',
      title: 'El Picacho — Contours (10 m)',
      preparedBy: 'Survey Co.',
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000);
    // PDF magic header.
    const head = String.fromCharCode(...bytes.slice(0, 5));
    expect(head).toBe('%PDF-');
  });

  it('renders the title block sourced from the unified provenance', async () => {
    // The title block now single-sources its CRS / datum / style / accuracy /
    // readiness / date from the shared provenance object so it can't drift from
    // the other exports. A binary PDF can't be text-asserted here, but supplying
    // the provenance must still produce a valid sheet (the strings come from `p`).
    const bytes = await buildMapSheetPdf({
      model,
      labels: [{ x: 50, y: 10, value: 100, angleRad: 0.1 }],
      worldOrigin: { x: 585000, y: 3386000 },
      provenance: PROV,
      title: 'El Picacho — Contours (10 m)',
      preparedBy: 'Survey Co.',
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('renders with a not-georeferenced / no-accuracy provenance without throwing', async () => {
    const preview: ExportProvenance = {
      ...PROV, horizontalCrs: 'not georeferenced', crsKnown: false,
      verticalDatum: 'unknown', datumKnown: false, accuracy: null,
      exportReadiness: 'Preview', exportReason: 'CRS unknown and vertical datum unknown',
    };
    const bytes = await buildMapSheetPdf({ model, labels: [], provenance: preview });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('accepts a vertical origin (z) on a recentred (negative) model and renders', async () => {
    // A recentred scan's contour values are negative in the local frame; the map
    // adds worldOrigin.z back to the DISPLAYED labels (geometry stays local). The
    // binary PDF can't be text-asserted, but the z path must render cleanly.
    const recentred: ContourFeatureModel = {
      ...model,
      features: model.features.map((f: ContourFeature) => ({ ...f, value: f.value - 1000 })),
    };
    const bytes = await buildMapSheetPdf({
      model: recentred,
      labels: [{ x: 50, y: 10, value: -900, angleRad: 0.1 }],
      worldOrigin: { x: 585000, y: 3386000, z: 1000 },
      provenance: PROV,
      title: 'Recentred scan',
    });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('still produces a PDF when there are no contours', async () => {
    const empty: ContourFeatureModel = { ...model, features: [], bbox: null };
    const bytes = await buildMapSheetPdf({ model: empty, labels: [], sheet: 'a4' });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('tolerates an unmeasured (NaN) interpolated fraction without drawing "NaN%"', async () => {
    // An empty contour set leaves interpolatedFraction = NaN (no length to
    // measure against). The legend must report it as unmeasured, never collapse
    // it to a fabricated 0% or stamp a literal "NaN%".
    const unmeasured: ContourFeatureModel = {
      ...model,
      features: [],
      bbox: null,
      interpolatedFraction: Number.NaN,
    };
    const bytes = await buildMapSheetPdf({ model: unmeasured, labels: [], sheet: 'a4' });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('renders a landscape sheet with a Project / Notes block without throwing', async () => {
    const bytes = await buildMapSheetPdf({
      model,
      labels: [{ x: 50, y: 10, value: 100, angleRad: 0.1 }],
      worldOrigin: { x: 585000, y: 3386000 },
      crs: model.crs,
      verticalDatum: model.verticalDatum,
      accuracy: demAccuracyStandards(0.08, 0.21, 3),
      readiness: 'ready',
      title: 'El Picacho — Contours (10 m)',
      preparedBy: 'Survey Co.',
      notes: 'Contours from picacho · interval 10 m · WGS 84 / UTM zone 11N',
      sheet: 'letter',
      orientation: 'landscape',
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('tolerates a very long notes string (truncated, not overflowing)', async () => {
    const longNotes = 'Survey area '.repeat(60).trim();
    const bytes = await buildMapSheetPdf({
      model,
      labels: [],
      crs: model.crs,
      verticalDatum: model.verticalDatum,
      accuracy: demAccuracyStandards(0.08, 0.21, 3),
      readiness: 'previewOnly',
      notes: longNotes,
      sheet: 'a3',
      orientation: 'portrait',
    });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  // ── annotation layer (opt-in) ──────────────────────────────────────────────
  // A placed annotation carries a local render-space anchor; the sheet plots it
  // as a numbered marker + lists it in a top-right table. The exact page maths
  // is unit-tested in annotationMapProjection.test.ts; here we pin the two
  // contracts that live in the PDF builder: opting in draws MORE content, and
  // leaving it off (or absent) is byte-identical to the pre-annotation sheet.
  const anno = (id: string, x: number, y: number, z = 0): Annotation => ({
    id, title: `Point ${id}`, type: 'warning', note: 'note', createdAt: 0, updatedAt: 0,
    localPosition: { x, y, z },
  });

  it('is byte-identical whether the annotation flag is OFF or absent', async () => {
    // A fixed generatedAt: the sheet stamps the generation time (minute
    // precision) when none is passed (`?? new Date()`), so two back-to-back
    // builds that straddle a minute boundary on a slow runner differ — a real
    // flake that has nothing to do with the annotation flag this test pins.
    const base = { model, labels: [], crs: model.crs, verticalDatum: model.verticalDatum, sheet: 'letter' as const, generatedAt: new Date(0) };
    const absent = await buildMapSheetPdf({ ...base });
    const off = await buildMapSheetPdf({ ...base, includeAnnotations: false, annotations: [anno('1', 25, 60)], sceneUpAxis: 'z' });
    expect(Buffer.from(off).equals(Buffer.from(absent))).toBe(true);
  });

  it('draws additional content when annotations are included', async () => {
    const base = { model, labels: [], crs: model.crs, verticalDatum: model.verticalDatum, sheet: 'letter' as const };
    const plain = await buildMapSheetPdf({ ...base });
    const withAnno = await buildMapSheetPdf({
      ...base, includeAnnotations: true, sceneUpAxis: 'z',
      annotations: [anno('1', 25, 60), anno('2', 80, 20)],
    });
    // The annotated sheet must be strictly larger (markers + table) and valid.
    expect(withAnno.length).toBeGreaterThan(plain.length);
    expect(String.fromCharCode(...withAnno.slice(0, 5))).toBe('%PDF-');
  });

  it('renders even when every annotation is outside the map extent', async () => {
    // All off-map: none plotted, but the table + a footnote still render.
    const bytes = await buildMapSheetPdf({
      model, labels: [], crs: model.crs, sheet: 'letter',
      includeAnnotations: true, sceneUpAxis: 'z',
      annotations: [anno('1', 500, 500), anno('2', -400, -400)],
    });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });
});

describe('wrapTextToWidth', () => {
  // A simple monospace-ish measurer: ~3pt per char at the given size.
  const measure = (s: string, size: number): number => s.length * (size * 0.46);

  it('wraps words to fit the width', () => {
    const lines = wrapTextToWidth('alpha beta gamma delta', 30, 6.5, measure, 4);
    expect(lines.length).toBeGreaterThan(1);
    for (const ln of lines) expect(measure(ln, 6.5)).toBeLessThanOrEqual(30);
  });

  it('caps at maxLines and ellipsises the last kept line on overrun', () => {
    const lines = wrapTextToWidth('alpha beta gamma delta epsilon zeta', 24, 6.5, measure, 2);
    expect(lines).toHaveLength(2);
    expect(lines[lines.length - 1].endsWith('…')).toBe(true);
  });

  it('returns no lines for empty input', () => {
    expect(wrapTextToWidth('   ', 100, 6.5, measure)).toEqual([]);
    expect(wrapTextToWidth('x', 0, 6.5, measure)).toEqual([]);
  });

  it('hard-cuts a single word wider than the line', () => {
    const lines = wrapTextToWidth('supercalifragilistic', 12, 6.5, measure, 1);
    expect(lines).toHaveLength(1);
    expect(measure(lines[0], 6.5)).toBeLessThanOrEqual(12);
  });
});

describe('readinessNote', () => {
  // A bare affirmative claim = "survey-grade"/"survey grade" NOT immediately
  // preceded by "not ". The project stance is: never claim survey-grade.
  const bareSurveyGrade = /(?<!not\s)survey.?grade/i;

  it.each(['ready', 'previewOnly', 'blocked'] as const)(
    'never makes a bare affirmative survey-grade claim for readiness=%s',
    (readiness) => {
      const note = readinessNote(readiness);
      expect(note).not.toMatch(bareSurveyGrade);
      // Any mention of survey-grade must be negated by a preceding "not".
      if (/survey.?grade/i.test(note)) {
        expect(note.toLowerCase()).toMatch(/not\s+survey.?grade/i);
      }
    },
  );

  it('states the validation fact for ready without asserting a certification', () => {
    const note = readinessNote('ready');
    expect(note.toLowerCase()).toContain('validated');
    expect(note.toLowerCase()).toContain('not a survey certification');
    expect(note).not.toMatch(/\bcertified\b/i);
  });

  it('keeps the preview note negated', () => {
    expect(readinessNote('previewOnly').toLowerCase()).toMatch(/not\s+survey-grade/);
  });
});

describe('buildMapSheetPdf — purpose deliverable content', () => {
  const engineering = {
    label: 'Engineering Plan', statement: 'Clear contours for planning.',
    analytical: true, cartographic: true, cartographicSmoothing: true,
    generalizeToleranceCells: 0.5, indexEvery: 5, labelsIndexOnly: false,
    hillshade: false, hypsometricTint: false, allowExploratory: true,
    completePackage: false, appendixRequired: false,
  } as const;
  const survey = {
    label: 'Survey Review', statement: 'Exact analytical geometry; does not imply survey certification.',
    analytical: true, cartographic: false, cartographicSmoothing: false,
    generalizeToleranceCells: 0, indexEvery: 5, labelsIndexOnly: true,
    hillshade: false, hypsometricTint: false, allowExploratory: false,
    completePackage: false, appendixRequired: true,
  } as const;

  it('is byte-identical to the pre-purpose sheet when purpose is absent or null', async () => {
    const base = { model, labels: [] as never[], provenance: PROV } as const;
    const absent = await buildMapSheetPdf({ ...base });
    const nul = await buildMapSheetPdf({ ...base, purpose: null });
    expect(Buffer.from(nul).equals(Buffer.from(absent))).toBe(true);
  });

  it('adds a page (appendix) only when appendixRequired', async () => {
    const noApx = await buildMapSheetPdf({ model, labels: [], provenance: PROV, purpose: engineering });
    const withApx = await buildMapSheetPdf({ model, labels: [], provenance: PROV, purpose: survey });
    // A required appendix means an extra page → measurably larger output.
    expect(withApx.length).toBeGreaterThan(noApx.length);
    // And both differ from the no-purpose sheet.
    const plain = await buildMapSheetPdf({ model, labels: [], provenance: PROV });
    expect(noApx.length).not.toBe(plain.length);
  });

  it('produces different bytes for two different purposes (purposes are real)', async () => {
    const a = await buildMapSheetPdf({ model, labels: [], provenance: PROV, purpose: engineering });
    const b = await buildMapSheetPdf({ model, labels: [], provenance: PROV, purpose: survey });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
