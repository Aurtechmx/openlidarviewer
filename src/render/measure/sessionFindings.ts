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

  clear(): void {
    this._findings.length = 0;
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
