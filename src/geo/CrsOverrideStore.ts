/**
 * src/geo/CrsOverrideStore.ts
 *
 * User CRS overrides — persistent across sessions, keyed by the
 * dataset name. When a user opens "east-levee.copc.laz" and confirms
 * its CRS as EPSG:32612, that choice survives a page refresh and
 * persists into the next session.
 *
 * Storage is `localStorage` only. The override is a small JSON object
 * (~40 bytes per entry); the store caps the active entry count at
 * `MAX_ENTRIES` so a user who opens hundreds of distinct scans
 * doesn't grow localStorage unboundedly — oldest entries are evicted
 * LRU-style.
 *
 * The store honours the same `?notelemetry=1` opt-out that the local-
 * first usage counter does. Under that flag, reads return `undefined`
 * (treating overrides as if the store were empty) and writes are
 * no-ops. That makes the privacy contract uniform across the local-
 * first stores.
 *
 * Pure — no DOM, no module-level state beyond a defensive `_disabled`
 * latch.
 */

import type { CrsKind } from './CoordinateTypes';

const STORAGE_KEY = 'olv:crs-overrides';
const MAX_ENTRIES = 100;
const SCHEMA_VERSION = 1;

/**
 * One user-supplied CRS choice. Stored under a `datasetKey` (typically
 * the loaded scan's `name` — see `keyForDataset()`).
 */
export interface CrsOverride {
  /** EPSG code the user picked, or `null` when the user marked the dataset as local-coordinates-only. */
  readonly epsg: number | null;
  /** What kind of CRS this represents — gates whether conversion is offered. */
  readonly kind: CrsKind;
  /** Timestamp (ms since epoch) of the most recent set; drives LRU eviction. */
  readonly updatedAt: number;
  /**
   * The EPSG the FILE declared when this override was made, when it declared
   * one. Entries are keyed by dataset name alone, so an unrelated file with the
   * same name collides; this records enough to tell the two apart. Absent on
   * entries written before the field existed, and on files that declared no CRS
   * — in both cases there is no evidence either way and the override applies.
   */
  readonly detectedEpsg?: number;
}

interface StoredEnvelope {
  readonly version: number;
  readonly entries: readonly { readonly key: string; readonly override: CrsOverride }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Suppression — match the usage-counter privacy contract
// ─────────────────────────────────────────────────────────────────────────────

let _disabled = false;

/**
 * True when the store is suppressed: either the `?notelemetry=1`
 * URL flag is set, or `localStorage` is unavailable in this
 * environment (private browsing, Node test, etc.).
 */
export function isSuppressed(): boolean {
  if (_disabled) return true;
  if (typeof window === 'undefined') return true;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('notelemetry')) return true;
  } catch {
    return true;
  }
  try {
    // Probe — some environments (Safari private mode) throw on access.
    window.localStorage.getItem(STORAGE_KEY);
  } catch {
    _disabled = true;
    return true;
  }
  return false;
}

/** Test hook — reset the suppression latch between unit tests. */
export function _resetSuppressionLatchForTesting(): void {
  _disabled = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a stable key for a dataset. The store keys on the dataset
 * name (e.g. `east-levee.copc.laz`). Whitespace + case normalisation
 * keeps `My Scan.LAZ` and `my scan.laz` aligned across sessions.
 *
 * The key is intentionally short (~50 chars) — long URLs are
 * truncated so the storage stays bounded.
 */
export function keyForDataset(name: string): string {
  return name.trim().toLowerCase().slice(0, 200);
}

/** Get the override for a dataset, or `undefined` if none is set. */
export function getOverride(datasetKey: string): CrsOverride | undefined {
  if (isSuppressed()) return undefined;
  const envelope = safeLoad();
  if (!envelope) return undefined;
  const entry = envelope.entries.find((e) => e.key === datasetKey);
  return entry?.override;
}

/**
 * Set or replace the override for a dataset. Touching the entry
 * refreshes its `updatedAt`, so frequently-used datasets stay in
 * the store under LRU eviction.
 */
export function setOverride(
  datasetKey: string,
  override: Omit<CrsOverride, 'updatedAt'>,
): void {
  if (isSuppressed()) return;
  const envelope = safeLoad() ?? { version: SCHEMA_VERSION, entries: [] };
  const now = Date.now();
  const next: CrsOverride = { ...override, updatedAt: now };

  // Replace-or-insert, then prune to MAX_ENTRIES by LRU.
  const without = envelope.entries.filter((e) => e.key !== datasetKey);
  const updated = [{ key: datasetKey, override: next }, ...without]
    .sort((a, b) => b.override.updatedAt - a.override.updatedAt)
    .slice(0, MAX_ENTRIES);

  safeSave({ version: SCHEMA_VERSION, entries: updated });
}

/** Clear a single dataset's override. No-op when none is set. */
export function clearOverride(datasetKey: string): void {
  if (isSuppressed()) return;
  const envelope = safeLoad();
  if (!envelope) return;
  const entries = envelope.entries.filter((e) => e.key !== datasetKey);
  if (entries.length === envelope.entries.length) return;
  safeSave({ version: SCHEMA_VERSION, entries });
}

/** Wipe every override. Used by the Inspector's "Reset CRS overrides" affordance. */
export function clearAllOverrides(): void {
  if (isSuppressed()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow — defensive */
  }
}

/** Snapshot every active override. Used by the inspector's debug panel. */
export function snapshotOverrides(): readonly (CrsOverride & {
  readonly datasetKey: string;
})[] {
  if (isSuppressed()) return [];
  const envelope = safeLoad();
  if (!envelope) return [];
  return envelope.entries.map((e) => ({ datasetKey: e.key, ...e.override }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Private — load / save with defensive fallbacks
// ─────────────────────────────────────────────────────────────────────────────

function safeLoad(): StoredEnvelope | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredEnvelope(parsed)) return null;
    if (parsed.version !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeSave(envelope: StoredEnvelope): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Quota exceeded or storage disabled — silently disable the store
    // for the rest of the session so we don't spam errors.
    _disabled = true;
  }
}

function isStoredEnvelope(value: unknown): value is StoredEnvelope {
  if (!value || typeof value !== 'object') return false;
  const env = value as { version?: unknown; entries?: unknown };
  if (typeof env.version !== 'number') return false;
  if (!Array.isArray(env.entries)) return false;
  return env.entries.every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      'key' in entry &&
      typeof entry.key === 'string' &&
      'override' in entry &&
      isOverride(entry.override),
  );
}

function isOverride(value: unknown): value is CrsOverride {
  if (!value || typeof value !== 'object') return false;
  const o = value as { epsg?: unknown; kind?: unknown; updatedAt?: unknown };
  const epsgOk = o.epsg === null || typeof o.epsg === 'number';
  const kindOk =
    o.kind === 'projected' ||
    o.kind === 'geographic' ||
    o.kind === 'local' ||
    o.kind === 'unknown';
  const updatedOk = typeof o.updatedAt === 'number';
  return epsgOk && kindOk && updatedOk;
}
