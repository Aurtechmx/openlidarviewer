/**
 * profilePdf.ts
 *
 * Full-page PDF export of a Profile measurement — a deliverable an
 * engineer can print and take measurements off. It renders:
 *
 *   - A large, box-filling section chart with a survey grid, labelled
 *     chainage (X) and height (Y) axes, and the profile drawn as a
 *     straight polyline between adjacent samples, so no plotted height
 *     falls outside the two stations bracketing it (gaps stay breaks).
 *   - The stated horizontal and vertical scales (1:N each) and the
 *     resulting vertical exaggeration, so distances/grades read off the
 *     print are unambiguous — a true civil section convention.
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
    text(page, `${heightWord} (${unit})`, M, plotTopY + 6, 8, bold, INK_DIM);
    text(
      page,
      system === 'metric' ? 'Chainage (station km+m)' : 'Chainage (100 ft stations)',
      plotRight - 130,
      plotBotY - 26,
      8,
      bold,
      INK_DIM,
    );

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

  // Chart legend swatch. The caption is the legend's own, so the plotted
  // series is named on the print exactly as it is named on screen.
  page.drawLine({
    start: { x: plotLeft, y: plotBotY - 38 },
    end: { x: plotLeft + 16, y: plotBotY - 38 },
    thickness: 1.4,
    color: CURVE,
  });
  text(page, legend.caption, plotLeft + 22, plotBotY - 41, 8, font, INK);

  // Summary block (two columns of label:value). The Profile Intelligence
  // rows (gain/loss, steepest station range, located extremes — v0.4.5) come
  // from the shared pure module so they match the panel's summary exactly.
  const intel = computeProfileSummary(input.samples);
  const sumTop = plotBotY - 52;
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
  const colW = (PAGE_W - 2 * M) / 2;
  rows.forEach((r, i) => {
    const col = i % 2;
    const line = Math.floor(i / 2);
    const x = M + col * colW;
    const y = sumTop - line * 14;
    text(page, r[0], x, y, 8.5, bold, INK_DIM);
    text(page, r[1], x + 130, y, 8.5, font, INK);
  });

  // Three statements too long for a half-width cell, and too load-bearing to
  // abbreviate: what the drawn series is, how far the class policy reached,
  // and what the read is entitled to claim. The page that expands them is
  // page 2; these are the one-line forms.
  const wideRows: Array<[string, string]> = [
    ['Derived series', legend.seriesLabel],
    ['Class exclusion', exclusionSummary(legend)],
    ['Read scope', record == null ? 'Not recorded' : describeProfileProvenance(record)],
  ];
  const wideTop = sumTop - Math.ceil(rows.length / 2) * 14;
  wideRows.forEach((r, i) => {
    const y = wideTop - i * 14;
    text(page, r[0], M, y, 8.5, bold, INK_DIM);
    text(page, r[1], M + 130, y, 8.5, font, INK);
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
  let y = PAGE_H - M - 4;

  const put = (s: string, x: number, yy: number, size: number, f: PDFFont, color = INK) =>
    page.drawText(winAnsiSafe(s), { x, y: yy, size, font: f, color });

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
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
