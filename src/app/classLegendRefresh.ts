/**
 * classLegendRefresh.ts
 *
 * Keeping the Classes legend true to the buffer it describes.
 *
 * Two callers, one rule. A freshly opened scan counts its classification once
 * ({@link classCountsOf}); an IN-PLACE class edit (the lasso reclassify, the
 * polygon reclassify, a class swap, and their undo/redo) has to recount,
 * because the numbers on the panel now describe a classification that no
 * longer exists.
 *
 * The edit path fans out to three surfaces, all invalidated together: the
 * cached terrain core (bare earth is picked from the classes), the rendered
 * Analyse result on screen, and the legend counts. The first two were already
 * settled; the counts were not. On a barely-classified airborne tile, which
 * OLV opens coloured by HEIGHT, because too few points carry a producer class
 * for the class ramp to read, the legend is the ONLY place an edit shows, so a
 * successful edit moved nothing the user could see and read as a refusal.
 *
 * The recount is a REPLACE that keeps the panel's visibility state. The fresh-
 * scan reset (`setClasses`) hands back an all-visible filter, which would
 * un-hide classes the user hid before they started editing.
 *
 * Structural dependencies, no DOM and no three.js, so the contract is
 * unit-testable without a Viewer or a panel.
 */

import { countClasses } from '../render/class/classHistogram';
import { toClassBuffer } from '../render/class/classBuffer';

/** Per-class point counts for any classification source, narrowed to bytes. */
export function classCountsOf(classification: ArrayLike<number>): Map<number, number> {
  return countClasses(toClassBuffer(classification));
}

/** The Classes panel surface this needs: replace counts, keep the filter. */
export interface ClassCountSink {
  replaceCounts(counts: Map<number, number>): void;
}

/** The live reads and effects one class edit fans out to. */
export interface ClassEditNotifyDeps {
  /** The edited cloud's classification buffer, or null when it has none. */
  readonly classification: ArrayLike<number> | null | undefined;
  readonly legend: ClassCountSink;
  /** Drop the cached terrain core and abort any in-flight compute. */
  readonly clearTerrainCache: () => void;
  /** Stamp the Analyse panel's stale caveat. No-op when nothing is on screen. */
  readonly noteStale: (message: string) => void;
}

/** The caveat an on-screen Analyse result carries once the classes move under it. */
export const CLASS_EDIT_STALE_NOTICE =
  'Classification edited. Results reflect the previous classification; re-run Analyse to refresh.';

/**
 * Settle every surface a class edit invalidated. Always drops the terrain cache
 * and stamps the stale caveat; recounts the legend when the cloud still carries
 * a classification buffer (an unknown id or a class-less cloud leaves the panel
 * alone rather than blanking it).
 */
export function noteClassificationEdited(deps: ClassEditNotifyDeps): void {
  deps.clearTerrainCache();
  deps.noteStale(CLASS_EDIT_STALE_NOTICE);
  const cls = deps.classification;
  if (cls && cls.length > 0) deps.legend.replaceCounts(classCountsOf(cls));
}
