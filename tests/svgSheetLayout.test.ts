/**
 * svgSheetLayout.test.ts: a contour SVG sheet is wide enough for its legend,
 * title and scale bar whatever the footprint's shape, and a sheet with room is
 * laid out as before.
 */
import { describe, it, expect } from 'vitest';
import { svgContours } from '../src/terrain/contour/svgContours';
import { svgContoursStyled } from '../src/terrain/contour/svgContoursStyled';
import { scaleBarSpan, svgSheetLayout } from '../src/terrain/contour/svgSheetLayout';
import { svgSize } from '../src/export/sheetKit/svgRaster';
import { sheetTokens } from '../src/export/sheetKit/tokens';
import type { ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';

const model = (w: number, h: number): ContourFeatureModel => ({
  features: [{ value: 5, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 0], [w, h]] }],
  crs: null, verticalDatum: null, intervalM: 1, contourStyle: 'smooth',
  bbox: { minX: 0, minY: 0, maxX: w, maxY: h }, interpolatedFraction: 0, coverageMode: 'full', warnings: [],
});
const SHEETS = {
  classic: (m: ContourFeatureModel) => svgContours(m),
  light: (m: ContourFeatureModel) => svgContoursStyled(m, { tokens: sheetTokens('light') }),
};

for (const [name, draw] of Object.entries(SHEETS)) {
  describe(`${name} SVG`, () => {
    for (const [w, h] of [[1, 100], [10, 1000], [300, 1000], [1000, 1000], [1000, 10], [100, 1]] as const) {
      it(`${w} by ${h}: every text and line stays on the page`, () => {
        const svg = draw(model(w, h));
        const size = svgSize(svg)!;
        const texts = [...svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)"([^>]*)>([^<]*)</g)];
        expect(texts.length).toBeGreaterThan(6);
        for (const [, xs, ys, attrs, txt] of texts) {
          const x = Number(xs), tw = txt!.length * 6.2;
          const anchor = /text-anchor="(\w+)"/.exec(attrs!)?.[1] ?? 'start';
          const x0 = anchor === 'end' ? x - tw : anchor === 'middle' ? x - tw / 2 : x;
          expect(x0, txt).toBeGreaterThanOrEqual(0);
          expect(x0 + tw, txt).toBeLessThanOrEqual(size.width);
          expect(Number(ys), txt).toBeLessThanOrEqual(size.height);
        }
        const d = /<path d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+)/.exec(svg)!.slice(1).map(Number);
        for (const x of [d[0]!, d[2]!]) expect(x).toBeLessThanOrEqual(size.width);
        // The map is drawn to one scale on both axes.
        expect(Math.abs(d[2]! - d[0]!) / w).toBeCloseTo(Math.abs(d[3]! - d[1]!) / h, 1);
      });
    }
  });
}

describe('svgSheetLayout', () => {
  it('keeps the size and positions of a sheet with room', () => {
    expect(svgSheetLayout({ mapW: 880, mapH: 400, margin: 28, legend: ['Contour'], title: ['Interval 1 m'] })).toEqual({
      frameW: 880, frameH: 400, frameX: 28, padX: 0, padY: 0, pageW: 936, stacked: false,
    });
  });
  it('stacks the title under the legend and centres the map when they do not fit side by side', () => {
    const l = svgSheetLayout({ mapW: 9, mapH: 880, margin: 28, legend: ['Index contour, labelled'], title: ['x'.repeat(60)] });
    expect(l.stacked).toBe(true);
    expect(l.frameX + l.frameW / 2).toBeCloseTo(l.pageW / 2, 9);
    expect(l.pageW).toBeGreaterThan(60 * 6);
  });
  it('lengthens only a scale bar too short to label', () => {
    expect(scaleBarSpan(100, 1)).toBe(100);
    expect(scaleBarSpan(2, 0.88)).toBe(100);
    expect(scaleBarSpan(1, 30)).toBe(2);
  });
});
