/**
 * profilePdf.ts
 *
 * Full-page PDF export of a Profile measurement — a deliverable an
 * engineer can print and take measurements off. It renders:
 *
 *   - A framed section chart with a survey grid, a height (Y) axis, and the
 *     profile drawn as a straight polyline between adjacent samples, so no
 *     plotted height falls outside the two stations bracketing it (gaps stay
 *     breaks).
 *   - A station data band ruled under the section, carrying partial distance,
 *     chainage and ground height per station. Its columns come from the plot's
 *     own x mapping, so a vertical dropped from the curve lands on the figures
 *     for that station; where the stations are too dense to label, the band
 *     thins them and says how many it is showing.
 *   - The stated horizontal and vertical scales (1:N each) and the resulting
 *     vertical exaggeration, so distances/grades read off the print are
 *     unambiguous — a true civil section convention. The exaggeration is the
 *     horizontal denominator over the vertical one, because a smaller
 *     denominator is a larger drawing.
 *   - A summary block: length, relief, min/max height, mean & max grade,
 *     coverage, sample count, corridor width, CRS/datum.
 *   - A method-and-provenance page: the derived series named exactly as the
 *     on-screen legend names it, the contributing sources by stable layer id
 *     with their classification kind and read kind, the class-exclusion
 *     policy and how far it reached, and the read scope.
 *   - A station table (chainage · height · grade) so values are exact,
 *     not eyeballed off the graph.
 *   - A provenance footer carrying the canonical NOT_SURVEY_GRADE_NOTE.
 *
 * Three vocabularies are borrowed rather than restated, because a printed
 * sheet that disagrees with the screen is two answers to one question:
 *
 *   - the derived series is named by `profileDerivedLegend`, which refuses to
 *     name the series after a terrain class it cannot certify;
 *   - the sources, class policy and read scope come from a
 *     `ProfileProvenance` record, which the reader of an exported file cannot
 *     otherwise recover;
 *   - every height heading comes from `heightLabel`, so only an orthometric
 *     reference is ever printed as an elevation.
 *
 * pdf-lib is imported here so this whole module lands in its own lazy
 * chunk — the panel dynamic-imports it only when the user clicks Export.
 *
 * Pure of the DOM beyond producing bytes; the caller triggers download.
 * No clock: `generatedAt` is required, so the same input is the same bytes.
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
import { NOT_SURVEY_GRADE_NOTE } from '../../terrain/export/exportNotes';
// Unit-aware length formatting — the SAME formatter every panel readout uses,
// so the sheet and the screen can never disagree on a number's unit.
import {
  DATUM_CONFLICT_MEASURE_NOTICE,
  formatElevation,
  formatLength,
} from './format';
// Straight-polyline path builder shared with the panel chart so the sheet and
// the screen draw the same geometry from the same samples.
import { profilePolylinePath } from './profilePath';
// The words for the derived series, and the sentences that qualify it. The
// sheet prints these verbatim rather than composing a second wording.
import { buildDerivedSurfaceLegend } from './profileDerivedLegend';
import type { DerivedSurfaceLegend, DerivedSurfaceSource } from './profileDerivedLegend';
// What shaped the estimate, as the record the app keeps beside the sample.
import { describeProfileProvenance } from './profileProvenance';
import type { ProfileProvenance } from './profileProvenance';
// Height headings. `Elevation` is earned by an orthometric reference and by
// nothing else — the sheet outlives the session, so it is the last place a
// reader can discover which surface a height was measured from.
import { heightLabel, heightReferenceNote, verticalReferenceFromDatum } from '../../geo/height';
import type { VerticalReference } from '../../geo/height';
import { pdfInfoDate } from '../../pdfInfoDate';
// Where the station band's columns and the summary's value column land. Pure
// arithmetic over measured text, kept out of the builder so the geometry of
// the sheet can be asserted without reading a PDF back.
import {
  buildStationBand,
  layoutSummaryRows,
  wideValueDx,
  type SummaryRow,
} from './profileSheetLayout';

/** Same constant the format/summary modules keep module-local. */
const FEET_PER_METRE = 3.280839895013123;

