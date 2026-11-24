/**
 * profileTickLabels.test.ts: an elevation label says the height its line is at.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFPage } from 'pdf-lib';
import { buildProfilePdf } from '../src/render/measure/profilePdf';
import { roundTickStep, tickDecimals } from '../src/render/measure/profileSheetLayout';

const loadFont = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));
afterEach(() => vi.restoreAllMocks());

describe('elevation tick labels', () => {
  it('write every multiple of every step exactly', () => {
    for (let span = 0.02; span < 4000; span *= 1.13) {
      const step = roundTickStep(span, 6), d = tickDecimals(step);
      for (let n = 1; n < 12; n++) expect(Number((n * step).toFixed(d)), `${step}`).toBeCloseTo(n * step, 6);
    }
    expect([1, 0.5, 0.25, 0.2, 2.5, 0.05, 0.025].map(tickDecimals)).toEqual([1, 1, 2, 1, 1, 2, 3]);
  });
  it.each(['light', 'classic'] as const)('are evenly spaced on the %s sheet at a step of 0.25', async (style) => {
    const at: Array<{ v: number; y: number }> = [];
    const orig = PDFPage.prototype.drawText;
    vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, t: string, o?: { y?: number }) {
      if (/^60[3-7]\.\d+$/.test(t)) at.push({ v: Number(t), y: o?.y ?? 0 });
      return orig.call(this, t, o as never);
    });
    const samples = Array.from({ length: 64 }, (_, i) => ({ distance: (i * 51) / 63, height: 605 + 0.73 * Math.sin(i / 6), count: 20 }));
    await buildProfilePdf({ name: 'P', project: 'S', samples, generatedAt: new Date(0), crs: 'EPSG:6346', verticalDatum: 'NAVD88', corridorWidthM: 5, groundPercentile: 25, style, loadFont } as never);
    // The axis labels are the first run going down the page in even steps.
    const ticks = at.filter((t, n) => n === 0 || Math.abs(t.v - at[n - 1]!.v) < 0.3).slice(0, 6);
    expect(ticks.length).toBeGreaterThan(4);
    const perUnit = ticks.slice(1).map((t, n) => (t.y - ticks[n]!.y) / (t.v - ticks[n]!.v));
    for (const k of perUnit) expect(k).toBeCloseTo(perUnit[0]!, 1);
    expect(at.some((t) => t.v === 605.25)).toBe(true);
  });
});
