/**
 * scientificState.ts — a lightweight identity for the scientific state an
 * authorization was issued against, so an authentic token cannot survive a
 * change that alters its scientific basis (STALE_AUTHORIZATION).
 *
 * It is DERIVED, not a new source of truth: the signature is a pure function of
 * the {@link ScanFacts} that `ProcessService` was already built from — the same
 * facts the capability evaluator reads. No revision counter is invented, no
 * central state is added, and no point array is touched. O(number of scans),
 * effectively constant for interactive use.
 *
 * A signature changes when a scientifically-relevant fact changes (dataset size,
 * classification, classification provenance, ground trust, coverage, horizontal
 * CRS authority + linear unit, vertical reference + unit). It does NOT encode
 * camera, theme, viewport, or any presentational state — those are not inputs to
 * `ScanFacts`, so a purely visual change leaves the signature (and every issued
 * authorization) untouched.
 */

import type { ScanFacts } from './ProcessPlan';

/** The scientifically-relevant projection of one scan, order-stable for hashing. */
function factTuple(s: ScanFacts): readonly (string | number | boolean | null)[] {
  const crs = s.crs;
  return [
    s.kind,
    s.coverage,
    s.pointCount,
    s.classification,
    s.classificationProvenance ?? 'none',
    s.groundClassified,
    // Horizontal + vertical authority: the fields the metric/vertical gates read.
    crs?.epsg ?? null,
    crs?.linearUnit ?? null,
    (crs?.linearUnitToMetres ?? null) as number | null,
    crs?.verticalDatum ?? null,
    (crs?.verticalUnitToMetres ?? null) as number | null,
  ];
}

/**
 * A stable, cheap signature of the scientific state a set of scans represents.
 * Deterministic and byte-identical for identical facts; different whenever any
 * scientifically-relevant fact differs. Pure — no DOM, no I/O, no point data.
 */
export function scientificStateSignature(scans: readonly ScanFacts[]): string {
  return JSON.stringify(scans.map(factTuple));
}
