/**
 * claimProseSyncScope.test.ts — which count a truth document is held to.
 *
 * The lint exists because "Ten products are now at E4" survived past twelve in
 * a published release note. Scoping a versioned release document to its own tag
 * must not give that failure a way back, so the case that matters most here is
 * the one where a release is being PREPARED: no tag yet, so the document is
 * still held to the live register and the original bug is still caught.
 *
 * Only an already-tagged release reads against its tag, and only because it has
 * become a historical record. Holding it to the live register would have the
 * lint demand that a shipped, archived document be rewritten every time a claim
 * is promoted afterwards, which is the opposite of what a truth gate is for.
 *
 * The helpers take their git access as parameters, so these cases decide their
 * own history rather than depending on the tags this checkout happens to have.
 */

import { describe, it, expect } from 'vitest';

// Kept on one line: @ts-expect-error applies to the line that follows it.
// @ts-expect-error — plain .mjs script, no types
import { releaseVersionOf, expectedCountFor } from '../scripts/lint-claim-prose-sync.mjs';

interface Expectation { count: number | null; basis: string }

const call = (
  rel: string,
  live: number,
  tags: string[],
  atTag: Record<string, number | null>,
  git = true,
): Expectation =>
  expectedCountFor(rel, live, {
    gitUsable: () => git,
    tagExists: (t: string) => tags.includes(t),
    e4CountAtTag: (t: string) => (t in atTag ? atTag[t] : null),
  }) as Expectation;

describe('recognising a versioned release document', () => {
  it('reads the version out of a release filename', () => {
    expect(releaseVersionOf('docs/releases/RELEASE_NOTES_v0.6.6.md')).toBe('v0.6.6');
    expect(releaseVersionOf('docs/releases/VALIDATION_REPORT_v0.6.6.md')).toBe('v0.6.6');
    expect(releaseVersionOf('docs/releases/KNOWN_LIMITATIONS_v1.12.3.md')).toBe('v1.12.3');
  });

  it('treats everything else as a living document', () => {
    expect(releaseVersionOf('ARTIFACT_EVALUATION.md')).toBeNull();
    expect(releaseVersionOf('docs/validation/EVIDENCE_MODEL.md')).toBeNull();
    expect(releaseVersionOf('docs/project/CLAIMS_AND_LIMITATIONS.md')).toBeNull();
    // Not under docs/releases/, so the version in the name does not scope it.
    expect(releaseVersionOf('docs/validation/matrix_v0.6.6.md')).toBeNull();
  });
});

describe('a living document is held to the live register', () => {
  it('takes the live count whatever the tags say', () => {
    const r = call('ARTIFACT_EVALUATION.md', 14, ['v0.6.6'], { 'v0.6.6': 12 });
    expect(r.count).toBe(14);
    expect(r.basis).toBe('the register');
  });
});

describe('a tagged release document is held to its own tag', () => {
  it('takes the count at the tag, not the live one', () => {
    // The whole point: 12 was true for v0.6.6 and stays true.
    const r = call('docs/releases/VALIDATION_REPORT_v0.6.6.md', 14, ['v0.6.6'], { 'v0.6.6': 12 });
    expect(r.count).toBe(12);
    expect(r.basis).toContain('at tag v0.6.6');
  });

  it('still fails a tagged document that disagrees with its own tag', () => {
    // Scoping is not an exemption. A release note that understated the count at
    // the moment it shipped is still wrong, and is still caught.
    const r = call('docs/releases/RELEASE_NOTES_v0.6.6.md', 14, ['v0.6.6'], { 'v0.6.6': 12 });
    expect(r.count).toBe(12);
    // Prose saying "ten" would be compared against 12 and rejected.
    expect(r.count).not.toBe(10);
  });
});

