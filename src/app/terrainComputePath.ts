/**
 * terrainComputePath.ts — the debug overlay's read of the terrain engine's
 * CPU/GPU equivalence-gate verdict, lifted out of the composition root.
 *
 * The value arrives through a verification-only `window` hook the terrain engine
 * registers when it loads; reading it that way is deliberate, because a static
 * import would pull the terrain engine into the main bundle and break chunk
 * isolation. Returns null before any main-thread terrain run (or when analysis
 * ran in the worker, whose engine is not reachable from here), and always in a
 * build without the test seam, where the hook is not registered.
 */

/** The engine's compute-path verdict, or null when no main-thread run has occurred. */
export function readTerrainComputePath(): { path: 'cpu' | 'gpu'; reason: string } | null {
  // The hook exists only in a build with the test seam compiled in.
  if (typeof __OLV_TEST_SEAM__ === 'undefined' || !__OLV_TEST_SEAM__) return null;
  const hook = (
    window as unknown as {
      __olvTerrainRasterEngine?: { getComputePath?: () => { path: 'cpu' | 'gpu'; reason: string } };
    }
  ).__olvTerrainRasterEngine;
  try {
    const s = hook?.getComputePath?.();
    return s ? { path: s.path, reason: s.reason } : null;
  } catch {
    return null;
  }
}
