/**
 * pdfWrappedTextPagination.test.ts
 *
 * Long wrapped text in the PDF sheets must break onto new pages instead of
 * running below the footer or off the bottom of the page, and nothing may be
 * dropped without a visible marker.
 *
 * Every `PDFPage.drawText` call is recorded (page, x, y, width, font), so the
 * assertions are about where each line actually lands, not about the inputs:
 *  - flowing text never sits below the footer band and never crosses the right
 *    margin;
 *  - the page count grows with the content;
 *  - the characters drawn are the characters of the source text (plus a
 *    visible omission marker when a field is capped);
 *  - a label whose value breaks across pages is repeated as "(continued)".
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFPage } from 'pdf-lib';
import { generateReport, composeReportInputs } from '../src/report';
import type { ReportInputs } from '../src/report';
import { buildTerrainReportPdf, type TerrainReportContent } from '../src/render/measure/terrainReportPdf';
import { buildSpaceReportPdf } from '../src/render/measure/spaceReportPdf';
import { buildProfilePdf } from '../src/render/measure/profilePdf';
import { spaceMetrics } from '../src/terrain/spaceMetrics';

// ─────────────────────────────────────────────────────────────────────────────
// drawText recorder
// ─────────────────────────────────────────────────────────────────────────────

interface Drawn {
  readonly seq: number;
  readonly page: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly width: number;
  readonly bold: boolean;
  readonly pageWidth: number;
}

async function recordDraws<T>(fn: () => Promise<T>): Promise<{ result: T; runs: Drawn[]; pages: number }> {
  const origDraw = PDFPage.prototype.drawText;
  const origAdd = PDFDocument.prototype.addPage;
  const ids = new WeakMap<object, number>();
  let pages = 0;
  const runs: Drawn[] = [];
  PDFDocument.prototype.addPage = function (this: PDFDocument, ...args: Parameters<PDFDocument['addPage']>) {
    const page = origAdd.apply(this, args);
    ids.set(page, ++pages);
    return page;
  } as PDFDocument['addPage'];
  PDFPage.prototype.drawText = function (this: PDFPage, text: string, options: Parameters<PDFPage['drawText']>[1] = {}) {
    const size = options.size ?? 24;
    const font = options.font;
    runs.push({
      seq: runs.length,
      page: ids.get(this) ?? 0,
      text,
      x: options.x ?? 0,
      y: options.y ?? 0,
      size,
      width: font ? font.widthOfTextAtSize(text, size) : 0,
      bold: font ? /Bold/.test(font.name) : false,
      pageWidth: this.getWidth(),
    });
    return origDraw.call(this, text, options);
  } as PDFPage['drawText'];
  try {
    const result = await fn();
    return { result, runs, pages };
  } finally {
    PDFPage.prototype.drawText = origDraw;
    PDFDocument.prototype.addPage = origAdd;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source text: lowercase consonant words, so a drawn run of the source is
// recognisable by its alphabet alone (no English text in the reports is made
// only of these letters).
// ─────────────────────────────────────────────────────────────────────────────

const ALPHABET = 'bcdfghj';

/** Deterministic text of exactly `n` characters: words of 2 to 9 letters. */
function sourceText(n: number, seed = 7): string {
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  let out = '';
  while (out.length < n) {
    const len = 2 + Math.floor(rnd() * 8);
    let w = '';
    for (let i = 0; i < len; i++) w += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    out += (out ? ' ' : '') + w;
  }
  out = out.slice(0, n);
  // Never end on a space (wrapping trims it, which would read as a lost char).
  return out.endsWith(' ') ? `${out.slice(0, -1)}b` : out;
}

const strip = (s: string): string => s.replace(/\s+/g, '');
/** A run's text without the prefix a block puts on its first line (a bullet, a bullet dash, "distance · "). */
const unprefixed = (text: string): string => text.replace(/^(• |- |distance · )/, '');
const isSourceRun = (r: Drawn): boolean => /^[bcdfghj ]+$/.test(unprefixed(r.text)) && r.text.trim() !== '';

