/**
 * profileSheet.test.ts — the profile PDF as a drawing sheet: does the stated
 * exaggeration match the drawing, does anything overprint anything else, and
 * do the station band's columns land where the section put its curve.
 *
 * These assert against the drawn page rather than against the layout helpers
 * alone. A helper that computes the right offset while the builder draws at a
 * hardcoded one is exactly the defect being pinned, so the offsets are read
 * back out of the page content stream and checked against the fonts' own
 * metrics.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { buildProfilePdf } from '../src/render/measure/profilePdf';
import { buildStationBand } from '../src/render/measure/profileSheetLayout';
import type { ProfileChartSample } from '../src/render/measure/types';

/** Fixed, injected. The builder never reads the clock. */
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

/**
 * A long, gently rolling section: 900 m of chainage over 181 stations with
 * ~35 m of relief. Long and shallow on purpose — the horizontal and vertical
 * scales come out an order of magnitude apart, so the two orderings of the
 * exaggeration are 10:1 and 0.1:1 and cannot be confused for one another.
 */
function rollingSection(): ProfileChartSample[] {
  const out: ProfileChartSample[] = [];
  for (let i = 0; i <= 180; i++) {
    const d = i * 5;
    out.push({ distance: d, height: 180 + Math.sin(d / 140) * 18 + d * 0.012 });
  }
  return out;
}

/** Every content stream, inflated, one entry per stream. */
function streamsOf(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const out: string[] = [];
  let idx = 0;
  for (;;) {
    const s = buf.indexOf('stream', idx);
    if (s === -1) break;
    let ds = s + 'stream'.length;
    if (buf[ds] === 0x0d) ds++;
    if (buf[ds] === 0x0a) ds++;
    const e = buf.indexOf('endstream', ds);
    if (e === -1) break;
    try {
      out.push(inflateSync(buf.subarray(ds, e)).toString('latin1'));
    } catch {
      out.push(buf.subarray(ds, e).toString('latin1'));
    }
    idx = e + 'endstream'.length;
  }
  return out;
}

/** One drawn string, with where and how it was drawn. */
interface Drawn {
  readonly base: string;
  readonly size: number;
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

const DRAW_RE =
  /\/([A-Za-z-]+)-\d+ ([\d.]+) Tf[\s\S]{0,40}?1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]+)> Tj/g;

function drawnIn(stream: string): Drawn[] {
  const out: Drawn[] = [];
  for (const m of stream.matchAll(DRAW_RE)) {
    out.push({
      base: m[1],
      size: Number(m[2]),
      x: Number(m[3]),
      y: Number(m[4]),
      text: Buffer.from(m[5], 'hex').toString('latin1'),
    });
  }
  return out;
}

/** The sheet's first page: the one carrying the title. */
function sheetPage(bytes: Uint8Array): { stream: string; drawn: Drawn[] } {
  for (const stream of streamsOf(bytes)) {
    const drawn = drawnIn(stream);
    if (drawn.some((d) => d.text === 'Terrain Profile')) return { stream, drawn };
  }
  throw new Error('no page carrying the sheet title');
}

/** All drawn text on every page, joined, for a wording assertion. */
function allProse(bytes: Uint8Array): string {
  return streamsOf(bytes)
    .flatMap((s) => drawnIn(s).map((d) => d.text))
    .join(' ');
}

/** One stroked straight segment, with the pen it was drawn with. */
interface Segment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  readonly stroke: string;
}

/**
 * The stroked segments of a page.
 *
 * pdf-lib wraps each line in its own q/Q block and restates the stroke colour
 * and width inside it, so a segment carries its own pen and can be told apart
 * from the grid rules around it.
 */
function segmentsIn(stream: string): Segment[] {
  const out: Segment[] = [];
  const re =
    /((?:-?[\d.]+ ){3})RG\s+([\d.]+) w\s+\[\] 0 d\s+(-?[\d.]+) (-?[\d.]+) m\s+-?[\d.]+ -?[\d.]+ m\s+(-?[\d.]+) (-?[\d.]+) l/g;
  for (const m of stream.matchAll(re)) {
    out.push({
      stroke: m[1].trim(),
      width: Number(m[2]),
      x1: Number(m[3]),
      y1: Number(m[4]),
      x2: Number(m[5]),
      y2: Number(m[6]),
    });
  }
  return out;
}

/**
 * The plot frame, recovered from the page: the 1pt axis-ink box around the
 * section. Recovering the mapping from the drawing rather than restating the
 * builder's constants is the point - a test that hardcodes the plot box would
 * still pass if the band and the plot moved apart together.
 */
