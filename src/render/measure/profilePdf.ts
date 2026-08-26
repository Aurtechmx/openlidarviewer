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
const M = 46;

/**
 * One ink, one accent, and neutrals mixed toward the ink rather than toward
 * pure grey, so nothing on the sheet reads as a second hue.
 *
 * `INK_DIM` is the plot frame's pen and is deliberately left at the value it
 * has always had: `profileSheet.test.ts` recovers the plot box out of the
 * content stream by that stroke colour, and the mapping it then checks the
 * station band against is only as trustworthy as the frame it was read from.
 * Reference-block labels moved to `INK_MUTED` instead, which is what actually
 * wanted demoting.
 */
const INK = rgb(0.09, 0.11, 0.15);
const INK_DIM = rgb(0.42, 0.46, 0.52);
const INK_MUTED = rgb(0.53, 0.57, 0.63);
const GRID = rgb(0.83, 0.86, 0.9);
const GRID_MINOR = rgb(0.91, 0.93, 0.95);
/**
 * The single accent. Darker than a screen blue on purpose: engineering sheets
 * are printed on mono devices, and this converts to roughly 31% luminance,
 * which still separates from the ground tint (84%) and from paper.
 */
const CURVE = rgb(0.05, 0.36, 0.56);
/**
 * The ground under the section: a desaturated tint of the accent, not the
 * accent itself. It sits behind the data and must never compete with the line
 * drawn on top of it. About a 16% tint in greyscale, which every printer
 * renders as an unambiguous fill rather than as almost-paper.
 */
const GROUND = rgb(0.78, 0.85, 0.91);
const RULE = rgb(0.7, 0.74, 0.8);

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
const GRID_LABEL_STRIP = 14;
/** Height of one station-band row, and the size its figures are set at. */
const BAND_ROW_H = 11;
const BAND_FONT = 6;
/** Clear space either side of a band figure before it counts as a collision. */
const BAND_PAD = 4;
/** Clear space between a summary label and its value. */
const SUMMARY_GAP = 8;
const SUMMARY_ROW_H = 12;
const SUMMARY_FONT = 8.5;
/**
 * The headline figures, and the size the sheet's title is set at.
 *
 * The ratio to `SUMMARY_FONT` is the whole point: at 22 over 8.5 it is a
 * little over 2.5:1, which is enough that a reader's eye lands on the five
 * figures before it lands on anything else. The previous sheet set the title,
 * the summary and the provenance within a point of each other, so it offered
 * no entry point at all.
 */
const HEADLINE_FONT = 22;
/** The quiet label over a headline figure, and the sheet's eyebrow labels. */
const HEADLINE_LABEL_FONT = 6.5;
/** Extra space inserted between letters of an uppercase eyebrow label. */
const TRACK = 0.9;
/** Inset of the sheet border from the page edge. */
const BORDER_INSET = 24;

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
 * An uppercase label drawn letter by letter, with `track` points of air
 * inserted between the letters.
 *
 * The standard PDF fonts stay: embedding a TTF would cost roughly 200KB
 * inside a chunk the browser loads only on Export, and Helvetica is the
 * genuine convention on an engineering drawing. Hierarchy is bought with
 * size, weight, case and spacing instead, and this is the spacing part —
 * tracked small caps read as a label rather than as a short sentence, which
 * is what lets the label sit quietly over a figure four times its size.
 *
 * Spaces are advanced over rather than drawn: an empty glyph carries no ink
 * and drawing it only grows the content stream.
 */
function trackedText(
  p: PDFPage,
  s: string,
  x: number,
  y: number,
  size: number,
  f: PDFFont,
  color: ReturnType<typeof rgb>,
  track = TRACK,
): void {
  let cx = x;
  for (const ch of winAnsiSafe(s)) {
    if (ch !== ' ') p.drawText(ch, { x: cx, y, size, font: f, color });
    cx += f.widthOfTextAtSize(ch, size) + track;
  }
}

/** Pitch and pen of the ground fill. See {@link fillUnderRun}. */
const GROUND_PITCH = 0.75;
const GROUND_PEN = 0.85;