export interface ProfilePdfInput {
  /** Measurement name, shown as the sheet subtitle. */
  readonly name: string;
  /** Height-vs-distance samples (metres). */
  readonly samples: ReadonlyArray<ProfileChartSample>;
  /** Corridor half-width used by the sampler, metres (for provenance). */
  readonly corridorWidthM?: number | null;
  /** Per-bin height percentile used by the sampler (for provenance). */
  readonly groundPercentile?: number | null;
  /** Horizontal CRS string, if known. */
  readonly crs?: string | null;
  /** Vertical datum string, if known. */
  readonly verticalDatum?: string | null;
  /**
   * True when sampled from streaming-resident nodes only. Ignored when
   * {@link provenance} is supplied: the record resolves the same fact from
   * the sources it actually read, and one fact gets one answer.
   */
  readonly residentOnly?: boolean;
  /**
   * Generation timestamp. REQUIRED, and never defaulted from the clock: a
   * builder that stamps itself cannot be compared byte for byte against
   * another copy of the same sheet.
   */
  readonly generatedAt: Date;
  /**
   * Active unit system (v0.4.5, B9): imperial sheets print feet on the
   * height axis + summary + station table and US 100-ft stationing on
   * the chainage axis. Defaults to metric (the pre-v0.4.5 sheet).
   */
  readonly unitSystem?: UnitSystem;
  /**
   * Whether the scene could assert a vertical datum at all. False when the
   * loaded clouds hold conflicting render origins, in which case the samples
   * are LOCAL heights and the sheet must not print the word elevation against
   * them. Defaults to true.
   */
  readonly datumKnown?: boolean;
  /**
   * What shaped the estimate: which sources were read, by stable layer id,
   * with their classification kind, whether the class policy could reach all
   * of them, and whether the read was a full static source or a resident
   * snapshot. Optional — a sheet exported without one says so on the
   * provenance page rather than implying a read that was never recorded.
   */
  readonly provenance?: ProfileProvenance | null;
}

const PAGE_W = 792; // US Letter landscape
const PAGE_H = 612;
const M = 40;
const INK = rgb(0.1, 0.12, 0.16);
const INK_DIM = rgb(0.42, 0.46, 0.52);
const GRID = rgb(0.82, 0.85, 0.89);
const GRID_MINOR = rgb(0.92, 0.94, 0.96);
const CURVE = rgb(0.05, 0.55, 0.78);
const RULE = rgb(0.68, 0.72, 0.78);

/**
 * Left stub of the station band, and so the left margin of the plot: the band
 * rules under the section and its row headings sit beside them, so one number
 * fixes both. Wide enough for the longest height heading `heightLabel` can
 * return, because a heading that has to be trimmed loses the qualification it
 * was printed to carry.
 */
const STUB_W = 118;
/**
 * Strip between the plot's bottom edge and the top of the station band, for
 * the grid's own round-interval stationing. The band's stations fall where the
 * samples fall, which is not on round numbers, so the two rows answer
 * different questions and both are wanted.
 */
const GRID_LABEL_STRIP = 11;
/** Height of one station-band row, and the size its figures are set at. */
const BAND_ROW_H = 11;
const BAND_FONT = 6;
/** Clear space either side of a band figure before it counts as a collision. */
const BAND_PAD = 4;
/** Clear space between a summary label and its value. */
const SUMMARY_GAP = 8;
const SUMMARY_ROW_H = 13;
const SUMMARY_FONT = 8.5;
/** Inset of the sheet border from the page edge. */
const BORDER_INSET = 18;

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

/**
 * The reference surface every height heading on this sheet is labelled from.
 *
 * A scene that cannot assert a datum yields LOCAL heights whatever a stored
 * record says, so that answer wins. Otherwise the record's own resolved
 * reference wins, and a datum string is classified only when the record left
 * the question open. Nothing here upgrades an undeclared datum: the fallback
 * is `verticalReferenceFromDatum`, which answers `unknown` for a name it does
 * not recognise rather than guessing orthometric.
 */
function resolveVerticalReference(input: ProfilePdfInput): VerticalReference {
  if (input.datumKnown === false) return 'local';
  const fromRecord = input.provenance?.units.verticalReference;
  if (fromRecord != null && fromRecord !== 'unknown') return fromRecord;
  return verticalReferenceFromDatum({ verticalDatum: input.verticalDatum ?? undefined });
}

/**
 * A column head short enough for the station table, and true for the
 * reference it describes. `HEIGHT` is honest for an ellipsoidal, local or
 * undeclared reference; only an orthometric one gets `ELEV`.
 */
function heightColumnHead(reference: VerticalReference): string {
  if (reference === 'orthometric') return 'ELEV';
  if (reference === 'depth') return 'DEPTH';
  return 'HEIGHT';
}

/**
 * The contributing sources, in the shape the legend describes them in.
 *
 * Only the sources that reached the accepted set are handed over: a source
 * that contributed nothing filtered nothing, so counting it would let the
 * legend report an exclusion scope the section never had. This is the same
 * set `buildProfileProvenance` computes `availableOnEverySource` over, so the
 * two statements cannot drift.
 */
