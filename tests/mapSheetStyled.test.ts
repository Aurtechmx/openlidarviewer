/**
 * mapSheetStyled.test.ts: the Light and Dark contour map sheet, its relief
 * model and the styled SVG.
 */
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFPage } from 'pdf-lib';
import { analyseContours, type AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import { buildMapSheetPdf, readinessNote, mapSheetEvidenceLine, type MapSheetInput } from '../src/render/measure/mapSheetPdf';
import { buildContourSheetPdf } from '../src/render/measure/mapSheetStyled';
import {
  CELL_FILLED, CELL_HOLE, CELL_MEASURED, CELL_OUTSIDE, MAX_RASTER_SIDE,
  classifyCells, contourSheetRaster, contourSheetRelief, rasterSizeFor, simplifyRing, styledContourStroke,
  type SheetReliefInput,
} from '../src/export/sheetKit/contourSheetModel';
import { sheetTokens } from '../src/export/sheetKit/tokens';
import { buildSvgSheet } from '../src/export/sheetKit/svgSheet';
import { serializeContours } from '../src/terrain/contour/contourDownload';
import { svgContours } from '../src/terrain/contour/svgContours';
import { STYLE_OPTIONS } from '../src/render/measure/mapSheetExportOptions';

const FONT_DIR = join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts');
const loadFont = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(FONT_DIR, n)));
const WHEN = new Date('2026-11-20T12:00:00Z');

/** A tilted, ridged site with an irregular edge, a hole without ground and a filled gap. */
function scene(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 90; x += 0.8) {
    for (let y = 0; y <= 60; y += 0.8) {
      const ex = (x - 45) / 44, ey = (y - 30) / 28;
      if (ex * ex + ey * ey > 1) continue;
      if (((x - 60) / 7) ** 2 + ((y - 34) / 5) ** 2 < 1) continue;
      if (x > 18 && x < 24 && y > 20 && y < 22.5) continue;
      pts.push({ x, y, z: 100 + 0.4 * x + 6 * Math.sin(x / 11) * Math.cos(y / 13) });
    }
  }
  return pts;
}

let r: AnalyseContoursResult;
let relief: SheetReliefInput;
beforeAll(() => {
  r = analyseContours(scene(), { cellSizeM: 1, crs: 'EPSG:32612', verticalDatum: 'EPSG:5703' } as never);
  const d = r.dtm;
  // The terrain pipeline fills small gaps, so cut a hole without ground into a
  // copy of the grid, well inside the site, away from any contour test.
  const coverage = Uint8Array.from(d.coverage);
  for (let row = 0; row < d.rows; row++) {
    for (let col = 0; col < d.cols; col++) {
      const x = d.originH1 + (col + 0.5) * d.cellSizeM, y = d.originH2 + (row + 0.5) * d.cellSizeM;
      if (((x - 60) / 6) ** 2 + ((y - 34) / 4) ** 2 < 1) coverage[row * d.cols + col] = 0;
    }
  }
  relief = { cols: d.cols, rows: d.rows, cellSize: d.cellSizeM, originX: d.originH1, originY: d.originH2, z: d.z, coverage };
});
afterEach(() => { vi.restoreAllMocks(); });

/** The analysed grid with the test hole, in the shape the SVG sheet reads. */
function holedDtm() {
  return { ...r.dtm, coverage: relief.coverage };
}

function input(over: Partial<MapSheetInput> = {}): MapSheetInput {
  return {
    model: r.model, labels: r.labels, worldOrigin: { x: 412000, y: 4501000, z: 0 },
    crs: 'WGS 84 / UTM zone 12N', verticalDatum: 'NAVD88', linearUnit: 'metre',
    readiness: 'previewOnly', title: 'Test site', generatedAt: WHEN, relief, sheet: 'letter', orientation: 'landscape',
    ...over,
  };
}

