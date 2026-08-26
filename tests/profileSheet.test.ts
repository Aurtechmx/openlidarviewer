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

/**
 * Every drawn string in the file, whatever text matrix drew it.
 *
 * `drawnIn` only matches the upright `1 0 0 1 x y Tm` form, so a rotated
 * string - the height-axis title reads up the left edge of the plot - is
 * invisible to it. The axis title is exactly where a claim about what the
 * figures beside it mean would do the most damage, so the wording assertions
 * read the raw strings instead.
 */
function rawProse(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const stream of streamsOf(bytes)) {
    for (const m of stream.matchAll(/<([0-9A-Fa-f]+)> Tj/g)) {
      parts.push(Buffer.from(m[1], 'hex').toString('latin1'));
    }
  }
  return parts.join(' ');
}

/** One drawn string with the fill colour it was painted in. */
interface Painted {
  readonly fill: string;
  readonly base: string;
  readonly size: number;
  readonly text: string;
}

/**
 * The drawn strings of a page with their fill colour.
 *
 * pdf-lib restates the fill inside each text block, right before the font, so
 * a cell carries the colour it was actually painted in rather than whatever
 * the graphics state happened to hold.
 */
const PAINT_RE =
  /((?:[\d.]+ ){3})rg\s*\/([A-Za-z-]+)-\d+ ([\d.]+) Tf[\s\S]{0,80}?<([0-9A-Fa-f]+)> Tj/g;

function paintedIn(stream: string): Painted[] {
  const out: Painted[] = [];
  for (const m of stream.matchAll(PAINT_RE)) {
    out.push({
      fill: m[1].trim(),
      base: m[2],
      size: Number(m[3]),
      text: Buffer.from(m[4], 'hex').toString('latin1'),
    });
  }
  return out;
}

/** Every page content stream, in page order. */
function pageStreams(bytes: Uint8Array): string[] {
  return streamsOf(bytes).filter((s) => s.includes(' Tj'));
}

/** The page carrying a given untracked title string. */
function pageWith(bytes: Uint8Array, title: string): { stream: string; drawn: Drawn[] } {
  for (const stream of pageStreams(bytes)) {
    const drawn = drawnIn(stream);
    if (drawn.some((d) => d.text === title)) return { stream, drawn };
  }
  throw new Error(`no page carrying "${title}"`);
}

/** The gap colour, as `GAP_MARK` is declared in the builder. */
const GAP_FILL = '0.72 0.31 0.02';

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

/**
 * A type size the builder declares, read from its source.
 *
 * Restating a size here is how a raised type scale quietly empties a filter
 * and passes the test on an empty set. Reading it means the scale can move
 * and these cases keep pointing at the same text.
 */
