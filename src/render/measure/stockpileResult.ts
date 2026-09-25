/**
 * stockpileResult.ts — the one canonical result of a lasso volume.
 *
 * The lasso record stores the area-weighted grid's figure, with the
 * point-sample cut and fill kept beside it as a labelled cross-check; a
 * withheld grid is saved as withheld, with no grid number. The measured
 * accuracy of both estimators is in ledger L05. {@link buildStockpileResult} builds that
 * record once, stamped with {@link STOCKPILE_RESULT_SCHEMA}; the toast line is
 * formatted from it ({@link stockpileResultHeadline}), and the saved
 * measurement, the session file, the CSV and GeoJSON, the findings report and
 * the evidence stamp all read the same object afterwards. Nothing downstream
 * recomputes it, and a record saved under an older method or schema is read
 * as saved.
 *
 * Lives in the lazy stockpile chunk (loaded through `loadStockpilePresenter`),
 * so none of it lands in the startup shell.
 */
import type { VolumeRecord, VolumeWithheldCounts } from './types';

/** Shape version of a lasso result built here. Bump when its fields change meaning. */
export const STOCKPILE_RESULT_SCHEMA = 1;

/**
 * What {@link withStockpileGrid} needs from the area-weighted grid.
 * Structurally compatible with `StockpileAreaGridView`, which the caller
 * passes.
 */
export interface StockpileGridFigure {
  /** id@version of the grid estimator. */
  readonly method: string;
  readonly authority: 'measured' | 'preview' | 'withheld';
  readonly reason: string;
  /** Native render/source linear units cubed — same contract as VolumeRecord. */
  readonly fillNative: number;
  readonly cutNative: number;
  readonly netNative: number;
}

/**
 * The area-weighted grid becomes the canonical figure for a LASSO
 * `VolumeRecord`. `record` is the point-sample record `deriveVolumeRecord`
 * already built for the same lasso; `grid` is `null` when the grid could not
 * be evaluated at all (no band loaded, a degenerate footprint) — the
 * point-sample record then passes through exactly as it was, which is also
 * what the hand-drawn polygon Volume tool gets by never calling this at all
 * (only the lasso record switches).
 *
 * When a grid figure exists, its numbers become `fill`/`cut`/`net` and
 * `method`; the point-sample numbers this record already carried move to
 * `crossCheck` under their own tag rather than being dropped.
 * A withheld grid clears `fill`/`cut`/`net` outright — the
 * cross-check is still there for a reader who wants a number, but it is
 * never presented under the grid's name.
 */
export function withStockpileGrid(
  record: VolumeRecord,
  grid: StockpileGridFigure | null,
): VolumeRecord {
  if (!grid) return record;
  const { fill, cut, net, method } = record;
  // Total function: a record with no point-sample figure or no estimator tag
  // (never true on the live path, which always supplies both) has nothing to
  // move into `crossCheck`, so it is returned unenriched rather than guessed at.
  if (fill === undefined || cut === undefined || net === undefined || method === undefined) {
    return record;
  }
  const enriched: VolumeRecord = {
    ...record,
    method: grid.method,
    gridAuthority: grid.authority,
    gridAuthorityReason: grid.reason,
    crossCheck: { fill, cut, net, method },
  };
  if (grid.authority === 'withheld') {
    delete enriched.fill;
    delete enriched.cut;
    delete enriched.net;
  } else {
    enriched.fill = grid.fillNative;
    enriched.cut = grid.cutNative;
    enriched.net = grid.netNative;
  }
  return enriched;
}

/**
 * Build the canonical lasso result: the point-sample record switched to the
 * grid (or left as it is when the grid could not be evaluated), with the
 * input counts and the schema version attached.
 */
export function buildStockpileResult(
  pointSample: VolumeRecord,
  grid: StockpileGridFigure | null,
  withheld: VolumeWithheldCounts | undefined,
): VolumeRecord {
  const record: VolumeRecord = { ...withStockpileGrid(pointSample, grid), resultSchema: STOCKPILE_RESULT_SCHEMA };
  if (withheld) record.withheld = { ...withheld };
  return record;
}

const m3 = (n: number, vol: number): string => `${(n * vol).toFixed(2)} m³`;

/**
 * The toast's volume clause, read from the result. `vol` is the native→m³
 * factor (linear² · vertical). A grid figure leads, the point-sample net
 * follows as the cross-check; a withheld grid prints no grid number at all.
 */
export function stockpileResultHeadline(r: VolumeRecord, vol: number): string {
  const cc = r.crossCheck;
  let head: string;
  if (r.fill !== undefined && r.cut !== undefined && r.net !== undefined) {
    head = `Volume · fill ${m3(r.fill, vol)} · cut ${m3(r.cut, vol)} · net ${m3(r.net, vol)}`;
    if (r.gridAuthority) {
      head += r.gridAuthority === 'preview'
        ? ` (area-weighted grid, PREVIEW: ${r.gridAuthorityReason})`
        : ' (area-weighted grid)';
    }
  } else {
    head = `Volume withheld (${r.gridAuthorityReason || 'insufficient observations'})`;
  }
  if (cc) head += ` · point-sample cross-check fill ${m3(cc.fill, vol)} · cut ${m3(cc.cut, vol)} · net ${m3(cc.net, vol)}`;
  return head + withheldClause(r.withheld);
}

/** ` · N Withheld points excluded`, ` · Withheld flags unavailable`, or `''`. */
export function withheldClause(w: VolumeWithheldCounts | undefined): string {
  if (!w) return '';
  if (w.excluded === 'unknown') return ' · Withheld flags unavailable';
  return w.excluded > 0 ? ` · ${w.excluded.toLocaleString()} Withheld points excluded` : '';
}
