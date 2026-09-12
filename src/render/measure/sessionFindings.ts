/**
 * sessionFindings.ts
 *
 * The session ledger that the integrity report is built from.
 *
 * Measurements are computed ad-hoc and shown in toasts; nothing collected them
 * into something a report could assemble. This is that collector — an ordered
 * list of {@link ReportFinding}s, each a number WITH its uncertainty band and
 * caveats — plus converters that turn the measurement cores' results into
 * findings so the band and the honesty notes survive the trip into the report
 * intact (no re-formatting, no dropped caveats).
 *
 * Pure data. The UI adds a finding when a measurement is taken; the report
 * export reads `all` and hands it to {@link buildReportManifest}.
 */

import type { ReportFinding } from './reportManifest';
import type { StockpileVolumeResult } from './stockpileVolume';
import type { ChangeVolumeUncertainty } from '../../terrain/change/changeUncertainty';

export class SessionFindings {
  private readonly _findings: ReportFinding[] = [];
  /**
   * The scan every finding in this ledger was measured on.
   *
   * The ledger deliberately outlives a panel re-render, and nothing bounded it
   * to a scan. Findings measured on A therefore survived opening B, and the
   * report they were exported into took its dataset name, CRS and
   * classification epoch from B — one manifest describing one dataset, filled
   * with another dataset's numbers. The report schema has no way to express
   * that, so the ledger must not be able to reach that state.
   *
   * `null` means "no findings yet"; the first `add` claims the ledger.
   */
  private _ownerId: string | null = null;

  /** The scan this ledger belongs to, or null while it is empty. */
  get ownerId(): string | null {
    return this._ownerId;
  }

  /**
   * Bind the ledger to the active scan, dropping findings measured on another.
   *
   * Called when the export target changes. Returns the number of findings
   * discarded so the caller can tell the user rather than silently losing work.
   * Re-asserting the SAME owner keeps everything, so an idle re-render costs
   * nothing.
   */
  retarget(targetId: string | null): number {
    if (targetId === this._ownerId) return 0;
    const dropped = this._findings.length;
    this._findings.length = 0;
    this._ownerId = targetId;
    return dropped;
  }

  add(finding: ReportFinding): void {
    this._findings.push(finding);
  }

  get all(): ReadonlyArray<ReportFinding> {
    return this._findings;
  }

  get count(): number {
    return this._findings.length;
  }

  /** Drop the most recent finding (e.g. the user discarded a measurement). */
  pop(): ReportFinding | undefined {
    return this._findings.pop();
  }

  /** Drop the finding at `index` (a row the reviewer removed). No-op if out of range. */
  remove(index: number): void {
    if (index >= 0 && index < this._findings.length) this._findings.splice(index, 1);
  }

  clear(): void {
    this._findings.length = 0;
    this._ownerId = null;
  }
}

/**
 * Stockpile result → finding, converting native CRS units to metres. A stockpile
 * volume is footprint area times thickness, so the factor is lin²·vert: the
 * horizontal factor squared for the footprint, the vertical factor once for the
 * height. `vert` defaults to `lin`, which keeps a single-unit CRS at lin³; a
 * compound CRS (metre eastings over foot heights) must not scale height by the
 * horizontal factor, matching {@link measurementMetrics}. The ± band,
 * confidence, and the honest caveats ride through unchanged.
 */
export function stockpileFinding(
  result: StockpileVolumeResult,
  lin = 1,
  label = 'Stockpile volume',
  vert = lin,
): ReportFinding {
  const v = Number.isFinite(vert) && vert > 0 ? vert : lin;
  const volFactor = lin * lin * v;
  return {
    label,
    value: result.volume * volFactor,
    unit: 'm³',
    sigma: result.sigma * volFactor,
    confidence: result.confidence,
    caveats: result.caveats,
  };
}

/**
 * Two-epoch change → finding. The net volume is already in m³; the band and the
 * detectability caveat come from {@link changeVolumeUncertainty}. When the
 * change isn't distinguishable from noise, the confidence reads 'low' and the
 * caveat says so — the report never presents noise as a confident change.
 */
export function changeFinding(
  netVolumeM3: number,
  uncertainty: ChangeVolumeUncertainty,
  label = 'Volume change (two-epoch)',
): ReportFinding {
  return {
    label,
    value: netVolumeM3,
    unit: 'm³',
    sigma: uncertainty.sigmaM3,
    confidence: uncertainty.confidence,
    caveats: uncertainty.caveats,
  };
}
