/**
 * actionRegistry.ts
 *
 * Pure data layer for the v0.3.9 command palette. Two concerns:
 *
 *   1. Action shape + registry helpers.
 *      An `Action` is a typed event handler with a title, section,
 *      and optional metadata (keyboard shortcut hint, keywords, run
 *      callback). The host (main.ts) populates the registry at boot
 *      from the same handlers that power the tool dock, Inspector,
 *      and keyboard shortcuts — no duplicated logic.
 *
 *   2. Fuzzy match + ranking.
 *      Given a query and a list of actions, return a ranked subset.
 *      The matcher prefers (in order):
 *        - exact substring matches in the title          (very high)
 *        - subsequence matches with consecutive runs     (high)
 *        - word-start matches                            (medium)
 *        - subsequence matches anywhere                  (low)
 *        - matches in keywords / section                 (lowest)
 *      An empty query returns every action ranked by their declared
 *      section order — useful for "open the palette and browse."
 *
 * The module owns NO DOM and NO three.js. Production callers feed it
 * actions + queries; the matcher is deterministic and unit-tested.
 * The DOM overlay (CommandPalette.ts) consumes the ranked list.
 */

/** A user-runnable command surfaced in the palette. */
export interface Action {
  /** Stable string id. Used for analytics + tests; never user-visible. */
  readonly id: string;
  /** The primary user-visible label. Searched first, weighted highest. */
  readonly title: string;
  /** Group label — "Camera", "Theme", "Tools", "Export". */
  readonly section: string;
  /**
   * Optional keyboard shortcut hint displayed at the right edge of
   * the row (e.g. "T", "Cmd-K", "Esc"). Purely informational — the
   * palette does not consume keystrokes other than its own.
   */
  readonly keys?: string;
  /**
   * Optional one-line description shown below the title. Useful for
   * differentiating "Frame all" from "Reset view".
   */
  readonly hint?: string;
  /**
   * Optional extra search terms. The matcher checks these in
   * addition to title + section, so "settings" can find
   * "Preferences" without re-naming the action.
   */
  readonly keywords?: readonly string[];
  /** Runs the action. The palette closes after a successful fire. */
  readonly run: () => void;
}

/**
 * A ranked search result. Score is a positive integer; the order of
 * `RankedAction`s is the order the UI should render them in.
 */
export interface RankedAction {
  readonly action: Action;
  /** Higher = better. Useful for tests; the UI ignores the value. */
  readonly score: number;
}

// ── case-insensitive constants ──────────────────────────────────────

/** Characters that delimit "word starts" for the match bonus. */
const WORD_BOUNDARY = /[\s\-_./()&]/;

// ── fuzzy match scoring ────────────────────────────────────────────

/**
 * Compute a fuzzy-match score for `query` against `target`. Returns
 * 0 when nothing matches; otherwise a positive integer.
 */
export function fuzzyMatch(query: string, target: string): number {
  if (query === '') return 1; // empty query trivially matches everything
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Substring fast path — most common case, deserves a big bonus.
  const idx = t.indexOf(q);
  if (idx === 0) return 2000 + q.length;
  if (idx > 0) return 1000 + q.length - Math.min(idx, 50);

  // Subsequence walk — every char of q must appear in t in order.
  let score = 0;
  let lastMatchIndex = -1;
  let consecutiveRun = 0;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    let found = -1;
    for (let j = lastMatchIndex + 1; j < t.length; j++) {
      if (t[j] === ch) {
        found = j;
        break;
      }
    }
    if (found < 0) return 0; // missed a query char — no match
    const skip = found - (lastMatchIndex + 1);
    score -= skip; // penalise gaps
    score += 1;
    if (found === lastMatchIndex + 1) {
      consecutiveRun += 1;
      score += 50 * consecutiveRun; // consecutive bonus snowballs
    } else {
      consecutiveRun = 0;
    }
    // Word-start bonus — match landed at index 0 or after a boundary.
    if (found === 0 || (found > 0 && WORD_BOUNDARY.test(t[found - 1]))) {
      score += 20;
    }
    lastMatchIndex = found;
  }
  return Math.max(0, score);
}

/**
 * Score an action against a query — title weighted highest, then
 * section + keywords. Returns 0 if no field matches.
 */
function scoreAction(query: string, action: Action): number {
  if (query === '') return 1; // empty query → every action ranks 1
  const titleScore = fuzzyMatch(query, action.title);
  const sectionScore = fuzzyMatch(query, action.section);
  let keywordScore = 0;
  if (action.keywords) {
    for (const kw of action.keywords) {
      const s = fuzzyMatch(query, kw);
      if (s > keywordScore) keywordScore = s;
    }
  }
  // Title dominates; section + keywords add a discount-weighted boost
  // so a perfect keyword match can win against a fuzzy title match.
  return titleScore + Math.floor(sectionScore * 0.4) + Math.floor(keywordScore * 0.6);
}

/**
 * Rank a list of actions against a query, dropping anything that
 * doesn't match. The result is a stable sort: ties resolve in the
 * input order, so the host's section ordering is preserved when no
 * query is active.
 */
export function rankActions(
  query: string,
  actions: readonly Action[],
): RankedAction[] {
  const trimmed = query.trim();
  const ranked: RankedAction[] = [];
  for (const action of actions) {
    const score = scoreAction(trimmed, action);
    if (score > 0) ranked.push({ action, score });
  }
  // Highest score first; equal scores preserve input order (V8,
  // JavaScriptCore and SpiderMonkey all use stable sort).
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

// ── registry helpers ───────────────────────────────────────────────

/**
 * Group ranked actions by section, preserving section-first ordering.
 * The UI uses this to render section headers between groups. Returns
 * an array of `{ section, rows }` tuples in the order each section
 * first appears in the ranked list.
 */
export function groupBySection(
  ranked: readonly RankedAction[],
): Array<{ section: string; rows: RankedAction[] }> {
  const seen = new Map<string, RankedAction[]>();
  for (const row of ranked) {
    const bucket = seen.get(row.action.section);
    if (bucket) bucket.push(row);
    else seen.set(row.action.section, [row]);
  }
  return Array.from(seen.entries()).map(([section, rows]) => ({
    section,
    rows,
  }));
}

/**
 * Validate that an action registry has no duplicate ids. Returns the
 * list of duplicate ids; an empty array means the registry is clean.
 * Useful for a smoke test in main.ts after the registry is built.
 */
export function findDuplicateIds(actions: readonly Action[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const a of actions) {
    if (seen.has(a.id)) dupes.add(a.id);
    else seen.add(a.id);
  }
  return Array.from(dupes);
}