function plotBoxIn(stream: string): { left: number; right: number; bottom: number } {
  const frame = segmentsIn(stream).filter(
    (g) => g.width === 1 && g.stroke === '0.42 0.46 0.52' && g.y1 === g.y2,
  );
  if (frame.length < 2) throw new Error('no plot frame on the page');
  const bottom = Math.min(...frame.map((g) => g.y1));
  const edge = frame.find((g) => g.y1 === bottom) as Segment;
  return {
    left: Math.min(edge.x1, edge.x2),
    right: Math.max(edge.x1, edge.x2),
    bottom,
  };
}

/**
 * The Info-dictionary dates, as the file carries them.
 *
 * They live in a compressed object stream, so a byte grep over the file never
 * sees them - and a clock-defaulted stamp only breaks byte identity when the
 * two builds fall either side of a second boundary, which is a coin toss
 * rather than a test. Reading the date back pins it either way.
 */
function infoDatesOf(bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (const stream of streamsOf(bytes)) {
    for (const m of stream.matchAll(/\/(?:Creation|Mod)Date \(([^)]*)\)/g)) out.push(m[1]);
  }
  return out;
}

/** The standard fonts, measured exactly as the builder measures them. */
async function fonts(): Promise<{ regular: PDFFont; bold: PDFFont; mono: PDFFont }> {
  const doc = await PDFDocument.create();
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
}

/** Metric civil stationing back to metres: `0+275.00` is 275 m. */
function stationToMetres(label: string): number | null {
  const m = /^(\d+)\+([\d.]+)$/.exec(label);
  return m == null ? null : Number(m[1]) * 1000 + Number(m[2]);
}

describe('profile sheet: vertical exaggeration', () => {
  it('states the exaggeration as horizontal over vertical, not its reciprocal', async () => {
    const bytes = await buildProfilePdf({
      name: 'Exaggeration',
      samples: rollingSection(),
      generatedAt: FIXED_DATE,
    });
    const line = sheetPage(bytes).drawn.find((d) => d.text.startsWith('Horizontal 1:'));
    expect(line).toBeDefined();
    const m = /Horizontal 1:(\d+).+Vertical 1:(\d+).+Vertical exaggeration ([\d.]+):1/.exec(
      line!.text,
    );
    expect(m).not.toBeNull();
    const h = Number(m![1]);
    const v = Number(m![2]);
    const stated = Number(m![3]);

    // A 1:N scale states a DENOMINATOR: the smaller denominator is the larger
    // drawing. This section is long and shallow, so the vertical denominator
    // is much the smaller of the two and the relief is drawn stretched.
    expect(v).toBeLessThan(h);
    expect(stated).toBeCloseTo(h / v, 1);
    // The reciprocal is what the sheet used to print. Naming it here keeps the
    // failure legible if the ordering is ever flipped back.
    expect(stated).not.toBeCloseTo(v / h, 1);
    expect(stated).toBeGreaterThan(1);
  });
});

describe('profile sheet: no overprinting in the summary', () => {
  it('draws every value clear of the right edge of its own label', async () => {
    const { regular, bold } = await fonts();
    // No declared datum, so the height headings take their longest form -
    // the case a fixed label-width offset gets wrong.
    const bytes = await buildProfilePdf({
      name: 'Overprint',
      samples: rollingSection(),
      crs: 'EPSG:32613',
      verticalDatum: null,
      generatedAt: FIXED_DATE,
    });
    const drawn = sheetPage(bytes).drawn;

    // The summary is the block set at 8.5pt: labels bold, values regular.
    const labels = drawn.filter((d) => d.size === 8.5 && d.base === 'Helvetica-Bold');
    const values = drawn.filter((d) => d.size === 8.5 && d.base === 'Helvetica');
    expect(labels.length).toBeGreaterThan(10);

    for (const label of labels) {
      const right = label.x + bold.widthOfTextAtSize(label.text, label.size);
      // The value on the same baseline, to the right of this label. Two-column
      // rows put another label further right; the value is the nearest one.
      const value = values
        .filter((v) => Math.abs(v.y - label.y) < 0.01 && v.x > label.x)
        .sort((a, b) => a.x - b.x)[0];
      expect(value, `no value drawn for "${label.text}"`).toBeDefined();
      expect(
        right,
        `"${label.text}" ends at ${right.toFixed(1)} but its value starts at ${value.x.toFixed(1)}`,
      ).toBeLessThanOrEqual(value.x);
      // And the value must not run off its own page either.
      expect(value.x + regular.widthOfTextAtSize(value.text, value.size)).toBeLessThanOrEqual(
        792 - 18,
      );
    }
  });
});

