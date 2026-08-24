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