/** Every string drawn, with its rotation in degrees. */
async function drawn(inp: MapSheetInput, opts = { loadFont }): Promise<Array<{ text: string; angle: number }>> {
  const out: Array<{ text: string; angle: number }> = [];
  const orig = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text: string, o?: { rotate?: { angle?: number } }) {
    out.push({ text, angle: o?.rotate?.angle ?? 0 });
    return orig.call(this, text, o as never);
  });
  await buildContourSheetPdf(inp, opts);
  return out;
}

describe('style dispatch', () => {
  it('Classic, or no style, is the original sheet byte for byte', async () => {
    const classic = await buildMapSheetPdf(input({ relief: null }));
    expect(Buffer.from(await buildContourSheetPdf(input({ relief: null }))).equals(Buffer.from(classic))).toBe(true);
    expect(Buffer.from(await buildContourSheetPdf(input({ relief: null, style: 'classic' }))).equals(Buffer.from(classic))).toBe(true);
    // Classic ignores the relief and the true-north input.
    const withGrid = await buildContourSheetPdf(input({ style: 'classic', trueNorth: { convergenceDeg: 1 } }));
    expect(Buffer.from(withGrid).equals(Buffer.from(await buildMapSheetPdf(input())))).toBe(true);
  });

  it('the dialog offers Light first, then Dark and Classic', () => {
    expect(STYLE_OPTIONS.map((o) => o.value)).toEqual(['light', 'dark', 'classic']);
  });

  for (const style of ['light', 'dark'] as const) {
    it(`${style}: the same input gives the same bytes`, async () => {
      const a = await buildContourSheetPdf(input({ style }), { loadFont });
      const b = await buildContourSheetPdf(input({ style }), { loadFont });
      expect(a.length).toBeGreaterThan(20_000);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      const doc = await PDFDocument.load(a);
      expect(doc.getPageCount()).toBe(1);
    }, 120_000);
  }
});

