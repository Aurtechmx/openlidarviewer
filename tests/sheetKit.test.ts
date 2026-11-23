/**
 * sheetKit.test.ts: the shared export-sheet kit (tokens, fonts, relief and
 * sheet furniture).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  SHEET_STYLES, DEFAULT_SHEET_STYLE, sheetTokens, isSheetStyle, contrastRatio, cssColor, tintAt, type SheetTokens,
} from '../src/export/sheetKit/tokens';
import { embedSheetFonts, drawableText, SHEET_FONT_FILES } from '../src/export/sheetKit/fonts';
import {
  shadeLight, multiLightHillshade, reliefRgba, reliefExaggeration, downsampleGrid, MULTI_LIGHT, type ReliefGrid,
} from '../src/export/sheetKit/relief';
import {
  drawDataBlock, drawScaleBar, drawNorthArrow, drawLegendRow, drawCoordinateTicks, drawFooter, drawSectionLabel,
  drawPaper, wrapSheetText,
} from '../src/export/sheetKit/primitives';
import { hillshade } from '../src/simulation/flowPulse/flowHillshade';
import { scaleBarUnit } from '../src/render/measure/scaleBar';
import { spyPdf } from './support/pdfSpy';

const FONT_DIR = join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts');
const fromDisk = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(FONT_DIR, name)));
const failing = async (): Promise<Uint8Array> => { throw new Error('offline'); };

const STYLED: SheetTokens[] = [sheetTokens('light'), sheetTokens('dark')];

describe('sheet tokens', () => {
  it('offers Light, Dark and Classic, with Light as the default', () => {
    expect(SHEET_STYLES).toEqual(['light', 'dark', 'classic']);
    expect(DEFAULT_SHEET_STYLE).toBe('light');
    expect(SHEET_STYLES.map((s) => sheetTokens(s).label)).toEqual(['Light', 'Dark', 'Classic']);
  });

  it('falls back to the default for an unknown style', () => {
    expect(sheetTokens('sepia').style).toBe('light');
    expect(sheetTokens(undefined).style).toBe('light');
    expect(isSheetStyle('dark')).toBe(true);
    expect(isSheetStyle('sepia')).toBe(false);
  });

  for (const t of STYLED) {
    it(`${t.label}: text meets WCAG contrast on paper and panel`, () => {
      for (const bg of [t.paper, t.panel]) {
        expect(contrastRatio(t.ink, bg)).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(t.dim, bg)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(t.contourLabel, t.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.accent, t.panel)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(t.warn, t.panel)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.warn, t.paper)).toBeGreaterThanOrEqual(4.5);
    });
  }

  for (const s of SHEET_STYLES) {
    it(`${s}: index and filled contours differ from ordinary ones by more than colour`, () => {
      const t = sheetTokens(s);
      expect(t.weight.index).toBeGreaterThan(t.weight.minor * 2);
      expect(t.filledDash.length).toBeGreaterThanOrEqual(2);
      expect(t.filledDash.every((d) => d > 0)).toBe(true);
    });
  }

  it('Classic keeps the colours the contour map sheet draws', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'render', 'measure', 'mapSheetPdf.ts'), 'utf8');
    const value = (name: string): number[] => {
      const m = new RegExp(`const ${name} = rgb\\(([^)]*)\\)`).exec(src);
      if (!m) throw new Error(`${name} not found`);
      return m[1]!.split(',').map(Number);
    };
    const c = sheetTokens('classic');
    expect([...c.ink]).toEqual(value('INK'));
    expect([...c.dim]).toEqual(value('DIM'));
    expect([...c.outline]).toEqual(value('FRAME'));
    expect([...c.minor]).toEqual(value('SEPIA'));
    expect([...c.index]).toEqual(value('SEPIA_INDEX'));
    expect(c.tint).toEqual([]);
    expect(c.tintAlpha).toBe(0);
  });

  it('cssColor and tintAt', () => {
    expect(cssColor([1, 0, 0.5])).toBe('#ff0080');
    const t = sheetTokens('light');
    expect(tintAt(t, 0)).toEqual(t.tint[0]);
    expect(tintAt(t, 1)).toEqual(t.tint[t.tint.length - 1]);
    expect(tintAt(t, Number.NaN)).toEqual(t.tint[0]);
    expect(tintAt(sheetTokens('classic'), 0.5)).toBeNull();
  });
});

/** A 9 x 7 grid: a plane rising to the east and north, with one hole. */
function testGrid(): ReliefGrid & { valid: Uint8Array; z: Float64Array } {
  const cols = 9, rows = 7;
  const z = new Float64Array(cols * rows);
  const valid = new Uint8Array(cols * rows).fill(1);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = 100 + 0.6 * c + 0.3 * r + 0.2 * Math.sin(c * r);
  valid[3 * cols + 4] = 0;
  z[3 * cols + 4] = Number.NaN;
  return { cols, rows, z, valid, cellX: 1.5, cellY: 1.5 };
}