function sizeOf(name: string): number {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const src = readFileSync(
    new URL('../src/render/measure/profilePdf.ts', import.meta.url),
    'utf8',
  );
  const m = new RegExp(`const ${name} = ([0-9.]+);`).exec(src);
  if (m == null) throw new Error(`profilePdf declares no ${name}`);
  return Number(m[1]);
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

describe('profile sheet: no overprinting in the notes table', () => {
  it('keeps every cell inside its own ruled column', async () => {
    const { regular, bold } = await fonts();
    // No declared datum, so the height headings take their longest form -
    // the case a column sized for a short heading gets wrong.
    const bytes = await buildProfilePdf({
      name: 'Overprint',
      samples: rollingSection(),
      crs: 'EPSG:32613',
      verticalDatum: null,
      generatedAt: FIXED_DATE,
    });
    const drawn = pageWith(bytes, 'Technical notes').drawn;

    // The three column origins the builder lays the table out on. Recovered
    // from the drawing by clustering the x of the body cells rather than
    // restated, so a column that moved without its neighbour is still caught.
    // The table only: the sheet furniture below it (general notes, title
    // block, issue strip) is set at the same sizes and has its own columns.
    // Sizes are read from the builder rather than restated: a type-scale
    // change should not silently empty this filter and pass the test on an
    // empty set, which is what happened when the scale was last raised.
    const bodySizes = new Set([sizeOf('T_TABLE'), sizeOf('T_REMARK')]);
    const body = drawn.filter((d) => bodySizes.has(d.size) && d.y > 260);
    expect(body.length).toBeGreaterThan(30);
    const origins = [...new Set(body.map((d) => Math.round(d.x)))]
      .sort((a, b) => a - b)
      .filter((x, i, all) => i === 0 || x - all[i - 1] > 40);
    expect(origins).toHaveLength(3);

    for (const cell of body) {
      const col = origins.findIndex((x) => Math.abs(x - cell.x) < 1);
      if (col === -1) continue;
      const face = cell.base === 'Helvetica-Bold' ? bold : regular;
      const right = cell.x + face.widthOfTextAtSize(cell.text, cell.size);
      // The next column's origin, or the right margin for the last column.
      const limit = col + 1 < origins.length ? origins[col + 1] : 1190.55 - 48;
      expect(
        right,
        `"${cell.text}" runs from ${cell.x.toFixed(1)} to ${right.toFixed(1)}, ` +
          `past the column boundary at ${limit.toFixed(1)}`,
      ).toBeLessThanOrEqual(limit);
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

    // Length, as the KPI band prints it, is the mapping's domain.
    const lengthCell = drawn.find((d) => d.base === 'Helvetica-Bold' && /^\d+\.\d+$/.test(d.text));
    expect(lengthCell).toBeDefined();
    const length = 900;
    expect(Number(lengthCell!.text)).toBeCloseTo(length, 2);

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

    // The rotated height-axis title too. It is drawn with a rotation matrix,
    // so the upright scan above cannot see it, and it is the one label on the
    // sheet a reader takes the meaning of every plotted figure from.
    const raw = rawProse(bytes);
    expect(raw).toContain('Height (datum unknown) (m)');
    expect(raw).not.toContain('Elevation');
    expect(raw).not.toContain('ELEV');
  });
});

describe('profile sheet: the title block', () => {
  /**
   * A set that says 1 of 3 while emitting four sheets has lost a sheet and
   * the reader has no way to know. The total is read back off every sheet and
   * checked against the page count the document actually reached.
   */
  it('numbers every sheet against the page count actually emitted', async () => {
    const bytes = await buildProfilePdf({
      name: 'Sheet numbering',
      samples: rollingSection(),
      crs: 'EPSG:32613',
      generatedAt: FIXED_DATE,
    });
    const total = (await PDFDocument.load(bytes)).getPageCount();
    expect(total).toBeGreaterThan(3);

    const streams = pageStreams(bytes);
    expect(streams).toHaveLength(total);
    streams.forEach((stream, i) => {
      const numbers = drawnIn(stream)
        .map((d) => d.text)
        .filter((t) => /^\d+ \/ \d+$/.test(t));
      expect(numbers, `sheet ${i + 1} states ${numbers.join(', ')}`).toEqual([
        `${i + 1} / ${total}`,
      ]);
    });
  });

  /**
   * The issue strip is a form, not data. A DATE filled from the clock would
   * both break the byte reproducibility the rest of this builder is built
   * around and record an issue nobody made.
   */
  it('leaves the issue strip DATE column empty', async () => {
    const bytes = await buildProfilePdf({
      name: 'Issue strip',
      samples: rollingSection(),
      generatedAt: FIXED_DATE,
    });
    for (const stream of pageStreams(bytes)) {
      const drawn = drawnIn(stream);
      const head = drawn.find((d) => d.text === 'DATE');
      expect(head, 'no DATE column header on a sheet').toBeDefined();
      // Everything drawn in that column, below its own header baseline.
      const inColumn = drawn.filter(
        (d) => d.y < head!.y - 1 && d.x >= head!.x - 8 && d.x < head!.x + 100,
      );
      expect(inColumn.map((d) => d.text)).toEqual([]);
    }
  });
});

describe('profile sheet: the gap colour', () => {
  /**
   * The one place a second colour is spent: a cell that says a station
   * returned nothing. A reader scanning a schedule of 181 rows finds the
   * holes at a glance. The word carries the same fact, so the sheet survives
   * a mono printer, which is why this asserts the word AND the colour.
   */
  it('paints gap cells in the gap colour and ordinary heights in the ink', async () => {
    const gapped: ProfileChartSample[] = [];
    for (let i = 0; i <= 12; i++) {
      gapped.push({ distance: i * 10, height: i === 4 || i === 9 ? Number.NaN : 100 + i });
    }
    const bytes = await buildProfilePdf({
      name: 'Gap colour',
      samples: gapped,
      generatedAt: FIXED_DATE,
    });
    const cells = pageStreams(bytes).flatMap((stream) => paintedIn(stream));
    const gaps = cells.filter((c) => c.text === 'gap');
    // Two gaps, each printed on the profile sheet's band and on the schedule.
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (const g of gaps) expect(g.fill).toBe(GAP_FILL);

    // And nothing else on the sheet wears it. A schedule that painted every
    // cell would look exactly as deliberate and mean nothing.
    const wearingIt = cells.filter((c) => c.fill === GAP_FILL).map((c) => c.text);
    expect([...new Set(wearingIt)]).toEqual(['gap']);
    // The heights that DID return are set in the ordinary ink.
    const heights = cells.filter(
      (c) => c.base.startsWith('Courier') && /^1\d\d\.\d\d$/.test(c.text),
    );
    expect(heights.length).toBeGreaterThan(4);
    for (const h of heights) expect(h.fill).not.toBe(GAP_FILL);
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

describe('profile sheet: typographic hierarchy and the readable floor', () => {
  /**
   * The critique this design answers was that the sheet set nearly everything
   * at one size in one weight, so a reader scanning it found no entry point,
   * and then bought its hierarchy by shrinking the lower half until the
   * schedule was unreadable. Both halves are pinned here: a real ratio
   * between the KPI figures and the table body, AND a floor nothing on any
   * sheet may go under.
   */
  it('sets the KPI figures well above the table body', async () => {
    const bytes = await buildProfilePdf({
      name: 'Hierarchy',
      samples: rollingSection(),
      crs: 'EPSG:32613',
      generatedAt: FIXED_DATE,
    });
    const { stream, drawn } = pageWith(bytes, 'Terrain Profile');
    const floor = plotBoxIn(stream).bottom;

    // The KPI band: eight ruled cells, each a bold figure, between the plot's
    // floor and the sheet furniture. Nothing else in that strip is set bold
    // at that size - the sheet title above it is larger and is not a figure.
    const strip = drawn.filter((d) => d.base === 'Helvetica-Bold' && d.y > 260 && d.y < floor);
    const biggestBold = Math.max(...strip.map((d) => d.size));
    const kpi = strip.filter((d) => d.size === biggestBold);
    expect(kpi).toHaveLength(8);
    expect(biggestBold).toBeGreaterThanOrEqual(16);

    // Against the body of the notes table, which is the smallest thing on the
    // set that is still a measurement rather than a caption.
    const bodySize = Math.max(
      ...pageWith(bytes, 'Technical notes')
        .drawn.filter((d) => d.text === 'Length (horizontal)')
        .map((d) => d.size),
    );
    expect(bodySize).toBeGreaterThanOrEqual(8);
    expect(biggestBold / bodySize).toBeGreaterThanOrEqual(1.7);
  });

  /**
   * Drawings get printed, and a figure a reader has to lean in for is a
   * figure they read wrong. Nothing on any sheet goes under 6.5pt (which is
   * reserved for the tracked title-block field labels), and nothing that
   * carries a measurement - every monospaced figure on the set - goes under
   * 8pt.
   */
  it('sets nothing below the readable floor', async () => {
    const bytes = await buildProfilePdf({
      name: 'Readable floor',
      samples: rollingSection(),
      crs: 'EPSG:32613',
      generatedAt: FIXED_DATE,
      verticalDatum: 'NAVD88',
    });
    const drawn = pageStreams(bytes).flatMap((stream) => drawnIn(stream));
    expect(drawn.length).toBeGreaterThan(200);
    for (const d of drawn) {
      expect(d.size, `"${d.text}" is set at ${d.size}pt`).toBeGreaterThanOrEqual(6.5);
      if (d.base === 'Courier') {
        expect(d.size, `tabular figure "${d.text}" is set at ${d.size}pt`).toBeGreaterThanOrEqual(
          8,
        );
      }
    }
  });

  /**
   * Figures read down a column have to line up under one another, and only a
   * monospaced face does that: in Helvetica a `1` is narrower than a `0`, so
   * two heights of the same magnitude start in different places.
   *
   * The band is found by where it sits - hung off the plot's own bottom edge
   * - rather than by a font size only it uses, so the assertion survives the
   * band being set at a readable size shared with the rest of the sheet.
   */
  it('sets every figure in the station band monospaced', async () => {
    const bytes = await buildProfilePdf({
      name: 'Band face',
      samples: rollingSection(),
      generatedAt: FIXED_DATE,
    });
    const { stream, drawn } = sheetPage(bytes);
    const floor = plotBoxIn(stream).bottom;
    const bandCells = drawn.filter(
      (d) => d.y < floor - 5 && d.y > floor - 72 && /\d/.test(d.text),
    );
    expect(bandCells.length).toBeGreaterThan(20);
    for (const cell of bandCells) {
      // Courier or Courier-Bold: the measured row carries weight, and both
      // faces are monospaced, which is the property the band needs so that
      // digits of one row line up under each other.
      expect(cell.base, `band cell "${cell.text}" is set in ${cell.base}`).toMatch(
        /^Courier(-Bold)?$/,
      );
    }
  });
});