describe('the styled sheet', () => {
  it('carries the readiness note, the evidence line and the not-survey-grade wording', async () => {
    const texts = (await drawn(input({ style: 'light' }))).map((t) => t.text).join('\n');
    expect(texts).toContain(readinessNote('previewOnly').slice(0, 30));
    expect(texts).toContain('Evidence:');
    expect(mapSheetEvidenceLine()).toMatch(/^Evidence:/);
    expect(texts).toContain('PREVIEW');
  }, 120_000);

  it('draws contour labels upright', async () => {
    const angles = (await drawn(input({ style: 'light' }))).filter((t) => /^\d+(\.\d+)?$/.test(t.text) && t.angle !== 0 && Math.abs(t.angle) !== 90).map((t) => t.angle);
    expect(angles.length).toBeGreaterThan(0);
    for (const a of angles) expect(Math.abs(a)).toBeLessThanOrEqual(90 + 1e-9);
  }, 120_000);

  it('the north arrow says true north only when it was worked out, and claims nothing on a local frame', async () => {
    const grid = (await drawn(input({ style: 'light' }))).map((t) => t.text);
    expect(grid).toContain('Grid N');
    vi.restoreAllMocks();
    const tn = (await drawn(input({ style: 'light', trueNorth: { convergenceDeg: -1.29 } }))).map((t) => t.text);
    expect(tn).toContain('True N');
    expect(tn.some((s) => s.startsWith('1.29') && s.includes('W of grid N'))).toBe(true);
    vi.restoreAllMocks();
    const local = (await drawn(input({ style: 'light', crs: null, provenance: undefined }))).map((t) => t.text);
    expect(local).toContain('Local grid up');
    expect(local).not.toContain('Grid N');
  }, 120_000);

  it('the legend lists the line kinds the map draws and the marks for the relief', async () => {
    const texts = (await drawn(input({ style: 'dark' }))).map((t) => t.text);
    expect(texts).toContain('Index contour, labelled');
    expect(texts).toContain('Scan footprint');
    expect(texts).toContain('No ground data inside the footprint');
    expect(texts).toContain('Highest measured ground');
    // A model with only measured runs lists no dashed or dotted kinds.
    vi.restoreAllMocks();
    const measuredOnly = { ...r.model, features: r.model.features.map((f) => ({ ...f, grade: 'solid' as const, provBits: undefined, basis: 'measured' as const })) };
    const plain = (await drawn(input({ style: 'light', model: measuredOnly as never }))).map((t) => t.text);
    expect(plain).not.toContain('Contour over filled cells');
    expect(plain).not.toContain('Low-confidence gap');
  }, 120_000);

  it('fits every sheet size and orientation without dropping a block', async () => {
    for (const sheet of ['letter', 'a4', 'a3'] as const) {
      for (const orientation of ['portrait', 'landscape'] as const) {
        const texts = (await drawn(input({ style: 'light', sheet, orientation, notes: 'Note line', preparedBy: 'A. Person' }))).map((t) => t.text);
        for (const want of ['LEGEND', 'SCALE', 'DATA', 'PROJECT / NOTES', 'Note line', 'A. Person']) expect(texts, `${sheet} ${orientation}: ${want}`).toContain(want);
        vi.restoreAllMocks();
      }
    }
  }, 240_000);

  it('still draws without a terrain grid, and without the font files', async () => {
    const noGrid = await drawn(input({ style: 'light', relief: null }));
    expect(noGrid.map((t) => t.text)).not.toContain('Scan footprint');
    vi.restoreAllMocks();
    const offline = await drawn(input({ style: 'light' }), { loadFont: async () => { throw new Error('offline'); } });
    expect(offline.length).toBeGreaterThan(20);
  }, 120_000);

  it('the purpose appendix states what the styled sheet drew', async () => {
    const purpose = { label: 'Engineering Plan', statement: 'Plan contours.', analytical: true, cartographic: false, cartographicSmoothing: false, generalizeToleranceCells: 0, indexEvery: 5, labelsIndexOnly: true, hillshade: false, hypsometricTint: false, allowExploratory: false, completePackage: true, appendixRequired: false };
    const texts = (await drawn(input({ style: 'light', purpose }))).map((t) => t.text);
    expect(texts).toContain('drawn on this sheet (four-light, north-west key)');
    expect(texts.some((s) => s.includes('raster not rendered'))).toBe(false);
    expect(texts).toContain('1 / 2');
  }, 120_000);

  it('the legend says which contours carry labels', async () => {
    const all = { label: 'Custom', statement: 'You drive every setting.', analytical: true, cartographic: true, cartographicSmoothing: true, generalizeToleranceCells: 0.5, indexEvery: 5, labelsIndexOnly: false, hillshade: true, hypsometricTint: true, allowExploratory: true, completePackage: false, appendixRequired: false };
    const texts = (await drawn(input({ style: 'light', purpose: all }))).map((t) => t.text);
    expect(texts).toContain('Index contour');
    expect(texts).not.toContain('Index contour, labelled');
    expect(texts.some((s) => /^Contour interval .*, labelled$/.test(s))).toBe(true);
  }, 120_000);

  it('the purpose appendix page takes the sheet style and its own footer', async () => {
    const purpose = { label: 'Engineering Plan', statement: 'Plan contours.', analytical: true, cartographic: false, cartographicSmoothing: false, generalizeToleranceCells: 0, indexEvery: 5, labelsIndexOnly: true, hillshade: false, hypsometricTint: false, allowExploratory: false, completePackage: true, appendixRequired: true };
    const texts = (await drawn(input({ style: 'dark', purpose }))).map((t) => t.text);
    expect(texts).toContain('2 / 2');
    expect(texts).toContain('THIS DELIVERABLE');
    expect(texts).toContain('VALIDATION APPENDIX');
    vi.restoreAllMocks();
    const doc = await PDFDocument.load(await buildContourSheetPdf(input({ style: 'dark', purpose }), { loadFont }));
    expect(doc.getPageCount()).toBe(2);
    const fontsOf = (i: number): string[] => {
      const res = doc.getPage(i).node.Resources();
      const dict = res?.lookup(PDFName.of('Font'), PDFDict);
      return dict ? dict.keys().map((k) => String(dict.lookup(k, PDFDict).get(PDFName.of('BaseFont')))) : [];
    };
    const page2 = fontsOf(1);
    expect(page2.length).toBeGreaterThan(0);
    // Figtree for text and Courier, the sheet's figure face, for the page label: no Helvetica.
    expect(page2.some((n) => n.includes('Figtree'))).toBe(true);
    expect(page2.filter((n) => n.includes('Helvetica'))).toEqual([]);
  }, 120_000);
});

