/**
 * reachability.ts — did the validation reach the code it says it checks?
 *
 * A suite can be green and never touch its subject. The case this generalises
 * shipped: the GPU derivatives spec waited on an engine hook that only appears
 * once terrain analysis starts, never started it, skipped on every runner and
 * reported as a pass. A deliberate error injected into the kernel did not move
 * it, because the kernel never ran.
 *
 * The witness here is V8's precise coverage, collected around the suite's own
 * tests. `witnessSuite(id)` opens a counter window for the whole file and, once
 * the file's tests have finished, asserts that every production function the
 * claim names was entered at least once BY THOSE TESTS. Nothing in this module
 * calls the subject: the counts come from the code under test executing, so a
 * suite that stops driving a path fails here even while its own assertions
 * still pass on whatever it does drive.
 *
 * WHY NOT A SPY OR A CALL COUNTER. Either would be produced by the harness, and
 * a harness can satisfy itself. An import and a direct call prove a module
 * loads, not that the validation exercises it. The counter window proves the
 * second, and it cannot be satisfied by adding a line to this file.
 *
 * WHAT IT DOES NOT PROVE. That the assertions are strong, that the path was
 * driven with meaningful input, or that a browser-only path ran. Claims of the
 * last kind are registered `unwitnessed` with a reason rather than given a
 * proxy.
 *
 * The claims live in validation/reachability/claims.json. Each run writes a
 * ledger entry to validation/reachability/ledger/<id>.json; anything with no
 * entry reads as `not-executed` in scripts/verify-reachability.mjs.
 *
 * Set OLV_REACHABILITY=0 to turn the window off. That is required when V8
 * coverage is being collected for another purpose, since the two share one
 * profiler.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import inspector from 'node:inspector';
import { afterAll, beforeAll, expect } from 'vitest';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const REGISTRY = join(ROOT, 'validation/reachability/claims.json');
const LEDGER_DIR = join(ROOT, 'validation/reachability/ledger');

export interface FunctionClaim {
  readonly file: string;
  readonly fn: string;
}

export interface PathClaim {
  readonly id: string;
  readonly title: string;
  readonly suite: string;
  readonly mode: 'coverage' | 'artifact' | 'unwitnessed';
  readonly functions?: readonly FunctionClaim[];
  readonly artifact?: string;
  readonly requiredChecks?: readonly string[];
  readonly reason?: string;
}

export interface FunctionWitness extends FunctionClaim {
  readonly calls: number;
}

export interface Witness {
  readonly id: string;
  readonly entered: readonly FunctionWitness[];
  readonly missing: readonly FunctionClaim[];
}

/** Every registered claim, in file order. */
export function loadClaims(): PathClaim[] {
  const parsed = JSON.parse(readFileSync(REGISTRY, 'utf8')) as { claims: PathClaim[] };
  return parsed.claims;
}

/** One claim by id. Throws rather than silently witnessing nothing. */
export function claim(id: string): PathClaim {
  const found = loadClaims().find((c) => c.id === id);
  if (!found) throw new Error(`reachability: no claim registered under "${id}"`);
  return found;
}

/** True when the counter window can be opened without disturbing another collector. */
export function witnessEnabled(): boolean {
  if (process.env.OLV_REACHABILITY === '0') return false;
  if (process.env.NODE_V8_COVERAGE) return false;
  return true;
}

interface CoverageFunction {
  functionName: string;
  ranges: { count: number }[];
}
interface CoverageScript {
  url: string;
  functions: CoverageFunction[];
}

/**
 * An open V8 counter window. `read()` returns the counts accumulated since it
 * opened and leaves the window open; `close()` releases the profiler.
 */
export interface CounterWindow {
  read(): Promise<CoverageScript[]>;
  close(): Promise<void>;
}

