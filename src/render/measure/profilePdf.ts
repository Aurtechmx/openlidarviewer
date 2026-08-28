/**
 * profilePdf.ts
 *
 * Full-page PDF export of a Profile measurement, laid out as an engineering
 * drawing set rather than as a report. Four kinds of sheet, all A3 landscape,
 * all carrying the same border, general notes, title block and issue strip so
 * they read as one set:
 *
 *   - LONGITUDINAL PROFILE. A framed section chart with a survey grid, a
 *     rotated height axis, and the profile drawn as a straight polyline
 *     between adjacent samples, so no plotted height falls outside the two
 *     stations bracketing it (gaps stay breaks). Under it the station data
 *     band, and under that a ruled KPI band carrying the eight figures a
 *     reader takes off a section. The maximum grade is called out on the plot
 *     itself with a leader, because it is the figure that decides whether an
 *     alignment is buildable and it is invisible in a curve.
 *   - TECHNICAL NOTES. Every recorded quantity as a three-column table: what
 *     was recorded, the value, and an engineering remark saying how to read
 *     it. The remark column is the half a reader who did not build the export
 *     cannot reconstruct.
 *   - METHOD AND SOURCES. How the series was derived, in the on-screen
 *     legend's own sentences, the declared height reference and CRS, the
 *     contributing sources by stable layer id with their classification kind
 *     and read kind, the class-exclusion policy and how far it reached, and
 *     the identity of the provenance record itself.
 *   - STATION SCHEDULE. Chainage, height and grade per station in four column
 *     groups, so values are exact rather than eyeballed off the graph, with a
 *     legend stating what a gap and a dash mean.
 *
 * Any of the last three continues onto further sheets when the data needs
 * them. The title block's SHEET n / m takes m from the page count the
 * document actually reached, so the set always states its own size.
 *
 * Each fact is stated ONCE per sheet, in the one place a reader of a drawing
 * goes looking for it, because a sheet that answers a question twice makes
 * the reader check whether the two answers agree:
 *
 *   - identity and reference - the measurement name, the horizontal CRS, the
 *     sheet number, the status, the revision - belong to the title block, so
 *     no sheet header repeats them;
 *   - the headline figures of the section - length, relief, extremes, grades,
 *     coverage, gaps, corridor half width - belong to the KPI band;
 *   - the standing qualifications belong to the numbered general notes, which
 *     repeat on every sheet of the set on purpose, because a sheet that
 *     leaves the set carries its caveats with it;
 *   - the key beside the plotted line names the series and points at the note
 *     that states the method, rather than restating it a second time within
 *     an inch of it.
 *
 * A disclosure is not a repetition: the station band says how many of the
 * section's stations it had room to label, because a band showing one station
 * in twelve looks exactly like a band showing every one of them.
 *
 * The stated horizontal and vertical scales (1:N each), the resulting vertical
 * exaggeration and the print instruction sit in the plot header, so distances
 * and grades read off the print are unambiguous — a true civil section
 * convention. The exaggeration is the horizontal denominator over the vertical
 * one, because a smaller denominator is a larger drawing.
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
 *     reference is ever printed as an elevation. The rotated axis title is
 *     that same string: the axis is where a reader decides what the numbers
 *     beside it mean, so it is the last place a claim may be upgraded.
 *
 * pdf-lib is imported here so this whole module lands in its own lazy
 * chunk — the panel dynamic-imports it only when the user clicks Export.
 *
 * Pure of the DOM beyond producing bytes; the caller triggers download.
 * No clock: `generatedAt` is required, so the same input is the same bytes.
 */

import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
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
// Where the station band's columns land. Pure arithmetic over measured text,
// kept out of the builder so the geometry of the sheet can be asserted
// without reading a PDF back.
import { buildStationBand } from './profileSheetLayout';

/** Same constant the format/summary modules keep module-local. */
const FEET_PER_METRE = 3.280839895013123;

