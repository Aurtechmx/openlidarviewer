/**
 * CrsService.ts
 *
 * The CRS service boundary — one place every consumer asks "what CRS
 * is the active scan in?" Before this module, CRS state was spread
 * across four orthogonal seams:
 *
 *   - a per-load signal resolver that was never wired in (removed).
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
import { spatialContextFrom, type SpatialContext } from './SpatialContext';
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
/**
 * Relative difference between two spans, or null when either is unusable.
 *
 * A non-positive or non-finite value is NOT a small measurement — it is a
 * degenerate one (bounds not computed yet, an empty buffer, a flat axis), and
 * comparing it against a real span would read as total disagreement and discard
 * a choice the user legitimately made. Unusable means "cannot tell".
 */
function spanRelDiff(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a <= 0 || b <= 0) return null;
  return Math.abs(a - b) / Math.max(a, b);
}

/**
 * Whether a remembered override's dataset and the one being opened positively
 * DISAGREE on point count or bounds spans.
 *
 * Only ever returns false on POSITIVE disagreement: if either side recorded no
 * identity, this cannot tell them apart and says so by returning true. That is
 * not a verified match — {@link classifyOverrideMatch} additionally requires
 * the source position before an override is applied.
 *
 * The tolerances mirror `matchSessionToScan`, which fingerprints a scan on the
 * same two facts for the same reason: 1% on each bounds span, 0.5% on the point
 * count. Both are far wider than float noise and far tighter than the gap
 * between two genuinely different surveys.
 */
export function sameDataset(
  stored: { readonly pointCount?: number; readonly extent?: readonly [number, number, number] } | undefined,
  loaded: { readonly pointCount?: number; readonly extent?: readonly [number, number, number] } | undefined,
): boolean {
  if (!stored || !loaded) return true;
  if (stored.pointCount !== undefined && loaded.pointCount !== undefined) {
    const d = spanRelDiff(stored.pointCount, loaded.pointCount);
    if (d !== null && d > 0.005) return false;
  }
  if (stored.extent && loaded.extent) {
    for (let i = 0; i < 3; i++) {
      const d = spanRelDiff(stored.extent[i], loaded.extent[i]);
      if (d !== null && d > 0.01) return false;
    }
  }
  return true;
}

