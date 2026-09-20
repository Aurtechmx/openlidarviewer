/**
 * Types for the importable surface of `lint-doc-narration.mjs`.
 *
 * The gate is plain ESM because it runs under bare `node` in CI with no build
 * step. Only the pure detector is declared; the CLI body that walks the tree
 * and exits has no types and is not imported.
 */

/** One narration hit, with where it sits so a long document is navigable. */
export interface NarrationHit {
  /** The pattern's id, as `pr-hygiene` names it. */
  readonly id: string;
  /** Why the construction is flagged, in the words the gate prints. */
  readonly why: string;
  /** One-based line within the document. */
  readonly line: number;
  /** The matched text, trimmed. */
  readonly text: string;
}

/**
 * Narration in one document, ordered by line.
 *
 * Uses the patterns `pr-hygiene` applies to a pull-request body, imported
 * rather than restated so the two rules cannot drift.
 */
export function narrationIn(text: string): NarrationHit[];
