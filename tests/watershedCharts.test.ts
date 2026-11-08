/**
 * watershedCharts.test.ts: the hypsometric curve labels its integral and the
 * channel profile states its vertical exaggeration and dashes each
 * interpolated stretch, all inside the box it is given.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { embedReportFonts, type ReportFonts } from '../src/export/watershedReport/reportFonts';
import { drawChannelProfile, drawHypsometricCurve, PROFILE_INTERPOLATED_DASH } from '../src/export/watershedReport/charts';
import type { Box } from '../src/export/watershedReport/pageKit';
import type { MainChannel } from '../src/simulation/flowPulse/watershed/mainChannel';
import { formatNumber } from '../src/simulation/flowPulse/watershed/watershedStrings';
import { spyPdf, type PdfSpy } from './support/pdfSpy';

const FONT_DIR = join(process.cwd(), 'src', 'export', 'watershedReport', 'fonts');
const fromDisk = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(FONT_DIR, name)));

let doc: PDFDocument;
let fonts: ReportFonts;
beforeAll(async () => {
  doc = await PDFDocument.create();
  fonts = await embedReportFonts(doc, fromDisk);
});

const BOX: Box = { x: 70, y: 300, width: 240, height: 160 };

function fresh(): PdfSpy {
  const s = spyPdf();
  s.wrap(doc.addPage([612, 792]));
  return s;
}
const pageOf = (_s: PdfSpy) => doc.getPage(doc.getPageCount() - 1);

function inside(s: PdfSpy, box: Box) {
  for (const t of s.texts) {
    if (t.rotated) {
      expect(t.x, t.text).toBeGreaterThanOrEqual(box.x - 0.01);
      expect(t.y + t.width, t.text).toBeLessThanOrEqual(box.y + box.height + 0.01);
    } else {
      expect(t.x, t.text).toBeGreaterThanOrEqual(box.x - 0.01);
      expect(t.x + t.width, t.text).toBeLessThanOrEqual(box.x + box.width + 0.01);
    }
    expect(t.y, t.text).toBeGreaterThanOrEqual(box.y - 0.01);
    expect(t.y + t.size * 0.8, t.text).toBeLessThanOrEqual(box.y + box.height + 0.01);
  }
}

function channel(interp: number[]): MainChannel {
  const n = interp.length;
  const distanceM = Float64Array.from({ length: n }, (_, i) => i * 10);
  const elevationM = Float64Array.from({ length: n }, (_, i) => (n - 1 - i) * 0.6 + Math.sin(i) * 0.2);
  return {
    cells: Int32Array.from({ length: n }, (_, i) => i),
    lengthM: { value: (n - 1) * 10 },
    profile: { distanceM, elevationM, interpolated: Uint8Array.from(interp) },
    slope1085: { value: 0.058 },
    slopeTaylorSchwarz: { value: 0.055 },
    reachSlopes: [{ fromM: 0, toM: 100, slope: 0.07 }, { fromM: 100, toM: 200, slope: 0.05 }, { fromM: 200, toM: 300, slope: 0.04 }],
    d8LengthBiasMax: 0.082,
  };
}

describe('drawHypsometricCurve', () => {
  it('curve labels the hypsometric integral', () => {
    const s = fresh();
    const relArea = Float64Array.from({ length: 21 }, (_, k) => 1 - (k / 20) ** 0.7);
    const relHeight = Float64Array.from({ length: 21 }, (_, k) => k / 20);
    drawHypsometricCurve(pageOf(s), BOX, { value: { relArea, relHeight, integral: 0.4372 } }, 'es', fonts);
    const all = s.texts.map((t) => t.text).join(' ');
    expect(all).toContain(`IH = ${formatNumber('es', 0.4372, 2)}`);
    expect(all).toContain('Curva hipsométrica');
    // the curve closes at (0, 1): its path runs to the top-left of the plot
    expect(s.paths.length).toBeGreaterThan(0);
    inside(s, BOX);
  });

  it('says why when the curve is withheld', () => {
    const s = fresh();
    drawHypsometricCurve(pageOf(s), BOX, { withheld: 'vertical-unresolved' }, 'en', fonts);
    expect(s.texts.map((t) => t.text).join(' ')).toMatch(/Not drawn/);
    inside(s, BOX);
  });
});

describe('drawChannelProfile', () => {
  it('profile states the vertical exaggeration and dashes interpolated stretches', () => {
    const s = fresh();
    // three interpolated runs: one at the divide end, one in the middle, one single cell
    const interp = [1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    drawChannelProfile(pageOf(s), BOX, channel(interp), 'en', fonts);
    const all = s.texts.map((t) => t.text).join(' ');
    expect(all).toMatch(/vertical exaggeration [\d.,]+×/);
    const dashed = s.paths.filter((p) => JSON.stringify(p.dash) === JSON.stringify(PROFILE_INTERPOLATED_DASH));
    expect(dashed).toHaveLength(3);
    inside(s, BOX);
  });

  it('draws no dashed stretch over fully measured ground', () => {
    const s = fresh();
    drawChannelProfile(pageOf(s), BOX, channel(new Array(12).fill(0)), 'es', fonts);
    expect(s.paths.filter((p) => JSON.stringify(p.dash) === JSON.stringify(PROFILE_INTERPOLATED_DASH))).toHaveLength(0);
    expect(s.texts.map((t) => t.text).join(' ')).toMatch(/exageración vertical/);
    inside(s, BOX);
  });
});
