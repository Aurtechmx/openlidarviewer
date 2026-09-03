/**
 * reclassifyOutcome.ts
 *
 * The sentence the lasso reclassify tool says after a commit.
 *
 * A class edit can end in four different ways and three of them used to share
 * one line, "no points inside the lasso": the lasso really was empty; the
 * points were there but a class / elevation / intensity filter or the clip box
 * hid them, so the edit deliberately left them alone; or every point inside
 * already carried the target class. Reported identically, a refusal the user
 * can act on looked like a tool that does not work. This turns the counts the
 * Viewer already returns into the specific sentence for the case that happened.
 *
 * Pure string building: no DOM, no Viewer, unit-testable in Node.
 */

import type { ClassEditResult } from '../render/measure/classificationEditor';

/**
 * Describe what a lasso reclassify did, or why it did nothing.
 *
 * `selectedCount` / `hiddenByFilters` are the screen-lasso path's own counts
 * (see {@link ClassEditResult}); an older result that carries neither still
 * falls back to the plain empty-lasso line rather than inventing a reason.
 */
export function reclassifyOutcome(result: ClassEditResult, targetClass: number): string {
  const changed = result.changedCount;
  if (changed > 0) {
    return `Reclassified ${changed.toLocaleString()} points → class ${targetClass}.`;
  }
  const hidden = result.hiddenByFilters ?? 0;
  if (hidden > 0) {
    return (
      `Reclassify · ${hidden.toLocaleString()} points inside the lasso are hidden right now, ` +
      'so they were left alone. Clear the class, elevation or intensity filter ' +
      '(or the clip box) and draw again.'
    );
  }
  if ((result.selectedCount ?? 0) > 0) {
    return `Reclassify · every point inside the lasso is already class ${targetClass}.`;
  }
  return 'Reclassify · no points inside the lasso.';
}