/** Round an absolute coordinate to 1 mm, so float noise is not a difference. */
function roundMm(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * A scan's identity for override matching: its source point total, the x/y/z
 * spans of its bounds, and the absolute bounds minimum in the source frame
 * (local bounds minimum plus the source/render origin, rounded to 1 mm).
 * Structural, so any object carrying these fields works. Returns undefined when
 * no fact is available.
 *
 * The position is what tells two same-shaped files apart: spans and count
 * survive any translation, so a survey and a copy shifted 100 km matched on
 * everything recorded before it.
 */
export function datasetIdentity(cloud: {
  readonly declaredPointCount?: number;
  readonly sourceDeclaredPointCount?: number;
  readonly pointCount?: number;
  readonly bounds?: () => { readonly min: readonly number[]; readonly max: readonly number[] };
  /** Static clouds: the frame `bounds()` is relative to. */
  readonly sourceOrigin?: readonly number[];
  readonly origin?: readonly number[];
  // A STREAMING source states the same facts in its own shape: a declared
  // source total, bounds as one flat [minX,minY,minZ,maxX,maxY,maxZ] in render
  // space, and the render origin they are relative to.
  readonly sourcePointCount?: number | null;
  readonly dataBounds?: () => readonly number[] | null | undefined;
  readonly localBounds?: () => readonly number[] | null | undefined;
  readonly renderOrigin?: readonly number[];
  /** A content digest of the source, when the caller already holds one. */
  readonly sourceDigest?: string | null;
  /** The catalogue item a stream was opened from, when it was picked from one. */
  readonly catalogItem?: CatalogItemIdentity | null;
} | null | undefined): DatasetIdentity | undefined {
  if (!cloud) return undefined;
  const pointCount = cloud.sourceDeclaredPointCount
    ?? cloud.declaredPointCount
    ?? cloud.sourcePointCount
    ?? cloud.pointCount
    ?? undefined;
  let extent: [number, number, number] | undefined;
  let localMin: readonly number[] | undefined;
  try {
    const b = cloud.bounds?.();
    if (b) {
      extent = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      localMin = b.min;
    } else {
      // Prefer the tight data bounds; the octree cube is a last resort.
      const f = (cloud.dataBounds ?? cloud.localBounds)?.();
      if (f && f.length >= 6) {
        extent = [f[3] - f[0], f[4] - f[1], f[5] - f[2]];
        localMin = [f[0], f[1], f[2]];
      }
    }
  } catch {
    extent = undefined;
    localMin = undefined;
  }
  const o = cloud.sourceOrigin ?? cloud.origin ?? cloud.renderOrigin ?? [0, 0, 0];
  let min: [number, number, number] | undefined;
  if (localMin) {
    const m = [0, 1, 2].map((i) => roundMm((o[i] ?? 0) + localMin[i]));
    if (m.every(Number.isFinite)) min = [m[0], m[1], m[2]];
  }
  const digest = cloud.sourceDigest ?? undefined;
  const item = cloud.catalogItem ?? undefined;
  if (pointCount === undefined && !extent && !digest && !item) return undefined;
  return {
    ...(pointCount !== undefined ? { pointCount } : {}),
    ...(extent ? { extent } : {}),
    ...(min ? { min } : {}),
    ...(digest ? { digest } : {}),
    ...(item ? { catalogItem: { id: item.id, bbox: [item.bbox[0], item.bbox[1], item.bbox[2], item.bbox[3]] as const } } : {}),
  };
}

/** A catalogue item a source was opened from: its id and WGS84 bbox. */
export interface CatalogItemIdentity {
  readonly id: string;
  readonly bbox: readonly [number, number, number, number];
}

/** The facts a dataset is identified by. See {@link datasetIdentity}. */
export interface DatasetIdentity {
  readonly pointCount?: number;
  readonly extent?: readonly [number, number, number];
  /** Absolute bounds minimum in the source frame, rounded to 1 mm. */
  readonly min?: readonly [number, number, number];
  /**
   * Content fingerprint of the source, when available. Names its scheme
   * (`olvsrc1-file:...`, see `io/sourceFingerprint.ts`); two digests are
   * compared only when their schemes match.
   */
  readonly digest?: string;
  /** The catalogue item the source was opened from, when it was picked from one. */
  readonly catalogItem?: CatalogItemIdentity;
}

/** The scheme a digest names (the part before ':'), or '' when it names none. */
function digestScheme(d: string): string {
  const i = d.indexOf(':');
  return i < 0 ? '' : d.slice(0, i);
}

/** Two digests taken the same way, so that comparing them means something. */
function comparableDigests(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && digestScheme(a) === digestScheme(b);
}

function sameBbox(a: readonly number[], b: readonly number[]): boolean {
  // The stored side comes from localStorage, so its shape is not trusted.
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-9);
}

/** Version of the identity a new override records. 2 = includes `min`. */
export const OVERRIDE_IDENTITY_VERSION = 2;

/**
 * How a remembered override relates to the dataset being opened.
 *
 * - `verified`: every strong fact agrees (declaration, spans, absolute
 *   position, and the count where both state one; or an equal content
 *   digest). Applied as user-confirmed.
 * - `candidate`: nothing positively disagrees on name, declaration, count or
 *   spans, but the position differs or a fact is missing (including every
 *   legacy record). Offered as a suggestion, never applied silently.
 * - `different`: a positive disagreement on declaration, count, spans or
 *   digest. Neither applied nor suggested.
 */
export type OverrideMatch =
  | { readonly kind: 'verified' }
  | { readonly kind: 'candidate'; readonly reason: OverrideSuggestionReason }
  | { readonly kind: 'different' };

/** Why a remembered override was only suggested. */
export type OverrideSuggestionReason = 'legacy' | 'identity-missing' | 'position-differs';

/** A remembered override offered for, but not applied to, the active scan. */
export interface OverrideSuggestion {
  readonly datasetKey: string;
  readonly epsg: number | null;
  /** The kinds `setOverride` can re-apply; any other stored kind is not offered. */
  readonly kind: 'projected' | 'geographic' | 'local';
  readonly reason: OverrideSuggestionReason;
}

/**
 * Classify a stored override against the dataset being opened. Pure.
 */