function legendSources(record: ProfileProvenance | null | undefined): DerivedSurfaceSource[] {
  if (record == null) return [];
  return record.sources
    .filter((s) => s.contributed)
    .map((s) => ({
      label: s.displayName !== '' ? s.displayName : s.layerId,
      classification: s.classification,
      read: s.streaming ? ('streaming-resident' as const) : ('static' as const),
    }));
}

/** Greedy word wrap against the font's real metrics. WinAnsi-safe first. */
function wrapText(s: string, font: PDFFont, size: number, maxW: number): string[] {
  const words = winAnsiSafe(s).split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [];
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line === '' ? w : `${line} ${w}`;
    if (line === '' || font.widthOfTextAtSize(next, size) <= maxW) {
      line = next;
    } else {
      out.push(line);
      line = w;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

/** Trim to fit `maxW`, marking the trim so a truncated id never reads whole. */
function clipText(s: string, font: PDFFont, size: number, maxW: number): string {
  const safe = winAnsiSafe(s);
  if (font.widthOfTextAtSize(safe, size) <= maxW) return safe;
  let cut = safe;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, size) > maxW) {
    cut = cut.slice(0, -1);
  }
  return `${cut}...`;
}

/**
 * A stroked box, drawn as four independent segments.
 *
 * Not `drawRectangle`, which emits one closed four-segment path. The profile
 * polyline is the only run of consecutive linetos this sheet is supposed to
 * contain - it is how a reader of the file, and the gap tests, tell a
 * continuous section from one broken at a station with no returns - and a
 * rectangle anywhere on any page adds a three-lineto run that is
 * indistinguishable from a drawn profile.
 */
function strokeBox(
  p: PDFPage,
  x: number,
  y: number,
  w: number,
  h: number,
  color: ReturnType<typeof rgb>,
  thickness: number,
): void {
  const corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ] as const;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    p.drawLine({
      start: { x: a[0], y: a[1] },
      end: { x: b[0], y: b[1] },
      thickness,
      color,
    });
  }
}

/**
 * The border that makes a page read as a drawing sheet rather than as a page
 * of text. Drawn on every page of the export, because a sheet that is bordered
 * on its first page and not its later ones reads as two documents.
 */
function drawSheetBorder(p: PDFPage): void {
  strokeBox(
    p,
    BORDER_INSET,
    BORDER_INSET,
    PAGE_W - 2 * BORDER_INSET,
    PAGE_H - 2 * BORDER_INSET,
    RULE,
    0.8,
  );
}

/** The one-line form of the class-exclusion policy, for the summary block. */
function exclusionSummary(legend: DerivedSurfaceLegend): string {
  const classes = legend.excludedClasses.join(',');
  if (legend.exclusionScope === 'none') {
    return legend.sourceCount === 0
      ? 'Not applied: no contributing source recorded'
      : 'Not applied: no source carries classification';
  }
  if (legend.exclusionScope === 'every-source') {
    return `Classes ${classes} on every source (${legend.sourcesWithClassification} of ${legend.sourceCount})`;
  }
  return `Classes ${classes} on only ${legend.sourcesWithClassification} of ${legend.sourceCount} sources: partial`;
}

