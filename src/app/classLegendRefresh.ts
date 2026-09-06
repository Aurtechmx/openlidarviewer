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

/**
 * The caveat carried when the FRAME changed under a derived classification.
 *
 * Distinct from the edit notice because the classes were not edited: their
 * basis was. `classifierOptions` restates physical metre thresholds in source
 * units, so a derived classification only means what it says in the frame it
 * was derived under. The in-flight race is already refused; this is the
 * completed one — classes derived under revision 10 stayed attached, and a
 * later analysis consumed them as current after the operator corrected the
 * frame.
 *
 * `Viewer.invalidateDerivedClassificationsForFrame` bumps the classification
 * epoch rather than deleting anything: the bytes are the user's work and a
 * derive costs seconds, while the epoch is what every downstream freshness gate
 * already reads, so results built on them go stale and exports refuse. The
 * points stay on screen until Classify is re-run. Producer classifications
 * carry no frame-dependent thresholds and are left alone.
 */
export const CLASS_FRAME_STALE_NOTICE =
  'Coordinate system changed. The derived classification was computed with '
  + 'thresholds converted under the previous frame, so anything built on it is '
  + 'no longer current; re-run Classify, then Analyse.';

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

/** What a frame change owes a derived classification. See the notice above. */
export interface FrameChangeInvalidateDeps {
  readonly invalidate: () => readonly string[];
  readonly clearTerrainCache: () => void;
  readonly noteStale: (message: string) => void;
}

/**
 * Mark derived classifications stale after a frame change, and tell the user.
 * A no-op when nothing was derived, so a CRS change on a producer-classified
 * scan costs nothing and says nothing.
 */
export function noteDerivedClassesFrameChanged(deps: FrameChangeInvalidateDeps): void {
  if (deps.invalidate().length === 0) return;
  deps.clearTerrainCache();
  deps.noteStale(CLASS_FRAME_STALE_NOTICE);
}
