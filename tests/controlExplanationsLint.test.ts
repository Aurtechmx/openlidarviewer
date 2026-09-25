/**
 * controlExplanationsLint.test.ts — the control-explanation ratchet
 * (scripts/lint-control-explanations.mjs) flags:
 *   - a bare `el('button', {...})` with none of tip/title/ariaLabel, inline
 *     or deferred onto the same target a few lines below;
 *   - a non-button tag later given `role="button"` (a "panel head builder")
 *     with no explanation;
 *   - a link-styled button (`className` containing `-link`) or an
 *     icon/glyph-only button (no `text`, or a short symbol with no letters)
 *     that relies on `ariaLabel` alone — real visible text is required for
 *     `ariaLabel` to count, since it names the control for assistive tech
 *     but shows nothing to a hovering sighted user;
 *   - a bare `document.createElement('button')` with no deferred title /
 *     aria-label / `dataset.tip` on the same target.
 *
 * `tip`, `title` (prop or shorthand), or `ariaLabel` alongside real visible
 * text all count as an explanation, inline or deferred via
 * `target.title = ...` / `target.dataset.tip = ...` /
 * `target.setAttribute('aria-label' | 'title', ...)`.
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

  it('accepts ariaLabel alongside real visible text', () => {
    const src = "const b = el('button', { text: 'Close', ariaLabel: 'Close the dialog' });";
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

  // ── icon/glyph-only buttons: ariaLabel alone is not enough ──────────────

  it('flags an icon-only button (no text) with only ariaLabel', () => {
    const src = "const b = el('button', { ariaLabel: 'Close' });";
    expect(findUnexplainedButtons(src)).toEqual([1]);
  });

  it('flags a glyph-text button (no letters) with only ariaLabel', () => {
    const src = "const b = el('button', { text: '×', ariaLabel: 'Close' });";
    expect(findUnexplainedButtons(src)).toEqual([1]);
  });

  it('accepts an icon-only button once it also carries a tip', () => {
    const src = "const b = el('button', { ariaLabel: 'Close', tip: 'Close this dialog.' });";
    expect(findUnexplainedButtons(src)).toEqual([]);
  });

  it('does not flag a button whose text is a dynamic expression', () => {
    const src = "const b = el('button', { text: label, ariaLabel: 'Remove item' });";
    expect(findUnexplainedButtons(src)).toEqual([]);
  });

  // Link-styled buttons, role="button" panel heads, and bare
  // document.createElement('button') sites: each source is one control.
  const flagged: [string, string[]][] = [
    ['a `-link`-styled button relying on ariaLabel alone',
      ["const b = el('button', { className: 'olv-di-story-link', text: 'Overview', ariaLabel: 'Open Story' });"]],
    ['a role="button" div with no explanation',
      ["const head = el('div', { className: 'olv-panel-head' });", "head.setAttribute('role', 'button');"]],
    ['a bare document.createElement("button") with no follow-up',
      ["const b = document.createElement('button');", "b.textContent = 'Close';"]],
    ['a select with ariaLabel alone',
      ["const s = el('select', { className: 'olv-report-select', ariaLabel: 'Navigation preset' });"]],
    ['a link with ariaLabel alone',
      ["const a = el('a', { text: 'Guide', href: 'x', ariaLabel: 'User guide' });"]],
    ['a bare createElement("select") with only a deferred aria-label',
      ["const select = document.createElement('select');", "select.setAttribute('aria-label', 'Target classification');"]],
  ];
  it.each(flagged)('flags %s', (_name, lines) => {
    expect(findUnexplainedButtons(lines.join('\n'))).toEqual([1]);
  });

  const accepted: [string, string[]][] = [
    ['a `-link`-styled button once it also carries a tip',
      ["const b = el('button', { className: 'olv-di-story-link', text: 'Overview', tip: 'Open the story.' });"]],
    ['a role="button" div with an inline tip',
      ["const head = el('div', { className: 'olv-panel-head', tip: 'Expand or collapse.' });", "head.setAttribute('role', 'button');"]],
    ['a role="button" div with a deferred title',
      ["const head = el('div', { className: 'olv-panel-head' });", "head.setAttribute('role', 'button');", "head.title = 'Expand or collapse.';"]],
    ['a non-button tag never given role="button"',
      ["const wrap = el('div', { className: 'olv-panel-head' });"]],
    ['document.createElement("button") with a deferred title',
      ["const b = document.createElement('button');", "b.title = 'Close this dialog.';"]],
    ['document.createElement("button") with a deferred dataset.tip',
      ["const b = document.createElement('button');", "b.dataset.tip = 'Close this dialog.';"]],
    ['a select with ariaLabel plus a tip',
      ["const s = el('select', { ariaLabel: 'Navigation preset', tip: 'Choose how dragging orbits.' });"]],
    ['a link with ariaLabel plus a tip',
      ["const a = el('a', { text: 'Guide', ariaLabel: 'User guide', tip: 'Open the guide.' });"]],
    ['a bare createElement("select") with aria-label and a deferred dataset.tip',
      ["const select = document.createElement('select');", "select.setAttribute('aria-label', 'Class');", "select.dataset.tip = 'Target class.';"]],
    ['a select with no ariaLabel (labelled by a wrapping <label>)',
      ["const s = el('select', { className: 'olv-x' });"]],
  ];
  it.each(accepted)('accepts %s', (_name, lines) => {
    expect(findUnexplainedButtons(lines.join('\n'))).toEqual([]);
  });
});
