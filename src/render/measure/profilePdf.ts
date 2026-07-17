/**
 * profilePdf.ts
 *
 * Full-page PDF export of a Profile measurement — a deliverable an
 * engineer can print and take measurements off. It renders:
 *
 *   - A large, box-filling section chart with a survey grid, labelled
 *     chainage (X) and elevation (Y) axes, and the curve drawn as a
 *     Catmull-Rom spline THROUGH every sample (interpolating, never
 *     moving a measured point; gaps stay breaks).
 *   - The stated horizontal and vertical scales (1:N each) and the
 *     resulting vertical exaggeration, so distances/grades read off the
 *     print are unambiguous — a true civil section convention.
 *   - A summary block: length, relief, min/max elevation, mean & max
 *     grade, coverage, sample count, corridor width, CRS/datum.
 *   - A station table (chainage · elevation · grade) so values are exact,
 *     not eyeballed off the graph.
 *   - A provenance footer (not survey-grade unless validated).
 *
 * pdf-lib is imported here so this whole module lands in its own lazy
 * chunk — the panel dynamic-imports it only when the user clicks Export.
 *
 * Pure of the DOM beyond producing bytes; the caller triggers download.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ProfileChartSample, UnitSystem } from './types';
import {
  computeCivilProfileStats,
  formatGradePercent,
  formatGradeRatio,
  formatGradeDegrees,
} from './civilProfileStats';
// Profile Intelligence (v0.4.5) — gain/loss, steepest station range, and the
// located extremes come from the same pure module the panel renders, so the
// sheet and the on-screen summary can never disagree. `formatStation` is the
// unit-aware civil stationing (metric km+m / imperial 100-ft stations) the
// panel's station table already prints.
import { computeProfileSummary, formatProfileExtreme, formatStation } from './profileSummary';
// Unit-aware length formatting — the SAME formatter every panel readout uses,
// so the sheet and the screen can never disagree on a number's unit.
import { formatElevation, formatLength } from './format';

/** Same constant the format/summary modules keep module-local. */
const FEET_PER_METRE = 3.280839895013123;

export interface ProfilePdfInput {
  /** Measurement name, shown as the sheet subtitle. */
  readonly name: string;
  /** Height-vs-distance samples (metres). */
  readonly samples: ReadonlyArray<ProfileChartSample>;
  /** Corridor half-width used by the sampler, metres (for provenance). */
  readonly corridorWidthM?: number | null;
  /** Bare-earth percentile used by the sampler (for provenance). */
  readonly groundPercentile?: number | null;
  /** Horizontal CRS string, if known. */
  readonly crs?: string | null;
  /** Vertical datum string, if known. */
  readonly verticalDatum?: string | null;
  /** True when sampled from streaming-resident nodes only. */
  readonly residentOnly?: boolean;
  /** Generation timestamp (defaults to now). */
  readonly generatedAt?: Date;
  /**
   * Active unit system (v0.4.5, B9): imperial sheets print feet on the
   * elevation axis + summary + station table and US 100-ft stationing on
   * the chainage axis. Defaults to metric (the pre-v0.4.5 sheet).
   */
  readonly unitSystem?: UnitSystem;
}

const PAGE_W = 792; // US Letter landscape
const PAGE_H = 612;
const M = 40;
const INK = rgb(0.1, 0.12, 0.16);
const INK_DIM = rgb(0.42, 0.46, 0.52);
const GRID = rgb(0.82, 0.85, 0.89);
const GRID_MINOR = rgb(0.92, 0.94, 0.96);
const CURVE = rgb(0.05, 0.55, 0.78);

/**
 * pdf-lib's StandardFonts use WinAnsi (CP1252) encoding, which throws on
 * any character it cannot map (Greek, CJK, emoji, em dash, …). User
 * measurement names are free text, so every string drawn to the page is
 * routed through this transliterator: it keeps printable ASCII and the
 * Latin-1 supplement (both fully WinAnsi-encodable), maps a few common
 * typographic glyphs to ASCII, and replaces anything else with '?'. This
 * guarantees the PDF never fails to render because of a stray glyph.
 */
function winAnsiSafe(s: string): string {
  const map: Record<string, string> = {
    'Δ': 'd', '×': 'x', '—': '-', '–': '-', '•': '-', '→': '->',
    '’': "'", '‘': "'", '“': '"', '”': '"', '…': '...',
  };
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, (ch) => map[ch] ?? '?');
}