export async function openCounterWindow(): Promise<CounterWindow> {
  const session = new inspector.Session();
  session.connect();
  const post = (method: string, params?: object): Promise<Record<string, unknown>> =>
    new Promise((res, rej) => {
      session.post(method, params as never, (err: Error | null, result: unknown) =>
        err ? rej(err) : res((result ?? {}) as Record<string, unknown>),
      );
    });
  await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  let closed = false;
  return {
    async read() {
      const out = await post('Profiler.takePreciseCoverage');
      return (out.result ?? []) as CoverageScript[];
    },
    async close() {
      if (closed) return;
      closed = true;
      await post('Profiler.stopPreciseCoverage');
      session.disconnect();
    },
  };
}

/**
 * Highest call count recorded for `fn` in `file` within a coverage snapshot.
 *
 * Matching is on the script URL of the file itself, so a same-named function in
 * another module cannot stand in for the one claimed. Zero means the function
 * exists in a loaded script and was never entered; a script that never loaded
 * is also zero, which is the same finding.
 */
export function callsRecorded(
  snapshot: readonly CoverageScript[],
  target: FunctionClaim,
): number {
  const url = pathToFileURL(join(ROOT, target.file)).href;
  // ranges[0] is the function body itself; later ranges are blocks inside it,
  // whose counts are loop iterations rather than calls.
  let best = 0;
  for (const script of snapshot) {
    if (script.url.split('?')[0] !== url) continue;
    for (const f of script.functions) {
      if (f.functionName !== target.fn) continue;
      best = Math.max(best, f.ranges[0]?.count ?? 0);
    }
  }
  return best;
}

/** Split a claim's functions into those a snapshot shows entered, and those it does not. */
export function witnessFrom(c: PathClaim, snapshot: readonly CoverageScript[]): Witness {
  const entered: FunctionWitness[] = [];
  const missing: FunctionClaim[] = [];
  for (const target of c.functions ?? []) {
    const calls = callsRecorded(snapshot, target);
    if (calls > 0) entered.push({ ...target, calls });
    else missing.push(target);
  }
  return { id: c.id, entered, missing };
}

export function writeLedgerEntry(entry: Record<string, unknown>): void {
  mkdirSync(LEDGER_DIR, { recursive: true });
  writeFileSync(join(LEDGER_DIR, `${entry.id as string}.json`), `${JSON.stringify(entry, null, 2)}\n`);
}

/**
 * Register the counter window for the calling suite file.
 *
 * Call once at module scope, naming every claim this file is responsible for.
 * One window serves them all: `takePreciseCoverage` resets the counters, so two
 * independent windows in one isolate would leave the second reading zeros.
 *
 * The assertion runs after the file's last test, so the counts it reads are the
 * ones the suite produced.
 */
export function witnessSuite(...ids: readonly string[]): void {
  const claims = ids.map((id) => {
    const c = claim(id);
    if (c.mode !== 'coverage') {
      throw new Error(`reachability: claim "${id}" is registered ${c.mode}, not coverage`);
    }
    return c;
  });
  let window: CounterWindow | null = null;

  beforeAll(async () => {
    if (!witnessEnabled()) return;
    window = await openCounterWindow();
  });

  afterAll(async () => {
    const now = new Date().toISOString();
    if (!window) {
      for (const c of claims) {
        writeLedgerEntry({
          id: c.id,
          suite: c.suite,
          mode: 'coverage',
          state: 'not-executed',
          reason: 'the counter window was disabled for this run',
          recordedAt: now,
        });
      }
      return;
    }
    const snapshot = await window.read();
    await window.close();
    window = null;

    const unreached: string[] = [];
    for (const c of claims) {
      const witness = witnessFrom(c, snapshot);
      writeLedgerEntry({
        id: c.id,
        suite: c.suite,
        mode: 'coverage',
        state: witness.missing.length === 0 ? 'witnessed' : 'unreached',
        entered: witness.entered,
        missing: witness.missing,
        recordedAt: now,
      });
      for (const m of witness.missing) unreached.push(`${c.id} → ${m.file}:${m.fn}`);
    }
    if (unreached.length > 0) {
      expect.unreachable(
        `reachability: the suite passed without entering ${unreached.join(', ')}. ` +
          'Either the suite stopped driving that path, or the claim in ' +
          'validation/reachability/claims.json is out of date.',
      );
    }
  });
}
