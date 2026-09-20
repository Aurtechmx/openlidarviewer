/**
 * Shipped documentation is held to the PR body's rule: describe the software,
 * not how the change was arrived at.
 *
 * `pr-hygiene` enforced this on PR bodies and commit messages and nothing
 * enforced it on docs, which are what reaches the source archive. A ledger
 * entry shipped with an account of an attempt in it before this existed.
 *
 * The patterns come from `pr-hygiene`, so these tests also pin that they are
 * shared rather than copied: a second vocabulary could drift from the one a
 * reviewer is held to.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { narrationIn } from '../scripts/lint-doc-narration.mjs';
import { NARRATION_PATTERNS } from '../scripts/pr-hygiene.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('the rule is shared with pr-hygiene, not restated', () => {
  it('detects with the same patterns a PR body is held to', () => {
    expect(NARRATION_PATTERNS.length).toBeGreaterThan(0);
    for (const p of NARRATION_PATTERNS) {
      expect(typeof p.id).toBe('string');
      expect(p.re).toBeInstanceOf(RegExp);
    }
  });
});

describe('what it catches', () => {
  it('catches an account of an attempt, which is what shipped', () => {
    const hits = narrationIn('The share looked at first like a swapped pair of timestamps.');
    expect(hits.map((h) => h.id)).toContain('try-fail-narrative');
  });

  it('catches first-person process narration', () => {
    expect(narrationIn('I noticed the budget was wrong.').length).toBeGreaterThan(0);
    expect(narrationIn('We then decided to keep the immediate path.').length).toBeGreaterThan(0);
  });

  it('catches a thinking-aloud opener at the start of a line', () => {
    expect(narrationIn('\nActually the gutter is nine pixels.').map((h) => h.id))
      .toContain('deliberation');
  });

  it('catches an echo of the instruction that prompted the work', () => {
    expect(narrationIn('As requested, the handle now sits flush.').map((h) => h.id))
      .toContain('instruction-echo');
  });

  it('catches a working-note artifact', () => {
    expect(narrationIn('TODO: measure this on a phone.').map((h) => h.id))
      .toContain('session-artifact');
  });

  it('reports the line, so a long document is navigable', () => {
    const hits = narrationIn('clean line\nclean line\nI discovered the bug.');
    expect(hits[0].line).toBe(3);
  });
});

describe('what it leaves alone', () => {
  it('passes ordinary description of software', () => {
    const prose = [
      'The scheduler paces on elapsed time rather than a frame count.',
      'A node outside the frustum keeps its mesh and its decoded chunk.',
      'The history depth surface needs EXT_color_buffer_float on WebGL 2.',
      'Measured on an Apple M3 Max, the gutter is nine pixels wide.',
    ].join('\n');
    expect(narrationIn(prose)).toEqual([]);
  });

  it('does not fire on a wrapped line that merely begins with a verb', () => {
    // The deliberation pattern is case-sensitive for this reason: an
    // ordinary sentence wrapping mid-clause is description, not thinking.
    expect(narrationIn('whether a finger was\nactually tracked at the time')).toEqual([]);
  });
});

describe('the whole docs tree', () => {
  it('passes, so the gate has no grandfathered exceptions', () => {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts/lint-doc-narration.mjs')], {
      cwd: ROOT, encoding: 'utf8',
    });
    expect(out).toContain('lint:doc-narration OK');
    // Reads, not merely lists. An earlier version reported a confident count
    // while a bad pathspec skipped every top-level document.
    const m = /(\d+) document\(s\) read under docs\//.exec(out);
    expect(m, out).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(150);
  });
});