describe('relief model', () => {
  it('splits cells into outside, holes, filled and measured', () => {
    const state = classifyCells(relief);
    const count = (v: number): number => state.filter((s) => s === v).length;
    expect(count(CELL_OUTSIDE)).toBeGreaterThan(0);
    expect(count(CELL_HOLE)).toBeGreaterThan(0);
    expect(count(CELL_MEASURED)).toBeGreaterThan(count(CELL_FILLED));
    // A grid corner is outside the elliptical site.
    expect(state[0]).toBe(CELL_OUTSIDE);
  });

  it('no contour vertex lies outside the footprint', () => {
    const state = classifyCells({ ...relief, coverage: r.dtm.coverage });
    for (const f of r.model.features) {
      for (const [x, y] of f.coordinates) {
        const c = Math.min(relief.cols - 1, Math.floor((x - relief.originX) / relief.cellSize));
        const rr = Math.min(relief.rows - 1, Math.floor((y - relief.originY) / relief.cellSize));
        expect(state[rr * relief.cols + c]).not.toBe(CELL_OUTSIDE);
      }
    }
  });

  it('measures the shares, the relief and the spot heights on measured ground', () => {
    const rel = contourSheetRelief(relief);
    expect(rel.measuredCells + rel.filledCells).toBeGreaterThan(0);
    expect(rel.hasHoles).toBe(true);
    expect(rel.highest!.z).toBeLessThanOrEqual(rel.zMax);
    expect(rel.lowest!.z).toBeGreaterThanOrEqual(rel.zMin);
    expect(rel.histogram.reduce((a, b) => a + b, 0)).toBe(rel.measuredCells + rel.filledCells);
    expect(rel.outline.length).toBeGreaterThan(0);
    for (const ring of rel.outline) {
      for (const [x, y] of ring) {
        expect(x).toBeGreaterThanOrEqual(rel.extent!.minX - 1e-9);
        expect(x).toBeLessThanOrEqual(rel.extent!.maxX + 1e-9);
        expect(y).toBeGreaterThanOrEqual(rel.extent!.minY - 1e-9);
        expect(y).toBeLessThanOrEqual(rel.extent!.maxY + 1e-9);
      }
    }
  });

  it('the raster is transparent outside the footprint, hatched in holes and capped in size', () => {
    const rel = contourSheetRelief(relief);
    const e = rel.extent!;
    const ras = contourSheetRaster(relief, sheetTokens('light'), e, 300, 200);
    expect([ras.width, ras.height]).toEqual([300, 200]);
    // Top-left pixel is outside the ellipse.
    expect(ras.rgba[3]).toBe(0);
    const hatch = sheetTokens('light').hatch.map((v) => Math.round(v * 255));
    let hatchPx = 0;
    for (let i = 0; i < ras.rgba.length; i += 4) if (ras.rgba[i] === hatch[0] && ras.rgba[i + 1] === hatch[1] && ras.rgba[i + 2] === hatch[2]) hatchPx++;
    expect(hatchPx).toBeGreaterThan(0);
    const big = rasterSizeFor(5000, 3000);
    expect(Math.max(big.width, big.height)).toBe(MAX_RASTER_SIDE);
    expect(big.width / big.height).toBeCloseTo(5 / 3, 2);
  });

  it('simplifyRing keeps a ring within tolerance of the original', () => {
    const stairs: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++) stairs.push([i, i], [i + 1, i]);
    stairs.push([10, 10], [0, 10]);
    const s = simplifyRing(stairs, 0.75);
    expect(s.length).toBeLessThan(stairs.length);
    expect(s.length).toBeGreaterThanOrEqual(3);
  });

  it('contour strokes: index heavier, filled runs dashed, gaps dotted', () => {
    const t = sheetTokens('light');
    expect(styledContourStroke(t, true, 'measured').width).toBeGreaterThan(styledContourStroke(t, false, 'measured').width * 2);
    expect(styledContourStroke(t, false, 'measured').dash).toBeNull();
    expect(styledContourStroke(t, false, 'interpolated').dash).toEqual(t.filledDash);
    expect(styledContourStroke(t, false, 'gap').dash).not.toBeNull();
  });

  it('sparse measured ground reads clearly lighter than measured ground', () => {
    for (const style of ['light', 'dark'] as const) {
      const t = sheetTokens(style);
      const m = styledContourStroke(t, false, 'measured'), sp = styledContourStroke(t, false, 'sparse');
      expect(sp.dash).toBeNull();
      expect(sp.opacity).toBeLessThanOrEqual(0.5);
      expect(sp.width).toBeLessThanOrEqual(m.width * 0.75);
    }
  });
});