/** Minimal Catmull-Rom → cubic-Bézier SVG path (y-down local coords). */
function curvePath(pts: ReadonlyArray<{ x: number; y: number }>): string {
  const n = pts.length;
  if (n === 0) return '';
  const f = (v: number) => v.toFixed(2);
  if (n === 1) return `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  if (n === 2) return `M ${f(pts[0].x)} ${f(pts[0].y)} L ${f(pts[1].x)} ${f(pts[1].y)}`;
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 < n ? i + 2 : n - 1];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}

/** "Nice" station interval keeping ≤ ~12 gridlines across the span. */
function niceInterval(span: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const ladder = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  for (const v of ladder) if (span / v <= 12) return v;
  let v = 10_000;
  while (span / v > 12) v *= 2;
  return v;
}

/** Convert a ground-metres-per-paper-point density to a 1:N scale ratio. */
function scaleRatio(groundM: number, paperPt: number): number {
  const paperM = (paperPt / 72) * 0.0254; // points → metres on paper
  return paperM > 0 ? groundM / paperM : 0;
}

/** Build the profile PDF and return its bytes. */
export async function buildProfilePdf(input: ProfilePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const stats = computeCivilProfileStats(input.samples);
  const when = input.generatedAt ?? new Date();
  // Unit system (B9): every printed number converts ONCE through `k`; the
  // underlying samples/stats stay metres so the geometry math is untouched.
  const system: UnitSystem = input.unitSystem ?? 'metric';
  const k = system === 'metric' ? 1 : FEET_PER_METRE;
  const unit = system === 'metric' ? 'm' : 'ft';
  const lenStr = (m: number | null): string => (m == null ? '—' : formatLength(m, system));
  // An elevation is a datum reading, not a magnitude — see `formatElevation`.
  const elevStr = (m: number | null): string => (m == null ? '—' : formatElevation(m, system));

  // ── Page 1: chart + summary ────────────────────────────────────────────
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const text = (
    p: PDFPage,
    s: string,
    x: number,
    y: number,
    size: number,
    f: PDFFont = font,
    color = INK,
  ) => p.drawText(winAnsiSafe(s), { x, y, size, font: f, color });

  // Header.
  text(page, 'Terrain Profile', M, PAGE_H - M - 4, 18, bold);
  text(page, input.name, M, PAGE_H - M - 22, 11, font, INK_DIM);
  text(
    page,
    `Generated ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    PAGE_W - M - font.widthOfTextAtSize(
      `Generated ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      9,
    ),
    PAGE_H - M - 4,
    9,
    font,
    INK_DIM,
  );
  // Provenance header line (v0.4.5, B4) — the CRS, corridor width and
  // ground percentile the section was actually computed with, right-aligned
  // under the timestamp so a printed sheet is self-describing at a glance
  // (the summary block repeats them in full lower down). Omitted entirely
  // when the caller knows none of them — no row of dashes.
  {
    const meta = [
      input.crs ? `CRS ${input.crs}` : null,
      input.corridorWidthM != null
        ? `corridor +/-${lenStr(input.corridorWidthM)}`
        : null,
      input.groundPercentile != null
        ? `ground p${Math.round(input.groundPercentile)}`
        : null,
    ].filter((s): s is string => s !== null);
    if (meta.length > 0) {
      // Measure the WinAnsi-safe text — the raw string may hold glyphs the
      // standard font cannot even measure without throwing.
      const line = winAnsiSafe(meta.join('  ·  '));
      text(
        page,
        line,
        PAGE_W - M - font.widthOfTextAtSize(line, 8),
        PAGE_H - M - 16,
        8,
        font,
        INK_DIM,
      );
    }
  }

  // Plot box (pdf coords, y up). Top edge below the header.
  const plotLeft = M + 52;
  const plotRight = PAGE_W - M - 6;
  const plotW = plotRight - plotLeft;
  const plotTopY = PAGE_H - M - 44; // y-up coordinate of the TOP edge
  const plotH = 300;
  const plotBotY = plotTopY - plotH;

  const len = stats.length;
  const minEl = stats.minElevation;
  const maxEl = stats.maxElevation;
  const span = stats.reliefSpan;

  // The finite checks are a v0.4.5 crash guard: a corrupt sample (Infinity /
  // NaN chainage or elevation) would otherwise pass `len > 0`, and the grid
  // walks below — float accumulators — would loop forever building a PDF
  // that never finishes. Corrupt geometry takes the honest "nothing to plot"
  // branch instead.
  if (
    Number.isFinite(len) && len > 0 &&
    minEl != null && maxEl != null && span != null &&
    Number.isFinite(span) && span >= 0
  ) {
    const elSpan = span < 1e-6 ? 1 : span; // avoid /0 on a flat line
    const mapX = (c: number) => plotLeft + (c / len) * plotW;
    const mapYdown = (e: number) => (1 - (e - minEl) / elSpan) * plotH; // local y-down

    // Grid — vertical (chainage) and horizontal (elevation). Tick VALUES are
    // chosen in the DISPLAY unit (B9): an imperial sheet needs gridlines on
    // nice 10/25/50 ft steps, not on metre steps relabelled in feet — the
    // display values convert back through `/k` only for positioning.
    // Both walks are iteration-capped — `niceInterval` keeps ≤ ~12 lines, so
    // 64 is far beyond legitimate counts and bounds the loop on any input.
    const hInt = niceInterval(len * k);
    for (let cD = 0, n = 0; cD <= len * k + 1e-9 && n < 64; cD += hInt, n++) {
      const x = mapX(cD / k);
      page.drawLine({ start: { x, y: plotTopY }, end: { x, y: plotBotY }, thickness: 0.5, color: GRID });
      text(page, formatStation(cD / k, system), x - 14, plotBotY - 12, 7, mono, INK_DIM);
    }
    const vInt = niceInterval(elSpan * k);
    for (
      let eD = Math.ceil((minEl * k) / vInt) * vInt, n = 0;
      eD <= maxEl * k + 1e-9 && n < 64;
      eD += vInt, n++
    ) {
      const y = plotTopY - mapYdown(eD / k);
      page.drawLine({ start: { x: plotLeft, y }, end: { x: plotRight, y }, thickness: 0.5, color: GRID_MINOR });
      text(page, `${eD.toFixed(1)}`, M, y - 3, 7, mono, INK_DIM);
    }
    // Axis frame.
    page.drawLine({ start: { x: plotLeft, y: plotTopY }, end: { x: plotLeft, y: plotBotY }, thickness: 1, color: INK_DIM });
    page.drawLine({ start: { x: plotLeft, y: plotBotY }, end: { x: plotRight, y: plotBotY }, thickness: 1, color: INK_DIM });
    text(page, `Elevation (${unit})`, M, plotTopY + 6, 8, bold, INK_DIM);
    text(
      page,
      system === 'metric' ? 'Chainage (station km+m)' : 'Chainage (100 ft stations)',
      plotRight - 130,
      plotBotY - 26,
      8,
      bold,
      INK_DIM,
    );

    // Curve runs (break on gaps), drawn through every sample.
    let run: Array<{ x: number; y: number }> = [];
    const drawRun = () => {
      if (run.length >= 1) {
        page.drawSvgPath(curvePath(run), {
          x: plotLeft,
          y: plotTopY,
          borderColor: CURVE,
          borderWidth: 1.4,
        });
      }
      run = [];
    };
    for (const st of stats.stations) {
      if (st.elevation == null) {
        drawRun();
        continue;
      }
      run.push({ x: mapX(st.chainage) - plotLeft, y: mapYdown(st.elevation) });
    }
    drawRun();

    // Stated scales + VEX (the bit that makes the print measurable).
    const hScale = scaleRatio(len, plotW);
    const vScale = scaleRatio(elSpan, plotH);
    const vex = hScale > 0 ? vScale / hScale : 1;
    const scaleLine =
      `Horizontal 1:${Math.round(hScale)}   ·   Vertical 1:${Math.round(vScale)}   ·   ` +
      `Vertical exaggeration ${vex.toFixed(1)}:1`;
    text(page, scaleLine, plotLeft, plotBotY - 26, 9, bold, INK);
  } else {
    text(page, 'No covered samples — nothing to plot.', plotLeft, plotTopY - 20, 11, font, INK_DIM);
  }

  // Summary block (two columns of label:value). The Profile Intelligence
  // rows (gain/loss, steepest station range, located extremes — v0.4.5) come
  // from the shared pure module so they match the panel's summary exactly.
  const intel = computeProfileSummary(input.samples);
  const sumTop = plotBotY - 48;
  const rows: Array<[string, string]> = [
    ['Length (horizontal)', lenStr(len)],
    ['Relief (height change)', stats.reliefSpan == null ? '-' : lenStr(stats.reliefSpan)],
    ['Min / Max elevation', `${elevStr(stats.minElevation)}  /  ${elevStr(stats.maxElevation)}`],
    [
      'Elevation gain / loss',
      intel.gainM == null || intel.lossM == null
        ? '—'
        : `+${lenStr(intel.gainM)}  /  -${lenStr(intel.lossM)}`,
    ],
    [
      'Mean grade',
      `${formatGradePercent(stats.meanGrade)}  (${formatGradeRatio(stats.meanGrade)}, ${formatGradeDegrees(stats.meanGrade)})`,
    ],
    [
      'Max grade',
      `${formatGradePercent(stats.maxGrade)}  (${formatGradeRatio(stats.maxGrade)}, ${formatGradeDegrees(stats.maxGrade)})`,
    ],
    [
      'Steepest section',
      intel.steepest == null
        ? '—'
        : `${formatStation(intel.steepest.fromChainage, system)} -> ` +
          `${formatStation(intel.steepest.toChainage, system)}  ` +
          `(${formatGradePercent(intel.steepest.grade)})`,
    ],
    [
      'Highest / Lowest point',
      intel.highest == null || intel.lowest == null
        ? '—'
        : `${formatProfileExtreme(intel.highest, system)}  /  ` +
          `${formatProfileExtreme(intel.lowest, system)}`,
    ],
    ['Samples · coverage', `${stats.sampleCount}  ·  ${(stats.coverage * 100).toFixed(0)}%`],
    [
      'Corridor half-width',
      input.corridorWidthM != null ? lenStr(input.corridorWidthM) : 'auto (5% of length)',
    ],
    [
      'Estimator',
      `bare-earth p${input.groundPercentile != null ? Math.round(input.groundPercentile) : 25} of corridor`,
    ],
    ['Horizontal CRS', input.crs ?? '— (not georeferenced)'],
    ['Vertical datum', input.verticalDatum ?? '—'],
  ];
  const colW = (PAGE_W - 2 * M) / 2;
  rows.forEach((r, i) => {
    const col = i % 2;
    const line = Math.floor(i / 2);
    const x = M + col * colW;
    const y = sumTop - line * 14;
    text(page, r[0], x, y, 8.5, bold, INK_DIM);
    text(page, r[1], x + 130, y, 8.5, font, INK);
  });

  // Provenance footer.
  const prov =
    'Not survey-grade unless validated against ground-truth control.' +
    (input.residentOnly ? '  Sampled from streaming-resident points only — may refine as more data loads.' : '');
  text(page, prov, M, M - 10, 8, font, INK_DIM);

  // ── Page 2+: station table ─────────────────────────────────────────────
  renderStationTable(doc, font, bold, mono, stats.stations, input.name, system);

  return doc.save();
}

/** Lay out the station/elevation/grade table across as many pages as needed. */
function renderStationTable(
  doc: PDFDocument,
  font: PDFFont,
  bold: PDFFont,
  mono: PDFFont,
  stations: ReturnType<typeof computeCivilProfileStats>['stations'],
  name: string,
  system: UnitSystem,
): void {
  // B9: the table prints in the display unit; geometry stays metres.
  const k = system === 'metric' ? 1 : FEET_PER_METRE;
  const unit = system === 'metric' ? 'm' : 'ft';
  const colCount = 4;
  const colGap = 14;
  const usableW = PAGE_W - 2 * M;
  const colW = (usableW - colGap * (colCount - 1)) / colCount;
  const rowH = 12;
  const topY = PAGE_H - M - 30;
  const bottomY = M + 14;
  const rowsPerCol = Math.floor((topY - bottomY) / rowH) - 1; // minus header

  const fmtGrade = (g: number | null) => (g == null ? '—' : `${(g * 100).toFixed(2)}%`);
  const fmtEl = (e: number | null) => (e == null ? 'gap' : (e * k).toFixed(2));

  let idx = 0;
  while (idx < stations.length) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const put = (s: string, x: number, y: number, size: number, f: PDFFont, color = INK) =>
      page.drawText(winAnsiSafe(s), { x, y, size, font: f, color });
    put('Station table', M, PAGE_H - M - 4, 14, bold);
    put(`${name} - STA, elevation (${unit}), grade to next`, M, PAGE_H - M - 20, 9, font, INK_DIM);

    for (let col = 0; col < colCount && idx < stations.length; col++) {
      const x = M + col * (colW + colGap);
      put('STA', x, topY, 8, bold, INK_DIM);
      put('ELEV', x + 78, topY, 8, bold, INK_DIM);
      put('GRADE', x + 122, topY, 8, bold, INK_DIM);
      page.drawLine({
        start: { x, y: topY - 3 },
        end: { x: x + colW, y: topY - 3 },
        thickness: 0.5,
        color: GRID,
      });
      for (let r = 0; r < rowsPerCol && idx < stations.length; r++, idx++) {
        const st = stations[idx];
        const y = topY - 12 - r * rowH;
        put(formatStation(st.chainage, system), x, y, 7.5, mono, INK);
        put(fmtEl(st.elevation), x + 78, y, 7.5, mono, INK);
        put(fmtGrade(st.gradeToNext), x + 122, y, 7.5, mono, INK_DIM);
      }
    }
  }
}
