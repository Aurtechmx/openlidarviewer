/**
 * json.ts
 *
 * The machine-readable report — the format the plotting scripts and any future
 * regression check read.
 *
 * Serialised whole, with no field pruning: a metric that is unavailable keeps
 * its key, its `null` value, its status and its reason. Dropping the key would
 * force every consumer to guess whether a missing metric means "not measured"
 * or "this suite does not produce it", and a guess is how a 0 gets invented.
 *
 * Two-space indent rather than a canonical single line: this file is read by
 * humans in pull requests as often as by scripts. The hash of an artifact never
 * comes from this string — that is `artifacts.ts` — so formatting is free.
 */

import type { RunReport } from '../types';

export function toJson(report: RunReport): string {
  return JSON.stringify(report, null, 2);
}