/**
 * The ground under one unbroken run of the section, filled to the plot floor.
 *
 * A civil section draws terrain as GROUND, not as a line on a chart, so the
 * area under the profile is filled and the line kept crisp on top of it.
 *
 * It is filled with abutting vertical strokes rather than with one filled
 * polygon, and that is not a stylistic choice. A filled path emits `m` then a
 * `l` per vertex, which is byte for byte what a drawn profile emits: the
 * document-wide invariant this sheet is tested on — that the longest run of
 * consecutive linetos anywhere in the file is the profile's own longest
 * unbroken run, so a reader can tell a continuous section from one broken at
 * a station with no returns — would be destroyed by a polygon with a vertex
 * per station. Each stroke here is its own `m … l S`, a run of one, so the
 * invariant survives intact. It is the same reason `strokeBox` exists.
 *
 * The strokes are placed at a pitch finer than the pen that draws them, so
 * they abut with no seam, and finer than half the width of the profile line
 * drawn over them, so the staircase along the top of the fill is covered by
 * that line at every gradient this sheet can plot.
 *
 * `run` carries plot-local points (x from the left edge, y DOWN from the top
 * edge) — the same coordinates the polyline path is built from, so the fill
 * and the line cannot describe two different surfaces.
 */
function fillUnderRun(
  p: PDFPage,
  run: ReadonlyArray<{ x: number; y: number }>,
  plotLeft: number,
  plotTopY: number,
  plotBotY: number,
): void {
  if (run.length === 0) return;
  const bar = (localX: number, localY: number) => {
    const top = plotTopY - localY;
    if (top <= plotBotY) return; // nothing to fill: the point IS the floor
    p.drawLine({
      start: { x: plotLeft + localX, y: plotBotY },
      end: { x: plotLeft + localX, y: top },
      thickness: GROUND_PEN,
      color: GROUND,
    });
  };
  if (run.length === 1) {
    bar(run[0].x, run[0].y);
    return;
  }
  for (let i = 0; i < run.length - 1; i++) {
    const a = run[i];
    const b = run[i + 1];
    const dx = b.x - a.x;
    if (!(dx > 0)) continue;
    // The last segment closes on its own end point; every earlier one stops
    // short of it, because the next segment starts there.
    const last = i === run.length - 2;
    for (let x = a.x; x < b.x - 1e-9 || (last && x <= b.x + 1e-9); x += GROUND_PITCH) {
      const at = Math.min(x, b.x);
      bar(at, a.y + ((at - a.x) / dx) * (b.y - a.y));
      if (at >= b.x) break;
    }
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

  // Header. The title carries the sheet; the measurement name sits under it
  // as a subtitle, and everything on the right is stamp material set small
  // and quiet. `Terrain Profile` is drawn as one string, untracked: it is how
  // the sheet's own tests find page one.
  text(page, 'Terrain Profile', M, PAGE_H - M - 8, HEADLINE_FONT, bold);
  text(page, input.name, M, PAGE_H - M - 27, 10, font, INK_DIM);
  {
    const stamp = `Generated ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    text(
      page,
      stamp,
      PAGE_W - M - font.widthOfTextAtSize(winAnsiSafe(stamp), 8),
      PAGE_H - M - 8,
      8,
      font,
      INK_MUTED,
    );
  }
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
        PAGE_W - M - font.widthOfTextAtSize(line, 7.5),
        PAGE_H - M - 20,
        7.5,
        font,
        INK_MUTED,
      );
    }
  }

  // A rule closing the header, so the title block reads as a block rather
  // than as the first three lines of the sheet. Generous air under it: the
  // spacing on this sheet is deliberately uneven — tight inside a group, open
  // between groups — because equal spacing everywhere is what made the
  // previous version read as a data dump.
  page.drawLine({
    start: { x: M, y: PAGE_H - M - 40 },
    end: { x: PAGE_W - M, y: PAGE_H - M - 40 },
    thickness: 0.6,
    color: RULE,
  });

  // Plot box (pdf coords, y up). Top edge below the header.
  const plotLeft = M + STUB_W;
  const plotRight = PAGE_W - M - 6;
  const plotW = plotRight - plotLeft;
  const plotTopY = PAGE_H - M - 58; // y-up coordinate of the TOP edge
  // The section keeps the upper half of the sheet; the rest is spent on the
  // station band, which is only useful directly under the curve it belongs to.
  const plotH = 196;
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
      text(page, tick, x - mono.widthOfTextAtSize(tick, 7) / 2, plotBotY - 11, 7, mono, INK_MUTED);
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
    // Profile runs (break on gaps), drawn as straight segments between
    // adjacent samples so no plotted height falls outside the two stations
    // that bracket it. The ground is filled to the plot floor first and the
    // line stroked over it, so the fill can never be mistaken for the datum
    // the line is read against. A gap fills nothing: absent ground is absent,
    // not flat.
    let run: Array<{ x: number; y: number }> = [];
    const drawRun = () => {
      if (run.length >= 1) {
        fillUnderRun(page, run, plotLeft, plotTopY, plotBotY);
        page.drawSvgPath(profilePolylinePath(run), {
          x: plotLeft,
          y: plotTopY,
          borderColor: CURVE,
          borderWidth: 1.6,
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

    // The plot frame, drawn last. A full rectangle rather than two axis
    // lines: the section is a drawing, and a drawing is bounded on all four
    // sides. Last, because the ground fill reaches the floor and would
    // otherwise erase the edge it is standing on.
    strokeBox(page, plotLeft, plotBotY, plotW, plotH, INK_DIM, 1);
    text(page, `${heightWord} (${unit})`, M, plotTopY + 8, 7.5, bold, INK_DIM);

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
    // Horizontal rules, and the single vertical that separates the stub from
    // the figures. Not a border per cell: a full grid of cell borders is more
    // ink than the figures it is meant to organise, and the columns are
    // already tied to the curve by their own drop lines.
    page.drawLine({
      start: { x: plotLeft, y: bandTop },
      end: { x: plotLeft, y: bandBot },
      thickness: 0.5,
      color: RULE,
    });
    bandRows.forEach(([head], r) => {
      const y = bandTop - (r + 1) * BAND_ROW_H + 3.5;
      text(page, clipText(head, bold, BAND_FONT, STUB_W - 10), M, y, BAND_FONT, bold, INK_MUTED);
    });
    band.columns.forEach((c, i) => {
      // A tick hung off the plot's own bottom edge, at the column's x. It
      // stops there rather than running the depth of the band: a rule
      // continued through three rows of centred figures crosses every one of
      // them through the middle, and a hairline drawn over a digit is a
      // hairline drawn over a digit however light it is.
      page.drawLine({
        start: { x: c.x, y: plotBotY },
        end: { x: c.x, y: plotBotY - 5 },
        thickness: 0.5,
        color: INK_DIM,
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
    // exactly like a band showing every station the section has. It shares a
    // line with the series legend, right-aligned against the plot: both are
    // captions on the drawing above them, and two captions on two lines is
    // two rows of the sheet spent saying so.
    {
      const caption =
        band.shown >= band.total
          ? `Station data band - all ${band.total} stations shown`
          : `Station data band - ${band.shown} of ${band.total} stations shown (thinned to fit)`;
      text(
        page,
        caption,
        plotRight - font.widthOfTextAtSize(winAnsiSafe(caption), 7),
        bandBot - 13,
        7,
        font,
        INK_MUTED,
      );
    }

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
    text(page, scaleLine, M, bandBot - 30, 9.5, bold, INK);
    const axisTitle =
      system === 'metric' ? 'Chainage (station km+m)' : 'Chainage (100 ft stations)';
    text(
      page,
      axisTitle,
      plotRight - font.widthOfTextAtSize(winAnsiSafe(axisTitle), 8),
      bandBot - 30,
      8,
      font,
      INK_MUTED,
    );
  } else {
    text(page, 'No covered samples — nothing to plot.', plotLeft, plotTopY - 20, 11, font, INK_DIM);
  }

  // Chart legend swatch. The caption is the legend's own, so the plotted
  // series is named on the print exactly as it is named on screen. Clipped
  // against the space the band caption leaves on the same line, so a long
  // series name cannot print over it.
  page.drawLine({
    start: { x: M, y: bandBot - 11 },
    end: { x: M + 16, y: bandBot - 11 },
    thickness: 1.6,
    color: CURVE,
  });
  text(
    page,
    clipText(legend.caption, font, 8, plotRight - M - 22 - 190),
    M + 22,
    bandBot - 13.5,
    8,
    font,
    INK,
  );

  // Summary block (two columns of label:value). The Profile Intelligence
  // rows (gain/loss, steepest station range, located extremes — v0.4.5) come
  // from the shared pure module so they match the panel's summary exactly.
  const intel = computeProfileSummary(input.samples);
  const sumTop = bandBot - 103;

  // ── Headline figures ───────────────────────────────────────────────────
  // Five, deliberately: the two that dimension the drawing (length and
  // relief), the two an earthworks or alignment reader sizes cut and fill
  // from and cannot recover by eye from a curve (gain and loss, which differ
  // from relief exactly when the section rolls), and the one that decides
  // whether an alignment is buildable at all (max grade). Everything else the
  // sheet knows is reference material and is set as reference material below.
  //
  // The value is large and bold and the label small and quiet above it, so
  // the figure is what a reader lands on. The unit carries the accent: it is
  // the same ink as the section line, which ties the strip to the drawing,
  // and it leaves the digits themselves in the dominant ink, where they stay
  // the strongest thing on the page in colour and in greyscale alike.
  {
    const headline: Array<[string, string]> = [
      ['LENGTH', lenStr(len)],
      ['RELIEF', stats.reliefSpan == null ? '-' : lenStr(stats.reliefSpan)],
      ['HEIGHT GAIN', intel.gainM == null ? '-' : `+${lenStr(intel.gainM)}`],
      ['HEIGHT LOSS', intel.lossM == null ? '-' : `-${lenStr(intel.lossM)}`],
      ['MAX GRADE', formatGradePercent(stats.maxGrade)],
    ];
    const cellW = (PAGE_W - 2 * M) / headline.length;
    // The accent rule that opens the strip. Used here and on the section line
    // and nowhere else on the page, which is what keeps it an accent.
    page.drawLine({
      start: { x: M, y: sumTop + 58 },
      end: { x: PAGE_W - M, y: sumTop + 58 },
      thickness: 0.9,
      color: CURVE,
    });
    headline.forEach(([label, value], i) => {
      const x = M + i * cellW;
      trackedText(page, label, x, sumTop + 46, HEADLINE_LABEL_FONT, bold, INK_MUTED);
      // Split the trailing unit off the magnitude so the two can be set
      // differently. `formatGradePercent` puts the unit hard against the
      // digits; the length formatters space it.
      const safe = winAnsiSafe(value);
      const cut = safe.lastIndexOf(' ');
      const num = cut > 0 ? safe.slice(0, cut) : safe.replace(/%$/, '');
      const suffix = cut > 0 ? safe.slice(cut + 1) : safe.endsWith('%') ? '%' : '';
      const numW = bold.widthOfTextAtSize(num, HEADLINE_FONT);
      page.drawText(num, { x, y: sumTop + 22, size: HEADLINE_FONT, font: bold, color: INK });
      if (suffix !== '') {
        page.drawText(suffix, {
          x: x + numW + 3,
          y: sumTop + 22,
          size: 10,
          font: bold,
          color: CURVE,
        });
      }
    });
  }
  const contributing = record == null ? 0 : record.sources.filter((s) => s.contributed).length;
  // Reference material, not headlines. Relief, gain/loss and max grade are
  // NOT repeated here: they are set large in the headline strip from the same
  // formatters, and a figure printed twice on one sheet is a figure a reader
  // has to check against itself. Length stays, because it is the domain the
  // whole drawing is mapped over and the row a reader confirms the sheet by.
  // Mean and max grade share one row, so the pair reads as one comparison.
  const rows: Array<[string, string]> = [
    ['Length (horizontal)', lenStr(len)],
    [
      `${heightWord} min / max`,
      `${elevStr(stats.minElevation)}  /  ${elevStr(stats.maxElevation)}`,
    ],
    [
      'Mean grade',
      `${formatGradePercent(stats.meanGrade)}  (${formatGradeRatio(stats.meanGrade)}, ${formatGradeDegrees(stats.meanGrade)})`,
    ],
    [
      'Max grade (ratio, angle)',
      `${formatGradeRatio(stats.maxGrade)}, ${formatGradeDegrees(stats.maxGrade)}`,
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

  // Horizontal rules only. A box around every cell is more ink than the
  // figures it is meant to organise; two rules and a divider group the block
  // just as well and leave the reader's eye on the values. The top rule also
  // closes the headline strip above it, so one line does two jobs.
  page.drawLine({
    start: { x: M, y: sumTop + 10 },
    end: { x: PAGE_W - M, y: sumTop + 10 },
    thickness: 0.6,
    color: RULE,
  });
  page.drawLine({
    start: { x: M, y: wideTop + 8 },
    end: { x: PAGE_W - M, y: wideTop + 8 },
    thickness: 0.5,
    color: GRID,
  });
  page.drawLine({
    start: { x: M, y: panelBot },
    end: { x: PAGE_W - M, y: panelBot },
    thickness: 0.6,
    color: RULE,
  });

  layout.pairs.forEach((r, i) => {
    const col = i % 2;
    const line = Math.floor(i / 2);
    const x = M + col * colW;
    const y = sumTop - line * SUMMARY_ROW_H;
    text(page, r.label, x, y, SUMMARY_FONT, bold, INK_MUTED);
    text(page, r.value, x + layout.valueDx, y, SUMMARY_FONT, font, INK);
  });
  wideRows.forEach((r, i) => {
    const y = wideTop - i * SUMMARY_ROW_H;
    text(page, r.label, M, y, SUMMARY_FONT, bold, INK_MUTED);
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
  text(page, prov, M, M - 13, 7.5, font, INK_MUTED);

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
  // Prose wraps to a shorter measure than the source table needs. A line of
  // 8.5pt Helvetica across the full landscape width runs to about 140
  // characters, which is roughly twice a comfortable measure, and the reader
  // loses the start of the next line. The table keeps the full width because
  // its columns are what set it.
  const proseW = Math.round(usableW * 0.72);
  let page = doc.addPage([PAGE_W, PAGE_H]);
  drawSheetBorder(page);
  let y = PAGE_H - M - 4;

  const put = (s: string, x: number, yy: number, size: number, f: PDFFont, color = INK) =>
    page.drawText(winAnsiSafe(s), { x, y: yy, size, font: f, color });

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    drawSheetBorder(page);
    y = PAGE_H - M - 4;
    put('Method and provenance (continued)', M, y - 4, 13, bold);
    y -= 24;
  };
  const need = (h: number) => {
    if (y - h < bottom) newPage();
  };
  // Section headings on the provenance page: tracked small caps in the
  // dominant ink, over an accent hairline. Small, but unmistakably a heading,
  // which is what the run of same-size paragraphs underneath needs.
  const heading = (s: string) => {
    need(30);
    y -= 12;
    trackedText(page, s.toUpperCase(), M, y, 7.5, bold, INK);
    page.drawLine({
      start: { x: M, y: y - 4 },
      end: { x: M + usableW, y: y - 4 },
      thickness: 0.7,
      color: CURVE,
    });
    y -= 15;
  };
  const para = (s: string, size = 8.5, color = INK) => {
    for (const line of wrapText(s, font, size, proseW)) {
      need(13);
      put(line, M, y, size, font, color);
      y -= 11.5;
    }
    y -= 2.5;
  };

  put('Method and provenance', M, y - 4, 18, bold);
  y -= 21;
  put(input.name, M, y, 10, font, INK_MUTED);
  y -= 16;

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
      for (const c of cols) trackedText(page, c.head, c.x, y, 7, bold, INK_MUTED, 0.6);
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
  for (const line of wrapText(NOT_SURVEY_GRADE_NOTE, font, 7.5, proseW)) {
    need(11);
    put(line, M, y, 7.5, font, INK_MUTED);
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
  const topY = PAGE_H - M - 48;
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
    put('Station table', M, PAGE_H - M - 8, 18, bold);
    put(
      `${name} - STA, ${heightLabel(reference)} (${unit}), grade to next`,
      M,
      PAGE_H - M - 25,
      9,
      font,
      INK_MUTED,
    );
    page.drawLine({
      start: { x: M, y: PAGE_H - M - 36 },
      end: { x: PAGE_W - M, y: PAGE_H - M - 36 },
      thickness: 0.6,
      color: RULE,
    });

    for (let col = 0; col < colCount && idx < stations.length; col++) {
      const x = M + col * (colW + colGap);
      trackedText(page, 'STA', x, topY, 7, bold, INK_MUTED, 0.6);
      trackedText(page, columnHead, x + 78, topY, 7, bold, INK_MUTED, 0.6);
      trackedText(page, 'GRADE', x + 122, topY, 7, bold, INK_MUTED, 0.6);
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