export function classifyOverrideMatch(
  override: CrsOverride,
  detected: CrsInfo | undefined,
  loaded: DatasetIdentity | undefined,
): OverrideMatch {
  const observed = override.detectedEpsgObserved === true;
  // Declaration: a record that observed it must agree exactly (including "both
  // declared nothing"); a legacy record disagrees only when both sides state one.
  const declarationDiffers = observed
    ? override.detectedEpsg !== detected?.epsg
    : (override.detectedEpsg !== undefined
      && detected?.epsg !== undefined
      && override.detectedEpsg !== detected.epsg);
  if (declarationDiffers) return { kind: 'different' };
  const stored = override.identity;
  const digestsComparable = comparableDigests(stored?.digest, loaded?.digest);
  if (digestsComparable && stored?.digest !== loaded?.digest) return { kind: 'different' };
  if (!sameDataset(stored, loaded)) return { kind: 'different' };

  // A record made for a catalogue item (a Planetary Computer pick, written
  // before the file was opened, so it holds no declaration or position) belongs
  // to a source opened from that item. Another item is a different source; a
  // source not opened from the catalogue cannot be confirmed either way.
  const item = stored?.catalogItem;
  if (item && override.identityVersion === OVERRIDE_IDENTITY_VERSION) {
    const other = loaded?.catalogItem;
    if (!other) return { kind: 'candidate', reason: 'identity-missing' };
    return other.id === item.id && sameBbox(other.bbox, item.bbox) ? { kind: 'verified' } : { kind: 'different' };
  }

  const legacy = override.identityVersion !== OVERRIDE_IDENTITY_VERSION || !observed;
  if (legacy) return { kind: 'candidate', reason: 'legacy' };
  if (digestsComparable) return { kind: 'verified' };
  // Position and spans are required on both sides. The point count is compared
  // whenever both sides state it (above) but is not required: a stream may not
  // know its total yet, and the count is translation-invariant anyway.
  if (!stored || !loaded || !stored.extent || !loaded.extent || !stored.min || !loaded.min) {
    return { kind: 'candidate', reason: 'identity-missing' };
  }
  for (let i = 0; i < 3; i++) {
    const span = stored.extent[i];
    const tol = Math.max(Number.isFinite(span) && span > 0 ? span * 0.01 : 0, 0.01);
    if (!(Math.abs(stored.min[i] - loaded.min[i]) <= tol)) {
      return { kind: 'candidate', reason: 'position-differs' };
    }
  }
  return { kind: 'verified' };
}

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
  /**
   * The scan's own size, shape and position, for telling two same-named
   * datasets apart before a remembered override is applied to the wrong one.
   * Without it a remembered override cannot be verified, so it is not applied
   * (the active scan gets it as a suggestion instead).
   */
  readonly identity?: DatasetIdentity;
}

/**
 * The CRS service. One instance per Viewer / per session is plenty;
 * the service owns no DOM and no module-level state beyond the port.
 *
 * Listeners receive `null` when the active scan closes and a fresh
 * `ResolvedCrs` after every successful resolve / override change.
 */
/**
 * Structural equality of two resolved CRS records. Plain data only (strings,
 * numbers, booleans, optional fields), compared key by key so that an
 * `undefined` field and an absent one read the same. Any differing fact,
 * including `source` and `userConfirmed`, is a different frame: the metric
 * claims a frame permits depend on them.
 */
function sameResolvedCrs(a: ResolvedCrs, b: ResolvedCrs): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const va = (a as unknown as Record<string, unknown>)[k];
    const vb = (b as unknown as Record<string, unknown>)[k];
    if (va === vb) continue;
    if (va == null && vb == null) continue;
    if (typeof va === 'number' && typeof vb === 'number' && Number.isNaN(va) && Number.isNaN(vb)) continue;
    return false;
  }
  return true;
}

export class CrsService {
  private readonly _port: CrsOverridePort;
  private readonly _listeners: Set<CrsListener> = new Set();
  private _currentDatasetKey: string | undefined = undefined;
  private _current: ResolvedCrs | null = null;
  /**
   * The active scan's {@link SpatialContext}, built ONCE per CRS and handed to
   * every consumer that needs a unit, datum, axis or metric permission.
   * Invalidated (not recomputed) on each CRS change, so a swap is still O(1)
   * and the rebuild happens on the next read.
   */
  private _context: SpatialContext | null = null;
  /**
   * The active scan's identity as last resolved, so applying an override
   * records WHICH dataset the choice was made for without every caller having
   * to pass it again.
   */
  private _currentIdentity: DatasetIdentity | undefined;
  /** The active scan's detection, for applying an accepted suggestion. */
  private _currentDetected: CrsInfo | undefined;
  private _currentSource: CrsSource = 'las-vlr';
  /** A remembered override offered for the active scan but not applied. */
  private _suggestion: OverrideSuggestion | null = null;

  constructor(port: CrsOverridePort = DEFAULT_CRS_OVERRIDE_PORT) {
    this._port = port;
  }

