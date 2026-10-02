/**
 * scripts/lib/gateScheduler.mjs: the scheduling loop of scripts/run-gates.mjs,
 * apart from process spawning so tests can drive it with a fake runner.
 *
 *   - `after` orders only: the step starts once each dependency has finished,
 *     whether it passed or not.
 *   - `needs` also requires success: a step whose need did not pass is
 *     skipped, and the skip counts as a failure.
 *   - At most `jobs` steps run at once. Serial mode walks the array in order.
 *   - A dependency outside `steps` (filtered out by a flag) counts as met.
 *
 * When nothing is running and pending steps still cannot start, the run is
 * deadlocked: the promise rejects with an error naming each stuck step and
 * what it waits for, instead of polling forever. validateGates rejects every
 * manifest that could get here; this guard covers a caller that bypasses it.
 */

import { directDeps } from './gates.mjs';

const finished = (st) => st === 'passed' || st === 'failed' || st === 'skipped';

/**
 * @param {{
 *   steps: Array<{script:string, after:string[], needs:string[]}>,
 *   gates: {steps: Array<object>},
 *   jobs: number,
 *   serial?: boolean,
 *   runStep: (step: object) => Promise<{code:number}>,
 *   onSkip?: (step: object, need: string) => void,
 *   onDone?: (step: object, result: object) => void,
 * }} opts
 * @returns {Promise<{state: Map<string,string>, results: Map<string,object>}>}
 */
export function runSchedule({ steps, gates, jobs, serial = false, runStep, onSkip, onDone }) {
  const included = new Set(steps.map((s) => s.script));
  /** script -> 'pending' | 'running' | 'passed' | 'failed' | 'skipped' */
  const state = new Map(steps.map((s) => [s.script, 'pending']));
  const results = new Map();
  const running = new Set();

  const depsOf = (step, kind) => {
    const deps = kind === 'needs'
      ? directDeps({ after: [], needs: step.needs }, gates)
      : directDeps(step, gates);
    return [...deps].filter((d) => included.has(d));
  };

  return new Promise((finish, fail) => {
    let settled = false;
    const pump = () => {
      if (settled) return;
      // Skips can unblock steps earlier in the array, so pass until stable.
      let changed = true;
      while (changed) {
        changed = false;
        for (const step of steps) {
          if (running.size >= jobs) break;
          if (state.get(step.script) !== 'pending') continue;
          if (!depsOf(step, 'all').every((d) => finished(state.get(d)))) {
            if (serial) break;
            continue;
          }
          const failedNeed = depsOf(step, 'needs').find((d) => state.get(d) !== 'passed');
          if (failedNeed !== undefined) {
            state.set(step.script, 'skipped');
            results.set(step.script, { code: null, ms: 0, output: `skipped: needs ${failedNeed}, which did not pass\n` });
            onSkip?.(step, failedNeed);
            changed = true;
            continue;
          }
          state.set(step.script, 'running');
          running.add(step.script);
          Promise.resolve()
            .then(() => runStep(step))
            .catch((err) => ({ code: 1, ms: 0, output: `run failed: ${err?.message ?? err}\n` }))
            .then((r) => {
              running.delete(step.script);
              results.set(step.script, r);
              state.set(step.script, r.code === 0 ? 'passed' : 'failed');
              onDone?.(step, r);
              pump();
            });
          if (serial) break;
        }
        if (serial && running.size > 0) break;
      }
      if (running.size > 0) return;
      const stuck = steps.filter((s) => state.get(s.script) === 'pending');
      settled = true;
      if (stuck.length === 0) {
        finish({ state, results });
        return;
      }
      const why = stuck.map((s) => {
        const waits = depsOf(s, 'all').filter((d) => !finished(state.get(d)));
        return `${s.script} waits for ${waits.join(', ') || 'nothing'}`;
      });
      fail(new Error(`run-gates: deadlock, no step can start:\n  ${why.join('\n  ')}`));
    };
    pump();
  });
}
