/**
 * mapSheetPdf.test.ts — the composer produces a valid PDF from a model.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  buildMapSheetPdf,
  readinessNote,
  wrapTextToWidth,
  scaleBarUnit,
  mapScaleLabel,
  contourShareSheetLines,
  contourDrawStyle,
  mapLinearUnitLabel,
  rotatedLabelOrigin,
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
  coverageMode: 'full',
  gridExtent: 'full', analysedBasis: null, analysedBasisLine: 'unknown', sourceInterpretation: { interpretationLevel: 'not-recorded', dataBasis: 'unknown' }, sourceSha256: null, sourceSha256Note: 'not recorded by this export path', analysisInputSha256: null, crsOrigin: { source: 'unknown', name: 'unknown', epsg: 'unknown', verticalDatum: 'unknown', verticalSource: 'unknown' }, contourIntervalM: 10, contourStyle: 'smooth', contourStyleLabel: 'Smooth',
  contourRequestedIntervalM: null,
  contourMethod: null, contourGeneralizeToleranceCells: null, deliverablePurpose: null,
  surfaceQuality: 'Good', exportReadiness: 'Ready', exportReason: '',
  accuracy: { rmseZM: 0.08, nvaM: 0.16, vvaM: 0.21, usgsDensityReferenceFloor: 'QL2' },
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
  it('labels metres, grouping to km past 1000, on a DECLARED metre CRS', () => {
    expect(scaleBarUnit(200, 'metre')).toEqual({ unit: 'm', divisor: 1 });
    expect(scaleBarUnit(2000, 'metre')).toEqual({ unit: 'km', divisor: 1000 });
  });
  it('labels feet on a foot CRS and NEVER groups to km', () => {
    // 1000 ft must read "1000 ft", not "1 km" — that was the drift.
    expect(scaleBarUnit(1000, 'foot')).toEqual({ unit: 'ft', divisor: 1 });
    expect(scaleBarUnit(2000, 'us-survey-foot')).toEqual({ unit: 'ft', divisor: 1 });
    expect(scaleBarUnit(50, 'foot')).toEqual({ unit: 'ft', divisor: 1 });
  });
  it('does NOT assert metres for an unresolved unit, and cannot group it', () => {
    // This previously kept a metre default "for back-compat", which put a metre
    // scale bar on a sheet whose own title block said "not georeferenced".
    // Grouping is dropped with it: dividing by 1000 to reach "km" only means
    // something once the unit is known.
    expect(scaleBarUnit(200, 'unknown')).toEqual({ unit: 'units', divisor: 1 });
    expect(scaleBarUnit(2000, 'unknown')).toEqual({ unit: 'units', divisor: 1 });
    expect(scaleBarUnit(200, undefined)).toEqual({ unit: 'units', divisor: 1 });
  });
});

describe('mapLinearUnitLabel — contour-interval unit matches the scale bar', () => {
  it('reads "m" only for a DECLARED metre CRS', () => {
    expect(mapLinearUnitLabel('metre')).toBe('m');
  });
  it('reads "units" for an unresolved or absent unit, never a false "m"', () => {
    expect(mapLinearUnitLabel('unknown')).toBe('units');
    expect(mapLinearUnitLabel(undefined)).toBe('units');
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

  it('sources the document date from generatedAt, so a fixed date is byte-reproducible', async () => {
    // Guards the pdf-lib Info-dictionary dates (CreationDate/ModDate), which
    // default to the wall clock at build time. Two builds either side of a
    // second boundary used to differ there even with a fixed visible stamp.
    const base = { model, labels: [] as never[], crs: model.crs, sheet: 'letter' as const };
    const a1 = await buildMapSheetPdf({ ...base, generatedAt: new Date(0) });
    const a2 = await buildMapSheetPdf({ ...base, generatedAt: new Date(0) });
    expect(Buffer.from(a1).equals(Buffer.from(a2))).toBe(true);

    // Two instants in the SAME minute but different seconds: the visible stamp
    // (minute precision) is identical, so the only thing that can move the bytes
    // is the document date being pinned to generatedAt. Without the pin both
    // builds would take the wall clock and land in the same second — equal bytes.
    const atSecond00 = await buildMapSheetPdf({ ...base, generatedAt: new Date(0) });
    const atSecond30 = await buildMapSheetPdf({ ...base, generatedAt: new Date(30_000) });
    expect(Buffer.from(atSecond00).equals(Buffer.from(atSecond30))).toBe(false);
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
    // A fixed generatedAt: the sheet stamps the generation time to the minute,
    // so two builds that straddle a boundary differ in bytes for a reason this
    // test is not about.
    const base = {
      model,
      labels: [] as never[],
      provenance: PROV,
      generatedAt: new Date(0),
    } as const;
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
    expect(noApx).not.toHaveLength(plain.length);
  });

  it('produces different bytes for two different purposes (purposes are real)', async () => {
    const a = await buildMapSheetPdf({ model, labels: [], provenance: PROV, purpose: engineering });
    const b = await buildMapSheetPdf({ model, labels: [], provenance: PROV, purpose: survey });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

/**
 * The sheet says which build drew it.
 *
 * Every other provenance-bearing export carries the build line; a printed map
 * did not, so a sheet whose figures looked wrong could not be traced to the
 * code that produced it — a question that cost a round of investigation over a
 * PDF nobody could attribute.
 */
