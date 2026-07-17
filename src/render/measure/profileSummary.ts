/**
 * profileSummary.ts
 *
 * Profile Intelligence — the civil headline numbers an engineer reads off a
 * section before anything else: length, elevation gain/loss, average and
 * maximum grade, the steepest station range, and the highest/lowest points.
 * Pure data over the already-sampled height-vs-distance series; no DOM, no
 * three.js, unit-tested with hand-computed fixtures.
 *
 * Honesty contract (inherited from the sampler): a NaN/null elevation is a
 * no-coverage gap. Gain/loss and grades accumulate ONLY between two adjacent
 * covered stations — a segment touching a gap contributes nothing rather than
 * inventing a slope across data that was never measured. With fewer than two
 * covered stations every derived figure is `null`, never 0 (0 would claim
 * "measured flat").
 *
 * This module also owns the profile CSV (the v0.4.4 audit gap "no profile
 * CSV, station table PDF-only") and the display-row formatting, so the panel,
 * the PDF and the CSV all read from one tested source of truth.
 */

import type { ProfileChartSample, UnitSystem } from './types';
import { formatStationing, formatGradePercent } from './civilProfileStats';
import { formatElevation, formatLength } from './format';

const FEET_PER_METRE = 3.280839895013123;

/** A located elevation extreme along the section. */
export interface ProfileExtreme {
  /** Chainage of the extreme, metres from the start. */
  readonly chainage: number;
  /** Elevation at that chainage, metres. */
  readonly elevation: number;
}

/** The steepest adjacent covered station pair. */
export interface SteepestSection {
  /** Station range start, metres of chainage. */
  readonly fromChainage: number;
  /** Station range end, metres of chainage. */
  readonly toChainage: number;
  /** Signed grade across the range (rise/run fraction, + = uphill). */
  readonly grade: number;
}

/** The Profile Intelligence summary. All distances/elevations in metres. */
export interface ProfileSummaryData {
  /** Horizontal length of the section (last − first chainage). */
  readonly lengthM: number;
  /** Fraction of stations with real coverage, 0..1. */
  readonly coverage: number;
  /** Total climb: Σ positive elevation deltas between adjacent covered stations. */
  readonly gainM: number | null;
  /** Total descent (as a positive number): Σ |negative deltas|. */
  readonly lossM: number | null;
  /**
   * Net average grade: (last covered elevation − first covered elevation) /
   * chainage run between those two stations. Signed; null below 2 covered.
   */
  readonly averageGrade: number | null;
  /** The steepest segment's signed grade (largest |grade|), or null. */
  readonly maxGrade: number | null;
  /** Where that steepest segment lies (first such segment on a tie). */
  readonly steepest: SteepestSection | null;
  /** Highest covered point (first occurrence on a tie). */
  readonly highest: ProfileExtreme | null;
  /** Lowest covered point (first occurrence on a tie). */
  readonly lowest: ProfileExtreme | null;
}

const covered = (h: number | undefined): h is number =>
  typeof h === 'number' && Number.isFinite(h);

/**
 * Take a sampled profile from render space to the numbers a reader is owed —
 * the B2 unit seam (v0.4.5), which is also where the datum comes back (v0.6).
 *
 * Render space keeps the scan's SOURCE units (a foot-CRS LAS stores feet), but
 * every profile consumer downstream of the controller (chart axes, summary,
 * CSV, PDF) is written in metres; applying the CRS's `linearUnitToMetres` once
 * here, before the series fans out, is what keeps the chart's raw numerals and
 * the formatted labels in lockstep.
 *
 * Heights arrive RENDER-LOCAL — recentred clouds store `local = world −
 * origin` — so `datumOffset`, the up-axis component of that origin, is added
 * back to make each height the elevation the source file describes. A `null`
 * offset is the scene REFUSING a datum it cannot assert (clouds with
 * conflicting origins): the heights stay local and the surfaces say so, which
 * is why the refusal changes no number here — only what the number is called. It belongs
 * at this seam and not in storage: `rebaseSessionGeometry` shifts stored
 * profile heights by an origin delta when a session is imported onto a
 * different-origin cloud, which only holds while what is stored is local. The
 * offset is in render units, so it goes on BEFORE the factor — converting the
 * two separately would leave the sum off by the units' ratio.
 *
 * Distances scale but never shift: chainage is measured from the profile line,
 * which has no datum. NaN gaps survive untouched (a datum cannot fill in a bin
 * that saw no points). The corridor `count` is a point tally, not a length —
 * copied verbatim, and an absent count stays absent so the CSV's "blank means
 * pre-count session" contract holds. An invalid factor falls back to 1 and an
 * invalid offset to 0 (same rationale as `format.ts`): a mislabelled scan is
 * the status quo, a series multiplied or shifted by garbage is strictly worse.
 */
