/**
 * CrsService.ts
 *
 * The CRS service boundary — one place every consumer asks "what CRS
 * is the active scan in?" Before this module, CRS state was spread
 * across four orthogonal seams:
 *
 *   - `CrsDetection.detectCrs(signals)` resolved per-load.
 *   - `CrsRegistry` carried the well-known EPSG catalogue.
 *   - `CrsOverrideStore` persisted user choices.
 *   - `main.ts` glued them via `resolveCloudCrs` + a `_currentResolvedCrs`
 *     module cache the inspector / measurement / point inspector each
 *     reached for through different channels.
 *
 * The service unifies that:
 *
 *   - Owns the per-scan `ResolvedCrs` state.
 *   - Combines detection + override + registry into one entry point.
 *   - Surfaces the validation verdict (`canDisplayMetric`,
 *     `canSaveMeasurement`).
 *   - Forwards UTM helpers so callers don't reach across modules.
 *   - Pub/sub for listeners that need to react to a CRS swap (the
 *     measurement HUD's CRS badge, the inspector's override panel,
 *     the point inspector's coordinate context).
 *
 * Pure-data shape, no DOM. The override store IS browser-dependent;
 * the service injects it as a port so tests can swap a fake.
 */

import type {
  CrsSource,
  ResolvedCrs,
} from './CoordinateTypes';
import {
  resolvedFromCrsInfo,
  unknownCrs,
} from './CoordinateTypes';
import type { CrsInfo } from '../io/crs';
import {
  validateCrsForMeasurement,
  type CrsValidationResult,
} from './CrsValidation';
import {
  latLonToUtm,
  utmZoneFor,
  type UtmGridPoint,
} from './UtmConverter';
import { getCrsEntry, resolveHorizontalDatum } from './CrsRegistry';
import {
  clearOverride as defaultClearOverride,
  getOverride as defaultGetOverride,
  keyForDataset,
  setOverride as defaultSetOverride,
  type CrsOverride,
} from './CrsOverrideStore';

/** The port the service uses to read + write user overrides. */
export interface CrsOverridePort {
  readonly get: (datasetKey: string) => CrsOverride | undefined;
  readonly set: (
    datasetKey: string,
    override: Omit<CrsOverride, 'updatedAt'>,
  ) => void;
  readonly clear: (datasetKey: string) => void;
}

/** The browser-backed default port — uses the persistent localStorage store. */
export const DEFAULT_CRS_OVERRIDE_PORT: CrsOverridePort = {
  get: defaultGetOverride,
  set: defaultSetOverride,
  clear: defaultClearOverride,
};

/** A subscriber called whenever the service's current CRS changes. */
export type CrsListener = (crs: ResolvedCrs | null) => void;

/**
 * Inputs to `resolveForScan` — everything the service needs to combine
 * a per-load `CrsInfo` with an existing override and emit a single
 * `ResolvedCrs`.
 */
export interface ResolveForScanInput {
  /**
   * Display name of the loaded scan. Used to compute the override-
   * store key — case-insensitive, whitespace-trimmed, truncated.
   */
  readonly name: string;
  /** Detected CRS from the LAS/COPC/EPT loader, or `undefined`. */
  readonly detected: CrsInfo | undefined;
  /** Where the detection came from — drives the source label. */
  readonly source: CrsSource;
}

/**
 * The CRS service. One instance per Viewer / per session is plenty;
 * the service owns no DOM and no module-level state beyond the port.
 *
 * Listeners receive `null` when the active scan closes and a fresh
 * `ResolvedCrs` after every successful resolve / override change.
 */
export class CrsService {
  private readonly _port: CrsOverridePort;
  private readonly _listeners: Set<CrsListener> = new Set();
  private _currentDatasetKey: string | undefined = undefined;
  private _current: ResolvedCrs | null = null;

  constructor(port: CrsOverridePort = DEFAULT_CRS_OVERRIDE_PORT) {
    this._port = port;
  }

  /** The current ResolvedCrs, or `null` when no scan is open. */
  current(): ResolvedCrs | null {
    return this._current;
  }

  /** The dataset key the active scan resolves against, or `undefined`. */
  currentDatasetKey(): string | undefined {
    return this._currentDatasetKey;
  }

