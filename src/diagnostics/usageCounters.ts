/**
 * usageCounters.ts
 *
 * Local-first event counters. Counts what the user does — file types
 * opened, measurement kinds placed, export modes triggered, report
 * templates generated, error categories hit — and stores the counts ONLY
 * in the user's browser localStorage. Nothing is ever transmitted.
 *
 * Why this module exists:
 *   - Gives the project an evidence base for future feature prioritisation
 *     without ever uploading anything. The v0.3.6 scope review identified
 *     the absence of any usage signal as the
 *     single largest gap in the decision-making process; this module
 *     closes it without violating the local-first promise.
 *   - Gives power users a small side benefit: a free fieldwork diary they
 *     can read in the Session Stats panel, optionally exported with
 *     `.olvsession`.
 *
 * Privacy contract (REPEATED in the module-level comment because it is
 * load-bearing):
 *
 *   1. localStorage only — never `fetch`-ed anywhere, never written to
 *      any cookie, never serialised into any URL.
 *   2. Categorical keys only — the recorded values are bounded category
 *      enums plus short subcategory strings ('laz', 'distance', 'depth',
 *      'engineering-inspection'). Never filenames, never coordinates,
 *      never user identifiers, never error messages, never stack traces.
 *   3. The user can clear at any moment with `reset()`.
 *   4. The `?notelemetry=1` URL flag suppresses every `increment()` call
 *      so users who prefer to leave no trace in their own localStorage
 *      can opt out structurally.
 *
 * The module is also load-safe in headless environments (SSR, vitest in
 * Node) — every localStorage interaction is wrapped in a defensive
 * try/catch. A storage failure is logged via `console.warn` once per
 * session and silently ignored thereafter; counters become a no-op
 * instead of throwing.
 */

/** Top-level event categories. Adding one is a deliberate change. */
export type UsageCategory =
  | 'scan-open'      // subcategory = source format ('laz', 'copc', 'ply', …)
  | 'measurement'   // subcategory = measurement kind ('distance', 'profile', …)
  | 'export'        // subcategory = export mode ('height-map', 'orthographic-rgb', …)
  | 'report'        // subcategory = report template id ('engineering-inspection', …)
  | 'error';        // subcategory = error class ('load', 'export', 'report')

/** A single durable counter row. */
export interface UsageCounter {
  /** Stable composite key: `${category}:${subcategory}`. */
  readonly key: string;
  readonly category: UsageCategory;
  readonly subcategory: string;
  readonly count: number;
  readonly firstSeen: number;       // epoch ms
  readonly lastSeen: number;        // epoch ms
}

const STORAGE_KEY = 'olv.usage.v1';

/**
 * LRU cap on distinct counter keys. The cap is large enough that no
 * plausible categorical-key explosion fills it under normal use; small
 * enough that a buggy caller passing per-file subcategories (which it
 * shouldn't) cannot blow up localStorage.
 */
const MAX_KEYS = 200;

/**
 * Suppression check — once per module load.
 *
 * If the URL carries `?notelemetry=1` (or `?notelemetry` without a value),
 * every `increment()` call becomes a no-op for the lifetime of the page.
 * Reading and resetting still work — a user who toggles the flag and
 * reloads can still see their existing counters and clear them.
 */
function suppressed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.has('notelemetry');
  } catch {
    return false;
  }
}

const SUPPRESSED = suppressed();

// One-shot warning gate so a missing localStorage doesn't spam the console.
let storageWarningEmitted = false;

function safeLoad(): UsageCounter[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Defensive — drop rows that don't match the expected shape.
    return parsed.filter(
      (r): r is UsageCounter =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as UsageCounter).key === 'string' &&
        typeof (r as UsageCounter).count === 'number',
    );
  } catch (err) {
    if (!storageWarningEmitted) {
      storageWarningEmitted = true;
      console.warn('[usageCounters] storage read failed; counters disabled', err);
    }
    return [];
  }
}

