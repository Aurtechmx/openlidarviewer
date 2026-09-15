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
  it('the frame-change wiring cancels an in-flight grade and leaves the space capture to its stamp', async () => {
    const fs = await import('node:fs');
    const main = fs.readFileSync('src/main.ts', 'utf8');
    // The cascade is wired through wireFrameChange, which subscribes to the
    // service and runs it only on a revision change. The shell hands it the
    // grade cancel; the wiring module owns the subscription.
    const i = main.indexOf('wireFrameChange({');
    expect(i, 'the shell no longer wires the frame change').toBeGreaterThan(0);
    const block = main.slice(i, i + 900);
    expect(block).toMatch(/crsService,/);
    expect(block).toMatch(/cancelFullCloudGrade: \(\) => streamingUi\.cancelGrade\(\)/);
    const wiring = fs.readFileSync('src/app/classLegendRefresh.ts', 'utf8');
    const w = wiring.indexOf('export function wireFrameChange');
    expect(w).toBeGreaterThan(0);
    expect(wiring.slice(w, w + 900)).toMatch(/crsService\.subscribe/);
    expect(wiring.slice(w, w + 900)).toMatch(/deps\.cancelFullCloudGrade\(\)/);
    // The space capture is NOT nulled on a frame change: nulling it made the
    // Report PDF and Floor plan buttons silent no-ops. Its crsRevision stamp
    // refuses a stale export with a message instead.
    expect(block).not.toMatch(/lastSpaceExport = null/);
    expect(main).toMatch(/spaceCtxCurrent\(/);
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

  it('every space handler guards EVERY await that precedes a live read', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/main.ts', 'utf8'));
    const guard = /if \(!spaceCtxCurrent\(ctx\)\) throw new Error\(SPACE_CONTEXT_MOVED\)/g;
    const handler = (start: string, end: string): string => {
      const i = src.indexOf(start);
      expect(i, `handler ${start} not found`).toBeGreaterThan(0);
      return src.slice(i, src.indexOf(end, i));
    };
    // The report handler awaits twice before it reads live state — the PDF
    // chunk, then the floor-plan chunk — so it owes two checks. Counting the
    // file as a whole would let one handler's guards cover for another's.
    const report = handler('onExportReport: async ()', 'const bytes = await buildSpaceReportPdf');
    expect((report.match(guard) ?? []).length,
      'the report handler must guard both of its awaits').toBe(2);
    // The standalone floor plan awaits once.
    const plan = handler('onExportFloorPlan: async ()', 'downloadFileBytes(');
    expect((plan.match(guard) ?? []).length,
      'the floor-plan handler must guard its await').toBe(1);
  });
});
