/**
 * The nav-jank results file (scripts/lib/navJankResults.mjs) and its report
 * (scripts/nav-jank-report.mjs): medians and IQR, the environment checks, the
 * comparison refusals and the table.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildNavJankRecord, validateJsonSchema, type NavJankEnv } from '../src/perf/navJankRecord';
import type { NavProbeSummary } from '../src/perf/navProbe';
import {
  buildNavJankResults,
  mergeNavJankResults,
  quantile,
  resultFileName,
  spread,
  type NavJankResults,
} from '../scripts/lib/navJankResults.mjs';
import { abRefusals, compareRefusals, compareResults, formatComparison, formatTable, GOVERNOR_FLAG } from '../scripts/nav-jank-report.mjs';

const SCHEMA = JSON.parse(
  readFileSync(fileURLToPath(new URL('../validation/performance/nav-jank.schema.json', import.meta.url)), 'utf8'),
);

function summary(p95: number, longMs = 0): NavProbeSummary {
  return {
    frames: 100, drawnFrames: 100, durationMs: 1700,
    frameMs: { p50: 16.7, p95, p99: p95 + 5, samples: 100 },
    cpuMs: { p50: 4, p95: 8, p99: 10 },
    over: { '16.7': 10, '33.3': 3, '50': 1, '100': 0 },
    jank: { thresholdMs: 33.4, events: 3, bursts: 1, longestBurst: 2 },
    inputToDrawMs: { p50: 20, p95: 40, samples: 50 },
    longestStarvationMs: 60,
    upload: { passes: 10, p95Ms: 2, p95Bytes: 1e6, totalBytes: 5e6, stoppedBy: { drained: 10, time: 0, bytes: 0, nodes: 0 } },
    lod: { added: 5, removed: 5, churnPerSec: 5.9 },
    quality: { transitions: 1, byKind: { edl: 1, dpr: 0, phase: 0 }, events: [{ t: 10, kind: 'edl', from: 1, to: 0 }] },
    longTasks: {
      count: longMs ? 1 : 0,
      byOwner: {
        upload: { count: longMs ? 1 : 0, totalMs: longMs }, stream: { count: 0, totalMs: 0 }, edl: { count: 0, totalMs: 0 },
        cull: { count: 0, totalMs: 0 }, unattributed: { count: 0, totalMs: 0 },
      },
    },
    idleWakes: { heartbeat: 4, wake: 1 },
    active: {
      durationMs: 1500, endReason: 'sleep', frames: 90,
      frameMs: { p50: 16.7, p95, p99: p95 + 5, samples: 90 },
      over: { '16.7': 9, '33.3': 2, '50': 1, '100': 0 },
      jank: { thresholdMs: 33.4, events: 2, bursts: 1, longestBurst: 2 },
      longestStarvationMs: 40,
    },
    settle: { postInputEdlFlaps: 0, timeToStationaryQualityMs: 300, finalEdl: 1 },
  } as unknown as NavProbeSummary;
}

/** The whole-run frame p95 differs from the active one, so the two views are told apart. */
function withWholeP95(sum: NavProbeSummary, p95: number): NavProbeSummary {
  return { ...sum, frameMs: { ...sum.frameMs, p95 } };
}

const ENV: NavJankEnv = {
  commit: 'abcdef1234', browser: 'chromium 140', os: 'darwin 25', renderer: 'webgpu / Apple M2', dpr: 2,
  refreshEstimateHz: 60, datasetSha256: 'a'.repeat(64), trajectoryDigest: 'd1', flags: ['benchmark=nav', 'headed'], cache: 'cold',
};

function session(p95s: number[], env: Partial<NavJankEnv> = {}, commit = 'abcdef1234'): NavJankResults {
  const e = { ...ENV, ...env, commit };
  return buildNavJankResults({
    generatedAt: '2026-09-25T00:00:00Z',
    machine: 'test',
    dataset: { id: 'OLV-DS-090' },
    trajectories: {
      orbit: {
        cold: buildNavJankRecord(e, [{ name: 'orbit', summary: summary(40, 120) }]),
        warm: buildNavJankRecord({ ...e, cache: 'warm' }, p95s.map((p, i) => ({ name: `orbit-${i}`, summary: summary(p) }))),
        loads: [],
      },
    },
  });
}