function safeSave(rows: UsageCounter[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch (err) {
    if (!storageWarningEmitted) {
      storageWarningEmitted = true;
      console.warn('[usageCounters] storage write failed; counters disabled', err);
    }
  }
}

/**
 * Validate a subcategory string before storing. Caps at 32 chars; restricts
 * to a safe ASCII subset; lowercases. Defensive against accidental misuse
 * — a caller that wires in a filename gets a truncated normalised token,
 * not a filesystem leak.
 */
function sanitiseSubcategory(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_\-.]/g, '')
    .slice(0, 32);
}

/**
 * Record one occurrence of `(category, subcategory)`. No-op when the URL
 * carries `?notelemetry=1`.
 *
 * The function intentionally never throws — a bad subcategory is sanitised,
 * a storage failure is silently swallowed (with a one-shot console.warn),
 * an SSR / vitest-in-Node load returns immediately.
 */
export function increment(category: UsageCategory, subcategory: string): void {
  if (SUPPRESSED) return;
  const sub = sanitiseSubcategory(subcategory);
  if (sub.length === 0) return;

  const now = Date.now();
  const key = `${category}:${sub}`;
  const rows = safeLoad();

  const existing = rows.find((r) => r.key === key);
  if (existing) {
    // Replace the row with an updated copy. Counters are readonly to
    // callers but we deliberately rebuild the array on every increment so
    // a snapshot returned from `snapshot()` cannot be mutated by a later
    // increment.
    const updated: UsageCounter = {
      ...existing,
      count: existing.count + 1,
      lastSeen: now,
    };
    const next = rows.filter((r) => r.key !== key);
    next.push(updated);
    safeSave(applyLruCap(next));
    return;
  }

  const fresh: UsageCounter = {
    key,
    category,
    subcategory: sub,
    count: 1,
    firstSeen: now,
    lastSeen: now,
  };
  rows.push(fresh);
  safeSave(applyLruCap(rows));
}

/**
 * Apply the LRU cap by least-recent-use. Keeps the most-recently-seen
 * MAX_KEYS rows; drops older ones. Even a buggy caller wiring in
 * per-file subcategories caps at 200 entries (and the sanitiser truncates
 * them to 32 chars each).
 */
function applyLruCap(rows: UsageCounter[]): UsageCounter[] {
  if (rows.length <= MAX_KEYS) return rows;
  // Sort by lastSeen DESC, take the top MAX_KEYS, restore insertion order.
  const sorted = [...rows].sort((a, b) => b.lastSeen - a.lastSeen);
  return sorted.slice(0, MAX_KEYS);
}

/**
 * Read every counter row. Sorted by most-recent-use first, then by
 * descending count. Returns a stable snapshot — subsequent `increment()`
 * calls do not mutate the returned array.
 */
export function snapshot(): readonly UsageCounter[] {
  const rows = safeLoad();
  return [...rows].sort((a, b) => {
    if (b.lastSeen !== a.lastSeen) return b.lastSeen - a.lastSeen;
    return b.count - a.count;
  });
}

/**
 * Wipe every counter. Used by the "Reset" link in the Session Stats panel.
 * Does not affect the suppression flag.
 */
export function reset(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow — best-effort */
  }
}

/**
 * Exported for tests + the Session Stats panel header.
 *
 * Returns true when telemetry is structurally suppressed via the URL flag.
 * The UI surfaces this so the user understands why the counters list is
 * empty + frozen.
 */
export function isSuppressed(): boolean {
  return SUPPRESSED;
}

/**
 * Human-readable labels for the Session Stats panel. Returning a friendly
 * string here keeps the panel UI dumb — it just renders what this module
 * gives it.
 */
export function describeCounter(row: UsageCounter): string {
  switch (row.category) {
    case 'scan-open':
      return `Scan opened (${row.subcategory})`;
    case 'measurement':
      return `Measurement: ${row.subcategory}`;
    case 'export':
      return `Export: ${row.subcategory}`;
    case 'report':
      return `Report: ${row.subcategory}`;
    case 'error':
      return `Error (${row.subcategory})`;
  }
}