  /** The current ResolvedCrs, or `null` when no scan is open. */
  current(): ResolvedCrs | null {
    return this._current;
  }

  /**
   * The active scan's spatial context — the single object every metric- and
   * coordinate-bearing consumer reads instead of re-deriving unit, datum, axis
   * and metric permission from the `ResolvedCrs` itself.
   *
   * This is THE application boundary where the context is built. Build it here
   * and pass it down; a leaf that calls `spatialContextFrom` while its caller
   * already holds a context has re-opened the divergence this replaces.
   *
   * Never `null`: with no scan open the context resolves to the explicit
   * unknown frame, whose `metricClaimsPermitted` is `false`, so a consumer that
   * reads it before a scan loads fails closed instead of dereferencing null.
   *
   * Memoised on the resolved CRS, so repeated reads inside one frame return the
   * same object and cannot disagree with each other.
   */
  context(): SpatialContext {
    this._context ??= spatialContextFrom(this._current);
    return this._context;
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
    this._currentDatasetKey = keyForDataset(input.name);
    this._currentIdentity = input.identity;
    this._currentDetected = input.detected;
    this._currentSource = input.source;
    const { resolved, suggestion } = this._resolveWithMatch(input);
    this._suggestion = suggestion;
    this._setCurrent(resolved);
    return resolved;
  }

  /**
   * A remembered override for a file with the active scan's name that could not
   * be verified as belonging to this file (legacy record, missing facts, or a
   * different position), or `null`. It was NOT applied; the UI offers it.
   */
  overrideSuggestion(): OverrideSuggestion | null {
    return this._suggestion;
  }

  /**
   * Apply the pending suggestion to the active scan as the user's own choice:
   * re-records the override against this scan's identity, so the next reopen
   * of the same source verifies and applies it. Returns the new CRS, or `null`
   * when there is no suggestion.
   */
  acceptOverrideSuggestion(): ResolvedCrs | null {
    const s = this._suggestion;
    if (!s || s.datasetKey !== this._currentDatasetKey) return null;
    return this.setOverride({
      override: { epsg: s.epsg, kind: s.kind },
      detected: this._currentDetected,
      source: this._currentSource,
    });
  }

  /** Drop the pending suggestion without applying it. */
  dismissOverrideSuggestion(): void {
    this._suggestion = null;
  }

  /**
   * Resolve the authoritative CRS for ANY cloud — combining its detected CRS
   * with any persisted override — WITHOUT making it the active scan or touching
   * listeners. This is THE primitive every non-active consumer must use so it
   * sees the same resolved CRS the Inspector shows instead of reaching for raw
   * `cloud.metadata.crs`: epoch A/B comparison, each project layer, conversion,
   * and every export seam. `resolveForScan` is this plus "make it current".
   *
   * Pure w.r.t. service state (reads the override port only), so it is safe to
   * call for several clouds in one frame — the single-active-scan `current()`
   * cache cannot represent more than one cloud, which is exactly why the
   * multi-cloud consumers needed this.
   */
  resolveFor(input: ResolveForScanInput): ResolvedCrs {
    return this._resolve(input);
  }

  private _resolve(input: ResolveForScanInput): ResolvedCrs {
    return this._resolveWithMatch(input).resolved;
  }

  /**
   * An override belongs to the file it was made for. The key is the dataset
   * NAME, so `site-a/points.laz` and an unrelated `site-b/points.laz` collide.
   * Only a verified match (see {@link classifyOverrideMatch}) is applied; a
   * candidate is returned as a suggestion and the file resolves from its own
   * declaration, so a remembered choice never silently replaces another
   * source's CRS.
   */
  private _resolveWithMatch(input: ResolveForScanInput): {
    readonly resolved: ResolvedCrs;
    readonly suggestion: OverrideSuggestion | null;
  } {
    const datasetKey = keyForDataset(input.name);
    const override = this._port.get(datasetKey);
    const match = override ? classifyOverrideMatch(override, input.detected, input.identity) : undefined;
    if (override && match?.kind === 'verified') {
      return { resolved: this._resolveDatum(this._fromOverride(override, input.detected)), suggestion: null };
    }
    const resolved = this._resolveDatum(resolvedFromCrsInfo(input.detected, input.source) ?? unknownCrs());
    // Nothing to offer when the remembered choice is what the file already says.
    const redundant = override?.epsg !== null && override?.epsg === resolved.epsg && override?.kind === resolved.kind;
    const k = override?.kind;
    const suggestion = override && match?.kind === 'candidate' && !redundant
      && (k === 'projected' || k === 'geographic' || k === 'local')
      ? { datasetKey, epsg: override.epsg, kind: k, reason: match.reason }
      : null;
    return { resolved, suggestion };
  }

