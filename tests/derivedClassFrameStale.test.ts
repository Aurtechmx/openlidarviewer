/**
 * A derived classification is only meaningful in the frame it was derived under.
 *
 * `classifierOptions` restates physical metre thresholds in source units, so the
 * class codes depend on the resolved frame. The in-flight race is already
 * refused — both derive paths capture `crsRevision` and will not land after a
 * change. This covers the COMPLETED one: classes derived under revision 10 stay
 * attached after the operator corrects the frame to revision 11, and a later
 * analysis consumed them as current.
 *
 * The fix marks them stale rather than deleting them. The bytes are the user's
 * work and a derive costs seconds; the epoch is what every downstream freshness
 * gate already reads.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  noteDerivedClassesFrameChanged,
  CLASS_FRAME_STALE_NOTICE,
} from '../src/app/classLegendRefresh';

describe('a frame change over a derived classification', () => {
  it('clears the terrain cache and says why', () => {
    const clearTerrainCache = vi.fn();
    const noteStale = vi.fn();
    noteDerivedClassesFrameChanged({
      invalidate: () => ['cloud_0'], clearTerrainCache, noteStale,
    });
    expect(clearTerrainCache).toHaveBeenCalledOnce();
    expect(noteStale).toHaveBeenCalledWith(CLASS_FRAME_STALE_NOTICE);
  });

  it('does nothing at all when nothing was derived', () => {
    const clearTerrainCache = vi.fn();
    const noteStale = vi.fn();
    noteDerivedClassesFrameChanged({
      invalidate: () => [], clearTerrainCache, noteStale,
    });
    // A producer-classified scan carries no frame-dependent thresholds, so a
    // CRS change must cost it nothing and say nothing.
    expect(clearTerrainCache).not.toHaveBeenCalled();
    expect(noteStale).not.toHaveBeenCalled();
  });

  it('says the classes were not edited, because they were not', () => {
    // The edit notice would be a false statement here: the bytes did not
    // change, their basis did.
    expect(CLASS_FRAME_STALE_NOTICE).toMatch(/Coordinate system changed/i);
    expect(CLASS_FRAME_STALE_NOTICE).not.toMatch(/Classification edited/i);
    expect(CLASS_FRAME_STALE_NOTICE).toMatch(/re-run Classify/i);
  });
});

describe('the viewer marks only DERIVED classifications', () => {
  it('bumps the epoch for a derived cloud and leaves a producer one alone', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/render/Viewer.ts', 'utf8'));
    const i = src.indexOf('invalidateDerivedClassificationsForFrame');
    expect(i, 'method missing').toBeGreaterThan(0);
    const body = src.slice(i, i + 400);
    expect(body).toMatch(/classificationIsDerived/);
    expect(body).toMatch(/_classEpochs\.bump/);
    // It must not delete or overwrite anything.
    expect(body).not.toMatch(/delete|splice|= null|applyDerivedClassification/);
  });

  it('is wired to the CRS subscriber in the shell', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/main.ts', 'utf8'));
    const i = src.indexOf('cancelFullCloudGrade();');
    expect(i).toBeGreaterThan(0);
    const around = src.slice(Math.max(0, i - 800), i + 500);
    expect(around).toMatch(/crsService\.subscribe/);
    expect(around).toMatch(/noteDerivedClassesFrameChanged/);
  });
});
