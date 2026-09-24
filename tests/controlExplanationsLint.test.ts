/**
 * controlExplanationsLint.test.ts — the button-explanation ratchet
 * (scripts/lint-control-explanations.mjs) flags a bare `el('button', {...})`
 * and accepts one explained via `tip`, `title` (prop or shorthand), an
 * explicit `ariaLabel`, or a deferred `target.title = ...` /
 * `target.setAttribute('aria-label' | 'title', ...)` a few lines below.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations.
import { findUnexplainedButtons } from '../scripts/lint-control-explanations.mjs';

describe('findUnexplainedButtons', () => {
  it('flags a button with no explanation prop', () => {
    const src = "const b = el('button', { className: 'x', text: 'Go' });";
    expect(findUnexplainedButtons(src)).toEqual([1]);
  });

  it('accepts a `tip` prop', () => {
    const src = "const b = el('button', { text: 'Go', tip: 'Runs the thing.' });";
    expect(findUnexplainedButtons(src)).toEqual([]);
  });

  it('accepts the `title` shorthand', () => {
    const title = 'x';
    const src = "const b = el('button', { text: 'Go', title });";
    void title;
    expect(findUnexplainedButtons(src)).toEqual([]);
  });

  it('accepts an explicit ariaLabel prop', () => {
    const src = "const b = el('button', { ariaLabel: 'Close' });";
    expect(findUnexplainedButtons(src)).toEqual([]);
  });

  it('accepts a deferred target.title assignment shortly after', () => {
    const src = [
      "const btn = el('button', { className: 'x' });",
      "btn.title = 'Explains itself';",
    ].join('\n');
    expect(findUnexplainedButtons(src)).toEqual([]);
  });

  it('accepts a deferred setAttribute aria-label or title', () => {
    const src = [
      "const btn = el('button', { className: 'x' });",
      "btn.setAttribute('aria-label', 'Explains itself');",
    ].join('\n');
    expect(findUnexplainedButtons(src)).toEqual([]);
  });

  it('still flags when the deferred title targets a different variable', () => {
    const src = [
      "const btn = el('button', { className: 'x' });",
      "other.title = 'Not this one';",
    ].join('\n');
    expect(findUnexplainedButtons(src)).toEqual([1]);
  });

  it('reports the correct line number for a later offender', () => {
    const src = [
      "const ok = el('button', { text: 'Go', tip: 'Runs.' });",
      '',
      "const bad = el('button', { text: 'Stop' });",
    ].join('\n');
    expect(findUnexplainedButtons(src)).toEqual([3]);
  });
});
