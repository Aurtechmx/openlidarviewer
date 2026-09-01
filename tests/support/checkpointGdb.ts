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
 *     of its rows may be treated as an independent, usable checkpoint; and
 *   - Mean Absolute Error, which `checkpointAccuracy()` does not report
 *     (it reports bias, RMSE, median, NMAD, P90/P95, max — MAE is computed
 *     here directly from the same residuals it returns).
 *
 * Fail-closed prerequisites, in the order checked:
 *   1. at least one checkpoint of the project falls inside the tile extent;
 *   2. of those, at least one shares the tile's horizontal AND vertical EPSG
 *      (a checkpoint surveyed in a different datum is not comparable without
 *      a reprojection this module does not perform, so it is excluded, not
 *      silently reprojected);
 *   3. of those, the checkpoint states an accuracy/uncertainty value;
 *   4. of those, the checkpoint states a point_type (NVA/VVA) — the field
 *      that marks it as an independent survey observation rather than a
 *      derived or unlabelled row;
 *   5. the surviving count is >= MIN_CHECKPOINT_SAMPLE_SIZE.
 * Any failure is reported with a specific reason string; the gate does not
 * stop at the first failure; nothing partial is computed for a closed gate.
 */

import { execFileSync } from 'node:child_process';
import {
  checkpointAccuracy,
  type Checkpoint,
  type CheckpointResult,
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
        'independence cannot be established without it',
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
 * Build `checkpointAccuracy()` input from checkpoint rows that already passed
 * `checkpointPrerequisites`, given the product's measured elevation at each
 * checkpoint's XY (by `unique_identifier`). Rows with no measured value
 * (outside DTM coverage) are dropped — they carry no comparison, not a zero.
 */
export function toAccuracyCheckpoints(
  rows: readonly RawCheckpointRow[],
  measuredById: ReadonlyMap<string, number>,
): Checkpoint[] {
  const out: Checkpoint[] = [];
  for (const r of rows) {
    const measured = measuredById.get(r.unique_identifier);
    if (measured === undefined || !Number.isFinite(measured)) continue;
    out.push({
      id: r.unique_identifier,
      measured,
      reference: Number(r.source_elevation),
      usage: 'independent',
      referenceSigma: Number(r.accuracy),
    });
  }
  return out;
}

/** Mean Absolute Error over residuals — not reported by `checkpointAccuracy()`. */
export function meanAbsoluteError(residuals: readonly number[]): number | null {
  if (residuals.length === 0) return null;
  let sum = 0;
  for (const r of residuals) sum += Math.abs(r);
  return sum / residuals.length;
}

export interface CheckpointStudyOutcome {
  readonly prereq: PrerequisiteResult;
  readonly result: CheckpointResult | null;
  readonly mae: number | null;
}

/**
 * End-to-end: gate, then (only if the gate passes) compute pooled/stratified
 * accuracy plus MAE. Fails closed: `result`/`mae` stay `null` whenever
 * `prereq.ok` is false, never a partial figure over an ungated sample.
 */
export function runCheckpointStudy(
  rows: readonly RawCheckpointRow[],
  tile: TileFrame,
  measuredById: ReadonlyMap<string, number>,
): CheckpointStudyOutcome {
  const prereq = checkpointPrerequisites(rows, tile);
  if (!prereq.ok) {
    return { prereq, result: null, mae: null };
  }
  const checkpoints = toAccuracyCheckpoints(prereq.usable, measuredById);
  const result = checkpointAccuracy(checkpoints, { minSample: MIN_CHECKPOINT_SAMPLE_SIZE });
  const mae =
    result.status === 'reported' ? meanAbsoluteError(result.residuals.map((r) => r.residual)) : null;
  return { prereq, result, mae };
}