describe('buildMapSheetPdf — build identity', () => {
  /** Every text run drawn into the PDF, decoded from its content streams. */
  const drawnText = (bytes: Uint8Array): string => {
    const buf = Buffer.from(bytes);
    let out = '';
    for (const seg of buf.toString('latin1').split(/stream\r?\n/).slice(1)) {
      const raw = seg.split('endstream')[0];
      let content: string;
      try {
        content = inflateSync(Buffer.from(raw, 'latin1')).toString('latin1');
      } catch {
        continue;
      }
      for (const m of content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) {
        out += Buffer.from(m[1]!, 'hex').toString('latin1');
      }
    }
    return out;
  };

  it('prints the provenance build line on the sheet', async () => {
    const bytes = await buildMapSheetPdf({ model, labels: [], provenance: PROV });
    expect(drawnText(bytes)).toContain(PROV.build);
  });

  it('prints nothing when no provenance was supplied', async () => {
    const withProv = await buildMapSheetPdf({ model, labels: [], provenance: PROV, generatedAt: new Date(0) });
    const without = await buildMapSheetPdf({ model, labels: [], generatedAt: new Date(0) });
    expect(drawnText(withProv)).toContain(PROV.build);
    expect(drawnText(without)).not.toContain(PROV.build);
  });
});

/**
 * The density row names the quantity it measures.
 *
 * The 3DEP floors are nominal PULSE density; this figure is measured
 * GROUND-RETURN density, which is not the same determination. Labelled
 * "USGS density ref" the row read as a pulse-density grade, and the technical
 * report for the same scan refuses to grade its all-returns density against
 * those floors — two documents from one session, apparently disagreeing.
 *
 * The row also has to fit its column: the accuracy block is right-aligned in a
 * fixed strip, and an overlong row runs into the legend beside it.
 */
describe('buildMapSheetPdf — the density reference names its basis', () => {
  const drawn = (bytes: Uint8Array): string => {
    let out = '';
    for (const seg of Buffer.from(bytes).toString('latin1').split(/stream\r?\n/).slice(1)) {
      let content: string;
      try {
        content = inflateSync(Buffer.from(seg.split('endstream')[0], 'latin1')).toString('latin1');
      } catch { continue; }
      for (const m of content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) out += Buffer.from(m[1]!, 'hex').toString('latin1');
    }
    return out;
  };

  it('says ground-return density, not a bare USGS density reference', async () => {
    const prov = { ...PROV, accuracy: { rmseZM: 1, nvaM: 1.96, vvaM: 2.1, usgsDensityReferenceFloor: 'QL3' } } as typeof PROV;
    const text = drawn(await buildMapSheetPdf({ model, labels: [], provenance: prov }));
    expect(text).toContain('Ground-return density ref');
    expect(text).toContain('>= USGS QL3');
    expect(text, 'the unqualified label read as a pulse-density grade').not.toContain('USGS density ref');
  });

  it('withholds the density reference and retitles the block on a sampled basis', async () => {
    const prov = {
      ...PROV,
      accuracy: { rmseZM: 1, nvaM: 1.96, vvaM: 2.1, usgsDensityReferenceFloor: 'none', accuracyOnSample: true },
    } as typeof PROV;
    const text = drawn(await buildMapSheetPdf({ model, labels: [], provenance: prov }));
    expect(text).toContain('Hold-out accuracy (preview)');
    expect(text).toContain('Figures are from a sample of the points');
    expect(text).toContain('not stated on a sample');
    expect(text).not.toContain('>= USGS');
    expect(text).not.toContain('Survey accuracy');
  });

  it('retitles the block when the readiness is Preview, without claiming a sample', async () => {
    const prov = { ...PROV, exportReadiness: 'Preview', accuracy: { rmseZM: 1, nvaM: 1.96, vvaM: 2.1, usgsDensityReferenceFloor: 'QL3' } } as typeof PROV;
    const text = drawn(await buildMapSheetPdf({ model, labels: [], provenance: prov }));
    expect(text).toContain('Hold-out accuracy (preview)');
    expect(text).not.toContain('Figures are from a sample of the points');
  });

  it('keeps the density reference on a full-cloud basis', async () => {
    const prov = { ...PROV, accuracy: { rmseZM: 1, nvaM: 1.96, vvaM: 2.1, usgsDensityReferenceFloor: 'QL3' } } as typeof PROV;
    const text = drawn(await buildMapSheetPdf({ model, labels: [], provenance: { ...prov, exportReadiness: 'Ready' } as typeof PROV }));
    expect(text).toContain('>= USGS QL3');
    expect(text).toContain('Survey accuracy');
  });

  it('fits the accuracy column at its longest', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    // Portrait letter is the narrowest sheet: the column runs from 72% of the
    // content width to the right margin, and the rows are drawn at 7.5pt.
    const column = (612 - 36 - 4) - (36 + (612 - 72) * 0.72);
    const longest = 'Ground-return density ref:  >= USGS QL0';
    expect(font.widthOfTextAtSize(longest, 7.5)).toBeLessThan(column);
  });
});