describe('the release being prepared, which is where the original bug lived', () => {
  it('is held to the LIVE register when its version has no tag yet', () => {
    // "Ten products are now at E4" was published in a release note. At that
    // moment there was no tag, so this branch is the one that catches it.
    const r = call('docs/releases/RELEASE_NOTES_v0.6.7.md', 14, ['v0.6.6'], { 'v0.6.6': 12 });
    expect(r.count).toBe(14);
    expect(r.basis).toContain('not tagged yet');
  });

  it('does not fall back to an older tag just because one exists', () => {
    const r = call('docs/releases/VALIDATION_REPORT_v0.7.0.md', 20, ['v0.6.6'], { 'v0.6.6': 12 });
    expect(r.count).toBe(20);
  });
});

describe('when git cannot answer', () => {
  it('skips a tagged document rather than failing it', () => {
    // An extracted archive has no history and the release gate runs there.
    // Failing every release document in that environment would make the gate
    // impossible to pass for a reason that has nothing to do with the evidence.
    const r = call('docs/releases/RELEASE_NOTES_v0.6.6.md', 14, ['v0.6.6'], { 'v0.6.6': null });
    expect(r.count).toBeNull();
    expect(r.basis).toContain('unreadable');
  });

  it('still holds a living document to the live register with no git at all', () => {
    // A living document describes main, so it needs no history to be judged.
    const r = call('docs/validation/EVIDENCE_MODEL.md', 14, [], {}, false);
    expect(r.count).toBe(14);
  });

  it('skips EVERY versioned document when there is no git at all', () => {
    // The archive case, and the one this rule got wrong first time. An
    // extracted archive has no .git, so a missing tag says nothing about
    // whether the release shipped. Treating it as "not tagged yet" held the
    // v0.6.6 release notes to the live count in the one environment where they
    // can never match, because the archive ships the current register beside
    // release notes describing an earlier one.
    for (const rel of [
      'docs/releases/RELEASE_NOTES_v0.6.6.md',
      'docs/releases/VALIDATION_REPORT_v0.6.6.md',
      'docs/releases/RELEASE_NOTES_v0.6.7.md',
    ]) {
      const r = call(rel, 14, [], {}, false);
      expect(r.count, rel).toBeNull();
      expect(r.basis, rel).toContain('no git history');
    }
  });

  it('a missing tag still means "not released yet" when git IS available', () => {
    // The protection has to survive the fix: in a real checkout an untagged
    // release document is the one being prepared and is held to the register.
    const r = call('docs/releases/RELEASE_NOTES_v0.6.7.md', 14, ['v0.6.6'], { 'v0.6.6': 12 }, true);
    expect(r.count).toBe(14);
    expect(r.basis).toContain('not tagged yet');
  });
});

/**
 * The total-claim rule.
 *
 * "Of the 28 registered claims" sat in EVIDENCE_MODEL.md while the register
 * held 29, and no gate read it: the E4 rule counts claims AT a rung and never
 * asks how many are registered at all. These cases pin the construction that
 * states a register total and, just as importantly, the ones that do not.
 */

// @ts-expect-error — plain .mjs script, no types
import { expectedTotalFor, totalCountProblemsIn } from '../scripts/lint-claim-prose-sync.mjs';

const totals = (
  rel: string,
  text: string,
  expected: number,
  basis = 'the register',
): string[] => totalCountProblemsIn(rel, text, expected, basis) as string[];

const totalCall = (
  rel: string,
  live: number,
  tags: string[],
  atTag: Record<string, number | null>,
  git = true,
): Expectation =>
  expectedTotalFor(rel, live, {
    gitUsable: () => git,
    tagExists: (t: string) => tags.includes(t),
    totalClaimsAtTag: (t: string) => (t in atTag ? atTag[t] : null),
  }) as Expectation;

