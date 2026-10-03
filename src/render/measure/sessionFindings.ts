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

/** What {@link SessionFindings.clear} removed, so the caller can offer Undo. */
export interface ClearedFindings {
  readonly ownerId: string | null;
  readonly findings: ReadonlyArray<ReportFinding>;
}

export class SessionFindings {
  /**
   * Findings kept per owner scan id. Only the active owner's list is visible
   * through `all`; switching scans changes which list that is and never
   * deletes another scan's findings. Scan ids are unique for the session, so a
   * kept list can never reattach to a different dataset.
   */
  private readonly _byOwner = new Map<string | null, ReportFinding[]>();
  /**
   * The scan the visible findings were measured on. A report describes one
   * dataset, so `all` only ever returns findings measured on this scan.
   * `null` means no scan has claimed the ledger yet.
   */
  private _ownerId: string | null = null;
  private readonly _listeners = new Set<() => void>();

  /** Told after every change to the ledger. Returns an unsubscribe. */
  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  private _changed(): void {
    for (const fn of [...this._listeners]) {
      try { fn(); } catch { /* a reader never breaks the ledger */ }
    }
  }

  private _list(owner: string | null = this._ownerId): ReportFinding[] {
    let list = this._byOwner.get(owner);
    if (!list) {
      list = [];
      this._byOwner.set(owner, list);
    }
    return list;
  }

  /** The scan the visible findings belong to, or null before any scan claims it. */
  get ownerId(): string | null {
    return this._ownerId;
  }

  /**
   * Show the findings of the active scan. The previous scan's findings are kept
   * and come back when that scan is active again. Returns how many findings
   * were set aside (0 when the owner is unchanged, so an idle call is free).
   */
  retarget(targetId: string | null): number {
    if (targetId === this._ownerId) return 0;
    const setAside = this._list().length;
    this._ownerId = targetId;
    this._changed();
    return setAside;
  }

  /** Drop the findings kept for a scan that has been removed. */
  forget(ownerId: string): void {
    const had = this._byOwner.get(ownerId);
    if (!this._byOwner.delete(ownerId)) return;
    if (ownerId === this._ownerId && had && had.length > 0) this._changed();
  }

  add(finding: ReportFinding): void {
    this._list().push(finding);
    this._changed();
  }

  get all(): ReadonlyArray<ReportFinding> {
    return this._byOwner.get(this._ownerId) ?? [];
  }

  get count(): number {
    return this.all.length;
  }

  /** Drop the most recent finding (e.g. the user discarded a measurement). */
  pop(): ReportFinding | undefined {
    const f = this._list().pop();
    if (f) this._changed();
    return f;
  }

  /** Drop the finding at `index` (a row the reviewer removed). No-op if out of range. */
  remove(index: number): void {
    const list = this._list();
    if (index >= 0 && index < list.length) {
      list.splice(index, 1);
      this._changed();
    }
  }

  /** Empty the active scan's findings. Returns what was removed, for Undo. */
  clear(): ClearedFindings {
    const cleared: ClearedFindings = { ownerId: this._ownerId, findings: [...this.all] };
    this._byOwner.delete(this._ownerId);
    this._changed();
    return cleared;
  }

  /**
   * Put back findings removed by {@link clear}, ahead of anything added since.
   * They return to the scan they were measured on, whichever scan is active.
   */
  restore(cleared: ClearedFindings): void {
    if (cleared.findings.length === 0) return;
    const list = this._list(cleared.ownerId);
    list.unshift(...cleared.findings);
    if (cleared.ownerId === this._ownerId) this._changed();
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
