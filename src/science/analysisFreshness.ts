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
 * Observatory's extension of the stamp above (`docs/observatory/SPEC.md` §4
 * OB-INT-03). It extends {@link AnalysisFreshnessStamp} rather than
 * duplicating it: an Observatory run is refused on every fact a terrain
 * result is refused on, plus five more an evidence ledger additionally
 * depends on. If SensorPrint introduces its own extended stamp type first,
 * that type is reused here instead of a second one being defined; no such
 * type exists in this tree yet.
 */
export interface ObservationFreshnessStamp extends AnalysisFreshnessStamp {
  /** Digest of the source scan(s)/stations the ledger was built from. */
  readonly sourceDigest: string;
  /**
   * The run's basis. Reuses the `full` / `resident-only` / `sampled`
   * vocabulary `TerrainCoverageMode` already carries (SPEC §1.1), as a plain
   * string for the same reason {@link AnalysisFreshnessStamp.coverageMode} is
   * one: this module stays import-free.
   */
  readonly basis: string;
  /** Digest of the declared ROI (domain box) the ledger was built over. */
  readonly roiDigest: string;
  /** Digest of the station set (ids, poses, statuses) the ledger addressed. */
  readonly stationSetDigest: string;
  /** Digest of the declared parameters (p_solid, p_empty, n_min, tau_abs, tau_rel). */
  readonly parameterDigest: string;
  /** The registered method tags this run's stages ran under. */
  readonly methodTags: readonly string[];
  /** Metres per source linear unit, or `null` when the unit is unknown (OB-INV-10). */
  readonly metresPerUnit: number | null;
}

/** Which additional fact moved, beyond what {@link FreshnessBreach} already names. */
export type ObservationFreshnessBreach = FreshnessBreach | 'source' | 'roi' | 'stationSet' | 'parameters';

/**
 * {@link analysisFreshnessBreach}, extended with Observatory's own four
 * facts. Checked in the same fixed order every time: the shared facts first
 * (scan, then classification, then frame — see that function's own doc
 * comment for why scan comes first), then source, then ROI, then station set,
 * then parameters, so two simultaneous changes always report the same one
 * (OB-INV-09: "the refusal names the fact that moved").
 */
export function observationFreshnessBreach(
  stamp: ObservationFreshnessStamp | null,
  now: Pick<
    ObservationFreshnessStamp,
    'targetId' | 'classificationEpoch' | 'crsRevision' | 'sourceDigest' | 'roiDigest' | 'stationSetDigest' | 'parameterDigest'
  >,
  sameTarget: (a: string | null, b: string | null) => boolean,
): ObservationFreshnessBreach {
  const shared = analysisFreshnessBreach(stamp, now, sameTarget);
  if (shared !== null) return shared;
  if (stamp === null) return null;
  if (stamp.sourceDigest !== now.sourceDigest) return 'source';
  if (stamp.roiDigest !== now.roiDigest) return 'roi';
  if (stamp.stationSetDigest !== now.stationSetDigest) return 'stationSet';
  if (stamp.parameterDigest !== now.parameterDigest) return 'parameters';
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

/** Observatory's refusal text, extending {@link FRESHNESS_REFUSALS} with its own four facts. */
export const OBSERVATION_FRESHNESS_REFUSALS: Record<Exclude<ObservationFreshnessBreach, null>, string> = {
  scan: FRESHNESS_REFUSALS.scan,
  classification: FRESHNESS_REFUSALS.classification,
  frame: FRESHNESS_REFUSALS.frame,
  source:
    'The scan or station this observation run was built from changed after it ran, so nothing was '
    + 'committed — the evidence ledger would be stamped with a source that did not produce it. '
    + 'Re-run Observatory on the active source to commit it.',
  roi:
    'The region of interest changed after this observation run started, so nothing was committed — '
    + 'the ledger covers the previous domain and the export would label it with the new one. Re-run '
    + 'Observatory on the current ROI to commit it.',
  stationSet:
    'The set of scanner stations changed after this observation run started, so nothing was '
    + 'committed — the ledger was built against the previous stations. Re-run Observatory with the '
    + 'current stations to commit it.',
  parameters:
    'A declared parameter (p_solid, p_empty, n_min, tau_abs or tau_rel) changed after this '
    + 'observation run started, so nothing was committed — the ledger was scored under the previous '
    + 'values. Re-run Observatory with the current parameters to commit it.',
};