  /**
   * Resolve a CRS for a freshly-loaded scan. Combines the detector's
   * signal with any persisted user override, lands on a single
   * ResolvedCrs, caches it, and broadcasts to listeners. Returns the
   * same ResolvedCrs for the caller's convenience.
   */
  resolveForScan(input: ResolveForScanInput): ResolvedCrs {
    const datasetKey = keyForDataset(input.name);
    this._currentDatasetKey = datasetKey;
    const override = this._port.get(datasetKey);
    // An override belongs to the file it was made for. The key is the dataset
    // NAME, so `site-a/points.laz` and an unrelated `site-b/points.laz` collide
    // and the stored choice would outrank the second file's own correct
    // declaration, at high confidence. Comparing the declaration recorded with
    // the override tells them apart — and still lets a user override a file's
    // own wrong CRS, because that file declares the same thing every reopen.
    const belongsToThisFile =
      override?.detectedEpsg === undefined ||
      input.detected?.epsg === undefined ||
      override.detectedEpsg === input.detected.epsg;
    const applicable = override && belongsToThisFile ? override : undefined;
    const resolved = this._resolveDatum(applicable
      ? this._fromOverride(applicable, input.detected)
      : (resolvedFromCrsInfo(input.detected, input.source) ?? unknownCrs()));
    this._setCurrent(resolved);
    return resolved;
  }

  /**
   * Apply a user override to the active scan. Persists via the
   * configured port, re-resolves immediately, and broadcasts the new
   * CRS to listeners. No-op when there's no active scan.
   *
   * `epsg === null && kind === 'local'` is the "use detected" sentinel
   * — clear the persisted override and fall back to whatever the
   * loader supplied for the active dataset.
   */
  setOverride(args: {
    readonly override: {
      readonly epsg: number | null;
      readonly kind: 'projected' | 'geographic' | 'local';
    };
    /**
     * The detected CRS for the active dataset, so the service can
     * re-resolve cleanly when the user picks "use detected".
     */
    readonly detected: CrsInfo | undefined;
    /** Source the loader assigned to the detected CRS. */
    readonly source: CrsSource;
  }): ResolvedCrs | null {
    if (!this._currentDatasetKey) return null;
    if (args.override.epsg === null && args.override.kind === 'local') {
      this._port.clear(this._currentDatasetKey);
      const resolved = this._resolveDatum(
        resolvedFromCrsInfo(args.detected, args.source) ?? unknownCrs(),
      );
      this._setCurrent(resolved);
      return resolved;
    }
    this._port.set(this._currentDatasetKey, {
      epsg: args.override.epsg,
      kind: args.override.kind,
      // What this file declared when the choice was made — see resolveForScan.
      // Without it the entry cannot be told apart from one belonging to an
      // unrelated file that happens to share a name.
      detectedEpsg: args.detected?.epsg,
    });
    const override = this._port.get(this._currentDatasetKey);
    if (!override) return this._current;
    const resolved = this._resolveDatum(this._fromOverride(override, args.detected));
    this._setCurrent(resolved);
    return resolved;
  }

  /** Clear the active scan's CRS state. Used on close. */
  clear(): void {
    this._currentDatasetKey = undefined;
    this._setCurrent(null);
  }

  /** The validation verdict for the current CRS — `null` when no scan is open. */
  validation(): CrsValidationResult {
    return validateCrsForMeasurement(this._current);
  }

  /**
   * The active scan's resolved horizontal datum (e.g. "NAD83(2011)", "WGS 84"),
   * or undefined when unknown. Single source of truth — consumers read this
   * instead of re-inferring the datum from the CRS name or EPSG ranges.
   */
  horizontalDatum(): string | undefined {
    return this._current?.horizontalDatum;
  }

  /** Compute UTM grid coords for a lat/lon point using the canonical helper. */
  utmFor(lat: number, lon: number, elevation?: number): UtmGridPoint {
    return latLonToUtm(lat, lon, elevation);
  }

  /** Compute the canonical UTM zone for a lat/lon point. */
  utmZoneFor(lat: number, lon: number): { zone: number; hemisphere: 'N' | 'S' } {
    return utmZoneFor(lat, lon);
  }

  /**
   * Compact display label combining EPSG + name for the volume HUD,
   * the inspector card, and the PDF report. Mirrors the formatting
   * the existing `formatCrsLabel` in `mapExportLayout` returns so
   * call sites read consistently across surfaces.
   */
  displayLabel(): string {
    const crs = this._current;
    if (!crs) return 'No scan loaded';
    if (crs.kind === 'local') return 'Local coordinates';
    if (crs.kind === 'unknown') return 'CRS unknown';
    if (typeof crs.epsg === 'number') {
      const entry = getCrsEntry(crs.epsg);
      const label = entry?.label ?? crs.name;
      return `EPSG:${crs.epsg} · ${label}`;
    }
    return crs.name;
  }

