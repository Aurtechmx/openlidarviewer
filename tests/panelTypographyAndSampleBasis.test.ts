import { describe, it, expect, beforeAll } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import { densityReferenceFloorFor, type AnalysedBasis } from '../src/terrain/export/analysedBasis';
import { describeWithheldRead, formatGroupedInt } from '../src/science/withheldCounts';
import { interpolatedShareCaption } from '../src/terrain/contour/evidenceGrade';
import { interpolatedLengthLine, layoutAccuracyColumn } from '../src/render/measure/mapSheetPdf';
import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
});

function hill(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 40; x++) {
    for (let y = 0; y <= 40; y++) {
      const dx = x - 20;
      const dy = y - 20;
      pts.push({ x, y, z: 8 * Math.exp(-(dx * dx + dy * dy) / 220) + ((x * 7 + y * 3) % 5) * 0.01 });
    }
  }
  return pts;
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
  it('keeps value and unit together', async () => {
    const text = await panelText(FULL, false);
    expect(text).toMatch(/Vertical RMSE: [\d.]+ m/);
    expect(text).not.toMatch(/RMSE by slope:[^|]* m\b/);
  });
});

describe('interpolated share', () => {
  it('prints the same percentage on the panel and the sheet', () => {
    for (const f of [0.004, 0.55, 0.76, 0.998]) {
      const pct = /^(\d+)%/;
      expect(interpolatedShareCaption(f).match(pct)?.[1]).toBe(interpolatedLengthLine(f).match(pct)?.[1]);
    }
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