/** Build the profile PDF and return its bytes. */
export async function buildProfilePdf(input: ProfilePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Accessibility metadata. `showInWindowTitleBar` sets the ViewerPreferences
  // DisplayDocTitle flag so a screen reader / PDF viewer announces the sheet
  // title rather than the raw filename; setLanguage tags the document language.
  // (A full tagged-structure tree is out of reach with this PDF library; these
  // are the honest, supported accessibility hooks — see ReportPdfRenderer.)
  const pdfTitle = input.name?.trim()
    ? `Terrain Profile - ${input.name.trim()}`
    : 'Terrain Profile';
  doc.setTitle(pdfTitle, { showInWindowTitleBar: true });
  doc.setLanguage('en-US');
  doc.setAuthor('OpenLiDARViewer');
  // Pin the Info-dictionary dates. pdf-lib defaults CreationDate and ModDate to
  // the wall clock at `create()`, so two identical builds either side of a
  // second boundary stop being byte-identical. See src/pdfInfoDate.ts.
  const infoStamp = pdfInfoDate(input.generatedAt);
  doc.setCreationDate(infoStamp);
  doc.setModificationDate(infoStamp);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const stats = computeCivilProfileStats(input.samples);
  const when = input.generatedAt;
  // Unit system (B9): every printed number converts ONCE through `k`; the
  // underlying samples/stats stay metres so the geometry math is untouched.
  const system: UnitSystem = input.unitSystem ?? 'metric';
  const k = system === 'metric' ? 1 : FEET_PER_METRE;
  const unit = system === 'metric' ? 'm' : 'ft';
  const datumKnown = input.datumKnown !== false;
  const record = input.provenance ?? null;
  const reference = resolveVerticalReference(input);
  // The heading every height on this sheet is printed under. Only an
  // orthometric reference resolves to "Elevation".
  const heightWord = heightLabel(reference);
  // One fact, one answer: the record resolves the read scope when it exists.
  const residentOnly = record != null ? record.residentOnly : input.residentOnly === true;
  const legend = buildDerivedSurfaceLegend({
    samples: input.samples,
    percentile: input.groundPercentile ?? null,
    corridorHalfWidthM: input.corridorWidthM ?? null,
    sources: legendSources(record),
    excludedClasses: record?.classPolicy.excludedClasses,
  });
  const lenStr = (m: number | null): string => (m == null ? '—' : formatLength(m, system));
  // A datum reading is not a magnitude — see `formatElevation`.
  const elevStr = (m: number | null): string => (m == null ? '—' : formatElevation(m, system));

  // ── Page 1: chart + summary ────────────────────────────────────────────
  const page = doc.addPage([PAGE_W, PAGE_H]);
  drawSheetBorder(page);
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
  // percentile the section was actually computed with, right-aligned under the
  // timestamp so a printed sheet is self-describing at a glance (the summary
  // block repeats them in full lower down). Omitted entirely when the caller
  // knows none of them — no row of dashes.
  {
    const meta = [
      input.crs ? `CRS ${input.crs}` : null,
      input.corridorWidthM != null
        ? `corridor +/-${lenStr(input.corridorWidthM)}`
        : null,
      input.groundPercentile != null
        ? `p${Math.round(input.groundPercentile)} of corridor`
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
  const plotLeft = M + STUB_W;
  const plotRight = PAGE_W - M - 6;
  const plotW = plotRight - plotLeft;
  const plotTopY = PAGE_H - M - 44; // y-up coordinate of the TOP edge
  // The section keeps the upper half of the sheet; the rest is spent on the
  // station band, which is only useful directly under the curve it belongs to.
  const plotH = 220;
  const plotBotY = plotTopY - plotH;
  // The band hangs off the bottom edge of the plot and shares its rules, so
  // the two read as one drawing rather than as a chart above a table.
  const bandTop = plotBotY - GRID_LABEL_STRIP;
  const bandBot = bandTop - 3 * BAND_ROW_H;

  const len = stats.length;
  const minEl = stats.minElevation;
  const maxEl = stats.maxElevation;
  const span = stats.reliefSpan;

  // The finite checks are a v0.4.5 crash guard: a corrupt sample (Infinity /
  // NaN chainage or height) would otherwise pass `len > 0`, and the grid
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

    // Grid — vertical (chainage) and horizontal (height). Tick VALUES are
    // chosen in the DISPLAY unit (B9): an imperial sheet needs gridlines on
    // nice 10/25/50 ft steps, not on metre steps relabelled in feet — the
    // display values convert back through `/k` only for positioning.
    // Both walks are iteration-capped — `niceInterval` keeps ≤ ~12 lines, so
    // 64 is far beyond legitimate counts and bounds the loop on any input.
    const hInt = niceInterval(len * k);
    for (let cD = 0, n = 0; cD <= len * k + 1e-9 && n < 64; cD += hInt, n++) {
      const x = mapX(cD / k);
      page.drawLine({ start: { x, y: plotTopY }, end: { x, y: plotBotY }, thickness: 0.5, color: GRID });
      // Round-interval stationing under the grid. The band below carries the
      // stations the samples actually fall on, which are not round numbers;
      // this row is what lets a reader take a chainage off the grid itself.
      const tick = formatStation(cD / k, system);
      text(page, tick, x - mono.widthOfTextAtSize(tick, 7) / 2, plotBotY - 8, 7, mono, INK_DIM);
    }
    const vInt = niceInterval(elSpan * k);
    for (
      let eD = Math.ceil((minEl * k) / vInt) * vInt, n = 0;
      eD <= maxEl * k + 1e-9 && n < 64;
      eD += vInt, n++
    ) {
      const y = plotTopY - mapYdown(eD / k);
      page.drawLine({ start: { x: plotLeft, y }, end: { x: plotRight, y }, thickness: 0.5, color: GRID_MINOR });
      // Right-aligned against the axis: a column of heights is read down its
      // last digit, and a left-aligned column of different-width numbers puts
      // the units, tens and hundreds places in three different columns.
      const tick = `${eD.toFixed(1)}`;
      text(page, tick, plotLeft - 4 - mono.widthOfTextAtSize(tick, 7), y - 3, 7, mono, INK_DIM);
    }
    // The plot frame. A full rectangle rather than two axis lines: the section
    // is a drawing, and a drawing is bounded on all four sides.
    strokeBox(page, plotLeft, plotBotY, plotW, plotH, INK_DIM, 1);
    text(page, `${heightWord} (${unit})`, M, plotTopY + 6, 8, bold, INK_DIM);

    // Profile runs (break on gaps), drawn as straight segments between
    // adjacent samples so no plotted height falls outside the two stations
    // that bracket it.
    let run: Array<{ x: number; y: number }> = [];
    const drawRun = () => {
      if (run.length >= 1) {
        page.drawSvgPath(profilePolylinePath(run), {
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

    // ── Station data band (the civil "guitarra") ───────────────────────
    // One ruled row per quantity, columns dropped from the same x mapping the
    // polyline was drawn with, so a vertical from the curve lands on its own
    // figures. Row headings sit in the fixed stub at the left.
    const partialStr = (m: number | null) => (m == null ? '-' : (m * k).toFixed(1));
    const bandHeightStr = (m: number | null) => (m == null ? 'gap' : (m * k).toFixed(2));
    const bandMeasure = (t: string) => mono.widthOfTextAtSize(winAnsiSafe(t), BAND_FONT) + BAND_PAD;
    const band = buildStationBand({
      stations: stats.stations.map((st) => ({ chainage: st.chainage, height: st.elevation })),
      mapX,
      plotLeft,
      plotW,
      // The column is as wide as its widest figure: thinning against the
      // chainage alone would let a long height overlap its neighbour.
      widest: (st) => {
        const cells = [formatStation(st.chainage, system), bandHeightStr(st.height)];
        return cells.reduce((a, b) => (bandMeasure(b) > bandMeasure(a) ? b : a), cells[0]);
      },
      measure: bandMeasure,
      fontSize: BAND_FONT,
    });

    const bandRows: Array<[string, (i: number) => string]> = [
      [`Partial dist. (${unit})`, (i) => partialStr(band.columns[i].partial)],
      ['Chainage', (i) => formatStation(band.columns[i].chainage, system)],
      [`${heightWord} (${unit})`, (i) => bandHeightStr(band.columns[i].height)],
    ];
    for (let r = 0; r <= bandRows.length; r++) {
      const y = bandTop - r * BAND_ROW_H;
      page.drawLine({ start: { x: M, y }, end: { x: plotRight, y }, thickness: 0.5, color: RULE });
    }
    for (const x of [M, plotLeft, plotRight]) {
      page.drawLine({ start: { x, y: bandTop }, end: { x, y: bandBot }, thickness: 0.5, color: RULE });
    }
    bandRows.forEach(([head], r) => {
      const y = bandTop - (r + 1) * BAND_ROW_H + 3.5;
      text(page, clipText(head, bold, BAND_FONT, STUB_W - 8), M + 4, y, BAND_FONT, bold, INK_DIM);
    });
    band.columns.forEach((c, i) => {
      // The column rule runs up through the label strip to the plot's own
      // bottom edge, so the figures stay visibly tied to the curve above them.
      page.drawLine({
        start: { x: c.x, y: plotBotY },
        end: { x: c.x, y: bandBot },
        thickness: 0.4,
        color: GRID,
      });
      bandRows.forEach(([, cell], r) => {
        const t = winAnsiSafe(cell(i));
        const y = bandTop - (r + 1) * BAND_ROW_H + 3.5;
        // Courier throughout, so the figures of one row line up digit under
        // digit whatever their magnitude.
        text(page, t, c.x - mono.widthOfTextAtSize(t, BAND_FONT) / 2, y, BAND_FONT, mono, INK);
      });
    });
    // Thinning stated, not silent: a band showing one station in nine looks
    // exactly like a band showing every station the section has.
    text(
      page,
      band.shown >= band.total
        ? `Station data band - all ${band.total} stations shown`
        : `Station data band - ${band.shown} of ${band.total} stations shown (thinned to fit)`,
      M,
      bandBot - 10,
      7,
      bold,
      INK_DIM,
    );

    // Stated scales + VEX (the bit that makes the print measurable).
    const hScale = scaleRatio(len, plotW);
    const vScale = scaleRatio(elSpan, plotH);
    // `scaleRatio` returns the DENOMINATOR of a 1:N scale, so a SMALLER value
    // is a LARGER drawing. Vertical 1:73 beside horizontal 1:386 means the
    // relief is drawn 386/73 times taller than the run, which is the
    // exaggeration. The reciprocal would report a compression on a sheet whose
    // relief is stretched, and every grade read off it would be wrong by the
    // square of the error the reader was told to correct for.
    const vex = vScale > 0 ? hScale / vScale : 1;
    const scaleLine =
      `Horizontal 1:${Math.round(hScale)}   ·   Vertical 1:${Math.round(vScale)}   ·   ` +
      `Vertical exaggeration ${vex.toFixed(1)}:1`;
    text(page, scaleLine, M, bandBot - 24, 9, bold, INK);
    const axisTitle =
      system === 'metric' ? 'Chainage (station km+m)' : 'Chainage (100 ft stations)';
    text(
      page,
      axisTitle,
      plotRight - font.widthOfTextAtSize(axisTitle, 8),
      bandBot - 24,
      8,
      bold,
      INK_DIM,
    );
  } else {
    text(page, 'No covered samples — nothing to plot.', plotLeft, plotTopY - 20, 11, font, INK_DIM);
  }

  // Chart legend swatch. The caption is the legend's own, so the plotted
  // series is named on the print exactly as it is named on screen.
  page.drawLine({
    start: { x: M, y: bandBot - 37 },
    end: { x: M + 16, y: bandBot - 37 },
    thickness: 1.4,
    color: CURVE,
  });
  text(page, legend.caption, M + 22, bandBot - 40, 8, font, INK);

  // Summary block (two columns of label:value). The Profile Intelligence
  // rows (gain/loss, steepest station range, located extremes — v0.4.5) come
  // from the shared pure module so they match the panel's summary exactly.
  const intel = computeProfileSummary(input.samples);
  const sumTop = bandBot - 62;
  const contributing = record == null ? 0 : record.sources.filter((s) => s.contributed).length;
  const rows: Array<[string, string]> = [
    ['Length (horizontal)', lenStr(len)],
    ['Relief (height change)', stats.reliefSpan == null ? '-' : lenStr(stats.reliefSpan)],
    [
      `${heightWord} min / max`,
      `${elevStr(stats.minElevation)}  /  ${elevStr(stats.maxElevation)}`,
    ],
    [
      'Height gain / loss',
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
      `Highest / Lowest ${heightWord.toLowerCase()}`,
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
      'Sources read',
      record == null
        ? 'Not recorded'
        : `${record.sources.length} (${contributing} contributing)`,
    ],
    ['Vertical reference', reference],
    ['Horizontal CRS', input.crs ?? '— (not georeferenced)'],
    [
      'Vertical datum',
      datumKnown ? (input.verticalDatum ?? '—') : DATUM_CONFLICT_MEASURE_NOTICE,
    ],
  ];
  const summaryW = PAGE_W - 2 * M;
  const colW = summaryW / 2;
  // The label is set bold and the value regular, so each is measured in the
  // font it will actually be drawn in. Both are measured AFTER the WinAnsi
  // transliteration, because that is the string the page receives.
  const measureLabel = (t: string) => bold.widthOfTextAtSize(winAnsiSafe(t), SUMMARY_FONT);
  const measureValue = (t: string) => font.widthOfTextAtSize(winAnsiSafe(t), SUMMARY_FONT);
  // The gutter keeps the left column's value clear of the right column's
  // label; without it a full-width value would run into the next heading.
  const layout = layoutSummaryRows({
    rows: rows.map(([label, value]) => ({ label, value })),
    measureLabel,
    measureValue,
    cellW: colW - 16,
    wideW: summaryW,
    gap: SUMMARY_GAP,
  });

  // Three statements too long for a half-width cell, and too load-bearing to
  // abbreviate: what the drawn series is, how far the class policy reached,
  // and what the read is entitled to claim. The page that expands them is
  // page 2; these are the one-line forms. Any summary row whose label and
  // value could not share a cell joins them, ahead of them, because it is a
  // measurement and they are qualifications.
  const wideRows: SummaryRow[] = [
    ...layout.promoted,
    { label: 'Derived series', value: legend.seriesLabel },
    { label: 'Class exclusion', value: exclusionSummary(legend) },
    {
      label: 'Read scope',
      value: record == null ? 'Not recorded' : describeProfileProvenance(record),
    },
  ];
  const wideDx = wideValueDx(wideRows, measureLabel, SUMMARY_GAP, summaryW);
  const pairLines = Math.ceil(layout.pairs.length / 2);
  const wideTop = sumTop - pairLines * SUMMARY_ROW_H - 4;
  const panelBot = wideTop - (wideRows.length - 1) * SUMMARY_ROW_H - 7;

  // A light panel, so the summary reads as one block of findings rather than
  // as loose lines under the drawing.
  strokeBox(page, M - 8, panelBot, summaryW + 16, sumTop + 10 - panelBot, RULE, 0.6);
  page.drawLine({
    start: { x: M - 8, y: wideTop + 9 },
    end: { x: PAGE_W - M + 8, y: wideTop + 9 },
    thickness: 0.5,
    color: GRID,
  });

  layout.pairs.forEach((r, i) => {
    const col = i % 2;
    const line = Math.floor(i / 2);
    const x = M + col * colW;
    const y = sumTop - line * SUMMARY_ROW_H;
    text(page, r.label, x, y, SUMMARY_FONT, bold, INK_DIM);
    text(page, r.value, x + layout.valueDx, y, SUMMARY_FONT, font, INK);
  });
  wideRows.forEach((r, i) => {
    const y = wideTop - i * SUMMARY_ROW_H;
    text(page, r.label, M, y, SUMMARY_FONT, bold, INK_DIM);
    // Nothing is wider to move to, so a value that overruns even the full
    // width is trimmed with the trim marked rather than drawn over the margin.
    text(
      page,
      clipText(r.value, font, SUMMARY_FONT, summaryW - wideDx),
      M + wideDx,
      y,
      SUMMARY_FONT,
      font,
      INK,
    );
  });

  // Provenance footer.
  const prov =
    NOT_SURVEY_GRADE_NOTE +
    (residentOnly ? '  Sampled from streaming-resident points only — may refine as more data loads.' : '');
  text(page, prov, M, M - 10, 8, font, INK_DIM);

  // ── Page 2: method and provenance ──────────────────────────────────────
  renderProvenancePage(doc, font, bold, mono, {
    name: input.name,
    legend,
    record,
    reference,
    crs: input.crs ?? null,
    verticalDatum: datumKnown ? (input.verticalDatum ?? null) : null,
    datumKnown,
    residentOnly,
  });

  // ── Page 3+: station table ─────────────────────────────────────────────
  renderStationTable(doc, font, bold, mono, stats.stations, input.name, system, reference);

  return doc.save();
}

interface ProvenancePageInput {
  readonly name: string;
  readonly legend: DerivedSurfaceLegend;
  readonly record: ProfileProvenance | null;
  readonly reference: VerticalReference;
  readonly crs: string | null;
  readonly verticalDatum: string | null;
  readonly datumKnown: boolean;
  readonly residentOnly: boolean;
}

/**
 * The page a reader of an exported file needs and cannot reconstruct: what
 * the drawn series is, which sources it was read from, and what the read is
 * entitled to claim.
 *
 * Every sentence about the series is the legend's own. The source table is
 * keyed on the stable layer id, because a display name is user-editable and
 * so is human context rather than identity.
 */
function renderProvenancePage(
  doc: PDFDocument,
  font: PDFFont,
  bold: PDFFont,
  mono: PDFFont,
  input: ProvenancePageInput,
): void {
  const bottom = M + 16;
  const usableW = PAGE_W - 2 * M;
  let page = doc.addPage([PAGE_W, PAGE_H]);
  drawSheetBorder(page);
  let y = PAGE_H - M - 4;

  const put = (s: string, x: number, yy: number, size: number, f: PDFFont, color = INK) =>
    page.drawText(winAnsiSafe(s), { x, y: yy, size, font: f, color });

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    drawSheetBorder(page);
    y = PAGE_H - M - 4;
    put('Method and provenance (continued)', M, y, 12, bold);
    y -= 20;
  };
  const need = (h: number) => {
    if (y - h < bottom) newPage();
  };
  const heading = (s: string) => {
    need(26);
    y -= 8;
    put(s, M, y, 10, bold, INK);
    y -= 13;
  };
  const para = (s: string, size = 8.5, color = INK) => {
    for (const line of wrapText(s, font, size, usableW)) {
      need(12);
      put(line, M, y, size, font, color);
      y -= 11;
    }
  };

  put('Method and provenance', M, y, 16, bold);
  y -= 16;
  put(input.name, M, y, 10, font, INK_DIM);
  y -= 12;

  heading('Derived series');
  for (const line of input.legend.lines) para(line);

  heading('Height reference');
  para(`${heightLabel(input.reference)}. ${heightReferenceNote(input.reference)}`);
  para(`Vertical datum: ${input.verticalDatum ?? 'not declared'}`, 8.5, INK_DIM);
  para(`Horizontal CRS: ${input.crs ?? 'not georeferenced'}`, 8.5, INK_DIM);
  if (!input.datumKnown) para(DATUM_CONFLICT_MEASURE_NOTICE, 8.5, INK_DIM);

  heading('Sources read');
  if (input.record == null) {
    para(
      'No provenance record was attached to this export, so the contributing sources, ' +
        'their classification and the read scope are not recorded on this sheet.',
    );
  } else {
    const cols: Array<{ head: string; x: number; w: number }> = [
      { head: 'LAYER ID', x: M, w: 128 },
      { head: 'NAME', x: M + 132, w: 128 },
      { head: 'CLASSIFICATION', x: M + 264, w: 90 },
      { head: 'READ', x: M + 358, w: 72 },
      { head: 'ACCEPTED', x: M + 434, w: 70 },
      { head: 'CONTRIBUTED', x: M + 508, w: 78 },
      { head: 'RESIDENCY', x: M + 590, w: 82 },
    ];
    const drawHead = () => {
      need(22);
      for (const c of cols) put(c.head, c.x, y, 7.5, bold, INK_DIM);
      page.drawLine({
        start: { x: M, y: y - 3 },
        end: { x: M + usableW, y: y - 3 },
        thickness: 0.5,
        color: GRID,
      });
      y -= 13;
    };
    drawHead();
    for (const s of input.record.sources) {
      if (y - 11 < bottom) {
        newPage();
        drawHead();
      }
      const cells = [
        s.layerId,
        s.displayName !== '' ? s.displayName : '-',
        s.classification,
        s.streaming ? 'streaming' : 'static',
        String(s.acceptedCount),
        s.contributed ? 'yes' : 'no',
        !s.streaming
          ? '-'
          : s.residency === true
            ? 'complete'
            : s.residency === false
              ? 'incomplete'
              : 'unknown',
      ];
      cells.forEach((cell, i) => {
        const c = cols[i];
        put(clipText(cell, mono, 7.5, c.w), c.x, y, 7.5, mono, INK);
      });
      y -= 11;
    }
    y -= 4;
    para(`Total accepted returns: ${String(input.record.acceptedCount)}.`, 8.5, INK_DIM);

    heading('Read scope');
    para(describeProfileProvenance(input.record));
    para(
      `Method ${input.record.method}, corridor definition version ` +
        `${String(input.record.corridorVersion)}, record version ` +
        `${String(input.record.recordVersion)}, captured ${input.record.capturedAt}.`,
      8.5,
      INK_DIM,
    );
    if (input.record.upDegenerate) {
      para(
        'The scene up axis was degenerate when this sample was taken, so the heights ' +
          'were not measured along a usable vertical.',
        8.5,
        INK_DIM,
      );
    }
  }

  if (input.residentOnly) {
    para(
      'Sampled from streaming-resident points only - may refine as more data loads.',
      8.5,
      INK_DIM,
    );
  }

  need(20);
  y -= 6;
  for (const line of wrapText(NOT_SURVEY_GRADE_NOTE, font, 8, usableW)) {
    need(11);
    put(line, M, y, 8, font, INK_DIM);
    y -= 10;
  }
}

/** Lay out the station/height/grade table across as many pages as needed. */
function renderStationTable(
  doc: PDFDocument,
  font: PDFFont,
  bold: PDFFont,
  mono: PDFFont,
  stations: ReturnType<typeof computeCivilProfileStats>['stations'],
  name: string,
  system: UnitSystem,
  reference: VerticalReference,
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
  const columnHead = heightColumnHead(reference);

  let idx = 0;
  while (idx < stations.length) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    drawSheetBorder(page);
    const put = (s: string, x: number, y: number, size: number, f: PDFFont, color = INK) =>
      page.drawText(winAnsiSafe(s), { x, y, size, font: f, color });
    put('Station table', M, PAGE_H - M - 4, 14, bold);
    put(
      `${name} - STA, ${heightLabel(reference)} (${unit}), grade to next`,
      M,
      PAGE_H - M - 20,
      9,
      font,
      INK_DIM,
    );

    for (let col = 0; col < colCount && idx < stations.length; col++) {
      const x = M + col * (colW + colGap);
      put('STA', x, topY, 8, bold, INK_DIM);
      put(columnHead, x + 78, topY, 8, bold, INK_DIM);
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
