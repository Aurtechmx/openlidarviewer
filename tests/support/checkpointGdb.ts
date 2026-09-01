/**
 * checkpointGdb.ts — TEST-SUPPORT adapter between USGS 3DEP survey checkpoints
 * stored in an ESRI FileGDB and OLV's existing checkpoint-accuracy engine at
 * `src/validation/checkpointAccuracy.ts`.
 *
 * This file ships with neither the app bundle nor `src/`: it is loaded only by
 * tests. It does not reimplement bias/RMSE/NMAD/median/P90/P95 — those are
 * computed by `checkpointAccuracy()`, reused as-is. What this file adds is
 * specific to the 3DEP checkpoint format and to pairing checkpoints with a
 * point-cloud tile:
 *
 *   - reading rows out of the `.gdb` with GDAL's `ogr2ogr` (no FileGDB reader
 *     is written here — GDAL already reads the format correctly);
 *   - the FAIL-CLOSED prerequisite gate a checkpoint set must pass before any
 *     of its rows may be paired with the tile;
 *   - the PREDICTION-COVERAGE LEDGER: how many eligible checkpoints the product
 *     actually predicted a value at, so a low-coverage tile reports a low
 *     coverage rather than silently shrinking the sample; and
 *   - Mean Absolute Error, which `checkpointAccuracy()` does not report
 *     (it reports bias, RMSE, median, NMAD, P90/P95, max — MAE is computed
 *     here directly from the same residuals it returns).
 *
 * INDEPENDENCE IS NOT INFERRED FROM THE GDB. A 3DEP `point_type` of NVA or VVA
 * is an accuracy-TYPE label (Non-vegetated / Vegetated Vertical Accuracy), not
 * evidence that a checkpoint was held back from the product's calibration,
 * registration, or parameter tuning. Whether a checkpoint is independent is a
 * property of external provenance, and this adapter only marks a checkpoint
 * `independent` when the caller passes provenance that says so
 * (`IndependenceProvenance`). Absent that provenance a checkpoint is given a
 * usage `checkpointAccuracy()` does not recognise, so it forces an
 * `unknown-usage` refusal naming it rather than entering an independent-accuracy
 * statistic.
 *
 * Fail-closed prerequisites, in the order checked:
 *   1. at least one checkpoint of the project falls inside the tile extent;
 *   2. of those, at least one shares the tile's horizontal AND vertical EPSG
 *      (a checkpoint surveyed in a different datum is not comparable without
 *      a reprojection this module does not perform, so it is excluded, not
 *      silently reprojected);
 *   3. of those, the checkpoint states an accuracy/uncertainty value;
 *   4. of those, the checkpoint states a point_type (NVA/VVA) — the accuracy-
 *      type label 3DEP uses to distinguish a vertical-accuracy observation from
 *      a derived or unlabelled row. This gates accuracy-type eligibility only;
 *      it does NOT establish independence (see above);
 *   5. the surviving count is >= MIN_CHECKPOINT_SAMPLE_SIZE.
 * Any failure is reported with a specific reason string; the gate does not
 * stop at the first failure; nothing partial is computed for a closed gate.
 */

import { execFileSync } from 'node:child_process';
import {
  checkpointAccuracy,
  referenceUncertaintyFromValue,
  type Checkpoint,
  type CheckpointResult,
  type CheckpointUsage,
  type ReferenceUncertaintyMeaning,
} from '../../src/validation/checkpointAccuracy';

/**
 * Minimum usable checkpoint count before an accuracy figure is reported.
 * Named and exported so a caller can see and tune the floor rather than
 * hunting a magic number. 20 is the smallest sample this harness treats as
 * saying something about a spatial bias rather than noise from a handful of
 * points; it is a project choice, not a value copied from a standard.
 */
export const MIN_CHECKPOINT_SAMPLE_SIZE = 20;