describe('a prose statement of the register total', () => {
  it('passes when the stated total matches the register', () => {
    expect(totals('docs/validation/EVIDENCE_MODEL.md',
      'Of the 29 registered claims, 17 currently sit below their required level.', 29)).toEqual([]);
  });

  it('fails when the stated total is stale, and names the real number', () => {
    const p = totals('docs/validation/EVIDENCE_MODEL.md',
      'Of the 28 registered claims, 17 currently sit below their required level.', 29);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('docs/validation/EVIDENCE_MODEL.md:1');
    expect(p[0]).toContain('28');
    expect(p[0]).toContain('29');
    expect(p[0]).toContain('the register');
  });

  it('accepts the spelled form, and rejects a stale spelled form', () => {
    expect(totals('a.md', 'Of the twenty-nine registered claims, 17 sit below.', 29)).toEqual([]);
    expect(totals('a.md', 'Of the twelve registered claims, 3 sit below.', 29)).toHaveLength(1);
  });

  it('reads the other constructions that state a total', () => {
    expect(totals('a.md', 'The register holds 29 claims.', 29)).toEqual([]);
    expect(totals('a.md', 'The claim register lists 28 claims.', 29)).toHaveLength(1);
    expect(totals('a.md', 'All 28 registered claims carry a scope block.', 29)).toHaveLength(1);
    expect(totals('a.md', 'Of the 28 claims in the register, 17 sit below.', 29)).toHaveLength(1);
  });

  it('reports the line number of the offending sentence', () => {
    const p = totals('a.md', 'intro\n\nOf the 28 registered claims, 17 sit below.\n', 29);
    expect(p[0]).toContain('a.md:3');
  });
});

describe('what the total rule must NOT fire on', () => {
  it('ignores a count of claims at a rung, which the E4 rule owns', () => {
    // The near miss. Both sentences shipped in the v0.6.6 release notes and use
    // the very noun phrase the total rule keys on. A rule that fired on any
    // number before "claims" would flag both, be argued with, and be switched off.
    expect(totals('docs/releases/RELEASE_NOTES_v0.6.6.md',
      'Twelve registered claims now carry E4 cross-implementation evidence, against five.', 29))
      .toEqual([]);
    expect(totals('docs/releases/RELEASE_NOTES_v0.6.6.md',
      'Twelve registered claims are now at E4: `SLOPE-RASTER`, `DSM` and others.', 29))
      .toEqual([]);
    expect(totals('a.md', 'Of the 29 registered claims at E4, none is field validated.', 29))
      .toEqual([]);
  });

  it('ignores counts of things that are not claims', () => {
    expect(totals('a.md', 'Seventeen products are at E4 and the register lists 9 datasets.', 29))
      .toEqual([]);
    expect(totals('a.md', 'Four external oracles and 12 derived products are covered.', 29))
      .toEqual([]);
  });

  it('ignores a number that merely shares a sentence with the word claims', () => {
    expect(totals('a.md', 'Both claims still require E5, and 17 checkpoints were held out.', 29))
      .toEqual([]);
    expect(totals('a.md', 'The 1.5 mm tolerance covers 36 coordinates; the claims are narrow.', 29))
      .toEqual([]);
  });
});

describe('the total rule inherits the release-document scoping', () => {
  it('holds a living document to the live register', () => {
    const r = totalCall('docs/validation/EVIDENCE_MODEL.md', 33, ['v0.6.6'], { 'v0.6.6': 29 });
    expect(r.count).toBe(33);
    expect(r.basis).toBe('the register');
  });

  it('holds a tagged release document to the total at its own tag', () => {
    // A shipped release note stating the count at its own release must not be
    // rewritten every time a claim is added.
    const r = totalCall('docs/releases/RELEASE_NOTES_v0.6.6.md', 33, ['v0.6.6'], { 'v0.6.6': 29 });
    expect(r.count).toBe(29);
    expect(r.basis).toContain('at tag v0.6.6');
  });

  it('holds the release being prepared to the live register', () => {
    const r = totalCall('docs/releases/RELEASE_NOTES_v0.6.7.md', 33, ['v0.6.6'], { 'v0.6.6': 29 });
    expect(r.count).toBe(33);
    expect(r.basis).toContain('not tagged yet');
  });

  it('skips every versioned document when there is no git history', () => {
    const r = totalCall('docs/releases/RELEASE_NOTES_v0.6.6.md', 33, [], {}, false);
    expect(r.count).toBeNull();
    expect(r.basis).toContain('no git history');
  });
});
