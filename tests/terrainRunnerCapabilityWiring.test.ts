/**
 * terrainRunnerCapabilityWiring.test.ts
 *
 * The terrain runner hands Contour Studio the scan's coverage and capability
 * verdicts from `ScanFacts`, not from the DTM grid. A strided static read has
 * a grid that reads 'full' and facts that read 'sampled'; the frame must say
 * 'sampled', with the DTM verdict naming it, and must not call the scan
 * streaming. Without facts the frame carries no verdicts, which the permit
 * treats as a shortfall.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import { installRecordingDom } from './helpers/recordingDom';
import { scanFacts, terrainRunnerHarness } from './helpers/terrainRunnerHarness';
import type { ScanFacts } from '../src/process/ProcessPlan';
import type { LaunchFrameContext } from '../src/terrain/contourStudio/contourStudioLaunchStateFromResult';

beforeAll(installRecordingDom);

/** Run once over the given facts and return the frame the runner published. */
async function frameFor(getScanFacts?: () => ScanFacts | null): Promise<LaunchFrameContext> {
  const h = terrainRunnerHarness({ getScanFacts });
  await h.runner.run();
  return h.frames[0];
}

describe('terrainAnalysisRunner hands the facts to Contour Studio', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTerrainCoreCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('a strided static read is sampled, not streaming, and the DTM verdict names it', async () => {
    const f = await frameFor(() => scanFacts('sampled'));
    expect(f.coverage).toBe('sampled');
    expect(f.streaming).toBe(false);
    expect(f.capabilities?.dtm?.readiness).toBe('review');
    expect(f.capabilities?.dtm?.reasonCode).toBe('SAMPLED');
    expect(f.capabilities?.contours?.readiness).toBe('review');
    // The basis the stamp prints: the gather's count of the declared total,
    // under the facts' coverage, never the grid's extent flag.
    expect(f.analysedBasis).toEqual({ analysedPointCount: 400, declaredPointCount: 1_000_000, coverage: 'sampled', loadStride: 2500 });
  });

  it('the frame mints an authorization that is fresh now and stale after the facts change', async () => {
    let live: ScanFacts | null = scanFacts('full');
    const f = await frameFor(() => live);
    const fresh = f.authorizeFor!('contours');
    expect(fresh!.verify(fresh!.token, 'contours').ok).toBe(true);
    live = scanFacts('sampled');
    const later = f.authorizeFor!('contours');
    expect(later!.verify(later!.token, 'contours')).toEqual({ ok: false, reason: 'STALE_AUTHORIZATION' });
  });

  it('without facts the frame mints nothing and carries no verdicts', async () => {
    const f = await frameFor();
    expect(f.authorizeFor).toBeUndefined();
    expect(f.coverage).toBeUndefined();
    expect(f.capabilities).toBeUndefined();
  });

  it('a full static read is ready on both products', async () => {
    const f = await frameFor(() => scanFacts('full'));
    expect(f.coverage).toBe('full');
    expect(f.capabilities?.dtm?.readiness).toBe('ready');
  });

  it('a resident streaming set is streaming and resident-only', async () => {
    const f = await frameFor(() => scanFacts('resident-only', 'streaming'));
    expect(f.coverage).toBe('resident-only');
    expect(f.streaming).toBe(true);
    expect(f.capabilities?.dtm?.reasonCode).toBe('RESIDENT_ONLY');
  });
});