  /**
   * Subscribe to CRS change events. Returns an unsubscribe function;
   * call it to detach. The subscriber is fired immediately with the
   * current value so it can paint a one-line caveat on mount without
   * a separate "what is the current state?" call.
   */
  subscribe(listener: CrsListener): () => void {
    this._listeners.add(listener);
    // Defensive fire — the same isolation we apply to broadcasts so a
    // buggy first-fire doesn't poison the rest of the session.
    try {
      listener(this._current);
    } catch {
      // Swallow; the subscriber is registered and will receive future
      // broadcasts. Letting the constructor caller see this throw
      // would skip the unsubscribe registration and leak the listener.
    }
    return () => this._listeners.delete(listener);
  }

  /** Number of active subscribers — used by disposal tests. */
  subscriberCount(): number {
    return this._listeners.size;
  }

  // ── private ────────────────────────────────────────────────────────

  private _setCurrent(next: ResolvedCrs | null): void {
    this._current = next;
    for (const fn of this._listeners) {
      try {
        fn(next);
      } catch {
        // Defensive — a buggy subscriber must not poison the broadcast
        // for the rest. The Inspector / measurement HUD subscribers
        // are expected to be defensive themselves, but we don't trust
        // every future caller to do the right thing.
      }
    }
  }

  /**
   * Translate a `CrsOverride` (from the store) into a ResolvedCrs,
   * borrowing labels from the registry when the EPSG is known and
   * falling back to the detector's VLR labels otherwise.
   */
  private _fromOverride(
    override: CrsOverride,
    detected: CrsInfo | undefined,
  ): ResolvedCrs {
    if (override.kind === 'local' || override.epsg === null) {
      return {
        kind: 'local',
        name: 'Local coordinates (no CRS)',
        linearUnit: 'unknown',
        linearUnitToMetres: 1,
        source: 'user-override',
        confidence: 'high',
        userConfirmed: true,
      };
    }
    const entry = getCrsEntry(override.epsg);
    const name =
      detected?.name && detected.epsg === override.epsg
        ? detected.name
        : (entry?.label ?? `EPSG:${override.epsg}`);
    return {
      kind: override.kind,
      name,
      epsg: override.epsg,
      // Linear unit, in priority order: borrow the detector's when it described
      // this exact EPSG; else read the registry entry's unit (set only for the
      // non-metre entries); else fall back — geographic is angular ('unknown'),
      // a projected entry defaults to metres. Metres is the correct default
      // here, not an assumption: every projected CRS this app can resolve
      // (epsgToProj4) is metre-based, and `getCrsEntry` enumerates only the
      // curated picker list (not parametric UTM), so a UTM override is
      // legitimately absent from it yet still metres.
      linearUnit:
        detected?.epsg === override.epsg
          ? detected.linearUnit
          : (entry?.linearUnit ?? (override.kind === 'geographic' ? 'unknown' : 'metre')),
      linearUnitToMetres:
        detected?.epsg === override.epsg
          ? detected.linearUnitToMetres
          : (entry?.linearUnitToMetres ?? 1),
      // Horizontal datum: borrow the detector's WKT datum only when it described
      // this exact EPSG (so an override to a DIFFERENT EPSG drops the now-wrong
      // WKT datum); the registry fallback for the chosen EPSG is then applied
      // uniformly by `_resolveDatum`. Mirrors the name / unit precedence above.
      horizontalDatum:
        detected?.epsg === override.epsg ? detected?.horizontalDatum : undefined,
      source: 'user-override',
      confidence: 'high',
      userConfirmed: true,
      wkt: detected?.wkt,
    };
  }

  /**
   * Fill the registry datum fallback so every resolution path ends with ONE
   * consistent horizontal datum (a WKT datum already present is preserved —
   * never downgraded; see {@link resolveHorizontalDatum}). Idempotent.
   */
  private _resolveDatum(crs: ResolvedCrs): ResolvedCrs {
    const datum = resolveHorizontalDatum(crs.horizontalDatum, crs.epsg);
    return datum === crs.horizontalDatum ? crs : { ...crs, horizontalDatum: datum };
  }
}