describe('relief', () => {
  it('a single north-west light matches the Flow Pulse hillshade', () => {
    const g = testGrid();
    const ours = shadeLight(g, { azimuthDeg: 315, altitudeDeg: 45 });
    const flow = hillshade({ z: g.z as never, valid: g.valid, cols: g.cols, rows: g.rows, cellMetresX: 1.5, cellMetresY: 1.5 });
    for (let i = 0; i < ours.length; i++) {
      if (!g.valid[i]) { expect(ours[i]).toBeNaN(); continue; }
      expect(ours[i]).toBeCloseTo(flow[i]!, 6);
    }
  });

  it('a flat surface shades to sin(altitude) under every light', () => {
    const g: ReliefGrid = { cols: 4, rows: 4, z: new Float64Array(16).fill(5), cellX: 1, cellY: 1 };
    const s = multiLightHillshade(g);
    const total = MULTI_LIGHT.reduce((a, l) => a + l.weight, 0);
    const expected = MULTI_LIGHT.reduce((a, l) => a + l.weight * Math.sin((l.altitudeDeg * Math.PI) / 180), 0) / total;
    for (const v of s) expect(v).toBeCloseTo(expected, 6);
  });

  it('a slope facing the north-west key is lit more than one facing south-east', () => {
    const cols = 5, rows = 5;
    const plane = (sign: number): ReliefGrid => {
      const z = new Float64Array(cols * rows);
      // sign 1: ground falls towards the north-west, so the slope faces it.
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = sign * (c - r);
      return { cols, rows, z, cellX: 1, cellY: 1 };
    };
    const centre = 2 * cols + 2;
    expect(multiLightHillshade(plane(1))[centre]!).toBeGreaterThan(multiLightHillshade(plane(-1))[centre]!);
  });

  it('is deterministic and leaves cells without ground as NaN', () => {
    const g = testGrid();
    const a = multiLightHillshade(g, MULTI_LIGHT, 2);
    const b = multiLightHillshade(g, MULTI_LIGHT, 2);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    expect(a[3 * g.cols + 4]).toBeNaN();
    for (let i = 0; i < a.length; i++) if (g.valid[i]) { expect(a[i]).toBeGreaterThanOrEqual(0); expect(a[i]).toBeLessThanOrEqual(1); }
  });

  it('rejects a light set with no positive weight', () => {
    expect(() => multiLightHillshade(testGrid(), [{ azimuthDeg: 0, altitudeDeg: 45, weight: 0 }])).toThrow();
  });

  it('exaggerates flat sites and leaves steep ones alone', () => {
    const flat: ReliefGrid = { cols: 100, rows: 100, z: Float64Array.from({ length: 10000 }, (_, i) => i % 100 * 0.001), cellX: 1, cellY: 1 };
    const steep: ReliefGrid = { cols: 10, rows: 10, z: Float64Array.from({ length: 100 }, (_, i) => (i % 10) * 5), cellX: 1, cellY: 1 };
    expect(reliefExaggeration(flat)).toBe(8);
    expect(reliefExaggeration(steep)).toBe(1);
    expect(reliefExaggeration({ cols: 2, rows: 2, z: [1, 1, 1, 1], cellX: 1, cellY: 1 })).toBe(1);
  });

  it('reliefRgba puts north at the top and leaves cells without ground transparent', () => {
    const g = testGrid();
    const shade = multiLightHillshade(g);
    const { width, height, rgba } = reliefRgba(g, shade, sheetTokens('light'));
    expect([width, height]).toEqual([g.cols, g.rows]);
    // Grid row 3 is image row rows - 1 - 3.
    const hole = ((g.rows - 1 - 3) * g.cols + 4) * 4;
    expect(rgba[hole + 3]).toBe(0);
    expect(rgba[3]).toBe(255);
    // Same cell, light style: tinted, so not a pure grey.
    const p = ((g.rows - 1) * g.cols) * 4;
    expect(new Set([rgba[p], rgba[p + 1], rgba[p + 2]]).size).toBeGreaterThan(1);
  });

  it('reliefRgba in Classic is plain paper white', () => {
    const g = testGrid();
    const { rgba } = reliefRgba(g, multiLightHillshade(g), sheetTokens('classic'));
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3]) expect([rgba[i], rgba[i + 1], rgba[i + 2]]).toEqual([255, 255, 255]);
  });

  it('downsampleGrid averages blocks and keeps empty blocks empty', () => {
    const z = Float64Array.from({ length: 16 }, (_, i) => i);
    const valid = new Uint8Array(16).fill(1);
    valid[10] = 0; valid[11] = 0; valid[14] = 0; valid[15] = 0;
    const d = downsampleGrid({ cols: 4, rows: 4, z, valid, cellX: 1, cellY: 2 }, 2);
    expect([d.cols, d.rows, d.cellX, d.cellY]).toEqual([2, 2, 2, 4]);
    expect(Array.from(d.z).slice(0, 3)).toEqual([2.5, 4.5, 10.5]);
    expect(Array.from(d.valid!)).toEqual([1, 1, 1, 0]);
    const same = { cols: 3, rows: 3, z: new Float64Array(9), cellX: 1, cellY: 1 };
    expect(downsampleGrid(same, 2000)).toBe(same);
  });
});

