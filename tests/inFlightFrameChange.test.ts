/**
 * A scientific computation is identified by the frame it RAN IN, not by whatever
 * the app happens to be showing when it finishes.
 *
 * The freshness stamp was minted in `AnalysePanel.update()` from live callbacks
 * at the moment a result landed. A CRS change while the core ran off-thread
 * therefore produced a result computed under revision N and stamped N+1 — and
 * the gate, comparing that stamp against the same live state, passed it as
 * current. The existing wiring test asserted the stamp NAMES crsRevision, which
 * is why the hole survived: it never changed the revision mid-run.
 *
 * These exercise the sequence itself.
 */
import { describe, it, expect } from 'vitest';
import { analysisFreshnessBreach } from '../src/science/analysisFreshness';
import { spaceContextStillCurrent } from '../src/export/exportScanIdentity';

const same = (a: string | null, b: string | null): boolean => a === b;

describe('a frame change during the run', () => {
  it('is a breach when the computation owns the stamp', () => {
    // The runner captured revision 7 and hands it down.
    const computed = { targetId: 'scan-a', classificationEpoch: 1, crsRevision: 7, coverageMode: 'full' };
    const nowAfterOverride = { targetId: 'scan-a', classificationEpoch: 1, crsRevision: 8, coverageMode: 'full' };
    expect(analysisFreshnessBreach(computed, nowAfterOverride, same)).toBe('frame');
  });

  it('is INVISIBLE when the stamp is minted from live state — the defect', () => {
    // What the panel used to do: read the revision at land time, so the stamp
    // and the live value agree by construction and nothing is ever a breach.
    const mintedFromLive = { targetId: 'scan-a', classificationEpoch: 1, crsRevision: 8, coverageMode: 'full' };
    const now = { targetId: 'scan-a', classificationEpoch: 1, crsRevision: 8, coverageMode: 'full' };
    expect(analysisFreshnessBreach(mintedFromLive, now, same)).toBeNull();
  });

  it('still reports no breach when nothing moved', () => {
    const s = { targetId: 'scan-a', classificationEpoch: 1, crsRevision: 7, coverageMode: 'full' };
    expect(analysisFreshnessBreach(s, { ...s }, same)).toBeNull();
  });
});

describe('the runner stakes its own frame', () => {
  it('captures the revision before the core and includes it in the stale test', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/terrainAnalysisRunner.ts', 'utf8'));
    expect(src).toMatch(/const runCrsRevision = crsService\.crsRevision\(\)/);
    const stale = src.slice(src.indexOf('const isStale'), src.indexOf('const isStale') + 400);
    expect(stale).toMatch(/crsService\.crsRevision\(\) !== runCrsRevision/);
  });

  it('hands the computation\'s own frame to the panel instead of letting it guess', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/terrainAnalysisRunner.ts', 'utf8'));
    expect(src).toMatch(/analysePanel\.update\(result, \{ targetId: runDatasetId, crsRevision: runCrsRevision \}\)/);
  });
});

describe('derived classification stakes its frame too', () => {
  it('both derive paths capture and re-check the revision', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/main.ts', 'utf8'));
    // Two derive sites: Classify and Fill Unclassified.
    expect((src.match(/const deriveCrsRevision = crsService\.crsRevision\(\)/g) ?? [])).toHaveLength(2);
    expect((src.match(/crsService\.crsRevision\(\) !== deriveCrsRevision/g) ?? [])).toHaveLength(2);
  });
});

describe('a frame change cancels or invalidates what it invalidates', () => {
  it('the CRS subscriber cancels an in-flight grade and drops the space capture', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/main.ts', 'utf8'));
    // There are several CRS subscribers; the frame-invalidation one is whichever
    // carries both effects, so assert on the file and on their adjacency rather
    // than on a fixed ordinal.
    const i = src.indexOf('cancelFullCloudGrade();');
    expect(i, 'no CRS-driven grade cancel').toBeGreaterThan(0);
    const around = src.slice(Math.max(0, i - 700), i + 200);
    expect(around).toMatch(/crsService\.subscribe/);
    expect(around).toMatch(/lastSpaceExport = null/);
  });
});

describe('space exports refuse a moved scan or frame', () => {
  const stamp = { targetId: 'scan-a', crsRevision: 4 };

  it('accepts an unchanged capture', () => {
    expect(spaceContextStillCurrent(stamp, { targetId: 'scan-a', crsRevision: 4 })).toBe(true);
  });

  it('refuses after another scan is opened', () => {
    expect(spaceContextStillCurrent(stamp, { targetId: 'scan-b', crsRevision: 4 })).toBe(false);
  });

  it('refuses after a CRS correction, which rescales every dimension', () => {
    expect(spaceContextStillCurrent(stamp, { targetId: 'scan-a', crsRevision: 5 })).toBe(false);
  });

  it('both space handlers apply it after their awaits', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/main.ts', 'utf8'));
    expect((src.match(/if \(!spaceCtxCurrent\(ctx\)\) throw new Error\(SPACE_CONTEXT_MOVED\)/g) ?? [])).toHaveLength(2);
  });
});
