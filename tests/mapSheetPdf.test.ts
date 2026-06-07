/**
 * mapSheetPdf.test.ts — the composer produces a valid PDF from a model.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMapSheetPdf,
  readinessNote,
  wrapTextToWidth,
} from '../src/render/measure/mapSheetPdf';
import type { ContourFeatureModel, ContourFeature } from '../src/terrain/contour/contourFeatureModel';
import { demAccuracyStandards } from '../src/terrain/quality/demAccuracyStandards';

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
  bbox: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
  interpolatedFraction: 0.12,
  coverageMode: 'full',
  warnings: [],
};

describe('buildMapSheetPdf', () => {
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

  it('still produces a PDF when there are no contours', async () => {
    const empty: ContourFeatureModel = { ...model, features: [], bbox: null };
    const bytes = await buildMapSheetPdf({ model: empty, labels: [], sheet: 'a4' });
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
