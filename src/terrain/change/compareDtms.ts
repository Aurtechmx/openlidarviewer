/**
 * compareDtms.ts
 *
 * The bridge between the terrain DTM pipeline and the pure two-epoch change
 * core. `detectChange` only sees bare grids (values + cell size + dims), so it
 * can flag a cell-size / dimension mismatch but CANNOT see world position, CRS,
 * or vertical datum — exactly the things a change comparison is easiest to
 * mislead with. This module adds that co-registration check: two DTMs that
 * happen to share a raster shape but sit at different world origins, CRSs, or
 * vertical datums are NOT comparable cell-for-cell, and a silent subtraction
 * would measure misregistration, not change.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic. The wipe/heatmap UI
 * that visualises the difference is a separate, browser-verified layer.
 */

import type { DtmGrid } from '../ground/cellConfidence';
import {
  detectChange,
  DEFAULT_LOD_M,
  type ChangeGrid,
  type ChangeResult,
  type ChangeDetectionOptions,
} from './changeDetection';
import { changeVolumeUncertainty, cellSigmaFromLoD } from './changeUncertainty';

/**
 * Adapt a {@link DtmGrid} to the bare {@link ChangeGrid} the change core
 * consumes: heights row-major, with empty cells (coverage 0) carried as NaN so
 * they read as incomparable — never as a real 0 m height.
 */
export function dtmToChangeGrid(dtm: DtmGrid): ChangeGrid {
  const n = dtm.cols * dtm.rows;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    values[i] = dtm.coverage[i] > 0 ? dtm.z[i] : Number.NaN;
  }
  return { width: dtm.cols, height: dtm.rows, cellSizeM: dtm.cellSizeM, values };
}

/** Options for {@link compareDtms} — the change-core options plus frame honesty. */
export interface CompareDtmsOptions extends ChangeDetectionOptions {
  /**
   * True when the grids' horizontal frame is geographic (degrees). A DtmGrid
   * cannot carry this itself, but it changes what the comparison may claim:
   * a degree² cell area has no scalar conversion to m² (a degree of longitude
   * alone varies with cos φ), so cut/fill VOLUMES are not computable — while
   * the per-cell elevation differences remain valid (z is a linear unit).
   * When set, the comparison refuses the volume figures instead of printing
   * degree-based numbers as m³, and says so in the co-registration notes.
   */
  readonly isGeographic?: boolean;
  /**
   * False when the horizontal frame is PROJECTED but its linear unit is unknown
   * (a CRS whose `linearUnit` is 'unknown', carrying the inert placeholder
   * factor 1). Distinct from geographic: the frame is planar, so it passes the
   * `isGeographic` gate, yet the source unit could be feet, US survey feet, or
   * links — the factor 1 is a placeholder, not a measurement. Multiplying by it
   * silently reports non-metre spacing (and, since the vertical unit falls back
   * to this same horizontal unit, non-metre heights) as metres. When false, the
   * comparison withholds the metre figures (cut/fill AND Δz) rather than
   * captioning source-unit numbers as m³/m — fail closed on the unknown unit.
   * Omitted/true means the unit is known (or a metre CRS) and figures print.
   */
  readonly horizontalUnitKnown?: boolean;
}