export function scaleProfileSamples(
  samples: ReadonlyArray<ProfileChartSample>,
  unitToMetres: number,
  datumOffset: number | null = 0,
): ProfileChartSample[] {
  const f = Number.isFinite(unitToMetres) && unitToMetres > 0 ? unitToMetres : 1;
  const d = datumOffset != null && Number.isFinite(datumOffset) ? datumOffset : 0;
  return samples.map((s) => {
    const out: ProfileChartSample = {
      distance: s.distance * f,
      height: (s.height + d) * f,
    };
    if (s.count !== undefined) out.count = s.count;
    return out;
  });
}

/** Compute the Profile Intelligence summary over a sampled profile. */
export function computeProfileSummary(
  samples: ReadonlyArray<ProfileChartSample>,
): ProfileSummaryData {
  const n = samples.length;
  const lengthM = n > 0 ? samples[n - 1].distance - samples[0].distance : 0;

  let hits = 0;
  let gain = 0;
  let loss = 0;
  let segments = 0;
  let firstHit = -1;
  let lastHit = -1;
  let highest: ProfileExtreme | null = null;
  let lowest: ProfileExtreme | null = null;
  let steepest: SteepestSection | null = null;

  for (let i = 0; i < n; i++) {
    const h = samples[i].height;
    if (!covered(h)) continue;
    hits++;
    if (firstHit < 0) firstHit = i;
    lastHit = i;
    // Strict > / < keep the FIRST extreme on ties — deterministic, and the
    // earliest station is the one a surveyor would call out.
    if (highest === null || h > highest.elevation) {
      highest = { chainage: samples[i].distance, elevation: h };
    }
    if (lowest === null || h < lowest.elevation) {
      lowest = { chainage: samples[i].distance, elevation: h };
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (!covered(a.height) || !covered(b.height)) continue; // gap — contribute nothing
    const run = b.distance - a.distance;
    if (!(run > 1e-9)) continue; // duplicate station — no honest grade
    segments++;
    const rise = b.height - a.height;
    if (rise > 0) gain += rise;
    else loss -= rise;
    const grade = rise / run;
    if (steepest === null || Math.abs(grade) > Math.abs(steepest.grade)) {
      steepest = { fromChainage: a.distance, toChainage: b.distance, grade };
    }
  }

  let averageGrade: number | null = null;
  if (firstHit >= 0 && lastHit > firstHit) {
    const run = samples[lastHit].distance - samples[firstHit].distance;
    if (run > 1e-9) {
      averageGrade = (samples[lastHit].height - samples[firstHit].height) / run;
    }
  }

  return {
    lengthM,
    coverage: n > 0 ? hits / n : 0,
    gainM: segments > 0 ? gain : null,
    lossM: segments > 0 ? loss : null,
    averageGrade,
    maxGrade: steepest ? steepest.grade : null,
    steepest,
    highest,
    lowest,
  };
}

/**
 * Format a chainage as civil stationing in the active unit system: metric is
 * the km+metres convention (`0+034.50`), imperial the US 100-ft station
 * convention (`1+13.45` = 113.45 ft). Matching what each drawing culture
 * expects beats forcing one notation on both.
 */
export function formatStation(chainageM: number, system: UnitSystem): string {
  if (!Number.isFinite(chainageM)) return '—';
  if (system === 'metric') return formatStationing(chainageM);
  const ft = Math.abs(chainageM) * FEET_PER_METRE;
  const sign = chainageM < 0 ? '-' : '';
  const sta = Math.floor(ft / 100);
  const rem = ft - sta * 100;
  return `${sign}${sta}+${rem.toFixed(2).padStart(5, '0')}`;
}

/**
 * Format a located extreme as `elevation @ station` — the shared model behind
 * the panel's Highest/Lowest rows and the PDF's, so the sheet an engineer
 * checks against the screen cannot quote a different point. The elevation goes
 * through `formatElevation`, not the length formatter: it is a signed datum
 * reading, and treating it as a magnitude is what once printed a 418 m ground
 * as "-41186.5 cm".
 */
export function formatProfileExtreme(e: ProfileExtreme | null, system: UnitSystem): string {
  if (e == null) return '—';
  return `${formatElevation(e.elevation, system)} @ ${formatStation(e.chainage, system)}`;
}

/** One display row of the summary block. */
export interface ProfileSummaryRow {
  readonly label: string;
  readonly value: string;
}

/**
 * The summary as label/value display rows, honouring the unit system — the
 * single formatting source for the panel block and the PDF so the two can
 * never disagree on a number.
 */
export function profileSummaryRows(
  s: ProfileSummaryData,
  system: UnitSystem,
  datumKnown = true,
): ProfileSummaryRow[] {
  // Without a datum the figure is a local render height, so the row says that
  // rather than calling it an elevation. The number is unchanged and still
  // useful — every row above these two is a difference, and a difference never
  // needed the datum.
  const point = (which: string): string =>
    datumKnown ? `${which} point` : `${which} point (local height)`;
  const len = (m: number | null): string => (m == null ? '—' : formatLength(m, system));
  const extreme = (e: ProfileExtreme | null): string => formatProfileExtreme(e, system);
  return [
    { label: 'Length', value: len(s.lengthM) },
    {
      label: 'Elevation gain / loss',
      value: s.gainM == null || s.lossM == null ? '—' : `+${len(s.gainM)} / −${len(s.lossM)}`,
    },
    { label: 'Avg grade', value: formatGradePercent(s.averageGrade) },
    { label: 'Max grade', value: formatGradePercent(s.maxGrade) },
    {
      label: 'Steepest section',
      value:
        s.steepest == null
          ? '—'
          : `${formatStation(s.steepest.fromChainage, system)} → ` +
            `${formatStation(s.steepest.toChainage, system)} ` +
            `(${formatGradePercent(s.steepest.grade)})`,
    },
    { label: point('Highest'), value: extreme(s.highest) },
    { label: point('Lowest'), value: extreme(s.lowest) },
  ];
}

/**
 * One station row of the data table — the SHARED row model behind the CSV
 * export and the in-panel station table (v0.4.5, B5/B6). All fields are
 * pre-formatted strings in the requested unit system; a no-coverage gap is
 * the empty string `''` (the CSV writes it verbatim as an honest blank, the
 * panel renders it as an em dash) — never a fabricated 0.
 */
export interface ProfileStationRow {
  /** Civil station label, e.g. `0+034.50` (metric) / `1+13.45` (imperial). */
  readonly station: string;
  /** Chainage in the system's unit, 2 decimals. */
  readonly chainage: string;
  /** Ground elevation, 3 decimals, or `''` for a gap. */
  readonly elevation: string;
  /** Corridor point count, or `''` for a pre-v0.4.5 series with no counts. */
  readonly points: string;
  /** Grade to the next station in percent, 2 decimals, or `''`. */
  readonly grade: string;
}

/**
 * The station rows for a sampled profile, one per sample, in order. Both the
 * CSV and the in-panel table read THIS — a number a reviewer checks against
 * the export can never disagree with the one on screen.
 */
export function profileStationRows(
  samples: ReadonlyArray<ProfileChartSample>,
  system: UnitSystem,
): ProfileStationRow[] {
  const k = system === 'metric' ? 1 : FEET_PER_METRE;
  const rows: ProfileStationRow[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    let grade = '';
    if (i + 1 < samples.length) {
      const b = samples[i + 1];
      const run = b.distance - s.distance;
      if (covered(s.height) && covered(b.height) && run > 1e-9) {
        grade = (((b.height - s.height) / run) * 100).toFixed(2);
      }
    }
    rows.push({
      station: formatStation(s.distance, system),
      chainage: (s.distance * k).toFixed(2),
      elevation: covered(s.height) ? (s.height * k).toFixed(3) : '',
      points: typeof s.count === 'number' && Number.isFinite(s.count) ? String(s.count) : '',
      grade,
    });
  }
  return rows;
}

/**
 * Build the profile station CSV — the data export the PDF-only station table
 * left missing. One row per station: civil station label, chainage, ground
 * elevation, the corridor point count behind the estimate (blank for samples
 * recorded before v0.4.5 stored counts), and the grade to the next station.
 * Gap stations keep their row with elevation/grade blank — the row count
 * always matches the sample count so downstream joins line up.
 *
 * Headers carry the unit (`_m` / `_ft`) so a spreadsheet never has to guess;
 * values are converted to that unit. Grade is dimensionless percent.
 * Row content comes from `profileStationRows` — the same model the in-panel
 * station table renders.
 */
export function buildProfileCsv(
  samples: ReadonlyArray<ProfileChartSample>,
  system: UnitSystem,
  datumKnown = true,
): string {
  const unit = system === 'metric' ? 'm' : 'ft';
  // A refused datum renames the column; it must NOT blank it. A blank already
  // means "the corridor saw no points here", and spending that signal on a
  // different problem would trade one silent wrong answer for another.
  const heightCol = datumKnown ? `elevation_${unit}` : `local_height_${unit}`;
  const lines: string[] = [
    `station,chainage_${unit},${heightCol},points,grade_to_next_pct`,
  ];
  for (const r of profileStationRows(samples, system)) {
    lines.push(`${r.station},${r.chainage},${r.elevation},${r.points},${r.grade}`);
  }
  return lines.join('\n') + '\n';
}