export interface ProfilePdfInput {
  /**
   * Measurement name. It is the PROJECT field of the title block, on every
   * sheet of the set, and it is printed nowhere else: a name repeated in a
   * sheet header is the same identity given twice on one sheet.
   */
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
   * height axis + summary + station schedule and US 100-ft stationing on
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

/**
 * A3 landscape, in points, and the sheet designation that names it.
 *
 * A3 rather than the US Letter this sheet used to be, because the readable
 * minimums this drawing is set at — 8pt in every table, 9pt in the schedule —
 * do not fit a Letter sheet alongside a title block, general notes and an
 * issue strip, and the answer to a crowded drawing is a larger sheet, never
 * smaller type. The designation is printed in the corner, and it is the size
 * actually emitted: a sheet that claims a size it is not is a sheet that
 * prints at the wrong scale.
 */
const PAGE_W = 1190.55;
const PAGE_H = 841.89;
const SHEET_SIZE = 'A3';
const M = 48;

/**
 * One ink, two colours, and neutrals mixed toward the ink rather than toward
 * pure grey, so nothing on the sheet reads as a third hue.
 *
 * `INK_DIM` is the plot frame's pen and is deliberately left at the value it
 * has always had: `profileSheet.test.ts` recovers the plot box out of the
 * content stream by that stroke colour, and the mapping it then checks the
 * station band against is only as trustworthy as the frame it was read from.
 * Nothing else on the sheet may be a 1pt horizontal line in this colour.
 */
const INK = rgb(0.09, 0.11, 0.15);
const INK_DIM = rgb(0.42, 0.46, 0.52);
/**
 * Secondary table text: the item column, the engineering remarks, the grade
 * column of the schedule. Darker than `INK_DIM`, which is a pen for hairlines
 * and captions and is too light to set a column of 8.5pt prose a reader is
 * expected to actually read.
 */
const INK_SOFT = rgb(0.3, 0.34, 0.4);
const INK_MUTED = rgb(0.53, 0.57, 0.63);
const GRID = rgb(0.83, 0.86, 0.9);
const GRID_MINOR = rgb(0.91, 0.93, 0.95);
/**
 * The first of the two colours: the section itself. Darker than a screen blue
 * on purpose: engineering sheets are printed on mono devices, and this
 * converts to roughly 31% luminance, which still separates from the ground
 * tint (84%) and from paper.
 */
const CURVE = rgb(0.05, 0.36, 0.56);
/**
 * The ground under the section: a desaturated tint of the section colour, not
 * a colour of its own. It sits behind the data and must never compete with
 * the line drawn on top of it. About a 16% tint in greyscale, which every
 * printer renders as an unambiguous fill rather than as almost-paper.
 */
const GROUND = rgb(0.78, 0.85, 0.91);
/**
 * The second colour, and its only job: a cell of the station schedule, or of
 * the station band, that says `gap` — a station where nothing returned.
 *
 * A reader scanning sixty-four rows for the holes in the data finds them at a
 * glance instead of reading every cell. It is coding a fact that is ALSO
 * carried by the word in the cell, which is what keeps the sheet whole in
 * greyscale: the colour is the fast path, the word is the answer. Dark enough
 * (about 38% luminance) to stay a legible mark on a mono printer rather than
 * fading toward the paper the way a bright orange would.
 */
const GAP_MARK = rgb(0.72, 0.31, 0.02);
const RULE = rgb(0.7, 0.74, 0.8);

/**
 * Type sizes, one constant per role, because a drawing that is readable in
 * its headline and unreadable in its schedule is not readable.
 *
 * Nothing on any sheet is set below 6.5pt, and nothing that carries a
 * measurement is set below 8pt: table bodies, schedule cells, band figures,
 * general notes and legend lines all sit at 8.5 or 9. Hierarchy is bought
 * with size, weight, case and tracking rather than by shrinking the lower
 * half of the sheet, which is what the previous pass did.
 *
 * Bold is spent deliberately and is reserved for: the sheet title, the sheet
 * name in the title block, section and table column headers, the KPI values,
 * the title-block values a reader is looking for, and any value that states a
 * limitation (`unknown`, `Not recorded`, `PRELIMINARY`). Everything else is
 * regular, the tracked labels included - a label set in caps at half the size
 * of its value already reads as a label, and bolding it spends the weight on
 * the word rather than on the figure. Bold runs to roughly a sixth of the
 * words on a sheet; past about a fifth it stops meaning anything.
 */
const T_TITLE = 18; // sheet title, bold
const T_STAMP = 9; // generation stamp, top right
const T_SCALE = 10; // the scale + exaggeration + print statement, bold
const T_AXIS = 10; // axis titles
const T_TICK = 9; // grid tick figures, monospaced
const T_BAND = 9.5; // station band figures, monospaced
const T_CAPTION = 9.5; // band caption and chart legend
const T_KPI_LABEL = 8.5; // KPI cell label, tracked caps, bold
const T_KPI_VALUE = 18; // KPI cell value, bold
const T_CALLOUT = 9; // the leader-line callout headline, bold
const T_CALLOUT_SUB = 9; // the station range under it
const T_NOTE_HEAD = 9; // GENERAL NOTES heading, tracked caps, bold
const T_NOTE = 9.5; // a numbered general note
const T_TB_LABEL = 7.5; // title-block field label, tracked caps, bold
const T_TB_VALUE = 10.5; // title-block field value
const T_TB_EYEBROW = 8; // TERRAIN PROFILE over the sheet name, tracked, bold
const T_TB_NAME = 15; // the sheet name, bold
const T_TB_DESC = 9.5; // the one-line descriptor under it
const T_ISSUE_HEAD = 9.5; // issue strip column headers, bold
const T_TABLE_HEAD = 9.5; // table column headers, tracked caps, bold
const T_TABLE = 10; // table body
const T_REMARK = 9.5; // the engineering remark column
const T_SECTION = 9; // a section heading on sheet 2, tracked caps, bold
const T_PARA = 10; // body prose on sheet 2
const T_SOURCE = 9.5; // the source table, monospaced
const T_SCHED = 10; // station schedule cells, monospaced
const T_SHEET_SIZE = 9; // the sheet-size designation in the corner

/** Extra space inserted between letters of an uppercase tracked label. */
const TRACK = 0.9;
/** Inset of the sheet border from the page edge. */
const BORDER_INSET = 22;

/**
 * The sheet furniture reserves the bottom of every page: the issue strip
 * along the very bottom, and the general notes and title block above it.
 * Drawing content below this is drawing content over the title block.
 */
const ISSUE_BOT = 36;
const ISSUE_ROW_H = 16;
/** Header row plus three blank rows: a form, sized to be written in by hand. */
const ISSUE_ROWS = 4;
const ISSUE_TOP = ISSUE_BOT + ISSUE_ROWS * ISSUE_ROW_H;
const FURNITURE_BOT = ISSUE_TOP + 10;
const FURNITURE_TOP = FURNITURE_BOT + 136;
/** The lowest y any page may draw content at. */
const CONTENT_BOT = FURNITURE_TOP + 12;

/** Width of the title block, and the gutter between it and the notes. */
const TITLE_BLOCK_W = 470;
const TITLE_BLOCK_GUTTER = 26;

/**
 * Left stub of the station band, and so the left margin of the plot: the band
 * rules under the section and its row headings sit beside them, so one number
 * fixes both. Wide enough for the longest height heading `heightLabel` can
 * return at the size the band is set at, because a heading that has to be
 * trimmed loses the qualification it was printed to carry.
 */
const STUB_W = 152;
/** Column reserved at the far left for the rotated height-axis title. */
const AXIS_COL = 22;
/**
 * Strip between the plot's bottom edge and the top of the station band, for
 * the grid's own round-interval stationing. The band's stations fall where the
 * samples fall, which is not on round numbers, so the two rows answer
 * different questions and both are wanted.
 */
const GRID_LABEL_STRIP = 20;
/** Height of one station-band row. */
const BAND_ROW_H = 16;
/** Clear space either side of a band figure before it counts as a collision. */
const BAND_PAD = 5;

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

/** Draw one WinAnsi-safe string. Every string on this sheet goes through it. */
function put(
  p: PDFPage,
  s: string,
  x: number,
  y: number,
  size: number,
  f: PDFFont,
  color = INK,
): void {
  p.drawText(winAnsiSafe(s), { x, y, size, font: f, color });
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
 * A column head short enough for the station schedule, and true for the
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

/** One straight ruled segment. Every rule on this sheet is drawn through it. */
function rule(
  p: PDFPage,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: ReturnType<typeof rgb>,
  thickness: number,
): void {
  p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
}

/**
 * A stroked box, drawn as four independent segments.
 *
 * Not `drawRectangle`, which emits one closed four-segment path. The profile
 * polyline is the only run of consecutive linetos this sheet is supposed to
 * contain - it is how a reader of the file, and the gap tests, tell a
 * continuous section from one broken at a station with no returns - and a
 * rectangle anywhere on any page adds a three-lineto run that is
 * indistinguishable from a drawn profile. This sheet is now full of ruled
 * tables - the title block, the issue strip, the KPI band - and every one of
 * their cells is ruled through this helper or through `rule` for the same
 * reason.
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
 * is what lets a 7.5pt label sit quietly over a figure twice its size.
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

/** The one-line form of the class-exclusion policy, for the notes table. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Sheet furniture: title block, issue strip, general notes
// ─────────────────────────────────────────────────────────────────────────────

/** The three standard fonts, passed around as one bag. */
interface Faces {
  readonly font: PDFFont;
  readonly bold: PDFFont;
  readonly mono: PDFFont;
  /** Courier-Bold, for the measured figure in a row of otherwise quiet cells. */
  readonly monoBold: PDFFont;
}

/** What the title block on one sheet states, beyond the set-wide fields. */
interface SheetIdentity {
  /** The large name of this sheet: LONGITUDINAL PROFILE, TECHNICAL NOTES, … */
  readonly sheetName: string;
  /** One line saying what is on it. */
  readonly descriptor: string;
}

/** The set-wide title-block fields, the same on every sheet. */
interface SetIdentity {
  /** The measurement name; the closest thing this export has to a project. */
  readonly project: string;
  /** Horizontal CRS as declared, or null when the scan is not georeferenced. */
  readonly crs: string | null;
  /** The numbered general notes, already composed. */
  readonly notes: readonly string[];
}

/**
 * The title block, bottom right, ruled into cells.
 *
 * Two rows of three fields over a name block, which is the arrangement a
 * reader of drawings already knows: the fields that identify the sheet within
 * the set on top, the name of the sheet itself set large underneath.
 *
 * `SHEET n / m` takes `total` from the page count the document actually
 * reached, never from a constant — a sheet that says 1 of 3 in a four-sheet
 * set has lost a sheet and the reader has no way to know.
 *
 * Three of the values state a limitation rather than a fact, and each is set
 * bold for the same reason a measured value is: `PRELIMINARY` because nothing
 * here is issued for construction, `Not recorded` where the export carries no
 * CRS, and `Not assigned` because a drawing number belongs to whoever files
 * the drawing and inventing one here would be a fabricated identity.
 */
function drawTitleBlock(
  p: PDFPage,
  f: Faces,
  set: SetIdentity,
  sheet: SheetIdentity,
  index: number,
  total: number,
): void {
  const x0 = PAGE_W - M - TITLE_BLOCK_W;
  const x1 = PAGE_W - M;
  const top = FURNITURE_TOP;
  const bot = FURNITURE_BOT;
  const rowA = top - 30; // bottom of the PROJECT / STATUS / SHEET row
  const rowB = rowA - 30; // bottom of the CRS / DRAWING NO. / REV. row
  // Two thirds of the block to the first field, then two quarter fields: a
  // project name is long and a revision is one character.
  const c1 = x0 + 235;
  const c2 = x0 + 352.5;

  strokeBox(p, x0, bot, TITLE_BLOCK_W, top - bot, INK, 1.2);
  rule(p, x0, rowA, x1, rowA, INK, 0.6);
  rule(p, x0, rowB, x1, rowB, INK, 0.6);
  for (const y of [rowA, rowB]) {
    rule(p, c1, y, c1, y + 30, INK, 0.6);
    rule(p, c2, y, c2, y + 30, INK, 0.6);
  }

  const cell = (
    x: number,
    w: number,
    yTop: number,
    label: string,
    value: string,
    strong: boolean,
  ) => {
    trackedText(p, label, x + 7, yTop - 11, T_TB_LABEL, f.font, INK_MUTED, 0.7);
    const face = strong ? f.bold : f.font;
    put(p, clipText(value, face, T_TB_VALUE, w - 14), x + 7, yTop - 25, T_TB_VALUE, face, INK);
  };

  cell(x0, 235, top, 'PROJECT', set.project.trim() !== '' ? set.project : 'Unnamed', true);
  cell(c1, 117.5, top, 'STATUS', 'PRELIMINARY', true);
  cell(c2, TITLE_BLOCK_W - 352.5, top, 'SHEET', `${index} / ${total}`, true);
  cell(x0, 235, rowA, 'HORIZONTAL CRS', set.crs ?? 'Not recorded', set.crs == null);
  cell(c1, 117.5, rowA, 'DRAWING NO.', 'Not assigned', true);
  cell(c2, TITLE_BLOCK_W - 352.5, rowA, 'REV.', '-', false);

  trackedText(p, 'TERRAIN PROFILE', x0 + 7, rowB - 14, T_TB_EYEBROW, f.font, INK_MUTED, 1.1);
  put(
    p,
    clipText(sheet.sheetName, f.bold, T_TB_NAME, TITLE_BLOCK_W - 14),
    x0 + 7,
    rowB - 36,
    T_TB_NAME,
    f.bold,
    INK,
  );
  const desc = wrapText(sheet.descriptor, f.font, T_TB_DESC, TITLE_BLOCK_W - 14);
  desc.slice(0, 2).forEach((line, i) => {
    put(p, line, x0 + 7, rowB - 52 - i * 11, T_TB_DESC, f.font, INK_DIM);
  });
}

/**
 * The issue / revision strip along the very bottom of every sheet.
 *
 * Ruled and empty. It is a form, not data: an issue is something a person or
 * a later revision of this drawing records, and a fresh export has had none.
 *
 * The DATE cells stay blank in particular. Filling one from the clock would
 * be the one thing this builder refuses to do anywhere else — the sheet is
 * byte-reproducible precisely because no part of it reads the time — and a
 * date against an issue nobody made would also be a record of an event that
 * did not happen.
 */
function drawIssueStrip(p: PDFPage, f: Faces): void {
  const x0 = M;
  const x1 = PAGE_W - M;
  const w = x1 - x0;
  const cols = [
    { head: 'ISSUE', w: 66 },
    { head: 'DESCRIPTION', w: w - 66 - 110 - 78 - 78 },
    { head: 'DATE', w: 110 },
    { head: 'BY', w: 78 },
    { head: 'CHK', w: 78 },
  ];
  strokeBox(p, x0, ISSUE_BOT, w, ISSUE_TOP - ISSUE_BOT, INK, 1.2);
  for (let r = 1; r < ISSUE_ROWS; r++) {
    const y = ISSUE_BOT + r * ISSUE_ROW_H;
    rule(p, x0, y, x1, y, RULE, 0.5);
  }
  // The header row's own baseline rule is heavier than the blank-row rules:
  // it separates a heading from a form, and the blank rows are ruled only
  // enough to write between.
  rule(p, x0, ISSUE_TOP - ISSUE_ROW_H, x1, ISSUE_TOP - ISSUE_ROW_H, INK, 0.6);
  let x = x0;
  for (const c of cols) {
    if (x > x0) rule(p, x, ISSUE_BOT, x, ISSUE_TOP, INK, 0.6);
    put(p, c.head, x + 7, ISSUE_TOP - 11, T_ISSUE_HEAD, f.bold, INK);
    x += c.w;
  }
}

/**
 * The general notes, bottom left, numbered.
 *
 * Numbered because a note on a drawing is referred to by its number, and
 * because a numbered list is read as a list of separate statements while a
 * paragraph is read as one. Every caveat the sheet carries is here in full:
 * what the surface is and that it is estimated rather than measured, what the
 * heights are measured from, what was read, and what the sheet is suitable
 * for.
 */
function drawGeneralNotes(p: PDFPage, f: Faces, notes: readonly string[]): void {
  const x0 = M;
  const w = PAGE_W - M - TITLE_BLOCK_W - TITLE_BLOCK_GUTTER - M;
  trackedText(p, 'GENERAL NOTES', x0, FURNITURE_TOP - 11, T_NOTE_HEAD, f.bold, INK, 1.0);
  rule(p, x0, FURNITURE_TOP - 17, x0 + w, FURNITURE_TOP - 17, RULE, 0.6);
  let y = FURNITURE_TOP - 30;
  notes.forEach((note, i) => {
    const lines = wrapText(note, f.font, T_NOTE, w - 18);
    lines.forEach((line, li) => {
      if (y < FURNITURE_BOT + 2) return;
      if (li === 0) put(p, `${i + 1}.`, x0, y, T_NOTE, f.font, INK_DIM);
      put(p, line, x0 + 18, y, T_NOTE, f.font, INK);
      y -= 11.5;
    });
    y -= 2.5;
  });
}

/** Everything that is on every sheet of the set, drawn after the content. */
function drawFurniture(
  p: PDFPage,
  f: Faces,
  set: SetIdentity,
  sheet: SheetIdentity,
  index: number,
  total: number,
): void {
  drawSheetBorder(p);
  drawGeneralNotes(p, f, set.notes);
  drawTitleBlock(p, f, set, sheet, index, total);
  drawIssueStrip(p, f);
  // The sheet size, in the corner, so a reader who prints this knows what
  // paper the stated scales are true on.
  trackedText(
    p,
    SHEET_SIZE,
    BORDER_INSET + 8,
    BORDER_INSET + 7,
    T_SHEET_SIZE,
    f.bold,
    INK_MUTED,
    1.2,
  );
}

/**
 * The header every sheet opens with: the sheet's own title left, the
 * generation stamp right, a closing rule under both.
 *
 * It carries no measurement name, no CRS and no sampler settings. Every one
 * of those is a field of the title block or a cell of the KPI band, which is
 * where a reader of a drawing goes looking for them, and a header that
 * repeats them makes a reader check whether the two copies agree.
 */
function drawSheetHeader(p: PDFPage, f: Faces, title: string, stamp: string): number {
  const top = PAGE_H - M;
  put(p, title, M, top - T_TITLE, T_TITLE, f.bold, INK);
  put(
    p,
    stamp,
    PAGE_W - M - f.font.widthOfTextAtSize(winAnsiSafe(stamp), T_STAMP),
    top - T_TITLE,
    T_STAMP,
    f.font,
    INK_MUTED,
  );
  rule(p, M, top - 46, PAGE_W - M, top - 46, RULE, 0.6);
  return top - 46;
}

// ─────────────────────────────────────────────────────────────────────────────
// The builder
// ─────────────────────────────────────────────────────────────────────────────

/** One emitted page, with what its title block should say about it. */
interface EmittedSheet {
  readonly page: PDFPage;
  readonly identity: SheetIdentity;
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
  const f: Faces = {
    font: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
  };

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
  const intel = computeProfileSummary(input.samples);
  const gapCount = stats.stations.filter((s) => s.elevation == null).length;

  // The notes are the sheet's honesty, and they are on every sheet of the set
  // because a sheet that leaves the set carries its caveats with it.
  const notes: string[] = [
    `${legend.seriesLabel}. Estimated, not measured.`,
    `Vertical reference: ${heightWord}. ${heightReferenceNote(reference)}`,
    record == null
      ? 'Provenance: no record of the sources read was attached to this export, so the ' +
        'contributing sources and the read scope are not recorded on this drawing.'
      : `Provenance: ${describeProfileProvenance(record)}`,
    NOT_SURVEY_GRADE_NOTE +
      (residentOnly
        ? ' Sampled from streaming-resident points only - may refine as more data loads.'
        : ''),
  ];
  const set: SetIdentity = { project: input.name, crs: input.crs ?? null, notes };
  const sheets: EmittedSheet[] = [];

  // ── Sheet 1: the longitudinal profile ──────────────────────────────────
  const page = doc.addPage([PAGE_W, PAGE_H]);
  sheets.push({
    page,
    identity: {
      sheetName: 'LONGITUDINAL PROFILE',
      descriptor: 'Section along the measured alignment, with the station data band beneath it.',
    },
  });

  // `Terrain Profile` is drawn as one string, untracked: it is how the
  // sheet's own tests find sheet one.
  const headerBot = drawSheetHeader(
    page,
    f,
    'Terrain Profile',
    `Generated ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  );

  // Plot box (pdf coords, y up).
  const plotLeft = M + AXIS_COL + STUB_W;
  const plotRight = PAGE_W - M - 6;
  const plotW = plotRight - plotLeft;
  const scaleLineY = headerBot - 18;
  const plotTopY = scaleLineY - 16; // y-up coordinate of the TOP edge
  const plotH = 300;
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
      rule(page, x, plotTopY, x, plotBotY, GRID, 0.5);
      // Round-interval stationing under the grid. The band below carries the
      // stations the samples actually fall on, which are not round numbers;
      // this row is what lets a reader take a chainage off the grid itself.
      const tick = formatStation(cD / k, system);
      put(
        page,
        tick,
        x - f.mono.widthOfTextAtSize(tick, T_TICK) / 2,
        plotBotY - 13,
        T_TICK,
        f.mono,
        INK_MUTED,
      );
    }
    const vInt = niceInterval(elSpan * k);
    for (
      let eD = Math.ceil((minEl * k) / vInt) * vInt, n = 0;
      eD <= maxEl * k + 1e-9 && n < 64;
      eD += vInt, n++
    ) {
      const y = plotTopY - mapYdown(eD / k);
      rule(page, plotLeft, y, plotRight, y, GRID_MINOR, 0.5);
      // Right-aligned against the axis: a column of heights is read down its
      // last digit, and a left-aligned column of different-width numbers puts
      // the units, tens and hundreds places in three different columns.
      const tick = `${eD.toFixed(1)}`;
      put(
        page,
        tick,
        plotLeft - 5 - f.mono.widthOfTextAtSize(tick, T_TICK),
        y - 3,
        T_TICK,
        f.mono,
        INK_DIM,
      );
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

    // The height axis title, rotated to read up the left edge of the plot.
    // It is `heightLabel`'s own string and nothing else: the axis is where a
    // reader decides what the figures beside it mean, so an undeclared datum
    // says so here rather than three blocks away.
    {
      const title = `${heightWord} (${unit})`;
      const w = f.bold.widthOfTextAtSize(winAnsiSafe(title), T_AXIS);
      page.drawText(winAnsiSafe(title), {
        x: M + 12,
        y: plotBotY + (plotH - w) / 2,
        size: T_AXIS,
        font: f.bold,
        color: INK_DIM,
        rotate: degrees(90),
      });
    }

    // The maximum grade, called out on the drawing where it happens.
    drawMaxGradeCallout(page, f, {
      steepest: intel.steepest,
      stations: stats.stations,
      mapX,
      mapYdown,
      plotTopY,
      plotBotY,
      plotLeft,
      plotRight,
      system,
    });

    // ── Station data band (the civil "guitarra") ───────────────────────
    // One ruled row per quantity, columns dropped from the same x mapping the
    // polyline was drawn with, so a vertical from the curve lands on its own
    // figures. Row headings sit in the fixed stub at the left.
    const partialStr = (m: number | null) => (m == null ? '-' : (m * k).toFixed(1));
    const bandHeightStr = (m: number | null) => (m == null ? 'gap' : (m * k).toFixed(2));
    const bandMeasure = (t: string) => f.mono.widthOfTextAtSize(winAnsiSafe(t), T_BAND) + BAND_PAD;
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
      fontSize: T_BAND,
    });

    const stubX = M + AXIS_COL;
    const bandRows: Array<[string, (i: number) => string]> = [
      [`Partial dist. (${unit})`, (i) => partialStr(band.columns[i].partial)],
      ['Chainage', (i) => formatStation(band.columns[i].chainage, system)],
      [`${heightWord} (${unit})`, (i) => bandHeightStr(band.columns[i].height)],
    ];
    for (let r = 0; r <= bandRows.length; r++) {
      const y = bandTop - r * BAND_ROW_H;
      rule(page, stubX, y, plotRight, y, RULE, 0.5);
    }
    // Horizontal rules, and the single vertical that separates the stub from
    // the figures. Not a border per cell: a full grid of cell borders is more
    // ink than the figures it is meant to organise, and the columns are
    // already tied to the curve by their own drop lines.
    rule(page, plotLeft, bandTop, plotLeft, bandBot, RULE, 0.5);
    bandRows.forEach(([head], r) => {
      const y = bandTop - (r + 1) * BAND_ROW_H + 5;
      put(page, clipText(head, f.bold, T_BAND, STUB_W - 10), stubX, y, T_BAND, f.bold, INK_MUTED);
    });
    band.columns.forEach((c, i) => {
      // A tick hung off the plot's own bottom edge, at the column's x. It
      // stops there rather than running the depth of the band: a rule
      // continued through three rows of centred figures crosses every one of
      // them through the middle, and a hairline drawn over a digit is a
      // hairline drawn over a digit however light it is.
      rule(page, c.x, plotBotY, c.x, plotBotY - 5, INK_DIM, 0.5);
      bandRows.forEach(([, cell], r) => {
        const t = winAnsiSafe(cell(i));
        const y = bandTop - (r + 1) * BAND_ROW_H + 5;
        // The height row is the measured one, so it carries the weight the way
        // the schedule's height column does. Partial distance and chainage
        // describe WHERE the station is rather than what was found there.
        const measured = r === bandRows.length - 1 && t !== 'gap';
        // Courier throughout, so the figures of one row line up digit under
        // digit whatever their magnitude. A cell that says `gap` takes the
        // gap colour, the same mark the station schedule uses for the same
        // fact, and the word carries it on a mono printer.
        put(
          page,
          t,
          c.x - (measured ? f.monoBold : f.mono).widthOfTextAtSize(t, T_BAND) / 2,
          y,
          T_BAND,
          measured ? f.monoBold : f.mono,
          t === 'gap' ? GAP_MARK : INK,
        );
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
      put(
        page,
        caption,
        plotRight - f.font.widthOfTextAtSize(winAnsiSafe(caption), T_CAPTION),
        bandBot - 16,
        T_CAPTION,
        f.font,
        INK_MUTED,
      );
    }

    // Stated scales + VEX + the print instruction, in the plot header where a
    // reader looks before taking a measurement off the paper.
    const hScale = scaleRatio(len, plotW);
    const vScale = scaleRatio(elSpan, plotH);
    // `scaleRatio` returns the DENOMINATOR of a 1:N scale, so a SMALLER value
    // is a LARGER drawing. Vertical 1:73 beside horizontal 1:386 means the
    // relief is drawn 386/73 times taller than the run, which is the
    // exaggeration. The reciprocal would report a compression on a sheet whose
    // relief is stretched, and every grade read off it would be wrong by the
    // square of the error the reader was told to correct for.
    const vex = vScale > 0 ? hScale / vScale : 1;
    // The print instruction is part of the scale statement, not a footnote:
    // every ratio on this line is false on a sheet scaled to fit.
    const scaleLine =
      `Horizontal 1:${Math.round(hScale)}   ·   Vertical 1:${Math.round(vScale)}   ·   ` +
      `Vertical exaggeration ${vex.toFixed(1)}:1   |   PRINT AT 100% ON ${SHEET_SIZE}`;
    put(page, scaleLine, M, scaleLineY, T_SCALE, f.bold, INK);
    const axisTitle =
      system === 'metric' ? 'Chainage (station km+m)' : 'Chainage (100 ft stations)';
    put(
      page,
      axisTitle,
      plotRight - f.font.widthOfTextAtSize(winAnsiSafe(axisTitle), T_AXIS),
      scaleLineY,
      T_AXIS,
      f.font,
      INK_MUTED,
    );
  } else {
    put(page, 'No covered samples — nothing to plot.', plotLeft, plotTopY - 20, 11, f.font, INK_DIM);
  }

  // Chart legend swatch: the pen, the name of the series it draws, and the
  // number of the note that says what the series is.
  //
  // The name is the legend's own, so the plotted series is named on the print
  // exactly as it is named on screen. What the name does NOT carry here is
  // the method, the station count or the gap count: general note 1 states the
  // method in full on this sheet and on every other sheet of the set, the
  // band caption below states how many stations are drawn, and the KPI band
  // states how many returned nothing. A key that restated all three would put
  // the same three facts twice on one sheet and give a reader two wordings to
  // reconcile. Clipped against the space the band caption leaves on the same
  // line, so a long series name cannot print over it.
  rule(page, M, bandBot - 13, M + 18, bandBot - 13, CURVE, 1.6);
  put(
    page,
    clipText(`${legend.seriesName} - see general note 1`, f.font, T_CAPTION, plotRight - M - 26 - 240),
    M + 26,
    bandBot - 16,
    T_CAPTION,
    f.font,
    INK,
  );

  // ── The KPI band ───────────────────────────────────────────────────────
  // The magnitude only: the unit is stated once, in the cell's label. The
  // length formatter is still the one that produces the figure, so the KPI
  // and the notes table cannot round the same quantity two ways.
  const bare = (s: string) => s.replace(/\s+(m|ft)$/, '').replace(/%$/, '');
  drawKpiBand(page, f, bandBot - 32, [
    { label: `LENGTH (${unit})`, value: bare(lenStr(len)) },
    {
      label: `RELIEF (${unit})`,
      value: stats.reliefSpan == null ? '-' : bare(lenStr(stats.reliefSpan)),
    },
    {
      label: `MIN / MAX (${unit})`,
      value:
        minEl == null || maxEl == null
          ? '-'
          : `${(minEl * k).toFixed(2)} / ${(maxEl * k).toFixed(2)}`,
      // Two figures and a separator in one cell, so it is given two cells of
      // width. A pair set in a cell sized for a single figure is a pair with
      // its second half trimmed off, and a trimmed height is a wrong height.
      span: 2,
    },
    { label: 'MEAN GRADE (%)', value: bare(formatGradePercent(stats.meanGrade)) },
    // Signed steepest grade: the panel, the callout, and this KPI must agree on
    // sign for one profile. stats.maxGrade is an unsigned magnitude; intel.maxGrade
    // is the signed steepest-section grade (same segment). The ratio/degrees row
    // below stays magnitude on purpose.
    { label: 'MAX GRADE (%)', value: bare(formatGradePercent(intel.maxGrade)) },
    { label: 'COVERAGE (%)', value: `${(stats.coverage * 100).toFixed(0)}` },
    { label: 'GAPS', value: `${gapCount}` },
    {
      label: `CORRIDOR +/- (${unit})`,
      value: input.corridorWidthM != null ? (input.corridorWidthM * k).toFixed(2) : 'auto',
    },
  ]);

  // ── Sheet 2: technical notes ───────────────────────────────────────────
  const contributing = record == null ? 0 : record.sources.filter((s) => s.contributed).length;
  // ITEM / RECORDED INFORMATION / ENGINEERING REMARK. The remark column is
  // what makes the sheet readable by someone who did not build the export:
  // the value alone does not say what it governs or how far it can be
  // trusted. `limit` marks a value that states a limitation rather than a
  // measurement, which is set bold for the same reason a measurement is.
  const notesRows: Array<{ item: string; value: string; remark: string; limit?: boolean }> = [
    {
      item: 'Length (horizontal)',
      value: lenStr(len),
      remark: 'Chainage along the alignment. Not slope distance over the terrain surface.',
    },
    {
      item: `${heightWord} min / max`,
      value: `${elevStr(stats.minElevation)}  /  ${elevStr(stats.maxElevation)}`,
      remark: 'Extremes of the plotted surface, read against the vertical reference below.',
    },
    {
      item: 'Relief',
      value: stats.reliefSpan == null ? '—' : lenStr(stats.reliefSpan),
      remark: 'Max minus min. Smaller than the total climb wherever the section rolls.',
    },
    {
      item: 'Height gain / loss',
      value:
        intel.gainM == null || intel.lossM == null
          ? '—'
          : `+${lenStr(intel.gainM)}  /  -${lenStr(intel.lossM)}`,
      remark: 'Summed rise and fall over every station pair. What cut and fill is sized from.',
    },
    {
      item: 'Mean grade',
      value: `${formatGradePercent(stats.meanGrade)}  (${formatGradeRatio(stats.meanGrade)}, ${formatGradeDegrees(stats.meanGrade)})`,
      remark: 'Net grade end to end. Local grades reach the maximum below.',
    },
    {
      item: 'Max grade (ratio, angle)',
      value: `${formatGradeRatio(stats.maxGrade)}, ${formatGradeDegrees(stats.maxGrade)}`,
      remark: 'The steepest station pair. Governs whether an alignment is buildable.',
    },
    {
      item: 'Steepest section',
      value:
        intel.steepest == null
          ? '—'
          : `${formatStation(intel.steepest.fromChainage, system)} -> ` +
            `${formatStation(intel.steepest.toChainage, system)}  ` +
            `(${formatGradePercent(intel.steepest.grade)})`,
      remark: 'Where that maximum was measured. Called out on the profile sheet.',
    },
    {
      item: `Highest / Lowest ${heightWord.toLowerCase()}`,
      value:
        intel.highest == null || intel.lowest == null
          ? '—'
          : `${formatProfileExtreme(intel.highest, system)}  /  ` +
            `${formatProfileExtreme(intel.lowest, system)}`,
      remark: 'Located at a sampled station, never interpolated between two of them.',
    },
    {
      item: 'Samples · coverage',
      value: `${stats.sampleCount}  ·  ${(stats.coverage * 100).toFixed(0)}%`,
      remark:
        gapCount === 0
          ? 'Every station returned. No part of the section is interpolated.'
          : `${gapCount} station(s) had no return in the corridor and are drawn as breaks.`,
      limit: gapCount > 0,
    },
    {
      item: 'Corridor half-width',
      value: input.corridorWidthM != null ? lenStr(input.corridorWidthM) : 'auto (5% of length)',
      remark: 'Returns further from the line than this were not sampled into the section.',
    },
    {
      item: 'Sources read',
      value: record == null ? 'Not recorded' : `${record.sources.length} (${contributing} contributing)`,
      remark: 'A source that contributed nothing also filtered nothing from the section.',
      limit: record == null,
    },
    {
      item: 'Vertical reference',
      value: reference,
      remark: heightReferenceNote(reference),
      limit: reference === 'unknown' || reference === 'local',
    },
    {
      item: 'Horizontal CRS',
      value: input.crs ?? '— (not georeferenced)',
      remark: 'Chainage is measured in this frame. Without one, distances are frame-local.',
      limit: input.crs == null,
    },
    {
      item: 'Vertical datum',
      value: datumKnown ? (input.verticalDatum ?? '—') : DATUM_CONFLICT_MEASURE_NOTICE,
      remark: 'A datum the tables do not recognise is not upgraded to a sea-level elevation.',
      limit: !datumKnown || input.verticalDatum == null,
    },
    {
      item: 'Derived series',
      value: legend.seriesLabel,
      remark: 'The series is never named after a terrain class the sources cannot certify.',
    },
    {
      item: 'Class exclusion',
      value: exclusionSummary(legend),
      remark: 'Partial means the exclusion did not reach every source under the section.',
      limit: legend.exclusionScope !== 'every-source',
    },
    {
      item: 'Read scope',
      value: record == null ? 'Not recorded' : describeProfileProvenance(record),
      remark: 'A resident snapshot may refine as more of the source streams in.',
      limit: record == null || residentOnly,
    },
  ];

  renderTechnicalNotes(doc, f, sheets, { rows: notesRows });

  // ── Sheet 3: method and sources ────────────────────────────────────────
  renderMethodSheet(doc, f, sheets, {
    legend,
    record,
    reference,
    crs: input.crs ?? null,
    verticalDatum: datumKnown ? (input.verticalDatum ?? null) : null,
    datumKnown,
  });

  // ── Sheet 4+: the station schedule ─────────────────────────────────────
  renderStationSchedule(doc, f, sheets, stats.stations, system, reference);

  // The furniture is stamped LAST, once every page exists, so `SHEET n / m`
  // takes its total from the page count the document actually reached.
  const total = doc.getPageCount();
  sheets.forEach((s, i) => drawFurniture(s.page, f, set, s.identity, i + 1, total));

  return doc.save();
}

/** One cell of the KPI band. `span` buys a cell the width of two. */
interface KpiCell {
  readonly label: string;
  readonly value: string;
  readonly span?: number;
}

/**
 * The ruled KPI band under the section: the eight figures a reader takes off
 * a profile, each in its own cell with a quiet tracked label over it.
 *
 * This band is where the headline figures of the section live, and it is the
 * only place on the sheet that states them: the corridor half width, the
 * coverage and the gap count are cells here rather than a line of small print
 * in the sheet header.
 *
 * Ruled into cells rather than set as a row of headings, because a cell is
 * what tells a reader that the label above a figure belongs to that figure
 * and not to the one beside it. Every rule is an independent segment: a
 * cell drawn as a rectangle would add a three-lineto run to the content
 * stream, which is the one thing this document may not contain outside the
 * profile itself.
 *
 * The unit rides in the label rather than beside the figure, so the cells
 * read as one row of magnitudes. A band that spells the unit out beside some
 * values and hides it in the label of others makes a reader check each cell
 * for which convention it followed.
 */
function drawKpiBand(p: PDFPage, f: Faces, top: number, cells: ReadonlyArray<KpiCell>): void {
  const x0 = M;
  const x1 = PAGE_W - M;
  const h = 56;
  const units = cells.reduce((n, c) => n + (c.span ?? 1), 0);
  const unitW = (x1 - x0) / units;
  // The accent rule that opens the band, used here and on the section line
  // and nowhere else on the sheet, which is what keeps it an accent.
  rule(p, x0, top, x1, top, CURVE, 1);
  rule(p, x0, top - h, x1, top - h, RULE, 0.6);
  let x = x0;
  for (const [i, cell] of cells.entries()) {
    const w = unitW * (cell.span ?? 1);
    if (i > 0) rule(p, x, top - h, x, top, RULE, 0.5);
    trackedText(p, cell.label, x + 8, top - 16, T_KPI_LABEL, f.font, INK_MUTED);
    put(
      p,
      clipText(cell.value, f.bold, T_KPI_VALUE, w - 16),
      x + 8,
      top - 44,
      T_KPI_VALUE,
      f.bold,
      INK,
    );
    x += w;
  }
}

interface CalloutInput {
  readonly steepest: ReturnType<typeof computeProfileSummary>['steepest'];
  readonly stations: ReturnType<typeof computeCivilProfileStats>['stations'];
  readonly mapX: (chainage: number) => number;
  readonly mapYdown: (elevation: number) => number;
  readonly plotTopY: number;
  readonly plotBotY: number;
  readonly plotLeft: number;
  readonly plotRight: number;
  readonly system: UnitSystem;
}

/**
 * The maximum grade, marked on the drawing with a leader.
 *
 * A grade is the one quantity on a section that a reader cannot recover by
 * eye: on a sheet with a stated vertical exaggeration the steepest place does
 * not even look steepest by the ratio it is. Naming it in a table leaves the
 * reader to find it on the drawing; a leader puts the figure where it
 * happens.
 *
 * The leader is a diagonal and a horizontal shoulder, each an independent
 * stroke, and the marker at the point is a cross of two more. Nothing here
 * closes a path.
 *
 * The label flips to whichever side of the point has room, so a maximum near
 * the right edge of the plot does not print over the frame.
 */
function drawMaxGradeCallout(p: PDFPage, f: Faces, input: CalloutInput): void {
  const s = input.steepest;
  if (s == null) return;
  const from = input.stations.find((st) => st.chainage === s.fromChainage);
  const to = input.stations.find((st) => st.chainage === s.toChainage);
  if (from?.elevation == null || to?.elevation == null) return;

  const midChainage = (s.fromChainage + s.toChainage) / 2;
  const midElevation = (from.elevation + to.elevation) / 2;
  const px = input.mapX(midChainage);
  const py = input.plotTopY - input.mapYdown(midElevation);

  const line1 = `MAX GRADE ${formatGradePercent(s.grade)}`;
  const line2 =
    `STA. ${formatStation(s.fromChainage, input.system)} TO ` +
    `${formatStation(s.toChainage, input.system)}`;
  const labelW = Math.max(
    f.bold.widthOfTextAtSize(winAnsiSafe(line1), T_CALLOUT),
    f.font.widthOfTextAtSize(winAnsiSafe(line2), T_CALLOUT_SUB),
  );

  // Out to the side with room, and up unless the point is already near the
  // top of the frame.
  const sx = px + 32 + labelW + 8 <= input.plotRight ? 1 : -1;
  const sy = py + 46 <= input.plotTopY ? 1 : -1;
  const elbowX = px + sx * 32;
  const elbowY = py + sy * 34;
  const textX = sx > 0 ? elbowX + 4 : elbowX - labelW - 4;

  // A cross at the point, then the leader out to the shoulder the label sits
  // on. Four independent strokes.
  rule(p, px - 3, py, px + 3, py, INK, 0.8);
  rule(p, px, py - 3, px, py + 3, INK, 0.8);
  rule(p, px, py, elbowX, elbowY, INK, 0.7);
  rule(p, elbowX, elbowY, sx > 0 ? textX + labelW : textX, elbowY, INK, 0.7);

  put(p, line1, textX, elbowY + 16, T_CALLOUT, f.bold, INK);
  put(p, line2, textX, elbowY + 5, T_CALLOUT_SUB, f.font, INK_DIM);
}

interface TechnicalNotesInput {
  readonly rows: ReadonlyArray<{
    item: string;
    value: string;
    remark: string;
    limit?: boolean;
  }>;
}

interface MethodSheetInput {
  readonly legend: DerivedSurfaceLegend;
  readonly record: ProfileProvenance | null;
  readonly reference: VerticalReference;
  readonly crs: string | null;
  readonly verticalDatum: string | null;
  readonly datumKnown: boolean;
}

/**
 * Sheet 2: what was recorded, what it says, and how to read it.
 *
 * The three-column table is the whole sheet. A two-column list of label and
 * value is only readable by whoever built the export: it states that coverage
 * is 96% without saying that the missing 4% is drawn as breaks in the line on
 * the sheet before. The remark column carries that, in the same plain
 * register as the rest of the drawing, and never adds a claim the value does
 * not support.
 */
function renderTechnicalNotes(
  doc: PDFDocument,
  f: Faces,
  sheets: EmittedSheet[],
  input: TechnicalNotesInput,
): void {
  const usableW = PAGE_W - 2 * M;
  const COL_ITEM = 250;
  const COL_VALUE = 350;
  const COL_REMARK = usableW - COL_ITEM - COL_VALUE - 32;
  const xItem = M;
  const xValue = M + COL_ITEM + 16;
  const xRemark = xValue + COL_VALUE + 16;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let continued = false;
  const identity = (): SheetIdentity => ({
    sheetName: 'TECHNICAL NOTES',
    descriptor: continued
      ? 'Recorded information and how to read it (continued).'
      : 'Recorded information, its value, and the engineering remark that qualifies it.',
  });
  sheets.push({ page, identity: identity() });
  let y = drawSheetHeader(page, f, 'Technical notes', '') - 22;

  const newPage = () => {
    continued = true;
    page = doc.addPage([PAGE_W, PAGE_H]);
    sheets.push({ page, identity: identity() });
    y = drawSheetHeader(page, f, 'Technical notes (continued)', '') - 22;
  };

  const tableHead = () => {
    trackedText(page, 'ITEM', xItem, y, T_TABLE_HEAD, f.bold, INK, 0.8);
    trackedText(page, 'RECORDED INFORMATION', xValue, y, T_TABLE_HEAD, f.bold, INK, 0.8);
    trackedText(page, 'ENGINEERING REMARK', xRemark, y, T_TABLE_HEAD, f.bold, INK, 0.8);
    rule(page, M, y - 5, M + usableW, y - 5, INK, 0.7);
    y -= 18;
  };
  tableHead();
  for (const row of input.rows) {
    // A value that states a limitation is set bold for the same reason a
    // measurement is: it is the thing on the row a reader must not miss.
    const valueFace = row.limit === true ? f.bold : f.font;
    const valueLines = wrapText(row.value, valueFace, T_TABLE, COL_VALUE);
    const remarkLines = wrapText(row.remark, f.font, T_REMARK, COL_REMARK);
    const lines = Math.max(1, valueLines.length, remarkLines.length);
    if (y - (lines * 12 + 7) < CONTENT_BOT) {
      newPage();
      tableHead();
    }
    put(page, clipText(row.item, f.font, T_TABLE, COL_ITEM), xItem, y, T_TABLE, f.font, INK_SOFT);
    valueLines.forEach((line, i) => {
      put(page, line, xValue, y - i * 12, T_TABLE, valueFace, INK);
    });
    remarkLines.forEach((line, i) => {
      put(page, line, xRemark, y - i * 12, T_REMARK, f.font, INK_SOFT);
    });
    y -= lines * 12 + 3;
    rule(page, M, y + 1, M + usableW, y + 1, GRID, 0.4);
    y -= 4;
  }
}

/**
 * The method sheet: what the drawn series is, what the heights are measured
 * from, which sources were read, and what the read is entitled to claim.
 *
 * Its own sheet rather than the tail of the notes table, because the two
 * answer different questions and a page break that lands wherever the table
 * happened to end leaves a reader holding half of one answer. Every sentence
 * about the series is the legend's own, less the ones the general notes at
 * the foot of this same sheet already carry, which are pointed at by number
 * instead. The source table is keyed on the stable layer id, because a
 * display name is user-editable and so is human context rather than
 * identity.
 */
function renderMethodSheet(
  doc: PDFDocument,
  f: Faces,
  sheets: EmittedSheet[],
  input: MethodSheetInput,
): void {
  const usableW = PAGE_W - 2 * M;
  // Prose wraps to a shorter measure than the source table needs. A line of
  // 9pt Helvetica across the full A3 width runs to about 200 characters,
  // which is nearly three times a comfortable measure, and the reader loses
  // the start of the next line. The table keeps the full width because its
  // columns are what set it.
  const proseW = Math.round(usableW * 0.6);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let continued = false;
  const identity = (): SheetIdentity => ({
    sheetName: 'METHOD AND SOURCES',
    descriptor: continued
      ? 'How the section was derived and what was read (continued).'
      : 'How the section was derived, what the heights are measured from, and what was read.',
  });
  sheets.push({ page, identity: identity() });
  let y = drawSheetHeader(page, f, 'Method and sources', '') - 22;

  const newPage = () => {
    continued = true;
    page = doc.addPage([PAGE_W, PAGE_H]);
    sheets.push({ page, identity: identity() });
    y = drawSheetHeader(page, f, 'Method and sources (continued)', '') - 22;
  };
  const need = (h: number) => {
    if (y - h < CONTENT_BOT) newPage();
  };

  // Section headings: tracked small caps in the dominant ink, over an accent
  // hairline. Small, but unmistakably a heading, which is what the run of
  // same-size paragraphs underneath needs.
  const heading = (s: string) => {
    need(36);
    y -= 14;
    trackedText(page, s.toUpperCase(), M, y, T_SECTION, f.bold, INK);
    rule(page, M, y - 5, M + usableW, y - 5, CURVE, 0.7);
    y -= 17;
  };
  const para = (s: string, size = T_PARA, color = INK) => {
    for (const line of wrapText(s, f.font, size, proseW)) {
      need(14);
      put(page, line, M, y, size, f.font, color);
      y -= 12;
    }
    y -= 3;
  };

  heading('Derived series');
  // The legend's own sentences, from the second: its first one names the
  // series and states that it is estimated, which is general note 1, which
  // is printed at the foot of this sheet and of every other sheet of the set.
  // Printing it here as well would put one sentence on one sheet twice.
  for (const line of input.legend.lines.slice(1)) para(line);

  heading('Height reference');
  // The reference is named, and what it entitles a reader to read into a
  // height is general note 2 at the foot of this sheet. The two lines under
  // it are what this section is FOR: the datum and CRS strings as declared,
  // which are nowhere else on the sheet.
  para(`${heightLabel(input.reference)}. See general note 2.`);
  para(`Vertical datum: ${input.verticalDatum ?? 'not declared'}`, T_PARA, INK_SOFT);
  para(`Horizontal CRS: ${input.crs ?? 'not georeferenced'}`, T_PARA, INK_SOFT);
  if (!input.datumKnown) para(DATUM_CONFLICT_MEASURE_NOTICE, T_PARA, INK_SOFT);

  heading('Sources read');
  if (input.record == null) {
    para(
      'No provenance record was attached to this export, so the contributing sources, ' +
        'their classification and the read scope are not recorded on this sheet.',
    );
  } else {
    const cols: Array<{ head: string; x: number; w: number }> = [
      { head: 'LAYER ID', x: M, w: 190 },
      { head: 'NAME', x: M + 200, w: 190 },
      { head: 'CLASSIFICATION', x: M + 400, w: 120 },
      { head: 'READ', x: M + 530, w: 90 },
      { head: 'ACCEPTED', x: M + 630, w: 90 },
      { head: 'CONTRIBUTED', x: M + 730, w: 100 },
      { head: 'RESIDENCY', x: M + 840, w: 100 },
    ];
    const drawHead = () => {
      need(28);
      for (const c of cols) trackedText(page, c.head, c.x, y, T_TABLE_HEAD, f.bold, INK, 0.8);
      rule(page, M, y - 5, M + usableW, y - 5, INK, 0.6);
      y -= 16;
    };
    drawHead();
    for (const s of input.record.sources) {
      if (y - 13 < CONTENT_BOT) {
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
        put(page, clipText(cell, f.mono, T_SOURCE, c.w), c.x, y, T_SOURCE, f.mono, INK);
      });
      y -= 13;
    }
    y -= 5;
    para(`Total accepted returns: ${String(input.record.acceptedCount)}.`, T_PARA, INK_SOFT);

    heading('Read scope');
    // The scope sentence is general note 3, on this sheet and on every other.
    // What follows it is the record's own identity, which no note carries.
    para('See general note 3.');
    para(
      `Method ${input.record.method}, corridor definition version ` +
        `${String(input.record.corridorVersion)}, record version ` +
        `${String(input.record.recordVersion)}, captured ${input.record.capturedAt}.`,
      T_PARA,
      INK_SOFT,
    );
    if (input.record.upDegenerate) {
      para(
        'The scene up axis was degenerate when this sample was taken, so the heights ' +
          'were not measured along a usable vertical.',
        T_PARA,
        INK_SOFT,
      );
    }
  }

}

/**
 * The station schedule, in four column groups across the page.
 *
 * Four groups because a schedule read down a single column wastes an A3 sheet
 * and spills to pages a reader then has to hold side by side. Set in Courier
 * so a chainage, a height and a grade line up digit under digit down each
 * group whatever their magnitude.
 *
 * A station with no return prints `gap` in the gap colour. The word is the
 * answer and the colour is the fast path to it, which is why the schedule
 * still works printed mono. The legend under the table says what a gap and a
 * dash mean, because a reader who joined at this sheet has not read the rest.
 */
function renderStationSchedule(
  doc: PDFDocument,
  f: Faces,
  sheets: EmittedSheet[],
  stations: ReturnType<typeof computeCivilProfileStats>['stations'],
  system: UnitSystem,
  reference: VerticalReference,
): void {
  // B9: the schedule prints in the display unit; geometry stays metres.
  const k = system === 'metric' ? 1 : FEET_PER_METRE;
  const unit = system === 'metric' ? 'm' : 'ft';
  const colCount = 4;
  const colGap = 22;
  const usableW = PAGE_W - 2 * M;
  const colW = (usableW - colGap * (colCount - 1)) / colCount;
  const rowH = 14;
  const legendTop = CONTENT_BOT + 28;
  const bottomY = legendTop + 16;

  const fmtGrade = (g: number | null) => (g == null ? '—' : `${(g * 100).toFixed(2)}%`);
  const fmtEl = (e: number | null) => (e == null ? 'gap' : (e * k).toFixed(2));
  const columnHead = heightColumnHead(reference);

  let idx = 0;
  let continued = false;
  while (idx < stations.length) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    sheets.push({
      page,
      identity: {
        sheetName: 'STATION SCHEDULE',
        descriptor: continued
          ? 'Chainage, height and grade per sampled station (continued).'
          : 'Chainage, height and grade at every sampled station, in draw order.',
      },
    });
    continued = true;
    const topY = drawSheetHeader(page, f, 'Station schedule', '') - 22;
    const rowsPerCol = Math.max(1, Math.floor((topY - bottomY) / rowH) - 1);

    for (let col = 0; col < colCount && idx < stations.length; col++) {
      const x = M + col * (colW + colGap);
      trackedText(page, 'STA', x, topY, T_TABLE_HEAD, f.bold, INK, 0.8);
      trackedText(page, `${columnHead} (${unit})`, x + 108, topY, T_TABLE_HEAD, f.bold, INK, 0.8);
      trackedText(page, 'GRADE', x + 200, topY, T_TABLE_HEAD, f.bold, INK, 0.8);
      rule(page, x, topY - 5, x + colW, topY - 5, INK, 0.7);
      for (let r = 0; r < rowsPerCol && idx < stations.length; r++, idx++) {
        const st = stations[idx];
        const y = topY - 16 - r * rowH;
        const height = fmtEl(st.elevation);
        put(page, formatStation(st.chainage, system), x, y, T_SCHED, f.mono, INK);
        // The height is what the row is FOR: chainage is an address and grade is
        // derived from two heights, so the weight goes on the measured figure.
        put(page, height, x + 108, y, T_SCHED, height === 'gap' ? f.mono : f.monoBold,
          height === 'gap' ? GAP_MARK : INK);
        put(page, fmtGrade(st.gradeToNext), x + 200, y, T_SCHED, f.mono, INK_SOFT);
      }
    }

    rule(page, M, legendTop + 12, M + usableW, legendTop + 12, RULE, 0.5);
    put(
      page,
      'GAP = NO RETURN AT STATION. DASH = GRADE NOT AVAILABLE.',
      M,
      legendTop,
      T_CAPTION,
      f.font,
      INK,
    );
    put(
      page,
      'GRADE = SLOPE FROM CURRENT STATION TO NEXT STATION',
      M,
      legendTop - 12,
      T_CAPTION,
      f.font,
      INK_DIM,
    );
  }
}
