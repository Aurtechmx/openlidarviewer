/**
 * classificationCoverage.ts — the Classify gate's coverage read, split out of
 * `deriveClassification.ts` so the eager shell can import it WITHOUT pulling the
 * classifier core and its eigen-descriptor dependencies (SpatialHash3d,
 * geometryDescriptors, verticalityCue) into the index bundle. The heavy
 * `deriveClassification` runs on-demand behind the async worker / lazy fallback;
 * this tiny pure counter is the only piece the shell needs at boot.
 */

/**
 * How "classifiable" an existing classification is: how many points are still
 * unclassified (ASPRS 0 Created / 1 Unclassified) vs already carry a producer
 * class. Drives the Classify gate — a cloud with NO unclassified points has
 * nothing to derive; an all-unclassified cloud (or no classification at all) is
 * fully derivable; a partial one is a "classify the gaps" candidate. Pure.
 */
export function classificationCoverage(
  classification: ArrayLike<number> | null | undefined,
  count: number,
): { readonly unclassified: number; readonly producer: number } {
  if (!classification) return { unclassified: count, producer: 0 };
  const n = Math.min(count, classification.length);
  let unclassified = 0;
  let producer = 0;
  for (let i = 0; i < n; i++) {
    const c = classification[i];
    if (c === 0 || c === 1) unclassified++;
    else producer++;
  }
  // Points past the (shorter) classification array are unclassified by default.
  unclassified += Math.max(0, count - n);
  return { unclassified, producer };
}