/** A two-epoch comparison plus the co-registration verdict the grids can't carry. */
export interface EpochComparison {
  readonly result: ChangeResult;
  /**
   * True only when the two DTMs share a raster (cell size + dims), sit at the
   * same world origin (to floating-point representation — half a cell of slack
   * used to pass, and half a cell of misregistration is not co-registration),
   * and declare the same CRS + vertical datum where both are known. When false,
   * `coregistrationNotes` says why, and `summarizeChange` reports no cut/fill
   * volume and no elevation difference — an unconfirmed frame is not a proven
   * mismatch, but it is not enough to publish a terrain-change measurement
   * either. `gridMisaligned` distinguishes a MEASURED grid defect from an
   * unconfirmed frame so each gets its own diagnosis.
   *
   * The difference-raster EXPORT is gated on this whole verdict rather than on
   * the provable subset, and so is stricter than the panel. An .asc is a bare
   * header plus a rectangle of numbers: opened in a GIS it carries no note about
   * an unconfirmed CRS, an unstated vertical datum or an unknown linear unit.
   * The caveat cannot travel with the file, so the file is not written.
   */
  readonly coregistered: boolean;
  /** Plain-language co-registration caveats (empty when fully aligned). */
  readonly coregistrationNotes: readonly string[];
  /** The Level-of-Detection (m) applied: |Δ| ≤ this read as no change (noise floor). */
  readonly levelOfDetectionM: number;
  /**
   * False when the grids' frame is geographic (degrees): the cut/fill volume
   * fields in `result.stats` are then degree²-based and MUST NOT be presented
   * as m³ (see {@link CompareDtmsOptions.isGeographic}). Omitted/true means
   * volumes are in m³ as documented. `summarizeChange` honours this.
   */
  readonly volumesComputable?: boolean;
  /**
   * True when the two grids PROVABLY sit in different frames — a differing
   * horizontal CRS, or a differing vertical datum. Different in kind from an
   * unknown frame, which is merely unconfirmed: a Δz between UTM 12N and 13N, or
   * between NAVD88 and ellipsoidal heights, describes nothing at all. Both
   * withhold the numbers; this one says the frames are known to differ, so the
   * fix is to reproject rather than to state what is missing.
   */
  readonly frameIncompatible: boolean;
  /**
   * True when the horizontal frame is projected but its linear unit is unknown
   * (see {@link CompareDtmsOptions.horizontalUnitKnown}). Like `frameIncompatible`,
   * the metre figures are then withheld — an unknown source unit can't be
   * multiplied into metres — but the cause is a missing unit, not a proven frame
   * clash, so `summarizeChange` says so distinctly.
   */
  readonly horizontalUnitUnknown: boolean;
  /**
   * True when the two grids are PROVABLY not one grid: different cell sizes,
   * different dimensions, or origins that do not coincide. Distinct from the
   * rest of `coregistrationNotes`, which record what could not be CONFIRMED (an
   * unstated CRS, an unstated vertical datum). Here the defect is measured, and
   * the difference provably carries a misregistration term — cell (i,j) of one
   * grid is not the ground under cell (i,j) of the other — so the quantitative
   * result is withheld the way a proven frame clash is.
   */
  readonly gridMisaligned: boolean;
}

/**
 * Compare two terrain DTMs (epoch `a` = before, `b` = after), adding the
 * world-origin / CRS / vertical-datum co-registration check on top of the pure
 * `detectChange` grid math.
 */