  /**
   * Apply a user override to the active scan. Persists via the
   * configured port, re-resolves immediately, and broadcasts the new
   * CRS to listeners. No-op when there's no active scan.
   *
   * `kind === 'detected'` is the "use detected" command — clear the persisted
   * override and fall back to whatever the loader supplied. It is DISTINCT from
   * `kind === 'local'` (with `epsg: null`), which persists a genuine
   * local-coordinates override; the two used to collide on the same
   * `{ epsg: null, kind: 'local' }` value, so "Local coordinates" silently
   * restored the detected CRS instead of pinning local (C3).
   */
  setOverride(args: {
    readonly override: {
      readonly epsg: number | null;
      readonly kind: 'projected' | 'geographic' | 'local' | 'detected';
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
    this._suggestion = null;
    if (args.override.kind === 'detected') {
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
      // Records that the declaration WAS looked at, so a later file declaring
      // something different — or declaring nothing when this one did — is not
      // mistaken for the same dataset.
      detectedEpsgObserved: true,
      ...(this._currentIdentity ? { identity: this._currentIdentity } : {}),
      identityVersion: OVERRIDE_IDENTITY_VERSION,
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
    this._suggestion = null;
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

  /**
   * Monotonic count of active-CRS changes. Not an identity: it answers only
   * "is this the same frame the result was computed under", which is what a
   * freshness check needs. Starts at 0 and never resets.
   */
  private _crsRevision = 0;

  /** The current spatial-frame revision. See {@link _crsRevision}. */
  crsRevision(): number {
    return this._crsRevision;
  }

  private _setCurrent(next: ResolvedCrs | null): void {
    const prev = this._current;
    this._current = next;
    // Every CHANGE to the active CRS advances the revision. A terrain result is
    // computed under one spatial frame — projected/geographic kind, horizontal
    // and vertical scale, datum — so a result minted at revision N describes a
    // frame that revision N+1 may have replaced. Scan identity alone cannot see
    // that: an override changes the frame without changing the scan.
    //
    // A re-resolution that lands the SAME frame is not a change. This bumped on
    // every call, so opening a second tile of one survey, or re-applying the
    // override already in force, advanced the revision: the freshness stamps
    // then refused the on-screen result as "coordinate system changed", every
    // derived classification was marked frame-invalid and the terrain cache
    // dropped, for a frame that had not moved. Equality is over the whole
    // resolved record, so any fact that differs still counts as a change.
    if (prev !== null && next !== null && sameResolvedCrs(prev, next)) {
      for (const fn of this._listeners) {
        try { fn(next); } catch { /* see below */ }
      }
      return;
    }
    this._crsRevision += 1;
    // Drop the memoised context so the next `context()` read rebuilds from the
    // CRS that just landed. Invalidate rather than recompute: a scan swap that
    // no one asks a spatial question about should not pay for one.
    this._context = null;
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
    const fallbackLinearUnit = override.kind === 'geographic' ? 'unknown' : 'metre';
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
          : (entry?.linearUnit ?? fallbackLinearUnit),
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
      // The WKT describes the DETECTED horizontal frame. An override to a
      // different EPSG makes it describe the wrong CRS — carrying it would let
      // `terrain.prj` identify the rejected original while the numbers use the
      // chosen one. Keep it ONLY when the override confirms the detected EPSG;
      // otherwise drop it (same gate as name / unit / datum above). Was
      // unconditional `detected?.wkt` — the C1 contradiction.
      wkt: detected?.epsg === override.epsg ? detected?.wkt : undefined,
      // Vertical component is independent of a HORIZONTAL override — a compound
      // CRS keeps its height datum/unit when the user corrects the horizontal
      // EPSG (and a same-EPSG confirmation must not lose it at all). Preserve the
      // detected vertical fields unconditionally; without this even confirming
      // the detected EPSG stripped valid vertical metadata (the C2 defect).
      verticalEpsg: detected?.verticalEpsg,
      verticalDatum: detected?.verticalDatum,
      verticalUnitToMetres: detected?.verticalUnitToMetres,
      ...(detected?.verticalLinearUnit !== undefined ? { verticalLinearUnit: detected.verticalLinearUnit } : {}),
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