describe('styled SVG', () => {
  it('embeds the relief, outlines the footprint and keeps the Classic SVG unchanged without a style', async () => {
    const sheet = await buildSvgSheet('light', holedDtm());
    const styled = serializeContours(r.model, 'svg', { labels: r.labels, svgSheet: sheet }).content;
    expect(styled).toContain('<image ');
    expect(styled).toContain('data:image/png;base64,');
    expect(styled).toContain('data-layer="footprint"');
    expect(styled).toContain('data-layer="highest"');
    expect(styled).toContain('Contour over filled cells');
    const classic = serializeContours(r.model, 'svg', { labels: r.labels }).content;
    expect(classic).toBe(svgContours(r.model, { labels: r.labels, unitLabel: 'm' }));
    expect(classic).not.toContain('<image ');
    expect(await buildSvgSheet('classic', holedDtm())).toBeNull();
  });

  it('shifts the relief into the world frame with the contours', async () => {
    const sheet = await buildSvgSheet('dark', holedDtm());
    const local = serializeContours(r.model, 'svg', { svgSheet: sheet }).content;
    const world = serializeContours(r.model, 'svg', { svgSheet: sheet, worldOrigin: { x: 1000, y: 2000, z: 0 } }).content;
    const img = (s: string): string => /<image x="([^"]+)" y="([^"]+)"/.exec(s)!.slice(1).join(',');
    // Same placement on the sheet: the relief moved with the contours.
    expect(img(world)).toBe(img(local));
  });

  it('keeps the data off the frame, names the arrow and draws every legend swatch visibly', async () => {
    const sheet = await buildSvgSheet('dark', holedDtm());
    const svg = serializeContours(r.model, 'svg', { labels: r.labels, svgSheet: sheet }).content;
    const frame = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="none"/.exec(svg)!.slice(1).map(Number);
    const [img] = /<image x="([\d.]+)"/.exec(svg)!.slice(1).map(Number);
    expect(img! - frame[0]!).toBeGreaterThanOrEqual(10);
    expect(svg).toContain('>Grid N</text>');
    expect(svg).not.toContain('>N</text>');
    const legendWidths = [...svg.matchAll(/<line [^>]*stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(legendWidths.length).toBeGreaterThan(0);
    expect(Math.min(...legendWidths)).toBeGreaterThanOrEqual(1.2);
  });
});
