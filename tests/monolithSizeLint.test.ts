/**
 * monolithSizeLint.test.ts — proves the shrink-only ratchet actually ratchets.
 *
 * The guard's promise is that `src/main.ts` and `src/render/Viewer.ts` may fall
 * but never rise, and that raising a banked number is a deliberate hand edit.
 * `--update` used to write whatever the files currently measured, in either
 * direction, so the one command an operator is told to run after a
 * decomposition step would also silently bank a regression. The rule half is a
 * pure function and is tested directly; the refusal is tested through the CLI,
 * because a correct rule wired into nothing is the failure this file exists to
 * catch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs script, no types
import { collectGrowth, collectWatchDrift, watchAllowance } from '../scripts/lint-monolith-size.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = 'src/main.ts';
const VIEWER = 'src/render/Viewer.ts';

const baselineOf = (main: number, viewer: number) => ({
  files: { [MAIN]: { lines: main, goal: 2500 }, [VIEWER]: { lines: viewer, goal: 2000 } },
});

describe('collectGrowth', () => {
  it('accepts counts equal to the baseline', () => {
    expect(collectGrowth({ [MAIN]: 100, [VIEWER]: 200 }, baselineOf(100, 200))).toEqual([]);
  });

  it('accepts counts below the baseline', () => {
    expect(collectGrowth({ [MAIN]: 90, [VIEWER]: 150 }, baselineOf(100, 200))).toEqual([]);
  });

  it('reports a file that exceeds its baseline by one line', () => {
    const grown = collectGrowth({ [MAIN]: 101, [VIEWER]: 200 }, baselineOf(100, 200));
    expect(grown).toHaveLength(1);
    expect(grown[0]).toMatchObject({ file: MAIN, current: 101, allowed: 100 });
  });

  it('reports every grown file, not just the first', () => {
    expect(collectGrowth({ [MAIN]: 101, [VIEWER]: 201 }, baselineOf(100, 200))).toHaveLength(2);
  });

  it('treats a missing baseline as nothing to enforce', () => {
    expect(collectGrowth({ [MAIN]: 9999 }, null)).toEqual([]);
  });

  it('ignores a file the baseline does not record', () => {
    expect(collectGrowth({ 'src/other.ts': 9999 }, baselineOf(100, 200))).toEqual([]);
  });

  it('holds the real tree at or below its banked baseline', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(ROOT, 'docs/validation/monolith-size-baseline.json'), 'utf8'),
    );
    const lines = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8').split('\n').length;
    expect(collectGrowth({ [MAIN]: lines(MAIN), [VIEWER]: lines(VIEWER) }, baseline)).toEqual([]);
  });
});

/**
 * A throwaway tree holding only what the script reads: itself, its one helper,
 * the two counted files and the baseline. The script resolves everything from
 * its own location, so a copy runs against the sandbox and never the repo.
 */