export function compareDtms(
  a: DtmGrid,
  b: DtmGrid,
  options: CompareDtmsOptions = {},
): EpochComparison {
  const notes: string[] = [];

  // Geographic (degree) frame: Δz statistics stay valid (z is linear) but
  // cell areas are degrees², so cut/fill volumes are refused rather than
  // mislabelled as m³ — `detectChange`'s own contract says degree grids
  // can't be volumed. The note also forces the not-co-registered caveat
  // path, because two same-CRS geographic epochs would otherwise pass every
  // check and ship the bogus volume with no warning at all.
  const volumesComputable = options.isGeographic !== true;
  // The degree-grid note explains a withheld VOLUME; it is not a doubt about the
  // frame. Counting it against co-registration swept every geographic pair into
  // "cannot be confirmed to share a frame", a false statement for two epochs
  // that both declare EPSG:4326 and one datum, and withheld the elevation
  // differences the note itself says remain valid.
  if (!volumesComputable) {
    notes.push(
      'Geographic (degree) grid — cell areas are in degrees², so cut/fill volumes ' +
        'are not computable. Reproject both epochs to a projected CRS to measure ' +
        'volumes; the per-cell elevation differences remain valid.',
    );
  }

  // Projected frame with an UNKNOWN linear unit: the frame is planar (so it is
  // not geographic), but the source unit is undetermined and the factor fed in
  // is the inert placeholder 1. Unlike the geographic case, z gives no reprieve
  // — the vertical unit falls back to this same unknown horizontal unit — so
  // BOTH the cut/fill volumes and the Δz figures would be source-unit numbers
  // mislabelled as m³/m. Refuse the numbers (fail closed) rather than caption
  // an unverified unit as metres; the diagnosis note says exactly what to fix.
  const horizontalUnitUnknown =
    options.isGeographic !== true && options.horizontalUnitKnown === false;
  if (horizontalUnitUnknown) {
    notes.push(
      'Horizontal linear unit is unknown — the grid spacing has no confirmed metre scale, ' +
        'so cut/fill volumes and elevation differences cannot be reported in metres. Set the ' +
        'CRS linear unit (or reproject to a projected metre/foot CRS) to measure.',
    );
  }

  // World origin: same raster shape is not enough — the grids must start at the
  // same world point, or cell (x,y) of one is a different place than the other.
  //
  // The tolerance is float-representation equality, NOT a fraction of a cell.
  // Half a cell of slack made the correspondence assumption false by up to half
  // a cell: on a 1 m grid, two surfaces whose origins differed by 0.49 m were
  // called origin-aligned and differenced cell-for-cell, which measures the
  // terrain's own slope across that offset and reports it as elevation change.
  // On a 10 % grade that is a 4.9 cm bias over the whole raster, forty-nine
  // times the default level of detection and in a fixed direction, so it does
  // not average out. Nothing here resamples one grid onto the other — that is a
  // new capability, not a tolerance — so the only honest test is whether the two
  // ARE the same grid. The live path composes both epochs onto one shared grid
  // (`compareEpochs.sharedGrid`), so its origins are the same number and this
  // costs it nothing; independently built pairs are told to co-register.
  let originsOffset = false;
  const dH1 = Math.abs(a.originH1 - b.originH1);
  const dH2 = Math.abs(a.originH2 - b.originH2);
  const originTol =
    Math.max(Math.abs(a.originH1), Math.abs(b.originH1), Math.abs(a.originH2), Math.abs(b.originH2), 1)
    * 1e-9;
  if (dH1 > originTol || dH2 > originTol) {
    // Origins are in SOURCE units. Convert to metres for a projected CRS
    // (a 30-ft offset must not print "30 m"); a geographic grid stays degrees.
    const off = Math.max(dH1, dH2);
    const hUnit =
      Number.isFinite(options.horizontalUnitToMetres) && (options.horizontalUnitToMetres as number) > 0
        ? (options.horizontalUnitToMetres as number)
        : 1;
    const cells = Math.max(a.cellSizeM, b.cellSizeM) > 0
      ? off / Math.max(a.cellSizeM, b.cellSizeM)
      : Number.NaN;
    const offLabel = options.isGeographic ? `${off.toFixed(5)}°` : `${(off * hUnit).toFixed(3)} m`;
    const cellLabel = Number.isFinite(cells) ? ` (${cells.toFixed(2)} of a cell)` : '';
    originsOffset = true;
    notes.push(
      `The two epochs are offset by about ${offLabel}${cellLabel} at the grid origin — ` +
        `co-register them (align to common ground control) before trusting the difference.`,
    );
  }

  // Horizontal CRS: a known mismatch is the worst case, but an UNKNOWN CRS on
  // either side is also a caution — without it we can't confirm the two epochs
  // share a frame, so the difference is unverified rather than measured.
  let frameIncompatible = false;
  if (a.crs && b.crs) {
    if (a.crs !== b.crs) {
      frameIncompatible = true;
      notes.push(
        `Horizontal CRS differs (${a.crs} vs ${b.crs}) — the grids aren't in the same frame.`,
      );
    }
  } else {
    const which = !a.crs && !b.crs ? 'both epochs' : 'one epoch';
    notes.push(
      `Horizontal CRS is unknown for ${which} — the grids can't be confirmed to share a ` +
        `frame.`,
    );
  }

  // Vertical datum: same logic. A known mismatch means heights sit on different
  // references; an unknown datum means we can't confirm they share one.
  if (a.verticalDatum && b.verticalDatum) {
    if (a.verticalDatum !== b.verticalDatum) {
      frameIncompatible = true;
      notes.push(
        `Vertical datum differs (${a.verticalDatum} vs ${b.verticalDatum}) — ` +
          `heights aren't on a common reference, so the elevation difference is unreliable.`,
      );
    }
  } else {
    const which = !a.verticalDatum && !b.verticalDatum ? 'both epochs' : 'one epoch';
    notes.push(
      `Vertical datum is unknown for ${which} — heights can't be confirmed on a common ` +
        `reference.`,
    );
  }

  const result = detectChange(dtmToChangeGrid(a), dtmToChangeGrid(b), options);
  // The raster mismatch (cell size / dims) is already in result.warnings; the
  // overall co-registration verdict folds those in too.
  const geographicNoteCount = volumesComputable ? 0 : 1;
  const coregistered = result.aligned && notes.length - geographicNoteCount === 0;
  const gridMisaligned = !result.aligned || originsOffset;
  const levelOfDetectionM = Math.max(0, options.levelOfDetectionM ?? DEFAULT_LOD_M);
  return { result, coregistered, coregistrationNotes: notes, levelOfDetectionM, volumesComputable, frameIncompatible, horizontalUnitUnknown, gridMisaligned };
}

