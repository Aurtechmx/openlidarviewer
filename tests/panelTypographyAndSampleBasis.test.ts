import { describe, it, expect, beforeAll } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import { densityReferenceFloorFor, type AnalysedBasis } from '../src/terrain/export/analysedBasis';
import { describeWithheldRead, formatGroupedInt } from '../src/science/withheldCounts';
import { contourShareCaption } from '../src/terrain/contour/evidenceGrade';
import { contourShareSheetLines, layoutAccuracyColumn } from '../src/render/measure/mapSheetPdf';
import type { ContourFeatureModel, ContourLengthShares } from '../src/terrain/contour/contourFeatureModel';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
});

function hill(): TerrainPoint[] {
  return Array.from({ length: 41 * 41 }, (_, i) => {
    const x = i % 41;
    const y = Math.floor(i / 41);
    return { x, y, z: 6 * Math.sin(x / 7) * Math.cos(y / 9) + ((x * 5 + y * 11) % 7) * 0.01 };
  });
}

const SAMPLED: AnalysedBasis = {
  analysedPointCount: 273_275, declaredPointCount: 10_789_680, coverage: 'sampled', loadStride: null,
};
const FULL: AnalysedBasis = {
  analysedPointCount: 1000, declaredPointCount: 1000, coverage: 'full', loadStride: null,
};

async function panelText(basis: AnalysedBasis | null, frameFirst: boolean): Promise<string> {
  const { AnalysePanel } = await import('../src/ui/AnalysePanel');
  const panel = new AnalysePanel({});
  const base = analyseContours(hill(), {
    cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', horizontalUnitToMetres: 1, verticalUnitToMetres: 1,
  });
  const result = {
    ...base,
    accuracyStandards: { ...base.accuracyStandards, densityReferenceFloorsMet: ['QL3'], densityReferenceNote: 'note' },
  } as typeof base;
  const frame = { analysedBasis: basis } as never;
  if (frameFirst) panel.setContourFrame(frame);
  panel.update(result);
  // The runner hands the frame over after the result, so the rows must redraw.
  if (!frameFirst) panel.setContourFrame(frame);
  return (panel.element as unknown as FakeEl).textContent;
}

describe('density reference chip', () => {
  it('keeps the earlier behaviour when the analysed basis is unknown', async () => {
    // Documented in densityReferenceFloorFor: an absent basis is not a sample.
    expect(await panelText(null, false)).toContain('USGS density ref: ≥ QL3 floor');
  });
  it('is withheld on a sample whichever of result and frame arrives first', async () => {
    expect(await panelText(SAMPLED, true)).not.toContain('USGS density ref: ≥');
    expect(await panelText(SAMPLED, false)).not.toContain('USGS density ref: ≥');
  });
  it('is shown on a full read', async () => {
    expect(await panelText(FULL, false)).toContain('USGS density ref: ≥ QL3 floor');
  });
  it('uses one decision for every surface', () => {
    expect(densityReferenceFloorFor(['QL2'], SAMPLED)).toBeNull();
    expect(densityReferenceFloorFor(['QL2'], FULL, 'sampled')).toBeNull();
    expect(densityReferenceFloorFor(['QL2'], FULL, 'full')).toBe('QL2');
    expect(densityReferenceFloorFor([], FULL)).toBeNull();
    expect(densityReferenceFloorFor(['QL2'], null, 'full')).toBe('QL2');
    expect(densityReferenceFloorFor(['QL2'], undefined, 'sampled')).toBeNull();
  });
});

describe('formatGroupedInt', () => {
  it('groups digits independent of locale', () => {
    expect(formatGroupedInt(10789680)).toBe('10,789,680');
    expect(formatGroupedInt(6150)).toBe('6,150');
    expect(formatGroupedInt(12)).toBe('12');
  });
  it('is used by the analysed-of-source line', () => {
    expect(describeWithheldRead({ sourcePoints: 10789680, withheldExcluded: 0, analysedPoints: 10789680 }))
      .toBe('10,789,680 of 10,789,680 analysed; Withheld excluded: 0');
  });
});