describe('profile sheet: station data band', () => {
  it('places each column at the plot mapping for its own chainage', async () => {
    const { mono } = await fonts();
    const bytes = await buildProfilePdf({
      name: 'Band',
      samples: rollingSection(),
      generatedAt: FIXED_DATE,
    });
    const { stream, drawn } = sheetPage(bytes);

    // The mapping is recovered from the drawing itself rather than assumed.
    const plot = plotBoxIn(stream);

    // Length, as the summary prints it, is the mapping's domain.
    const lengthRow = drawn.find((d) => /^\d+\.\d+ m$/.test(d.text) && d.size === 8.5);
    expect(lengthRow).toBeDefined();
    const length = 900;
    expect(Number(lengthRow!.text.replace(' m', ''))).toBeCloseTo(length, 2);

    // The band's chainage cells: Courier, drawn centred on the column.
    const cells = drawn
      .filter((d) => d.base === 'Courier' && stationToMetres(d.text) != null)
      .map((d) => ({
        chainage: stationToMetres(d.text) as number,
        centre: d.x + mono.widthOfTextAtSize(d.text, d.size) / 2,
      }));
    expect(cells.length).toBeGreaterThan(4);

    for (const c of cells) {
      const expected = plot.left + (c.chainage / length) * (plot.right - plot.left);
      expect(
        c.centre,
        `column for chainage ${c.chainage} is at ${c.centre.toFixed(3)}, plot maps it to ${expected.toFixed(3)}`,
      ).toBeCloseTo(expected, 2);
    }
  });

  it('thins dense stations and says how many it is showing', async () => {
    const bytes = await buildProfilePdf({
      name: 'Band thinning',
      samples: rollingSection(),
      generatedAt: FIXED_DATE,
    });
    const caption = sheetPage(bytes).drawn.find((d) => d.text.startsWith('Station data band'));
    expect(caption).toBeDefined();
    const m = /Station data band - (\d+) of (\d+) stations shown/.exec(caption!.text);
    expect(m).not.toBeNull();
    const shown = Number(m![1]);
    const total = Number(m![2]);
    expect(total).toBe(181);
    expect(shown).toBeGreaterThan(2);
    expect(shown).toBeLessThan(total);
  });

  it('takes its column x straight from the mapping it is given', () => {
    const stations = [0, 10, 20, 30, 40, 50].map((chainage) => ({ chainage, height: 5 }));
    const mapX = (c: number) => 100 + c * 4;
    const band = buildStationBand({
      stations,
      mapX,
      plotLeft: 100,
      plotW: 200,
      widest: () => 'XXXX',
      measure: () => 20,
      fontSize: 6,
    });
    expect(band.total).toBe(6);
    expect(band.shown).toBeGreaterThan(0);
    for (const c of band.columns) expect(c.x).toBe(mapX(c.chainage));
    // Columns keep the input order, and each partial is the run from the
    // previous SHOWN column, so the partials sum to the last chainage.
    const chainages = band.columns.map((c) => c.chainage);
    expect([...chainages].sort((a, b) => a - b)).toEqual(chainages);
    const summed = band.columns.reduce((acc, c) => acc + (c.partial ?? 0), chainages[0]);
    expect(summed).toBeCloseTo(chainages[chainages.length - 1], 9);
  });
});

describe('profile sheet: height wording', () => {
  it('never prints "Elevation" for a scan with no declared datum', async () => {
    const bytes = await buildProfilePdf({
      name: 'No datum',
      samples: rollingSection(),
      crs: 'EPSG:32613',
      verticalDatum: null,
      generatedAt: FIXED_DATE,
    });
    const prose = allProse(bytes);
    expect(prose).toContain('Height (datum unknown)');
    expect(prose).not.toContain('Elevation');
    expect(prose).not.toContain('ELEV');
  });
});

describe('profile sheet: determinism', () => {
  it('is byte-identical across two builds of the same input', async () => {
    const input = {
      name: 'Deterministic',
      samples: rollingSection(),
      crs: 'EPSG:32613',
      corridorWidthM: 4,
      groundPercentile: 15,
      generatedAt: FIXED_DATE,
    } as const;
    const a = await buildProfilePdf(input);
    const b = await buildProfilePdf(input);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);

    // Both Info dates come from the caller's own timestamp. Asserted directly
    // because two builds a millisecond apart share a second, so byte identity
    // alone would pass a clock-defaulted stamp most of the time.
    const dates = infoDatesOf(a);
    expect(dates.length).toBeGreaterThanOrEqual(2);
    for (const d of dates) expect(d).toBe('D:20260101000000Z');
  });
});
