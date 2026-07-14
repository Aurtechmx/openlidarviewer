/**
 * exportNotes.ts
 *
 * The standing export honesty notes, as a dependency-free leaf module.
 *
 * These strings were defined in `exportProvenance.ts`, but the evidence-gate
 * resolver (`src/export/exportManifest.ts`) needs `NOT_SURVEY_GRADE_NOTE` for
 * its caveats — and the export gate is now reached EAGERLY (Contour Studio mints
 * a permit synchronously at click time). Importing it from `exportProvenance`
 * would drag that whole (deliberately code-split, lazy) module into the eager
 * bundle and collapse its chunk. Housing the constant here keeps the eager
 * import graph tiny while `exportProvenance` re-exports it for back-compat, so
 * every existing importer is unchanged.
 */

/**
 * The standing honesty note stamped on every artifact. Plain language about what
 * the output is suitable for — never an affirmative survey-grade claim.
 */
export const NOT_SURVEY_GRADE_NOTE =
  'Suitability: not survey-grade unless validated against ground-truth control.';