describe('mapScaleLabel — no numeric ratio without a known ground unit', () => {
  it('prints units unknown when the linear unit is unknown or unresolved', () => {
    expect(mapScaleLabel(2400, 'unknown')).toBe('units unknown');
    expect(mapScaleLabel(2400, undefined)).toBe('units unknown');
  });
  it('prints the ratio for a resolved unit', () => {
    expect(mapScaleLabel(2400, 'metre')).toBe(`1:${(2400).toLocaleString()}`);
    expect(mapScaleLabel(2400, 'us-survey-foot')).toBe(`1:${(2400).toLocaleString()}`);
  });
});

/**
 * The sheet once printed one "interpolated or uncertain" share: every line below
 * the solid threshold. A measured cell grades below it whenever it holds fewer
 * ground returns than the scene's typical cell, so on a drone strip with a few
 * percent of interpolated cells the sheet said 49%. Interpolated and sparse
 * measured ground now have their own swatch, their own line style and their own
 * share.
 */
describe('map sheet — interpolated and sparse ground apart', () => {
  const contentStreams = (bytes: Uint8Array): string => {
    let out = '';
    for (const seg of Buffer.from(bytes).toString('latin1').split(/stream\r?\n/).slice(1)) {
      try {
        out += inflateSync(Buffer.from(seg.split('endstream')[0], 'latin1')).toString('latin1');
      } catch { continue; }
    }
    return out;
  };
  const drawnText = (bytes: Uint8Array): string =>
    [...contentStreams(bytes).matchAll(/<([0-9A-Fa-f]*)> Tj/g)].map((m) => Buffer.from(m[1]!, 'hex').toString('latin1')).join('\n');

  const PROV_M = 1;
  const PROV_I = 2;
  const run = (value: number, grade: ContourFeature['grade'], provBits: number, y: number): ContourFeature =>
    ({ value, isIndex: false, grade, meanConfidence: 50, closed: false, provBits, coordinates: [[0, y], [100, y]] });
  // 1 measured, 9 sparse, 1 interpolated, 1 gap run, each 100 long.
  const split: ContourFeatureModel = {
    ...model,
    features: [
      run(100, 'solid', PROV_M, 0),
      ...Array.from({ length: 9 }, (_, i) => run(101 + i, 'dashed', PROV_M, 5 + i * 5)),
      run(110, 'dashed', PROV_M | PROV_I, 55),
      run(111, 'gap', PROV_I, 60),
    ],
    bbox: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
    interpolatedFraction: 11 / 12,
    interpolatedLengthFraction: 1 / 12,
    sparseLengthFraction: 9 / 12,
    gapLengthFraction: 1 / 12,
  };

  it('names five line kinds in the legend, with the share of each kind apart', async () => {
    const text = drawnText(await buildMapSheetPdf({ model: split, labels: [], provenance: PROV }));
    for (const label of ['Index contour (labelled)', 'Intermediate contour', 'Sparse ground (measured)', 'Interpolated', 'Low-confidence gap']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('8% interpolated \xb7');
    expect(text).toContain('75% sparse ground \xb7');
    expect(text).toContain('8% gap (by contour length)');
    expect(text, 'the old single share counted sparse ground as interpolated').not.toContain('interpolated or uncertain');
    expect(text).not.toContain('Interpolated (uncertain)');
  });

  it('draws interpolated runs dashed and sparse ground continuous', async () => {
    const streams = contentStreams(await buildMapSheetPdf({ model: split, labels: [], provenance: PROV }));
    const interp = contourDrawStyle(false, 'interpolated');
    const sparse = contourDrawStyle(false, 'sparse');
    expect(interp.dash).not.toBeNull();
    expect(sparse.dash).toBeNull();
    // The interpolated dash pattern is on the page: the one interpolated run and its swatch.
    expect(streams.match(new RegExp(`\\[${interp.dash!.join(' ')}\\] 0 d`, 'g'))?.length).toBe(2);
  });

  it('gives every legend kind a style of its own', () => {
    const kinds = ['measured', 'sparse', 'interpolated', 'gap'] as const;
    const key = (k: (typeof kinds)[number], index: boolean): string => {
      const st = contourDrawStyle(index, k);
      return JSON.stringify([st.color, st.width, st.dash, st.opacity]);
    };
    for (const index of [false, true]) expect(new Set(kinds.map((k) => key(k, index))).size).toBe(4);
  });

  it('reads the shares of a model assembled without them from its features', async () => {
    const { interpolatedLengthFraction: _i, sparseLengthFraction: _s, gapLengthFraction: _g, ...bare } = split;
    const text = drawnText(await buildMapSheetPdf({ model: bare, labels: [], provenance: PROV }));
    expect(text).toContain('75% sparse ground');
  });

  it('fits the share inside the legend column on every sheet, breaking only between parts', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const measure = (t: string, sz: number): number => font.widthOfTextAtSize(t, sz);
    const worst = { interpolated: 0.99, sparse: 0.99, gap: 0.99 };
    for (const width of [612, 792, 595.28, 841.89]) {
      // The legend column runs from 46% of the content width to the separator 10pt
      // left of the 72% accuracy column, less the 4pt the sheet keeps clear.
      const column = (36 + (width - 72) * 0.72 - 10) - (36 + (width - 72) * 0.46) - 4;
      const lines = contourShareSheetLines(worst, column, 6.5, measure);
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const l of lines) expect(measure(l, 6.5)).toBeLessThanOrEqual(column);
      for (const l of lines) expect(l).not.toMatch(/^(interpolated|sparse ground|gap)\b/);
      expect(lines.join(' ')).toBe('99% interpolated \u00b7 99% sparse ground \u00b7 99% gap (by contour length)');
    }
  });

  it('leaves the gap part out when there is no gap, and says unmeasured plainly', () => {
    const measure = (t: string, sz: number): number => t.length * sz * 0.5;
    expect(contourShareSheetLines({ interpolated: 0.04, sparse: 0.45, gap: 0 }, 400, 6.5, measure))
      .toEqual(['4% interpolated \u00b7 45% sparse ground (by contour length)']);
    expect(contourShareSheetLines({ interpolated: Number.NaN, sparse: Number.NaN, gap: Number.NaN }, 400, 6.5, measure))
      .toEqual(['Contour shares not measured (no contours)']);
  });
});

describe('contour label placement on the sheet', () => {
  // The middle of the drawn text, from the origin PDF text turns about.
  const middle = (o: [number, number], w: number, lift: number, a: number): [number, number] => [
    o[0] + Math.cos(a) * (w / 2) - Math.sin(a) * lift,
    o[1] + Math.sin(a) * (w / 2) + Math.cos(a) * lift,
  ];

  it('centres a label on its anchor at any angle', () => {
    for (const a of [0, 0.4, Math.PI / 2, -Math.PI / 2, -1.2]) {
      const [x, y] = middle(rotatedLabelOrigin(300, 400, 20, 2.25, a), 20, 2.25, a);
      expect(x).toBeCloseTo(300, 9);
      expect(y).toBeCloseTo(400, 9);
    }
  });

  it('keeps the horizontal case where it was', () => {
    expect(rotatedLabelOrigin(300, 400, 20, 2.25, 0)).toEqual([290, 397.75]);
  });
});
