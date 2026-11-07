/**
 * watershedMapPage.test.ts: the site and catchment maps outline every studied
 * catchment, list each stream order in the legend, label coordinates as local
 * when the CRS is unknown, keep the map inside its frame on an anisotropic
 * grid and draw no text off the page.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { embedReportFonts, type ReportFonts } from '../src/export/watershedReport/reportFonts';
import { newPage } from '../src/export/watershedReport/pageKit';
import { drawMapPage, smoothLine, STUDIED_OUTLINE_WIDTH } from '../src/export/watershedReport/mapPage';
import { t } from '../src/simulation/flowPulse/watershed/watershedStrings';
import { buildValley, type Valley } from './support/watershedValley';
import { encodeStoredPng } from './support/storedPng';
import { spyPdf, type PdfSpy } from './support/pdfSpy';

const FONT_DIR = join(process.cwd(), 'src', 'export', 'watershedReport', 'fonts');
const fromDisk = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(FONT_DIR, name)));

async function render(v: Valley, focus: boolean): Promise<{ s: PdfSpy; doc: PDFDocument; bytes: () => Promise<Uint8Array> }> {
  const doc = await PDFDocument.create();
  const fonts: ReportFonts = await embedReportFonts(doc, fromDisk);
  const s = spyPdf(doc);
  const c = newPage(doc, 'letter', { id: '03', section: 'Site map', pageNo: 3 }, fonts, 'Valley test site');
  const m = v.model;
  await drawMapPage(c, doc, m, {
    partition: focus ? undefined : m.partition,
    sections: m.sections,
    network: m.network,
    focus: focus ? m.sections[0] : undefined,
    grid: v.result.grid,
    coverage: v.dtm.coverage,
    filled: v.result.filled,
  }, fonts, encodeStoredPng);
  const fixed = new Date('2026-10-25T12:00:00Z');
  doc.setCreationDate(fixed);
  doc.setModificationDate(fixed);
  return { s, doc, bytes: () => doc.save({ useObjectStreams: false }) };
}

function noTextOffPage(s: PdfSpy) {
  for (const x of s.texts) {
    const { width, height } = x.page.getSize();
    expect(x.x, x.text).toBeGreaterThanOrEqual(0);
    expect(x.y, x.text).toBeGreaterThanOrEqual(0);
    expect(x.x + (x.rotated ? x.size : x.width), x.text).toBeLessThanOrEqual(width);
    expect(x.y + (x.rotated ? x.width : x.size), x.text).toBeLessThanOrEqual(height);
  }
}

let valley: Valley;
beforeAll(() => { valley = buildValley(); });

describe('drawMapPage', () => {
  it('draws every catchment outline and the legend lists each order present', async () => {
    const { s } = await render(valley, false);
    const drawable = valley.model.sections.filter((x) => !x.divide.degenerate);
    expect(drawable.length).toBe(2);
    expect(s.paths.filter((p) => p.borderWidth === STUDIED_OUTLINE_WIDTH)).toHaveLength(drawable.length);
    const texts = s.texts.map((x) => x.text);
    for (const sec of drawable) expect(texts).toContain(sec.label);
    const orders = [...new Set(valley.model.network.segments.map((g) => g.order))];
    expect(orders.length).toBeGreaterThan(1);
    for (const o of orders) expect(texts).toContain(t('en', 'map.legend.order', { order: o }));
    noTextOffPage(s);
  });

  it('labels coordinates as local when the CRS is unknown', async () => {
    const { s } = await render(valley, false);
    const all = s.texts.map((x) => x.text).join(' ');
    expect(all).toContain(t('en', 'map.coords.local'));
    expect(all).toContain(t('en', 'map.north.local'));
    noTextOffPage(s);
    const named = buildValley({ crsName: 'WGS 84 / UTM zone 14N', language: 'es' });
    const r = await render(named, false);
    const es = r.s.texts.map((x) => x.text).join(' ');
    expect(es).toContain(t('es', 'map.coords.grid', { crs: 'WGS 84 / UTM zone 14N' }));
    expect(es).not.toContain(t('es', 'map.coords.local'));
  });

  it('draws the map inside the frame for a non-square anisotropic grid', async () => {
    const v = buildValley({ scale: { isGeographic: true, latitudeDeg: 60, unitToMetres: 1, resolved: true }, cellSizeM: 3 / 111_000 });
    const g = v.result.grid;
    expect(Math.abs(g.cellMetresX / g.cellMetresY - 1)).toBeGreaterThan(0.3);
    const { s } = await render(v, false);
    expect(s.images).toHaveLength(1);
    const img = s.images[0]!;
    const groundAspect = (g.cols * g.cellMetresX) / (g.rows * g.cellMetresY);
    expect(img.width / img.height).toBeCloseTo(groundAspect, 1);
    const { width } = img.page.getSize();
    expect(img.x).toBeGreaterThanOrEqual(60);
    expect(img.x + img.width).toBeLessThanOrEqual(width - 30);
    noTextOffPage(s);
  });

  it('keeps the main channel inside its catchment, as cells and as drawn', () => {
    const g = valley.result.grid;
    for (const sec of valley.model.sections) {
      for (const i of sec.channel.cells) expect(sec.mask[i], `${sec.label} cell ${i}`).toBe(1);
      // The smoothed divide still encloses every channel cell centre.
      const raw: [number, number][] = [];
      for (let k = 0; k + 1 < sec.divide.outer.length; k += 2) raw.push([sec.divide.outer[k]!, sec.divide.outer[k + 1]!]);
      const ring = smoothLine(raw, true, Math.min(g.cellMetresX, g.cellMetresY));
      const inside = (x: number, y: number) => {
        let ins = false;
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const [xi, yi] = ring[a]!, [xj, yj] = ring[b]!;
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
        }
        return ins;
      };
      for (const i of sec.channel.cells) {
        const x = ((i % g.cols) + 0.5) * g.cellMetresX, y = (Math.floor(i / g.cols) + 0.5) * g.cellMetresY;
        expect(inside(x, y), `${sec.label} cell ${i}`).toBe(true);
      }
    }
  });

  it('smooths a long simplified edge without cutting its corners', () => {
    const square: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    const out = smoothLine(square, true, 1);
    const maxDev = Math.max(...out.map(([x, y]) => Math.min(Math.abs(x), Math.abs(100 - x), Math.abs(y), Math.abs(100 - y))));
    expect(maxDev).toBeLessThan(0.5);
  });

  it('gives byte-identical output for the same input', async () => {
    const a = await (await render(valley, false)).bytes();
    const b = await (await render(valley, false)).bytes();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
