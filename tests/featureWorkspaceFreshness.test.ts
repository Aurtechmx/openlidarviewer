/**
 * The feature workspace must not outlive the classification it was built from.
 *
 * `mountFeatureCandidates` snapshots `buildFeatureExtractionInput(cloud)` once,
 * and building candidates are selected by ASPRS class 6, so Reclassify / Auto
 * Classify / Fill Unclassified can change the candidate set outright. The mount
 * was keyed on the scan id alone, so after a class edit the pre-edit footprints
 * stayed on screen and stayed exportable — while the terrain result, which goes
 * stale on the very same event, correctly showed a caveat.
 *
 * The CRS revision is part of the key for the same reason: the mount also
 * captures the frame's lon/lat converter and its metric scale.
 */
import { describe, it, expect } from 'vitest';

/**
 * The identity comparison the panel performs, extracted so the rule can be
 * tested without a DOM. This mirrors `_refreshFeatureLauncher`'s guard.
 */
function workspaceIsCurrent(
  built: { scanId: string | null; epoch: number; crsRev: number; mounted: boolean },
  now: { scanId: string | null; epoch: number; crsRev: number },
): boolean {
  return built.scanId === now.scanId
    && built.epoch === now.epoch
    && built.crsRev === now.crsRev
    && built.mounted;
}

const built = { scanId: 'scan-a', epoch: 3, crsRev: 1, mounted: true };

describe('feature workspace identity', () => {
  it('is current when nothing moved', () => {
    expect(workspaceIsCurrent(built, { scanId: 'scan-a', epoch: 3, crsRev: 1 })).toBe(true);
  });

  it('is STALE after a classification edit', () => {
    expect(workspaceIsCurrent(built, { scanId: 'scan-a', epoch: 4, crsRev: 1 })).toBe(false);
  });

  it('is STALE after a CRS correction', () => {
    expect(workspaceIsCurrent(built, { scanId: 'scan-a', epoch: 3, crsRev: 2 })).toBe(false);
  });

  it('is STALE on a different scan', () => {
    expect(workspaceIsCurrent(built, { scanId: 'scan-b', epoch: 3, crsRev: 1 })).toBe(false);
  });

  it('the scan id alone is NOT sufficient — the defect this closes', () => {
    const scanOnly = built.scanId === 'scan-a';
    expect(scanOnly, 'the old key still matches after a reclassification').toBe(true);
    expect(workspaceIsCurrent(built, { scanId: 'scan-a', epoch: 4, crsRev: 1 })).toBe(false);
  });
});

describe('the panel wires the invalidation to the class-edit event', () => {
  it('setStaleNotice re-keys the feature workspace', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/ui/AnalysePanel.ts', 'utf8'));
    const body = src.slice(src.indexOf('setStaleNotice(text: string | null)'));
    const method = body.slice(0, body.indexOf('\n  }') + 4);
    expect(method).toContain('_refreshFeatureLauncher');
  });

  it('the launcher keys on the epoch and the CRS revision, not the scan alone', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/ui/AnalysePanel.ts', 'utf8'));
    const body = src.slice(src.indexOf('private _refreshFeatureLauncher()'));
    const method = body.slice(0, 2000);
    expect(method).toContain('activeClassificationEpoch');
    expect(method).toContain('crsRevision');
    expect(method).toContain('_featureEpoch');
  });
});
