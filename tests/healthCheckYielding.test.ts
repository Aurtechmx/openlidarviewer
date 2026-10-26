/**
 * healthCheckYielding.test.ts
 *
 * The scan report runs its health checks and its modules as separate tasks,
 * yielding between them. The rows must be the ones the single-task run gives,
 * and a run whose scan is replaced part way stops without settling, so no
 * stale report paints.
 */

import { describe, expect, test } from 'vitest';
import { healthCheck } from '../src/analysis/modules/healthCheck';
import { scanReport } from '../src/analysis/modules/scanReport';
import { runAnalysisModules } from '../src/app/analysisModuleRegistry';
import { PointCloud } from '../src/model/PointCloud';

function cloud(seed: number): PointCloud {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
  const n = 20_000;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = rnd() * 200;
    positions[i * 3 + 1] = rnd() * 200;
    positions[i * 3 + 2] = i % 500 === 0 ? 5_000 : rnd() * 10;
  }
  // A few exact duplicates and a non-finite point, so every check has something to say.
  positions.copyWithin(30, 0, 30);
  positions[99] = Number.NaN;
  const classification = new Uint8Array(n).map(() => [1, 2, 6][Math.floor(rnd() * 3)]!);
  return new PointCloud({ positions, classification, origin: [0, 0, 0], sourceFormat: 'las', name: `c${seed}.las`, declaredPointCount: n + 5 });
}

describe('scan report run in steps', () => {
  test('healthCheck.runYielding gives the rows run gives, pausing between the five checks', async () => {
    // Two clouds with the same data, so neither result comes from the other's memo.
    const want = healthCheck.run(cloud(4));
    let pauses = 0;
    const got = await healthCheck.runYielding!(cloud(4), async () => { pauses++; return true; });
    expect(got).toEqual(want);
    expect(pauses).toBe(4);
  });

  test('the report rows equal the single-task rows, and the run yields between modules', async () => {
    const a = cloud(7);
    const b = cloud(7);
    const want = [...healthCheck.run(a).rows, ...scanReport.run(a, undefined, {}).rows];
    let yields = 0;
    const got = await runAnalysisModules(b, {}, () => true, async () => { yields++; });
    expect(got).toEqual(want);
    expect(yields).toBe(5); // four between the checks, one between the modules
  });

  test('a run whose scan was replaced stops and never settles', async () => {
    let current = true;
    let yields = 0;
    let settled = false;
    void runAnalysisModules(cloud(9), {}, () => current, async () => {
      yields++;
      if (yields === 2) current = false; // the scan is replaced during the checks
    }).then(() => { settled = true; });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    expect(yields).toBe(2);
  });
});
