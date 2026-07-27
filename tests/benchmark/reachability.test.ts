/**
 * reachability.test.ts — the negative controls for the reachability layer.
 *
 * A check that cannot fail is not a check. Every claim registered in
 * validation/reachability/claims.json is run here against a situation where its
 * path is NOT taken, and the witness has to say so:
 *
 *   coverage claims. A counter window is opened and closed around work that
 *     touches none of the claimed functions. Every one must come back unentered.
 *     If a claim could report `witnessed` from an empty window, the same claim
 *     would report `witnessed` for a suite that had stopped driving its subject.
 *
 *   artifact claims. The emitted result is doctored three ways: a required
 *     check removed, the file count zeroed, a check turned into a reason-less
 *     skip. Each must be refused.
 *
 * The controls also pin the two ways a coverage witness could be satisfied by
 * accident: a same-named function in a different file, and a claim naming a
 * function that no longer exists.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  loadClaims,
  openCounterWindow,
  witnessFrom,
  callsRecorded,
  witnessEnabled,
  type PathClaim,
} from './reachability';
// @ts-expect-error — plain .mjs tooling module, no type declarations
import { judgeArtifactClaim } from '../../scripts/verify-reachability.mjs';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const CLAIMS = loadClaims();
const COVERAGE_CLAIMS = CLAIMS.filter((c) => c.mode === 'coverage');
const ARTIFACT_CLAIMS = CLAIMS.filter((c) => c.mode === 'artifact');

/** Work that reaches nothing any claim names, so the window has a real subject. */
function decoy(): number {
  let acc = 0;
  for (let i = 0; i < 1000; i++) acc = (acc + i * 7) % 9973;
  return acc;
}

describe('the registry describes the tree it is about', () => {
  test('every claim is one of the three modes and carries what that mode needs', () => {
    expect(CLAIMS.length).toBeGreaterThan(0);
    for (const c of CLAIMS) {
      expect(['coverage', 'artifact', 'unwitnessed']).toContain(c.mode);
      if (c.mode === 'coverage') expect((c.functions ?? []).length).toBeGreaterThan(0);
      if (c.mode === 'artifact') expect((c.requiredChecks ?? []).length).toBeGreaterThan(0);
      if (c.mode === 'unwitnessed') expect(c.reason ?? '').not.toBe('');
    }
  });

  test('every claimed function is a name that exists in the file it is claimed in', () => {
    // A claim naming a function the file no longer exports would be reported
    // unreached forever, which reads as a defect in the suite rather than in
    // the claim. Catch it here instead.
    for (const c of COVERAGE_CLAIMS) {
      for (const f of c.functions ?? []) {
        const src = readFileSync(join(ROOT, f.file), 'utf8');
        expect(
          new RegExp(`\\b(function|const|let|class|async)?\\s*\\b${f.fn}\\b\\s*[(<=]`).test(src),
          `${f.file} declares no ${f.fn}`,
        ).toBe(true);
      }
    }
  });

  test('the ids are unique', () => {
    const ids = CLAIMS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.runIf(witnessEnabled())('negative control: an untaken path is reported unreached', () => {
  test('no claimed function reads as entered from a window that ran none of them', async () => {
    const window = await openCounterWindow();
    expect(decoy()).toBeGreaterThanOrEqual(0);
    const snapshot = await window.read();
    await window.close();

    const report: Record<string, number> = {};
    for (const c of COVERAGE_CLAIMS) {
      const witness = witnessFrom(c, snapshot);
      report[c.id] = witness.missing.length;
      // Every function the claim names must be missing. One entered function
      // here would mean the witness can be satisfied without the suite.
      expect(witness.entered, `${c.id} reported entered functions from an empty window`).toEqual([]);
      expect(witness.missing.length).toBe((c.functions ?? []).length);
    }
    // Reported so the control's size is visible, not just its verdict.
    expect(Object.values(report).reduce((a, b) => a + b, 0)).toBe(
      COVERAGE_CLAIMS.reduce((n, c) => n + (c.functions ?? []).length, 0),
    );
  });

  test('a same-named function in another file does not satisfy the claim', async () => {
    const window = await openCounterWindow();
    // `witnessFrom` itself runs during the window, in this file.
    witnessFrom(COVERAGE_CLAIMS[0], []);
    const snapshot = await window.read();
    await window.close();
    const impostor: PathClaim = {
      id: 'control',
      title: 'control',
      suite: 'control',
      mode: 'coverage',
      functions: [{ file: 'src/canonicalHash.ts', fn: 'witnessFrom' }],
    };
    expect(callsRecorded(snapshot, impostor.functions![0])).toBe(0);
    expect(witnessFrom(impostor, snapshot).missing.length).toBe(1);
  });

  test('a function that did run in the window is reported entered', async () => {
    // The other half of the control: the mechanism must be able to say yes, or
    // the negative above proves only that it always says no.
    const window = await openCounterWindow();
    decoy();
    const snapshot = await window.read();
    await window.close();
    expect(
      callsRecorded(snapshot, { file: 'tests/benchmark/reachability.test.ts', fn: 'decoy' }),
    ).toBeGreaterThan(0);
  });
});

describe('negative control: a doctored artifact is refused', () => {
  /** A result object in which every required check ran and passed. */
  function goodResult(c: PathClaim) {
    return {
      fileCount: 412,
      results: (c.requiredChecks ?? []).map((id) => ({ id, status: 'pass', errors: 0, warnings: 0 })),
    };
  }

  test.each(ARTIFACT_CLAIMS.map((c) => [c.id, c] as const))(
    '%s: an intact result is witnessed and each doctored one is not',
    (_id, c) => {
      const intact = judgeArtifactClaim(c, goodResult(c));
      expect(intact.problems).toEqual([]);
      expect(intact.state).toBe('witnessed');
      expect(intact.executed.length).toBe((c.requiredChecks ?? []).length);

      const dropped = goodResult(c);
      dropped.results = dropped.results.slice(1);
      expect(judgeArtifactClaim(c, dropped).state).toBe('unreached');

      const empty = goodResult(c);
      empty.fileCount = 0;
      expect(judgeArtifactClaim(c, empty).state).toBe('unreached');

      const silentSkip = goodResult(c);
      silentSkip.results[0] = { id: silentSkip.results[0].id, status: 'skipped' } as never;
      expect(judgeArtifactClaim(c, silentSkip).state).toBe('unreached');

      // A skip that states its reason stays a skip: not a pass, not a failure.
      const honestSkip = goodResult(c);
      honestSkip.results[0] = {
        id: honestSkip.results[0].id,
        status: 'skipped',
        reason: 'requires the repository',
      } as never;
      const judged = judgeArtifactClaim(c, honestSkip);
      expect(judged.state).toBe('witnessed');
      expect(judged.skipped).toContain(c.requiredChecks![0]);
      expect(judged.executed).not.toContain(c.requiredChecks![0]);

      // Nothing to read at all is not-executed, never a pass.
      expect(judgeArtifactClaim(c, null).state).toBe('not-executed');
      expect(judgeArtifactClaim(c, { fileCount: 9, results: [] }).state).toBe('unreached');
    },
  );
});