describe('navJankResults', () => {
  it('computes median and IQR by linear interpolation', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(spread([5, 1, 3, 2, 4])).toEqual({ median: 3, iqr: 2, n: 5 });
    expect(spread([7])).toEqual({ median: 7, iqr: 0, n: 1 });
  });

  it('reads frame statistics from the active window and keeps the whole run apart', () => {
    const r = buildNavJankResults({
      generatedAt: 'x', machine: 'm', dataset: {},
      trajectories: { o: { warm: buildNavJankRecord({ ...ENV, cache: 'warm' }, [{ name: 'o', summary: withWholeP95(summary(30), 258) }]) } },
    });
    expect(r.trajectories.o.warmMedians?.frameP95Ms.median).toBe(30);
    expect(r.trajectories.o.warmMedians?.wholeFrameP95Ms.median).toBe(258);
    expect(r.trajectories.o.warmMedians?.timeToStationaryQualityMs.median).toBe(300);
  });

  it('builds warm medians, cold metrics and long tasks by owner', () => {
    const r = session([20, 22, 24, 26, 28]);
    const t = r.trajectories.orbit;
    expect(t.warmMedians?.frameP95Ms).toEqual({ median: 24, iqr: 4, n: 5 });
    expect(t.coldMetrics?.frameP95Ms).toBe(40);
    expect(t.longTasksByOwner).toMatchObject({ upload: { count: 1, totalMs: 120 }, cull: { count: 0, totalMs: 0 } });
    expect(r.fingerprint.renderer).toBe('webgpu / Apple M2');
    for (const rec of [t.cold, t.warm]) expect(validateJsonSchema(SCHEMA, rec)).toEqual([]);
  });

  it('refuses records whose environment or trajectory digest differs', () => {
    const cold = buildNavJankRecord(ENV, [{ name: 'o', summary: summary(20) }]);
    const warmOtherDpr = buildNavJankRecord({ ...ENV, dpr: 1, cache: 'warm' }, [{ name: 'o', summary: summary(20) }]);
    const warmOtherDigest = buildNavJankRecord({ ...ENV, trajectoryDigest: 'd2', cache: 'warm' }, [{ name: 'o', summary: summary(20) }]);
    const base = { generatedAt: 'x', machine: 'm', dataset: {} };
    expect(() => buildNavJankResults({ ...base, trajectories: { o: { cold, warm: warmOtherDpr } } })).toThrow(/environment/);
    expect(() => buildNavJankResults({ ...base, trajectories: { o: { cold, warm: warmOtherDigest } } })).toThrow(/digest/);
  });

  it('merges per-trajectory files of one session and refuses mixed commits', () => {
    const a = session([20]);
    const b = { ...session([30]), trajectories: { flythrough: session([30]).trajectories.orbit } };
    expect(Object.keys(mergeNavJankResults([a, b]).trajectories)).toEqual(['orbit', 'flythrough']);
    expect(() => mergeNavJankResults([a, session([20], {}, '1234567abc')])).toThrow(/commits/);
  });

  it('names the file by day, short sha and machine tag', () => {
    expect(resultFileName(new Date('2026-09-25T12:00:00Z'), 'ac06ddf8deadbeef', 'mbp local')).toBe('2026-09-25-ac06ddf8-mbp-local.json');
  });
});

describe('nav-jank-report', () => {
  it('prints a table with the warm median and the cold run', () => {
    const text = formatTable(session([20, 22, 24, 26, 28]));
    expect(text).toMatch(/\nframe p95 ms\s+24\s+40/);
    expect(text).toMatch(/whole run \(secondary\)/);
    expect(text).toMatch(/idle wakes\s+5\s+5/);
    expect(text).toMatch(/upload\s+120/);
    expect(text).toContain('orbit 5 warm');
  });

  it('reports a difference against the larger IQR', () => {
    const cmp = compareResults(session([20, 22, 24, 26, 28]), session([30, 31, 32, 33, 34], {}, '1234567abc'));
    expect(cmp.orbit.frameP95Ms).toMatchObject({ base: 24, head: 32, diff: 8, noise: 4, beyondNoise: true });
    expect(cmp.orbit.frameP50Ms.beyondNoise).toBe(false);
    expect(formatComparison(session([20]), session([21]))).toMatch(/frame p95 ms +20 +21 +\+1 /);
  });

  it('refuses unlike environments, digests and files', () => {
    const a = session([20]);
    expect(compareRefusals(a, session([20], { renderer: 'webgl2 / SwiftShader' }))).toEqual([expect.stringMatching(/renderer/)]);
    expect(compareRefusals(a, session([20], { datasetSha256: 'b'.repeat(64) }))[0]).toMatch(/datasetSha256/);
    expect(compareRefusals(a, session([20], { trajectoryDigest: 'other' }))).toEqual(['orbit: trajectory digest differs']);
    expect(compareRefusals(a, { ...a, version: 1 } as unknown as NavJankResults)[0]).toMatch(/version/);
    expect(compareRefusals(a, {} as NavJankResults)[0]).toMatch(/not a nav-jank results file/);
    expect(() => compareResults(a, session([20], { dpr: 1 }))).toThrow(/refusing/);
  });
});

describe('governor A/B (--ab)', () => {
  const off = () => session([20]);
  const on = (env: Partial<NavJankEnv> = {}) => session([18], { flags: [...ENV.flags, GOVERNOR_FLAG], ...env });

  it('the governor flag makes the two sessions different environments', () => {
    expect(compareRefusals(off(), on())[0]).toMatch(/flags/);
  });

  it('accepts off vs on when every other field matches', () => {
    expect(abRefusals(off(), on())).toEqual([]);
    expect(compareResults(off(), on(), abRefusals).orbit.frameP95Ms).toMatchObject({ base: 20, head: 18 });
    expect(formatComparison(off(), on(), abRefusals)).toMatch(/governor off vs on/);
  });

  it('refuses anything else that differs, and a swapped or missing flag', () => {
    expect(abRefusals(off(), on({ dpr: 3 }))[0]).toMatch(/dpr/);
    expect(abRefusals(off(), on({ flags: [...ENV.flags, GOVERNOR_FLAG, 'headless'] }))[0]).toMatch(/flags/);
    expect(abRefusals(off(), off())).toEqual([`on file lacks the ${GOVERNOR_FLAG} flag`]);
    expect(abRefusals(on(), on())).toContain(`off file carries the ${GOVERNOR_FLAG} flag`);
    expect(abRefusals(off(), session([20], { flags: [...ENV.flags, GOVERNOR_FLAG] }, 'other'))[0]).toMatch(/commit differs/);
    expect(abRefusals(off(), on({ trajectoryDigest: 'x' }))).toEqual(['orbit: trajectory digest differs']);
  });
});