describe('lint-monolith-size --update', () => {
  let dir: string;
  const BASELINE_REL = 'docs/validation/monolith-size-baseline.json';
  const script = () => join(dir, 'scripts/lint-monolith-size.mjs');
  const bank = () => JSON.parse(readFileSync(join(dir, BASELINE_REL), 'utf8'));

  /** Write `n` lines, which the script counts as `n + 1` via split('\n'). */
  const seed = (rel: string, n: number) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), `${'x\n'.repeat(n - 1)}x`);
  };

  const run = (): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [script(), '--update'], { encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'olv-monolith-'));
    mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
    cpSync(resolve(ROOT, 'scripts/lint-monolith-size.mjs'), script());
    cpSync(resolve(ROOT, 'scripts/lib/isCliEntry.mjs'), join(dir, 'scripts/lib/isCliEntry.mjs'));
    mkdirSync(join(dir, 'docs/validation'), { recursive: true });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('banks a genuine shrink', () => {
    seed(MAIN, 40);
    seed(VIEWER, 60);
    writeFileSync(join(dir, BASELINE_REL), `${JSON.stringify(baselineOf(100, 200), null, 2)}\n`);
    const { code } = run();
    expect(code).toBe(0);
    expect(bank().files[MAIN].lines).toBe(40);
    expect(bank().files[VIEWER].lines).toBe(60);
  });

  it('refuses to bank a raise and leaves the baseline untouched', () => {
    seed(MAIN, 140);
    seed(VIEWER, 60);
    writeFileSync(join(dir, BASELINE_REL), `${JSON.stringify(baselineOf(100, 200), null, 2)}\n`);
    const before = readFileSync(join(dir, BASELINE_REL), 'utf8');
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toMatch(/140/);
    expect(readFileSync(join(dir, BASELINE_REL), 'utf8')).toBe(before);
  });

  it('refuses the whole write when one file grew and the other shrank', () => {
    seed(MAIN, 40);
    seed(VIEWER, 260);
    writeFileSync(join(dir, BASELINE_REL), `${JSON.stringify(baselineOf(100, 200), null, 2)}\n`);
    const { code } = run();
    expect(code).toBe(1);
    // The shrink is discarded with the raise: a partial bank would record a
    // state no run of the files ever had.
    expect(bank().files[MAIN].lines).toBe(100);
    expect(bank().files[VIEWER].lines).toBe(200);
  });

  it('bootstraps when no baseline exists yet', () => {
    seed(MAIN, 140);
    seed(VIEWER, 260);
    rmSync(join(dir, BASELINE_REL), { force: true });
    const { code } = run();
    expect(code).toBe(0);
    expect(bank().files[MAIN].lines).toBe(140);
  });
});

describe('the watch list monitors the next tier for material growth', () => {
  const banked = { watch: { 'src/ui/AnalysePanel.ts': { lines: 3000 }, 'src/ui/Inspector.ts': { lines: 2000 } } };

  it('gives a module a 5% band, with a 40-line floor for small ones', () => {
    expect(watchAllowance(3000)).toBe(3150);
    expect(watchAllowance(1680)).toBe(1764);
    // Below 800 lines, 5% is under the floor, so the floor applies.
    expect(watchAllowance(400)).toBe(440);
    expect(watchAllowance(800)).toBe(840);
  });

  it('passes inside the band, in either direction', () => {
    expect(collectWatchDrift({ 'src/ui/AnalysePanel.ts': 3150 }, banked)).toEqual([]);
    expect(collectWatchDrift({ 'src/ui/AnalysePanel.ts': 2400 }, banked)).toEqual([]);
  });

  it('fails one line past the band, naming the banked figure and the ceiling', () => {
    const drift = collectWatchDrift({ 'src/ui/AnalysePanel.ts': 3151 }, banked);
    expect(drift).toEqual([{ file: 'src/ui/AnalysePanel.ts', current: 3151, banked: 3000, ceiling: 3150 }]);
  });

  it('reports every drifted module, not just the first', () => {
    const drift = collectWatchDrift({ 'src/ui/AnalysePanel.ts': 4000, 'src/ui/Inspector.ts': 2500 }, banked);
    expect(drift.map((d: { file: string }) => d.file)).toEqual(['src/ui/AnalysePanel.ts', 'src/ui/Inspector.ts']);
  });

  it('ignores a module the baseline does not watch, and an absent watch section', () => {
    expect(collectWatchDrift({ 'src/ui/Other.ts': 99_999 }, banked)).toEqual([]);
    expect(collectWatchDrift({ 'src/ui/AnalysePanel.ts': 99_999 }, { files: {} })).toEqual([]);
  });

  it('the committed baseline watches the next tier and the tree sits inside every band', () => {
    const live = JSON.parse(readFileSync(resolve(ROOT, 'docs/validation/monolith-size-baseline.json'), 'utf8'));
    expect(Object.keys(live.watch ?? {}).length).toBeGreaterThanOrEqual(7);
    const current: Record<string, number> = {};
    for (const f of Object.keys(live.watch)) {
      current[f] = readFileSync(resolve(ROOT, f), 'utf8').split('\n').length;
    }
    expect(collectWatchDrift(current, live)).toEqual([]);
  });
});