/** One row read from the checkpoint FileGDB, as strings (raw CSV cells). */
export interface RawCheckpointRow {
  readonly unique_identifier: string;
  readonly point_type: string; // 'NVA' | 'VVA' | ''
  readonly source_easting: string;
  readonly source_northing: string;
  readonly source_elevation: string;
  readonly source_horizontal_epsg: string;
  readonly source_vertical_epsg: string;
  readonly accuracy: string;
  readonly project_id: string;
}

const CSV_FIELDS = [
  'unique_identifier',
  'point_type',
  'source_easting',
  'source_northing',
  'source_elevation',
  'source_horizontal_epsg',
  'source_vertical_epsg',
  'accuracy',
  'project_id',
] as const;

/** The tile's known frame: its CRS and its horizontal extent. */
export interface TileFrame {
  readonly horizontalEpsg: number;
  readonly verticalEpsg: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * Minimal RFC-4180-ish CSV parser: handles double-quoted fields with escaped
 * `""`, commas inside quotes, and CRLF/LF line endings. Sufficient for
 * `ogr2ogr -f CSV` output, which is what this module ever parses.
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function parseCheckpointCsv(csv: string): RawCheckpointRow[] {
  const lines = csv.split(/\r\n|\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  const idx = new Map(header.map((h, i) => [h, i]));
  const rows: RawCheckpointRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const get = (field: string): string => {
      const j = idx.get(field);
      return j === undefined ? '' : (cells[j] ?? '');
    };
    rows.push({
      unique_identifier: get('unique_identifier'),
      point_type: get('point_type'),
      source_easting: get('source_easting'),
      source_northing: get('source_northing'),
      source_elevation: get('source_elevation'),
      source_horizontal_epsg: get('source_horizontal_epsg'),
      source_vertical_epsg: get('source_vertical_epsg'),
      accuracy: get('accuracy'),
      project_id: get('project_id'),
    });
  }
  return rows;
}

/**
 * Read one project's checkpoints out of the FileGDB with `ogr2ogr -f CSV
 * /vsistdout/`. Requires GDAL's `ogr2ogr` on PATH. No FileGDB parsing is done
 * in this codebase — GDAL is the reference reader for the format.
 */
/**
 * Absolute path to GDAL's `ogr2ogr`, resolved through the absolute `which` so
 * the tool call never depends on PATH resolution (a bare `ogr2ogr` could run an
 * attacker-planted binary earlier in PATH). `OGR2OGR_BIN` overrides for a
 * non-standard install. Throws if GDAL is not installed, since the harness
 * cannot read a FileGDB without it.
 */
function resolveOgr2ogr(): string {
  const override = process.env.OGR2OGR_BIN;
  if (override) return override;
  const found = execFileSync('/usr/bin/which', ['ogr2ogr'], { encoding: 'utf8' }).trim();
  if (!found) throw new Error('ogr2ogr not found on PATH; install GDAL or set OGR2OGR_BIN');
  return found;
}

export function readProjectCheckpointsCsv(
  gdbPath: string,
  layer: string,
  projectId: string,
): RawCheckpointRow[] {
  const whereValue = /^-?\d+$/.test(projectId) ? projectId : `'${projectId.replace(/'/g, "''")}'`;
  const ogr2ogr = resolveOgr2ogr();
  const csv = execFileSync(
    ogr2ogr,
    [
      '-f',
      'CSV',
      '/vsistdout/',
      gdbPath,
      layer,
      '-where',
      `project_id=${whereValue}`,
      '-select',
      CSV_FIELDS.join(','),
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return parseCheckpointCsv(csv);
}

export function withinTileExtent(row: RawCheckpointRow, tile: TileFrame): boolean {
  const x = Number(row.source_easting);
  const y = Number(row.source_northing);
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= tile.minX &&
    x <= tile.maxX &&
    y >= tile.minY &&
    y <= tile.maxY
  );
}

export function crsMatchesTile(row: RawCheckpointRow, tile: TileFrame): boolean {
  const h = Number(row.source_horizontal_epsg);
  const v = Number(row.source_vertical_epsg);
  return Number.isFinite(h) && Number.isFinite(v) && h === tile.horizontalEpsg && v === tile.verticalEpsg;
}

function hasAccuracy(row: RawCheckpointRow): boolean {
  return row.accuracy !== '' && Number.isFinite(Number(row.accuracy)) && Number(row.accuracy) >= 0;
}

function hasPointType(row: RawCheckpointRow): boolean {
  return row.point_type === 'NVA' || row.point_type === 'VVA';
}

export interface PrerequisiteResult {
  readonly ok: boolean;
  readonly reasons: string[];
  /** Rows that passed every gate except the minimum-sample-size check. */
  readonly usable: readonly RawCheckpointRow[];
}

/**
 * The fail-closed prerequisite gate. See the file header for the ordered list
 * of checks. Every failing check appends its own reason; the gate never stops
 * at the first failure, so a caller sees the whole picture in one pass.
 */
export function checkpointPrerequisites(rows: readonly RawCheckpointRow[], tile: TileFrame): PrerequisiteResult {
  const reasons: string[] = [];

  const inExtent = rows.filter((r) => withinTileExtent(r, tile));
  if (inExtent.length === 0) {
    reasons.push(`0 of ${rows.length} project checkpoint(s) fall inside the tile extent`);
  }

  const crsOk = inExtent.filter((r) => crsMatchesTile(r, tile));
  if (inExtent.length > 0 && crsOk.length === 0) {
    reasons.push(
      `${inExtent.length} checkpoint(s) in extent, but none share the tile's ` +
        `horizontal/vertical EPSG (${tile.horizontalEpsg}/${tile.verticalEpsg})`,
    );
  } else if (crsOk.length < inExtent.length) {
    reasons.push(
      `${inExtent.length - crsOk.length} in-extent checkpoint(s) excluded: CRS does not match the tile ` +
        `(EPSG ${tile.horizontalEpsg}/${tile.verticalEpsg})`,
    );
  }

  const withAccuracy = crsOk.filter(hasAccuracy);
  if (crsOk.length > 0 && withAccuracy.length < crsOk.length) {
    reasons.push(`${crsOk.length - withAccuracy.length} checkpoint(s) lack a stated accuracy/uncertainty value`);
  }

  const withPointType = withAccuracy.filter(hasPointType);
  if (withAccuracy.length > 0 && withPointType.length < withAccuracy.length) {
    reasons.push(
      `${withAccuracy.length - withPointType.length} checkpoint(s) lack a point_type (NVA/VVA); ` +
        'the accuracy-type label is required to treat the row as a vertical-accuracy observation',
    );
  }

  if (withPointType.length < MIN_CHECKPOINT_SAMPLE_SIZE) {
    reasons.push(
      `${withPointType.length} usable checkpoint(s), ${MIN_CHECKPOINT_SAMPLE_SIZE} required ` +
        '(MIN_CHECKPOINT_SAMPLE_SIZE)',
    );
  }

  return { ok: reasons.length === 0, reasons, usable: withPointType };
}

/**
 * Externally-established independence of individual checkpoints.
 *
 * The GDB does not carry independence (a point_type is an accuracy-type label,
 * not proof a checkpoint was withheld from the product's calibration,
 * registration, or tuning). The caller supplies what external provenance
 * established:
 *
 *   - `independentIds`: unique_identifiers confirmed independent. A checkpoint
 *     in this set is marked `usage: 'independent'`.
 *   - `usageById`: a specific `CheckpointUsage` per checkpoint, for provenance
 *     that recorded a leaking role (control/registration/parameter-tuning/
 *     manual-correction) rather than independence. Takes precedence over
 *     `independentIds` for the ids it names, and a leaking usage here is carried
 *     into `checkpointAccuracy()` so it refuses over that checkpoint rather than
 *     the adapter dropping it.
 *
 * A checkpoint named by neither is left at `INDEPENDENCE_NOT_ESTABLISHED`.
 */
export interface IndependenceProvenance {
  readonly independentIds?: ReadonlySet<string>;
  readonly usageById?: ReadonlyMap<string, CheckpointUsage>;
}

/**
 * The `usage` given to a checkpoint whose independence external provenance did
 * not confirm. It is intentionally NOT one of CHECKPOINT_USAGES: an unconfirmed
 * checkpoint's independence is UNKNOWN, not known-leaked. `checkpointAccuracy()`
 * does not recognise this string, so it triggers an `unknown-usage` refusal that
 * names the checkpoint ("an unreadable usage cannot be shown to be
 * independent"), rather than the value silently entering an independent-accuracy
 * figure. Supply `IndependenceProvenance` to lift a checkpoint out of it.
 */
export const INDEPENDENCE_NOT_ESTABLISHED: string = 'independence-not-established';

function resolveUsage(id: string, provenance?: IndependenceProvenance): CheckpointUsage {
  const explicit = provenance?.usageById?.get(id);
  if (explicit !== undefined) return explicit;
  if (provenance?.independentIds?.has(id)) return 'independent';
  // Cast at the parse boundary the way checkpointAccuracy() documents: the value
  // is not a CheckpointUsage, and its isUsage() runtime check refuses it.
  return INDEPENDENCE_NOT_ESTABLISHED as CheckpointUsage;
}

/**
 * Prediction coverage over the checkpoints offered to the product.
 *
 * A checkpoint with no finite product prediction at its XY (outside the DTM's
 * coverage, or a void inside it) carries no comparison, so it cannot become a
 * `Checkpoint`. It is COUNTED here rather than dropped: `pooled.n` alone cannot
 * tell a reader whether a low sample is a thin survey or a tile the product
 * barely covered. The GDB/prediction map does not say WHY a prediction is
 * missing, so no outside-coverage vs void distinction is fabricated.
 */
export interface PredictionCoverageLedger {
  /** Checkpoints offered for comparison (rows that passed the prerequisite gate). */
  readonly eligible: number;
  /** Of those, the ones with a finite product prediction at their XY. */
  readonly predicted: number;
  /** Of those, the ones with no finite prediction. `eligible - predicted`. */
  readonly unpredicted: number;
}

/** Optional metadata the caller establishes about the checkpoint set. */
export interface CheckpointAdapterOptions {
  /** Externally-established per-checkpoint independence. */
  readonly independence?: IndependenceProvenance;
  /**
   * What the GDB `accuracy` field's number means statistically. The 3DEP
   * checkpoint schema does not state this per row, so it defaults to `'unknown'`
   * (fail-closed): an unlabelled value is NOT taken as a 1-sigma standard
   * uncertainty. Set it (for example to `'95-percent'`) only when external
   * metadata establishes what the field is.
   */
  readonly accuracyMeaning?: ReferenceUncertaintyMeaning;
}

/** `checkpointAccuracy()` input plus the coverage ledger over the same rows. */
export interface AccuracyCheckpointBuild {
  readonly checkpoints: Checkpoint[];
  readonly ledger: PredictionCoverageLedger;
}

/**
 * Build `checkpointAccuracy()` input from checkpoint rows that already passed
 * `checkpointPrerequisites`, given the product's measured elevation at each
 * checkpoint's XY (by `unique_identifier`).
 *
 * Independence comes from `options.independence`, not from the GDB. The stated
 * accuracy value is wrapped in a `ReferenceUncertainty` whose meaning is
 * `options.accuracyMeaning` (default `'unknown'`), so an unlabelled value is
 * never converted to a 1-sigma sigma by `checkpointAccuracy()`.
 *
 * Rows with no finite product prediction cannot form a comparison, so they do
 * not become a `Checkpoint`; they are counted in the returned ledger rather than
 * dropped silently.
 */
export function toAccuracyCheckpoints(
  rows: readonly RawCheckpointRow[],
  measuredById: ReadonlyMap<string, number>,
  options: CheckpointAdapterOptions = {},
): AccuracyCheckpointBuild {
  const meaning: ReferenceUncertaintyMeaning = options.accuracyMeaning ?? 'unknown';
  const out: Checkpoint[] = [];
  let predicted = 0;
  for (const r of rows) {
    const measured = measuredById.get(r.unique_identifier);
    if (measured === undefined || !Number.isFinite(measured)) continue;
    predicted++;
    out.push({
      id: r.unique_identifier,
      measured,
      reference: Number(r.source_elevation),
      usage: resolveUsage(r.unique_identifier, options.independence),
      referenceUncertainty: referenceUncertaintyFromValue(
        Number(r.accuracy),
        meaning,
        '3DEP checkpoint accuracy field',
      ),
    });
  }
  const eligible = rows.length;
  return { checkpoints: out, ledger: { eligible, predicted, unpredicted: eligible - predicted } };
}

/** Mean Absolute Error over residuals — not reported by `checkpointAccuracy()`. */
export function meanAbsoluteError(residuals: readonly number[]): number | null {
  if (residuals.length === 0) return null;
  let sum = 0;
  for (const r of residuals) sum += Math.abs(r);
  return sum / residuals.length;
}

const EMPTY_LEDGER: PredictionCoverageLedger = { eligible: 0, predicted: 0, unpredicted: 0 };

export interface CheckpointStudyOutcome {
  readonly prereq: PrerequisiteResult;
  readonly result: CheckpointResult | null;
  readonly mae: number | null;
  /**
   * Prediction coverage over the gated checkpoints. Populated even when
   * `result` is a refusal (for example an insufficient sample caused by low
   * coverage): the count of eligible checkpoints and how many the product
   * predicted is a reported figure, not something a refusal erases.
   */
  readonly coverage: PredictionCoverageLedger;
  /**
   * `coverage.predicted / coverage.eligible`, or null when nothing was eligible.
   * A tile the product barely covered reports a low coverage here rather than a
   * shrunken checkpoint sample.
   */
  readonly predictionCoverage: number | null;
}

/**
 * End-to-end: gate, then (only if the gate passes) compute pooled/stratified
 * accuracy plus MAE. Fails closed: `result`/`mae` stay `null` whenever
 * `prereq.ok` is false, never a partial figure over an ungated sample. The
 * coverage ledger is always populated (empty when the gate closed before any
 * row was eligible).
 *
 * Independence and the accuracy-field meaning are supplied through `options`;
 * with none, every checkpoint stays at `INDEPENDENCE_NOT_ESTABLISHED` and
 * `checkpointAccuracy()` refuses (`unknown-usage`) rather than reporting an
 * independent-accuracy figure the provenance does not support.
 */
export function runCheckpointStudy(
  rows: readonly RawCheckpointRow[],
  tile: TileFrame,
  measuredById: ReadonlyMap<string, number>,
  options: CheckpointAdapterOptions = {},
): CheckpointStudyOutcome {
  const prereq = checkpointPrerequisites(rows, tile);
  if (!prereq.ok) {
    return { prereq, result: null, mae: null, coverage: EMPTY_LEDGER, predictionCoverage: null };
  }
  const { checkpoints, ledger } = toAccuracyCheckpoints(prereq.usable, measuredById, options);
  const result = checkpointAccuracy(checkpoints, { minSample: MIN_CHECKPOINT_SAMPLE_SIZE });
  const mae =
    result.status === 'reported' ? meanAbsoluteError(result.residuals.map((r) => r.residual)) : null;
  const predictionCoverage = ledger.eligible === 0 ? null : ledger.predicted / ledger.eligible;
  return { prereq, result, mae, coverage: ledger, predictionCoverage };
}
