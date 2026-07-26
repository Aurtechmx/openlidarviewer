/**
 * gcMode.ts
 *
 * The one place that decides whether this run is meant to be GC-controlled, and
 * the one place that names the environment variable saying so.
 *
 * WHY AN ENV FLAG RATHER THAN A SEPARATE CONFIG OR A SEPARATE ENTRY POINT. The
 * flag has to be legible to three different things that never see each other's
 * arguments: `vitest.config.ts`, which is what turns it into an `--expose-gc`
 * on every worker; the suite code, which records what it got; and the child
 * `vitest run` that `scalingIsolated.ts` spawns per tier, which inherits the
 * parent's environment and nothing else. An env var is the only channel all
 * three already share. A CLI flag would reach the first process and stop there,
 * and the tier children would quietly run in the other mode — producing one
 * result tree measured two ways, which is the exact confusion this whole file
 * exists to prevent.
 *
 * WHY REQUESTED AND OBSERVED ARE KEPT APART. This module reports only what was
 * ASKED FOR. Whether `global.gc` actually turned up is measured per run by
 * `execute.ts` and recorded as `forcedGcAvailable`. Collapsing the two would
 * make a broken flag invisible: the manifest would claim "GC controlled"
 * because someone typed it, not because anything collected. The manifest
 * publishes both, and they disagreeing is the finding.
 *
 * Pure. No I/O beyond reading the variable.
 */

/** The single documented switch. Set it to `1` to ask for `--expose-gc`. */
export const FORCED_GC_ENV_VAR = 'BENCHMARK_FORCE_GC';

/**
 * Whether this process was asked to run with forced GC available.
 *
 * Deliberately strict about what counts as on: `1`, `true` and `yes`. A loose
 * truthiness test would read `BENCHMARK_FORCE_GC=0` as a request, and a reader
 * who wrote `0` meant the opposite of what they would then get published.
 */
export function forcedGcRequested(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env[FORCED_GC_ENV_VAR] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * What the recorded runs actually observed, collapsed to one word.
 *
 * `'mixed'` is a real outcome and has to be nameable: the scaling ladder runs
 * each tier in its own child process, so a flag that reaches some children and
 * not others yields a table whose rows are not comparable with each other. That
 * must be visible in the manifest rather than averaged away into a boolean.
 */
export type ForcedGcObservation = 'all' | 'none' | 'mixed' | 'no-runs';

export function summariseForcedGc(observed: readonly boolean[]): ForcedGcObservation {
  if (observed.length === 0) return 'no-runs';
  const first = observed[0];
  return observed.every((v) => v === first) ? (first ? 'all' : 'none') : 'mixed';
}