/**
 * A short, human-readable summary of a comparison for a panel or export — the
 * cut/fill volumes, the change significance, and every co-registration caveat,
 * so the numbers never travel without their honesty context.
 */
/** Extra facts, known only at the call site, that qualify the net-volume figure. */
export interface ChangeSummaryContext {
  /** Co-registration RMSE (m) of the applied alignment — the systematic error term. */
  readonly registrationSigmaM?: number;
  /**
   * True when the caller supplied a level of detection measured for these
   * epochs. False / absent means the comparison is running on the built-in
   * default, which the report then says out loud.
   */
  readonly levelOfDetectionSupplied?: boolean;
  /** Horizontal linear-unit factor, to turn the source-unit cell size into m². */
  readonly horizontalUnitToMetres?: number;
}

/**
 * What a MEASURED (not indicative) comparison needs, spelled out so the user
 * knows exactly what to fix. Printed on every path that falls short of one.
 */
const COREGISTRATION_CHECKLIST =
  'Needs for a measured result: shared CRS · shared vertical datum · ' +
  'matching units · common ground control.';

export function summarizeChange(comparison: EpochComparison, ctx: ChangeSummaryContext = {}): string[] {
  const { result, coregistered, coregistrationNotes } = comparison;
  const s = result.stats;
  const lines: string[] = [];

  if (comparison.frameIncompatible) {
    // A PROVEN frame mismatch: the numbers describe nothing, so none are
    // printed — a warning under a confident figure does not make it
    // meaningful. The diagnosis lines below still say exactly why.
    lines.push(
      '✗ Not comparable — the two epochs are in provably different frames, so no ' +
        'difference is reported. Reproject them to a common CRS and vertical datum first.',
    );
    for (const note of coregistrationNotes) lines.push(`• ${note}`);
    return lines;
  }
  if (comparison.horizontalUnitUnknown) {
    // Projected frame, unknown linear unit: the source spacing has no confirmed
    // metre scale, so every metre figure (m³ and Δz) would be a source-unit
    // number wearing a metre label. Withhold them all — same posture as a proven
    // frame clash — and keep only the diagnosis so the fix is clear.
    lines.push(
      '✗ Not comparable — the horizontal linear unit is unknown, so cut/fill volumes and ' +
        'elevation differences are not reported in metres. Set the CRS linear unit (or ' +
        'reproject to a metre/foot CRS) and compare again.',
    );
    for (const note of coregistrationNotes) lines.push(`• ${note}`);
    return lines;
  }
  if (comparison.gridMisaligned) {
    // A MEASURED grid defect, not an unconfirmed one. Cell (i,j) of one grid is
    // not the ground under cell (i,j) of the other, so a cell-for-cell
    // subtraction returns the terrain's own slope across the offset (or across
    // the resolution step) as though it were elevation change. That contaminant
    // is systematic and signed, so it survives every aggregate below. Same
    // posture as a proven frame clash: state the defect, report no figure.
    lines.push(
      '✗ Not comparable — the two epochs are not on one grid (different cell size, ' +
        'different dimensions, or offset origins), so no cut/fill volume or elevation ' +
        'difference is reported. Co-register them onto a common grid and compare again.',
    );
    for (const note of coregistrationNotes) lines.push(`• ${note}`);
    for (const w of result.warnings) lines.push(`• ${w}`);
    lines.push(COREGISTRATION_CHECKLIST);
    return lines;
  }
  if (s.comparable === 0) {
    // No cell is measured in both epochs. detectChange reports NaN for every
    // per-cell aggregate here, and this printed those through toFixed as
    // "NaN m³" beside a band that called the undefined figure "below the
    // threshold". Two adjacent tiles of one survey reach this path with every
    // frame check passing.
    lines.push(
      '✗ Nothing compared — no cell holds a measured height in both epochs, so no ' +
        'cut/fill volume or elevation difference exists to report. The two footprints ' +
        'do not overlap on the shared grid.',
    );
    for (const w of result.warnings) lines.push(`• ${w}`);
    for (const note of coregistrationNotes) lines.push(`• ${note}`);
    return lines;
  }
  if (!coregistered) {
    // Everything that falls short of a confirmed common frame: an unstated CRS,
    // an unstated vertical datum, a geographic grid. None of these PROVES a
    // mismatch — but a cut/fill volume is a measurement, and absence of evidence
    // that two epochs describe the same place is not evidence that they do.
    //
    // This printed the volumes under "treat as indicative, not measured". That
    // is the defensible GIS posture and the wrong one for a figure that leaves
    // this process: the caveat is a line of prose above a m³ number, and the
    // number is what gets quoted, pasted and published. The same reasoning
    // already withholds the figures for a proven frame clash, an unknown linear
    // unit and a measured grid defect; an unconfirmed frame was the last member
    // of that family still answering with numbers.
    lines.push(
      '✗ Not comparable — the two epochs cannot be confirmed to share a frame, so no ' +
        'cut/fill volume or elevation difference is reported. The difference raster is ' +
        'still available to LOOK at; it is not a measurement until the frame is stated.',
    );
    for (const note of coregistrationNotes) lines.push(`• ${note}`);
    for (const w of result.warnings) lines.push(`• ${w}`);
    lines.push(COREGISTRATION_CHECKLIST);
    return lines;
  }
  if (comparison.volumesComputable === false) {
    // Degree² cell areas: no m³ figure exists — the refusal line replaces it.
    lines.push(
      'Cut/fill volumes: not computable on a geographic (degree) grid — ' +
        'reproject both epochs to a projected CRS to measure volumes.',
    );
  } else {
    lines.push(
      `Net volume change (raw, all comparable cells, no LoD threshold): ${s.rawNetVolumeM3.toFixed(1)} m³.`,
    );
    lines.push(
      `Detectable gross change (above the ${comparison.levelOfDetectionM} m level of detection): ` +
        `gain ${s.detectableGainVolumeM3.toFixed(1)} m³, loss ${s.detectableLossVolumeM3.toFixed(1)} m³, ` +
        `thresholded net ${s.detectableNetVolumeM3.toFixed(1)} m³ — thresholding the net biases it ` +
        `(uncorrelated sub-LoD error should cancel, not zero out asymmetrically), so the raw net above ` +
        `is the reported net figure.`,
    );
    // Qualify the net volume with a ± band + detectability. A bare figure hides
    // whether the change exceeds the noise, and an unquantified co-registration
    // error is the most common way a change number lies — so both are surfaced.
    const hM = ctx.horizontalUnitToMetres;
    if (hM && hM > 0) {
      const u = changeVolumeUncertainty({
        // The band must qualify the figure the line above REPORTS, which is
        // the raw net over every comparable cell. It qualified the thresholded
        // net over above-LoD cells only: a different estimand, and one whose
        // count is zero whenever every cell changes below the level of
        // detection, collapsing the band while the reported net is non-zero.
        netVolumeM3: s.rawNetVolumeM3,
        contributingCells: s.comparable,
        cellAreaM2: (result.cellSizeM * hM) * (result.cellSizeM * hM),
        cellSigmaM: cellSigmaFromLoD(comparison.levelOfDetectionM),
        registrationSigmaM: ctx.registrationSigmaM ?? 0,
      });
      // Three outcomes, not two. An EMPTY error budget (a zero level of
      // detection and no registration RMSE) also yields ±0, and printing that
      // as "below the level of detection" would describe a threshold that was
      // never set. Say the band bounds nothing, and name what to supply.
      if (!u.quantified) {
        lines.push(
          'Volume uncertainty: not quantified — the level of detection is 0 and no ' +
            'co-registration RMSE was supplied, so the ±0 m³ band bounds nothing. ' +
            'Set a level of detection to qualify this figure.',
        );
      } else {
        lines.push(
          u.detectable
            ? `Independent-cell model uncertainty: ±${u.sigmaM3.toFixed(1)} m³ (1σ, ${(u.relativeError * 100).toFixed(0)}% relative). Net volume exceeds the selected 1.96σ threshold under the independent-cell uncertainty model.`
            : `Independent-cell model uncertainty: ±${u.sigmaM3.toFixed(1)} m³ (1σ) — net volume is below the selected 1.96σ threshold, not distinguishable from noise.`,
        );
      }
      if (!(ctx.registrationSigmaM && ctx.registrationSigmaM > 0)) {
        lines.push('The co-registration error is unquantified (no alignment applied), so this band is a lower bound.');
      } else {
        // What that term IS. The caller supplies the ICP fit's RMS
        // nearest-neighbour distance, a 3-D residual carrying horizontal
        // mismatch, point spacing, surface roughness and real change as well as
        // vertical noise. It is a proxy for the vertical co-registration sigma
        // the model wants, not a measurement of it, and the report said nothing.
        lines.push(
          'The co-registration term is the alignment fit\'s 3-D RMS residual, which ' +
            'also carries horizontal mismatch, point spacing, surface roughness and ' +
            'real change — a proxy for vertical registration error, not a measurement ' +
            'of it. Vertical residuals on stable ground would quantify it.',
        );
      }
      // Where the per-cell sigma came from. It is derived as LoD/1.96, so when
      // the level of detection is the built-in default rather than a figure
      // from this survey, the whole band rests on that default. Printing the
      // band without saying so presents a shipped constant as an error model.
      if (comparison.levelOfDetectionM === DEFAULT_LOD_M && ctx.levelOfDetectionSupplied !== true) {
        lines.push(
          `The per-cell sigma is derived from the level of detection (${DEFAULT_LOD_M} m ÷ 1.96), ` +
            'and that level of detection is this build\'s default, not a figure measured for ' +
            'these epochs. Supply one from the surveys\' own accuracy to make the band theirs.',
        );
      }
    }
  }
  lines.push(
    `${(s.significantFraction * 100).toFixed(1)}% of comparable cells changed beyond the ` +
      `detection floor of ${comparison.levelOfDetectionM} m ` +
      `(${s.gained} gained, ${s.lost} lost, ${s.unchanged} unchanged).`,
    `Largest gain ${s.maxGainM.toFixed(2)} m, largest loss ${s.maxLossM.toFixed(2)} m; ` +
      `mean |Δ| ${s.meanAbsChangeM.toFixed(2)} m over ${s.comparable} comparable cells.`,
  );
  for (const w of result.warnings) lines.push(`• ${w}`);
  for (const note of coregistrationNotes) lines.push(`• ${note}`);
  // Co-registration checklist — spell out what a MEASURED (not indicative)
  // change comparison needs, so the user knows exactly what to fix. Shown only
  // when the result isn't co-registered, where it's actionable.
  return lines;
}