describe('validation row units', () => {
  const NB = '\u00a0';
  it('keeps value and unit together', async () => {
    const text = await panelText(FULL, false);
    expect(text).toMatch(new RegExp(`Vertical RMSE: [\\d.]+${NB}m`));
    // The row must really exist: a slope stratum named steep with a figure, then the unit.
    expect(text).toMatch(new RegExp(`RMSE by slope:.*steep [\\d.]+${NB}m`));
    // No number is followed by a plain space and the unit in these rows.
    expect(text).not.toMatch(/(?:Vertical RMSE|RMSE by slope|RMSE by zone|Blocked RMSE):[^|]*\d m\b/);
  });
});

describe('contour share', () => {
  const withShares = (s: ContourLengthShares): ContourFeatureModel => ({
    features: [], interpolatedFraction: s.interpolated + s.sparse + s.gap,
    interpolatedLengthFraction: s.interpolated, sparseLengthFraction: s.sparse, gapLengthFraction: s.gap,
  }) as unknown as ContourFeatureModel;

  it('prints the same wording on the panel and the sheet', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const measure = (t: string, sz: number): number => font.widthOfTextAtSize(t, sz);
    for (const s of [
      { interpolated: 0.004, sparse: 0.45, gap: 0 },
      { interpolated: 0.55, sparse: 0.2, gap: 0.01 },
      { interpolated: 0.998, sparse: 0.001, gap: 0.001 },
    ]) {
      // Portrait A4 is the narrowest legend column.
      expect(contourShareSheetLines(s, 126, 6.5, measure).join(' ')).toBe(contourShareCaption(withShares(s)));
    }
  });

  it('shows the panel the split share of a real run', async () => {
    expect(await panelText(FULL, false)).toMatch(
      /\d+% interpolated · \d+% sparse ground( · \d+% gap)? \(by contour length\)|All contour length is from confident, measured terrain\./,
    );
  });
});

describe('layoutAccuracyColumn', () => {
  const measure = (s: string, sz: number): number => s.length * sz * 0.5;
  const rows: Array<[string, string, string?]> = [
    ['NVA-style (95%, hold-out)', '1.19 m'],
    ['VVA-style (95th pct, hold-out)', '2.10 m'],
    ['RMSEz', '0.61 m'],
    ['Ground-return density ref', 'not stated on a sample', 'Density ref'],
  ];
  for (const colW of [120, 150, 190]) {
    it(`keeps every line inside a ${colW} pt column and apart from the next row`, () => {
      const { lines } = layoutAccuracyColumn(rows, { topY: 700, colW, sampleNote: 'Figures are from a sample of the points', measure });
      for (const l of lines) expect(measure(l.text, l.size), l.text).toBeLessThanOrEqual(colW);
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i - 1].y - lines[i].y, lines[i].text).toBeGreaterThanOrEqual(lines[i - 1].size);
      }
    });
  }
  it('puts the sample note on its own row above the first figure', () => {
    const { lines } = layoutAccuracyColumn(rows, { topY: 700, colW: 190, sampleNote: 'note', measure });
    expect(lines[0].text).toBe('note');
    expect(lines[0].y - lines[1].y).toBeGreaterThanOrEqual(10);
  });
});

describe('layoutAccuracyColumn with the sheet font', () => {
  it.each([142, 147, 215])('keeps the sampled rows inside a %i pt column', async (colW) => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const measure = (t: string, sz: number): number => font.widthOfTextAtSize(t, sz);
    const rows: Array<[string, string, string?]> = [
      ['NVA-style (95%, hold-out)', '1.19 m'],
      ['VVA-style (95th pct, hold-out)', '2.10 m'],
      ['RMSEz', '0.61 m'],
      ['Ground-return density ref', 'not stated on a sample', 'Ground density ref'],
    ];
    const { lines } = layoutAccuracyColumn(rows, { topY: 700, colW, sampleNote: 'Figures are from a sample of the points', measure });
    for (const l of lines) expect(measure(l.text, l.size), l.text).toBeLessThanOrEqual(colW);
    for (let i = 1; i < lines.length; i++) expect(lines[i - 1].y - lines[i].y).toBeGreaterThanOrEqual(lines[i - 1].size);
    expect(lines.map((l) => l.text).join(' ')).toContain('Ground');
  });
});