/** All source-alphabet runs of one font weight, in draw order, whitespace removed. */
function drawnSource(runs: readonly Drawn[], bold: boolean): string {
  return runs.filter((r) => r.bold === bold && isSourceRun(r)).map((r) => strip(unprefixed(r.text))).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Report (ReportPdfRenderer) fixtures and invariants
// ─────────────────────────────────────────────────────────────────────────────

const REPORT_PAGE_W = 612;
const REPORT_MARGIN = 44;
/** FOOTER_HEIGHT + 16: the lowest baseline flowing text may use. */
const REPORT_FLOOR = 48;
/** Footer stamps are drawn by the late page-number pass at y <= 22. */
const isReportFooter = (r: Drawn): boolean => r.y <= 22;

function baseInputs(): ReportInputs {
  return composeReportInputs({
    templateId: 'technical-report',
    title: 'Inspection',
    metadata: {
      fileName: 'scan.e57',
      format: 'E57',
      sourcePointCount: 1000,
      width: 10,
      depth: 10,
      height: 5,
      density: 10,
      hasRgb: false,
      hasIntensity: false,
      hasClassification: false,
    },
    visuals: [],
    annotations: [],
    measurements: [],
    unitSystem: 'metric' as never,
  });
}

async function renderReport(inputs: ReportInputs) {
  const { result, runs } = await recordDraws(() => generateReport(inputs, { timeoutMs: Infinity }));
  return { pages: result.pages, failed: result.failedSections, runs };
}

function expectReportGeometry(runs: readonly Drawn[]): void {
  for (const r of runs) {
    if (!isReportFooter(r)) {
      expect(r.y, `"${r.text.slice(0, 40)}" on page ${r.page} sits below the footer band`).toBeGreaterThanOrEqual(REPORT_FLOOR);
    }
    expect(
      r.x + r.width,
      `"${r.text.slice(0, 40)}" on page ${r.page} crosses the right margin`,
    ).toBeLessThanOrEqual(REPORT_PAGE_W - REPORT_MARGIN + 0.5);
  }
}

/** A run reading "<something> (continued)" on a later page than `afterPage`. */
function continuedAfter(runs: readonly Drawn[], afterPage: number): Drawn[] {
  return runs.filter((r) => r.text.endsWith('(continued)') && r.page > afterPage);
}

describe('report PDF: wrapped text paginates', () => {
  it('short-line control: 400 short note lines paginate and every line is drawn', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`);
    const base = await renderReport(baseInputs());
    const { pages, failed, runs } = await renderReport({ ...baseInputs(), technicalNotes: lines.join('\n') });
    expect(failed).toEqual([]);
    expectReportGeometry(runs);
    expect(pages).toBeGreaterThanOrEqual(base.pages + 6);
    for (const l of lines) expect(runs.some((r) => r.text === l), l).toBe(true);
  });

  it('a 15,000-character technical note flows across pages with nothing lost', async () => {
    const note = sourceText(15_000);
    const base = await renderReport(baseInputs());
    const { pages, failed, runs } = await renderReport({ ...baseInputs(), technicalNotes: note });
    expect(failed).toEqual([]);
    expectReportGeometry(runs);
    expect(pages).toBeGreaterThanOrEqual(base.pages + 2);
    expect(drawnSource(runs, false)).toBe(strip(note));
    const heading = runs.find((r) => r.text === 'Technical notes' && r.size === 14)!;
    expect(continuedAfter(runs, heading.page).length).toBeGreaterThan(0);
  });

  it('a 6,000-character annotation note flows across pages with its title continued', async () => {
    const note = sourceText(6_000, 11);
    const inputs: ReportInputs = {
      ...baseInputs(),
      annotations: [
        { title: 'Crack A', type: 'issue', note, position: { x: 1, y: 2, z: 3 }, frame: 'local', createdAt: 0 },
      ],
    };
    const base = await renderReport(baseInputs());
    const { pages, failed, runs } = await renderReport(inputs);
    expect(failed).toEqual([]);
    expectReportGeometry(runs);
    expect(pages).toBeGreaterThan(base.pages);
    expect(drawnSource(runs, false)).toBe(strip(note));
    const title = runs.find((r) => r.text.startsWith('Crack A'))!;
    expect(continuedAfter(runs, title.page).some((r) => r.text.startsWith('Crack A'))).toBe(true);
    // The position line still follows the note.
    expect(runs.some((r) => r.text.startsWith('Position (render-local)'))).toBe(true);
  });

  it('E57-style declared metadata (40 fields of 400 characters) stays above the footer', async () => {
    const fields = Array.from({ length: 40 }, (_, i) => ({
      name: `field${i + 1}`,
      value: sourceText(400, 100 + i),
    }));
    const { pages, failed, runs } = await renderReport({
      ...baseInputs(),
      sourceMetadata: { standard: fields, extensions: [] },
    });
    expect(failed).toEqual([]);
    expectReportGeometry(runs);
    const base = await renderReport(baseInputs());
    expect(pages).toBeGreaterThanOrEqual(base.pages + 3);
    const body = drawnSource(runs, false);
    for (const f of fields) expect(body.includes(strip(f.value)), f.name).toBe(true);
    expect(body).toBe(fields.map((f) => strip(f.value)).join(''));
  });

  it('a 15,000-character measurement name is wrapped, paginated and capped with a visible marker', async () => {
    const name = sourceText(15_000, 23);
    const { pages, failed, runs } = await renderReport({
      ...baseInputs(),
      measurements: [{ name, kind: 'distance', value: '12.50 m', pointCount: 2 }],
    });
    expect(failed).toEqual([]);
    expectReportGeometry(runs);
    const base = await renderReport(baseInputs());
    expect(pages).toBeGreaterThan(base.pages);
    // The row label is "distance · <name>"; its first 8,000 characters are
    // drawn and the marker names the rest.
    const prefix = 'distance · '.length;
    expect(drawnSource(runs, true)).toBe(strip(name.slice(0, 8_000 - prefix)));
    const marker = runs.find((r) => r.text.includes('characters omitted'));
    expect(marker?.text).toBe(`[… ${(15_000 + prefix - 8_000).toLocaleString('en-US')} characters omitted from this PDF]`);
    // The value still prints after the name.
    expect(runs.some((r) => r.text === '12.50 m')).toBe(true);
  });

  it('a long profile coverage caveat paginates with its label continued', async () => {
    const caveat = sourceText(6_000, 31);
    const { failed, runs } = await renderReport({
      ...baseInputs(),
      measurements: [
        {
          name: 'P1',
          kind: 'profile',
          value: '40.00 m',
          pointCount: 40,
          profileExtras: {
            summary: 'Horizontal 40.00 m',
            stations: '0 m · 20 m · 40 m',
            stationInterval: 'Station interval 20 m',
            slopeSummary: 'Max +1.0 %',
            coverageCaveat: caveat,
          },
        },
      ],
    });
    expect(failed).toEqual([]);
    expectReportGeometry(runs);
    expect(drawnSource(runs, false)).toBe(strip(caveat));
    const label = runs.find((r) => r.text.trim() === 'coverage')!;
    expect(continuedAfter(runs, label.page).some((r) => r.text.includes('coverage (continued)'))).toBe(true);
  });

  it('long summary caveats and finding detail stay above the footer', async () => {
    const inputs = baseInputs();
    const summary = inputs.summary!;
    const caveat = sourceText(5_000, 41);
    const detail = sourceText(5_000, 43);
    const { failed, runs } = await renderReport({
      ...inputs,
      summary: {
        ...summary,
        findings: [{ ...summary.findings[0], detail }, ...summary.findings.slice(1)],
        caveats: [caveat],
      },
    });
    expect(failed).toEqual([]);
    expectReportGeometry(runs);
    const body = drawnSource(runs, false);
    expect(body.includes(strip(detail))).toBe(true);
    expect(body.includes(strip(caveat))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terrain report
// ─────────────────────────────────────────────────────────────────────────────

/** The terrain body floor: M + FOOTER_RESERVE. */
const TERRAIN_FLOOR = 48 + 96;

function terrainContent(rowValue: string, warning: string): TerrainReportContent {
  return {
    title: 'Terrain report',
    subtitle: 'TERRAIN INTELLIGENCE REPORT',
    sections: [
      {
        title: 'Executive summary',
        rows: [
          { label: 'Surface', value: 'Ground model ready' },
          { label: 'Operator note', value: rowValue },
        ],
      },
    ],
    workflows: [],
    products: [],
    warnings: [warning],
    howToImprove: [],
    provenance: {} as TerrainReportContent['provenance'],
    provenanceLines: ['Software  OpenLiDARViewer', 'Source  scan.laz'],
    notSurveyGrade: 'Not survey grade.',
    definitions: [],
  } as unknown as TerrainReportContent;
}

describe('terrain report PDF: wrapped text paginates', () => {
  it('a 15,000-character row value and a 6,000-character warning flow across pages', async () => {
    const value = sourceText(15_000, 51);
    const warning = sourceText(6_000, 53);
    const { runs, pages } = await recordDraws(() => buildTerrainReportPdf(terrainContent(value, warning)));
    const short = await recordDraws(() => buildTerrainReportPdf(terrainContent('short', 'short')));
    expect(pages).toBeGreaterThanOrEqual(short.pages + 2);
    // Flowing text (the source runs) never enters the footer reserve and never
    // crosses the right margin.
    for (const r of runs) {
      expect(r.x + r.width, `"${r.text.slice(0, 30)}" crosses the right margin`).toBeLessThanOrEqual(r.pageWidth - 48 + 0.5);
      if (isSourceRun(r)) {
        expect(r.y, `"${r.text.slice(0, 30)}" on page ${r.page} sits in the footer reserve`).toBeGreaterThanOrEqual(TERRAIN_FLOOR);
      }
    }
    const body = drawnSource(runs, false);
    // The value is capped at 8,000 characters with a visible marker; the
    // 6,000-character warning prints whole.
    expect(body.includes(strip(value.slice(0, 8_000)))).toBe(true);
    expect(body.includes(strip(value.slice(0, 8_001)))).toBe(false);
    expect(runs.some((r) => r.text === '[... 7,000 characters omitted from this PDF]')).toBe(true);
    expect(body.includes(strip(warning))).toBe(true);
    const label = runs.find((r) => r.text === 'Operator note')!;
    expect(runs.some((r) => r.text === 'Operator note (continued)' && r.page > label.page)).toBe(true);
  });

  it('hard-breaks a single word wider than the value column', async () => {
    const word = 'b'.repeat(900);
    const { runs } = await recordDraws(() => buildTerrainReportPdf(terrainContent(word, 'none')));
    for (const r of runs) expect(r.x + r.width).toBeLessThanOrEqual(r.pageWidth - 48 + 0.5);
    expect(drawnSource(runs, false)).toBe(word);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Space report
// ─────────────────────────────────────────────────────────────────────────────

function smallRoom(): Float32Array {
  const t: number[] = [];
  const W = 4, D = 5, H = 2.5, step = 0.25;
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) t.push(x, y, 0, x, y, H);
  for (let z = 0; z <= H; z += step) {
    for (let x = 0; x <= W; x += step) t.push(x, 0, z, x, D, z);
    for (let y = 0; y <= D; y += step) t.push(0, y, z, W, y, z);
  }
  return Float32Array.from(t);
}

describe('space report PDF: wrapped text paginates', () => {
  it('a 15,000-character caveat flows across pages above the provenance footer', async () => {
    const caveat = sourceText(15_000, 61);
    const real = spaceMetrics(smallRoom(), { upAxis: 'z', spaceKind: 'interior', hasRgb: false });
    const input = { space: { ...real, reasons: [caveat] }, name: 'Room', generatedAt: '2026-01-01T00:00:00Z' };
    const { runs, pages } = await recordDraws(() => buildSpaceReportPdf(input));
    const short = await recordDraws(() => buildSpaceReportPdf({ ...input, space: { ...real, reasons: ['short'] } }));
    expect(pages).toBeGreaterThan(short.pages);
    // The footer (provenance stamp + bold note) is the last thing drawn; its top
    // run is the highest of the runs after the last body line.
    const lastSource = runs.filter((r) => isSourceRun(r) || r.text.includes('omitted')).at(-1)!;
    const footerTop = Math.max(...runs.filter((r) => r.seq > lastSource.seq).map((r) => r.y));
    for (const r of runs) {
      expect(r.x + r.width, `"${r.text.slice(0, 30)}" crosses the right margin`).toBeLessThanOrEqual(r.pageWidth - 48 + 0.5);
      if (isSourceRun(r)) {
        expect(r.y, `"${r.text.slice(0, 30)}" on page ${r.page} overprints the footer`).toBeGreaterThan(footerTop + 12);
      }
    }
    // The note line is "- <caveat>", capped at 8,000 characters with a
    // visible marker for the rest.
    expect(drawnSource(runs, false)).toBe(strip(caveat.slice(0, 8_000 - 2)));
    expect(runs.some((r) => r.text === '[... 7,002 characters omitted from this PDF]')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile sheet general notes
// ─────────────────────────────────────────────────────────────────────────────

describe('profile sheet general notes', () => {
  const samples = Array.from({ length: 24 }, (_, i) => ({ distance: i * 2, height: 100 + Math.sin(i / 4) * 3 }));

  it('ends with a visible omission marker when the notes overflow their box', async () => {
    const { runs } = await recordDraws(() =>
      buildProfilePdf({
        name: 'P1',
        samples,
        generatedAt: new Date('2026-01-01T00:00:00.000Z'),
        coverageNote: sourceText(3_000, 71),
      }),
    );
    expect(runs.some((r) => /\[(…|\.\.\.) \d+ more lines? omitted\]/.test(r.text))).toBe(true);
  });

  it('draws no marker when the notes fit', async () => {
    const { runs } = await recordDraws(() =>
      buildProfilePdf({ name: 'P1', samples, generatedAt: new Date('2026-01-01T00:00:00.000Z') }),
    );
    expect(runs.some((r) => /omitted\]/.test(r.text))).toBe(false);
  });
});