describe('sheet fonts', () => {
  it('sets figures in Figtree too, so no figure depends on a font the PDF does not carry', async () => {
    const doc = await PDFDocument.create();
    const f = await embedSheetFonts(doc, fromDisk);
    expect(f.fallback).toBe(false);
    expect(f.sans.name).toContain('Figtree-Regular');
    expect(f.sansBold.name).toContain('Figtree-Bold');
    expect(f.mono).toBe(f.sans);
    expect(f.monoBold).toBe(f.sansBold);
    expect(SHEET_FONT_FILES).toEqual(['figtree/Figtree-Regular.ttf', 'figtree/Figtree-Bold.ttf']);
  });

  it('falls back to Helvetica when the font files cannot be loaded', async () => {
    const doc = await PDFDocument.create();
    const f = await embedSheetFonts(doc, failing);
    expect(f.fallback).toBe(true);
    expect(f.sans.name).toBe('Helvetica');
    expect(f.sansBold.name).toBe('Helvetica-Bold');
    expect(f.mono.name).toBe('Courier');
    // A sheet still draws with the fallback.
    const page = doc.addPage();
    expect(() => page.drawText(drawableText('Relief 1 846.4 – 2 005.6 m ≤ 3 m', f.sans, f), { x: 10, y: 10, size: 8, font: f.sans })).not.toThrow();
  });

  it('drawableText keeps what Figtree can draw and transliterates the rest', async () => {
    const doc = await PDFDocument.create();
    const f = await embedSheetFonts(doc, fromDisk);
    expect(drawableText('≤ 3 m', f.sans, f)).toBe('≤ 3 m');
    expect(drawableText('2 × 3 — m', f.mono, f)).toBe('2 × 3 — m');
    expect(drawableText('\u{1F600}', f.sans, f)).toBe('?');
  });

  it('gives a negative figure a minus sign and leaves names, dates and dashes alone', async () => {
    const doc = await PDFDocument.create();
    const f = await embedSheetFonts(doc, fromDisk);
    expect(drawableText('-0.08', f.sans, f)).toBe('−0.08');
    expect(drawableText('-46.16%', f.sans, f)).toBe('−46.16%');
    for (const s of ['2026-11-23', '-', 'A-1', '-2 site', 'scan-01']) expect(drawableText(s, f.sans, f)).toBe(s);
    const plain = await PDFDocument.create();
    const g = await embedSheetFonts(plain, failing);
    expect(drawableText('-0.08', g.sans, g)).toBe('-0.08');
  });
});

