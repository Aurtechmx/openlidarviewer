/**
 * sourceTopology.ts — deriving the manifest's topology record from a cloud.
 *
 * `OrganizedRangeFrame.linkage` already answers, on screen, whether a grid cell
 * still resolves to the display record the loader decoded it from. That answer
 * used to end at the screen: an artifact carried no trace of it, so a reviewer
 * holding only the export could not tell that a reduction had spent the
 * cell-to-record identity, nor which step spent it.
 *
 * This module is the one place that turns a cloud's acquisition topology into
 * the plain {@link SourceTopologyRecord} the processing manifest binds. It is
 * split from `processingManifest.ts` so that the manifest module keeps its
 * "pure data, no model dependency" shape, and split from the model so the model
 * keeps knowing nothing about provenance records.
 *
 * Three outcomes, deliberately distinct:
 *   - No topology at all → `undefined`. The manifest gains NO op. An ordinary
 *     LAS never carried an acquisition grid, so it had no identity to keep and
 *     none to lose, and silence is the only honest record of that.
 *   - Topology with every frame exactly linked → a record saying `exact`.
 *   - Topology whose frames degraded → a record naming the LEAST faithful state
 *     across the frames and the reasons the frames in that state carry.
 *
 * Pure data: no DOM, no three.js, no I/O.
 */

import type { OrganizedRangeSet, RangeLinkage } from '../model/OrganizedRange';
import type { SourceTopologyRecord } from './processingManifest';

/**
 * Least-faithful-wins ordering. A set is only as trustworthy as its worst
 * frame: reporting the best, or an average, would let one intact frame speak
 * for a set whose others no longer resolve anything.
 */
const SEVERITY: Readonly<Record<RangeLinkage['kind'], number>> = {
  exact: 0,
  partial: 1,
  unavailable: 2,
};

/**
 * Order two reason strings by UTF-16 code unit.
 *
 * Deliberately NOT `String.localeCompare`. These strings are hashed into the
 * processing manifest's tamper-evident chain, so their order has to be the same
 * on every machine that builds the same artifact. `localeCompare` consults the
 * runtime's locale and ICU data, which differ between a developer's laptop, a
 * CI runner and a reviewer's machine, and a different order would produce a
 * different digest for identical input. A code-unit comparison has no such
 * dependency.
 *
 * This is what the bare `.sort()` already did, since the default comparator
 * compares string conversions by code unit. It is written out, and exported so
 * a test can pin it, because the reason strings in use today happen to sort the
 * same way under either comparator. The guard is therefore against a FUTURE
 * reason string, and a rule that only fires once such a string exists would
 * fire after the digests had already diverged.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The reason a linkage state carries, or null for `exact`, which carries none. */
function reasonOf(linkage: RangeLinkage): string | null {
  return linkage.kind === 'exact' ? null : linkage.reason;
}

/**
 * The manifest topology record for a cloud's acquisition topology, or
 * `undefined` when there is nothing to record.
 *
 * A set with no frames returns `undefined` as well: it declares no cell, so it
 * has no linkage to report, and calling that `exact` would assert an identity
 * over an empty grid.
 */
export function sourceTopologyRecord(
  set: OrganizedRangeSet | undefined,
): SourceTopologyRecord | undefined {
  if (!set || set.frames.length === 0) return undefined;
  let worst: RangeLinkage['kind'] = 'exact';
  for (const frame of set.frames) {
    if (SEVERITY[frame.linkage.kind] > SEVERITY[worst]) worst = frame.linkage.kind;
  }
  const reasons = [
    ...new Set(
      set.frames
        .filter((f) => f.linkage.kind === worst)
        .map((f) => reasonOf(f.linkage))
        .filter((r): r is string => r !== null),
    ),
  ].sort(compareCodeUnits);
  return {
    organization: set.organization,
    frames: set.frames.length,
    linkage: worst,
    reasons,
  };
}
