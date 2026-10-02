/**
 * gateSchedule.test.ts: scripts/lib/gates.mjs validateGates rejects a manifest
 * the runner could not schedule, checked after `@group` expansion, and
 * scripts/lib/gateScheduler.mjs runs a valid one with `after`, `needs`, the
 * job bound, serial mode and filtered runs intact, and stops on a deadlock
 * instead of polling. The runner is a fake: nothing spawns and nothing sleeps.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain .mjs script, no types
import { validateGates, loadGates, serialOrder, directDeps } from '../scripts/lib/gates.mjs';
// @ts-expect-error - plain .mjs script, no types
import { runSchedule } from '../scripts/lib/gateScheduler.mjs';

type RawStep = { script: string; group?: string; after?: string[]; needs?: string[] };

const pkg = (steps: RawStep[]) => Object.fromEntries(steps.map((s) => [s.script, 'true']));
const validate = (steps: RawStep[]) => validateGates({ steps }, pkg(steps));
const problems = (steps: RawStep[]): string => {
  try {
    validate(steps);
  } catch (err) {
    return (err as Error).message;
  }
  return '';
};

/** Fake runner: steps finish in the order the test releases them. */
function fakeRunner(codes: Record<string, number> = {}) {
  const started: string[] = [];
  const pending = new Map<string, () => void>();
  let live = 0;
  let peak = 0;
  const runStep = (step: { script: string }) => {
    started.push(step.script);
    live += 1;
    peak = Math.max(peak, live);
    return new Promise((resolve) => {
      pending.set(step.script, () => {
        live -= 1;
        resolve({ code: codes[step.script] ?? 0, ms: 0, output: '' });
      });
    });
  };
  const release = async (script: string) => {
    const r = pending.get(script);
    if (!r) throw new Error(`${script} is not running`);
    pending.delete(script);
    r();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const drain = async () => {
    for (let guard = 0; guard < 1000 && pending.size > 0; guard++) await release([...pending.keys()][0]!);
  };
  return { runStep, started, release, drain, running: () => [...pending.keys()], peak: () => peak };
}

describe('validateGates', () => {
  it('rejects a group that contains the step waiting for it', () => {
    const msg = problems([
      { script: 'a', group: 'g' },
      { script: 'b', group: 'g', after: ['@g'] },
      { script: 'c', group: 'g' },
    ]);
    expect(msg).toContain('b depends on itself through group @g');
    expect(msg).toContain('b depends on c through group @g, which is a later step');
  });

  it('rejects a later group member that would form a cycle', () => {
    const msg = problems([
      { script: 'a', group: 'g' },
      { script: 'b', needs: ['@g'] },
      { script: 'c', group: 'g', after: ['b'] },
    ]);
    expect(msg).toContain('b depends on c through group @g, which is a later step');
  });

  it('rejects an unknown dependency and an unknown group', () => {
    const msg = problems([
      { script: 'a', after: ['nosuch'] },
      { script: 'b', needs: ['@nogroup'] },
    ]);
    expect(msg).toContain('a depends on nosuch, which is not a step');
    expect(msg).toContain('b waits for group @nogroup, which no step belongs to');
  });

  it('rejects a direct dependency on a later step or on itself', () => {
    const msg = problems([
      { script: 'a', after: ['b'] },
      { script: 'b', needs: ['b'] },
    ]);
    expect(msg).toContain('a depends on b, which is a later step');
    expect(msg).toContain('b depends on itself');
  });

  it('accepts groups whose members all come first', () => {
    const g = validate([
      { script: 'a', group: 'g' },
      { script: 'b', group: 'g' },
      { script: 'c', after: ['@g'] },
      { script: 'd', group: 'h', needs: ['c'] },
      { script: 'e', group: 'h', needs: ['c'] },
      { script: 'f', needs: ['@h'], after: ['@g'] },
    ]);
    expect([...directDeps(g.steps[5], g)].sort()).toEqual(['a', 'b', 'd', 'e']);
  });

  it('accepts the shipped scripts/gates.json', () => {
    const g = loadGates();
    expect(serialOrder(g).length).toBe(g.steps.length);
  });
});

describe('runSchedule', () => {
  const graph = validate([
    { script: 'a', group: 'g' },
    { script: 'b', group: 'g' },
    { script: 'c', group: 'g' },
    { script: 'after', after: ['@g'] },
    { script: 'needs', needs: ['b'] },
    { script: 'chained', needs: ['needs'] },
  ]);

  it('runs a group in parallel within the job bound and orders `after` regardless of success', async () => {
    const f = fakeRunner({ b: 1 });
    const done = runSchedule({ steps: graph.steps, gates: graph, jobs: 2, runStep: f.runStep });
    await Promise.resolve();
    expect(f.running()).toEqual(['a', 'b']);
    await f.release('a');
    expect(f.running()).toEqual(['b', 'c']);
    await f.release('b');
    await f.release('c');
    expect(f.started).toContain('after');
    await f.drain();
    const { state } = await done;
    expect(state.get('b')).toBe('failed');
    expect(state.get('after')).toBe('passed');
    expect(f.peak()).toBeLessThanOrEqual(2);
  });

  it('skips a step whose need failed and propagates the skip', async () => {
    const f = fakeRunner({ b: 1 });
    const skipped: string[] = [];
    const done = runSchedule({
      steps: graph.steps, gates: graph, jobs: 8, runStep: f.runStep,
      onSkip: (s: { script: string }) => skipped.push(s.script),
    });
    await Promise.resolve();
    await f.drain();
    const { state } = await done;
    expect(state.get('needs')).toBe('skipped');
    expect(state.get('chained')).toBe('skipped');
    expect(skipped).toEqual(['needs', 'chained']);
    expect(f.started).not.toContain('needs');
  });

  it('runs one at a time in array order in serial mode', async () => {
    const f = fakeRunner();
    const done = runSchedule({ steps: graph.steps, gates: graph, jobs: 1, serial: true, runStep: f.runStep });
    await Promise.resolve();
    await f.drain();
    await done;
    expect(f.started).toEqual(serialOrder(graph));
    expect(f.peak()).toBe(1);
  });

  it('treats a dependency filtered out of the run as met', async () => {
    const f = fakeRunner();
    const steps = graph.steps.filter((s: { script: string }) => ['needs', 'chained'].includes(s.script));
    const done = runSchedule({ steps, gates: graph, jobs: 4, runStep: f.runStep });
    await Promise.resolve();
    await f.drain();
    const { state } = await done;
    expect(f.started).toEqual(['needs', 'chained']);
    expect(state.get('chained')).toBe('passed');
  });

  it('starts the shipped manifest in serial order in serial mode', async () => {
    const g = loadGates();
    const f = fakeRunner();
    const done = runSchedule({ steps: g.steps, gates: g, jobs: 1, serial: true, runStep: f.runStep });
    await Promise.resolve();
    await f.drain();
    await done;
    expect(f.started).toEqual(serialOrder(g));
  });

  it('fails with a deadlock error instead of polling when nothing can start', async () => {
    // Bypasses validateGates: b waits for its own group.
    const bad = {
      steps: [
        { script: 'a', group: 'g', after: [], needs: [], tags: [] },
        { script: 'b', group: 'g', after: ['@g'], needs: [], tags: [] },
        { script: 'c', after: ['b'], needs: [], tags: [] },
      ],
    };
    const f = fakeRunner();
    const done = runSchedule({ steps: bad.steps, gates: bad, jobs: 4, runStep: f.runStep });
    await Promise.resolve();
    await f.drain();
    await expect(done).rejects.toThrow(/deadlock[\s\S]*b waits for b[\s\S]*c waits for b/);
    expect(f.started).toEqual(['a']);
  });
});
