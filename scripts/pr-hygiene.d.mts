/**
 * Types for the importable surface of `pr-hygiene.mjs`.
 *
 * The narration patterns are shared with `lint-doc-narration.mjs`, so a pull
 * request body and a shipped document are held to one rule rather than to two
 * copies of it that can drift apart. Only that export is declared; the CLI
 * body has no types.
 */

/** One construction that describes the authoring rather than the software. */
export interface NarrationPattern {
  readonly id: string;
  readonly re: RegExp;
  readonly why: string;
}

export const NARRATION_PATTERNS: readonly NarrationPattern[];
