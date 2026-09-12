/**
 * analysisFreshness.ts — is a terrain result still current for the state that
 * would be stamped onto its exports?
 *
 * A terrain result is computed from four facts: the scan it ran on, the
 * classification in force, the spatial frame that gave its coordinates meaning,
 * and how much of the cloud was actually analysed. Every one of those can
 * change while the result stays on screen, and the panel deliberately keeps a
 * result when another scan becomes active.
 *
 * Before this, only the SCAN was checked. A classification edit, an auto
 * classify, or a CRS override left the result exportable, and the app said so
 * in a caveat — "Results reflect the previous classification; re-run Analyse" —
 * while the export went out anyway. A caveat is not a gate: the file leaves
 * with provenance asserting facts that did not produce it, and its recipient
 * has no way to tell.
 *
 * The asymmetry is what decides the strictness. A false refusal costs a re-run
 * of Analyse, which is seconds and always available. A false permit produces an
 * artifact that misattributes its own inputs, permanently and silently. So this
 * refuses on any mismatch and names which fact moved, because "re-run Analyse"
 * is only actionable if the reader knows what changed.
 *
 * Pure: no imports, no app state. The caller supplies both sides.
 */

/** What a terrain result records about the state it was computed under. */
export interface AnalysisFreshnessStamp {
  /**
   * The export-target id, not the raw active id — a streaming scan leaves the
   * latter null, so two streaming scans would compare equal.
   */
  readonly targetId: string | null;
  /** The cloud's classification edit epoch at computation time. */
  readonly classificationEpoch: number;
  /** {@link CrsService.crsRevision} at computation time. */
  readonly crsRevision: number;
  /** Whether the analysis saw the whole cloud or only the resident set. */
  readonly coverageMode: string;
}

/** Which fact moved. `null` when the result is still current. */
export type FreshnessBreach = 'scan' | 'classification' | 'frame' | null;

/**
 * Compare a stamp against the state now in force.
 *
 * Scan identity is checked FIRST so a scan swap reports as a swap rather than
 * as whichever of its consequences happens to be noticed — a different scan
 * usually carries a different epoch and frame too, and naming the epoch there
 * would send the reader to re-classify when they need to re-run.
 */
export function analysisFreshnessBreach(
  stamp: AnalysisFreshnessStamp | null,
  now: Pick<AnalysisFreshnessStamp, 'targetId' | 'classificationEpoch' | 'crsRevision'>,
  sameTarget: (a: string | null, b: string | null) => boolean,
): FreshnessBreach {
  // No stamp means no result to protect; the caller's own null checks decide.
  if (stamp === null) return null;
  if (!sameTarget(stamp.targetId, now.targetId)) return 'scan';
  if (stamp.classificationEpoch !== now.classificationEpoch) return 'classification';
  if (stamp.crsRevision !== now.crsRevision) return 'frame';
  return null;
}

/**
 * Why the export was refused, in the reader's terms. Each says what changed and
 * what to do, because a refusal a user cannot act on reads as a malfunction.
 */
export const FRESHNESS_REFUSALS: Record<Exclude<FreshnessBreach, null>, string> = {
  scan:
    'This terrain analysis was computed on a different scan than the one now '
    + 'active, so nothing was written — the contours, rasters and report would '
    + "have been stamped with the active scan's origin, coordinate system and "
    + 'name. Re-run the analysis on this scan to export it.',
  classification:
    'The classification changed after this terrain analysis ran, so nothing was '
    + 'written — the surface was built from the previous classes and the export '
    + 'would present it as current. Re-run Analyse to export it.',
  frame:
    'The coordinate reference system changed after this terrain analysis ran, so '
    + 'nothing was written — the surface was computed in the previous frame and '
    + 'the export would label it with the new one. Re-run Analyse to export it.',
};