async function sheet() {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const spy = spyPdf(doc);
  const f = await embedSheetFonts(doc, fromDisk);
  const page = doc.addPage([1224, 792]);
  return { doc, spy, f, page };
}

describe('sheet furniture', () => {
  it('data block: keys as written, long values wrapped', async () => {
    const { spy, f, page } = await sheet();
    const t = sheetTokens('light');
    const end = drawDataBlock(page, [
      { key: 'RMSEz', value: 'NAD83(2011) / Conus Albers' },
      { key: 'Relief', value: '1846.4 – 2005.6 m' },
      { key: 'Note', value: 'a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g h' },
    ], 900, 400, 200, t, f);
    const keys = spy.texts.filter((x) => x.x === 900).map((x) => x.text);
    expect(keys).toEqual(['RMSEz', 'Relief', 'Note']);
    const values = spy.texts.filter((x) => x.x > 900);
    expect(values.every((v) => v.font === f.mono)).toBe(true);
    expect(values.find((v) => v.text.startsWith('1846.4'))!.text).toBe('1846.4 – 2005.6 m');
    expect(values.length).toBeGreaterThan(3);
    expect(values.every((v) => v.x + v.width <= 1100 + 0.01)).toBe(true);
    expect(end).toBeLessThan(400 - values.length * 7);
  });

  it('scale bar: four segments, labels at 0, the middle and the end, unit after them', async () => {
    const { spy, f, page } = await sheet();
    // 2 points per metre, bar at most 230 points: 100 m.
    drawScaleBar(page, { scalePtPerWorld: 2, maxBarPt: 230, unitFor: (g: number) => scaleBarUnit(g, 'metre') }, 900, 300, sheetTokens('light'), f);
    expect(spy.texts.map((x) => x.text)).toEqual(['0', '50', '100', 'm']);
    drawScaleBar(page, { scalePtPerWorld: 0, maxBarPt: 230, unitFor: (g: number) => scaleBarUnit(g, 'metre') }, 900, 200, sheetTokens('light'), f);
    expect(spy.texts.length).toBe(4);
  });

  it('scale bar in feet says ft and never km', async () => {
    const { spy, f, page } = await sheet();
    drawScaleBar(page, { scalePtPerWorld: 0.1, maxBarPt: 230, unitFor: (g: number) => scaleBarUnit(g, 'foot') }, 900, 300, sheetTokens('light'), f);
    expect(spy.texts.map((x) => x.text).at(-1)).toBe('ft');
    expect(spy.texts.map((x) => x.text)).toContain('2000');
  });

  it('north arrow: grid, true north with its angle, and a local frame that claims no bearing', async () => {
    const { spy, f, page } = await sheet();
    const t = sheetTokens('light');
    drawNorthArrow(page, { kind: 'grid' }, 100, 100, t, f);
    expect(spy.texts.map((x) => x.text)).toEqual(['Grid N']);
    expect(spy.paths.length).toBe(1);
    drawNorthArrow(page, { kind: 'true', convergenceDeg: -1.29 }, 200, 100, t, f);
    expect(spy.texts.map((x) => x.text).slice(1)).toEqual(['True N', '1.29° W of grid N']);
    const before = spy.paths.length;
    drawNorthArrow(page, { kind: 'local' }, 300, 100, t, f);
    expect(spy.paths.length).toBe(before);
    expect(spy.texts.map((x) => x.text).slice(3)).toEqual(['Local grid up', 'true north unknown']);
  });

  it('legend rows step down the panel and label each key', async () => {
    const { spy, f, page } = await sheet();
    const t = sheetTokens('dark');
    let y = 500;
    y = drawLegendRow(page, { kind: 'line', color: t.index, width: t.weight.index }, 'Index contour, 10 m, labelled', 900, y, t, f);
    y = drawLegendRow(page, { kind: 'line', color: t.minor, width: t.weight.minor, dash: t.filledDash }, 'Contour over filled cells', 900, y, t, f);
    y = drawLegendRow(page, { kind: 'hatch', color: t.hatch, background: t.nodata }, 'No ground data', 900, y, t, f);
    drawLegendRow(page, { kind: 'marker', color: t.ink, shape: 'up' }, 'Highest ground', 900, y, t, f);
    const ys = spy.texts.map((x) => x.y);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    expect(new Set(ys).size).toBe(4);
    expect(spy.paths.length).toBe(1);
  });

  it('coordinate ticks: eastings under the frame, northings rotated beside it, out-of-frame ticks skipped', async () => {
    const { spy, f, page } = await sheet();
    const frame = { x: 60, y: 60, w: 800, h: 600 };
    drawCoordinateTicks(page, frame, [{ at: 100, label: '-1 384 000' }, { at: 2000, label: 'off' }], [{ at: 200, label: '1 483 900' }], sheetTokens('light'), f);
    const texts = spy.texts.map((x) => [x.text, x.rotated]);
    expect(texts).toEqual([['-1 384 000', false], ['1 483 900', true]]);
  });

  it('section label upper-cases, footer prints both ends, wrap respects the width', async () => {
    const { spy, f, page } = await sheet();
    const t = sheetTokens('light');
    drawPaper(page, t);
    const y = drawSectionLabel(page, 'Legend', 900, 700, 260, t, f);
    expect(y).toBeLessThan(700);
    drawFooter(page, 'OpenLiDARViewer', '1 / 1', 900, 1160, 40, t, f);
    expect(spy.texts.map((x) => x.text)).toEqual(['LEGEND', 'OpenLiDARViewer', '1 / 1']);
    const right = spy.texts[2]!;
    expect(right.x + right.width).toBeCloseTo(1160, 6);
    const lines = wrapSheetText('Not a survey-grade deliverable. Contours follow the ground model.', f.sans, 6.5, 120, f);
    expect(lines.length).toBeGreaterThan(1);
    for (const ln of lines) expect(f.sans.widthOfTextAtSize(ln, 6.5)).toBeLessThanOrEqual(120);
  });

  it('the same furniture saves to the same bytes', async () => {
    const build = async (): Promise<string> => {
      const { doc, f, page } = await sheet();
      const t = sheetTokens('light');
      drawPaper(page, t);
      drawDataBlock(page, [{ key: 'Grid', value: '1.0 m cells' }], 900, 400, 200, t, f);
      drawScaleBar(page, { scalePtPerWorld: 2, maxBarPt: 230, unitFor: (g: number) => scaleBarUnit(g, 'metre') }, 900, 300, t, f);
      drawNorthArrow(page, { kind: 'true', convergenceDeg: 1.29 }, 100, 100, t, f);
      return createHash('sha256').update(await doc.save()).digest('hex');
    };
    expect(await build()).toBe(await build());
  });
});
