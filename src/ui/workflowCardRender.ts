/**
 * workflowCardRender.ts
 *
 * The two new render surfaces for the Analyse panel, factored out as small,
 * self-contained DOM builders so they can be unit-tested through a recording
 * DOM stub (same approach as scanTypeControl):
 *
 *   - {@link renderWorkflowCard} — the "Recommended workflow" checklist: one row
 *     per workflow with a ✓ / ⚠ / ✕ glyph, the label, and an optional short
 *     note. Colour comes from the `--rating-*` tokens via the row status class.
 *   - {@link renderWhyDetails} — a collapsed "Why? — what's holding this back"
 *     <details> with two short lists (Why / How to improve). Returns null when
 *     there is nothing to explain (a fully-good surface), so the caller simply
 *     omits the section.
 *
 * Honesty-first: these only render what the pure engines decided; no claims are
 * minted here.
 */

import type { WorkflowItem } from '../terrain/contour/recommendedWorkflow';
import type { Limitations } from '../terrain/contour/whyNotReasons';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text) node.textContent = opts.text;
  return node;
}

/** Glyph for a workflow status — kept alongside the colour for colourblind safety. */
const GLYPH: Record<WorkflowItem['status'], string> = {
  good: '✓',
  caution: '⚠',
  blocked: '✕',
};

/**
 * Build the "Recommended workflow" card — a quiet, readable checklist. Each row
 * carries its own status class (`is-good` / `is-caution` / `is-blocked`) so the
 * stylesheet can colour the glyph from the rating tokens, plus the label and an
 * optional short note.
 */
export function renderWorkflowCard(items: ReadonlyArray<WorkflowItem>): HTMLElement {
  const card = el('div', { className: 'olv-analyse-workflow' });
  card.append(el('div', { className: 'olv-analyse-workflow-head', text: 'Recommended workflow' }));
  const list = el('div', { className: 'olv-analyse-workflow-list' });
  for (const item of items) {
    const row = el('div', { className: `olv-analyse-workflow-row is-${item.status}` });
    row.append(el('span', { className: 'olv-analyse-workflow-glyph', text: GLYPH[item.status] }));
    const main = el('div', { className: 'olv-analyse-workflow-main' });
    main.append(el('span', { className: 'olv-analyse-workflow-label', text: item.label }));
    if (item.note) {
      main.append(el('span', { className: 'olv-analyse-workflow-note', text: item.note }));
    }
    row.append(main);
    list.append(row);
  }
  card.append(list);
  return card;
}

/**
 * Build the collapsed "Why? — what's holding this back" details. Two short
 * lists: the causes (each with its measured figure) and the matching fixes.
 * Returns null when there are no causes, so the caller renders nothing for a
 * fully-good surface.
 */
export function renderWhyDetails(limitations: Limitations): HTMLElement | null {
  if (limitations.causes.length === 0) return null;
  const details = el('details', { className: 'olv-analyse-why' });
  details.append(
    el('summary', {
      className: 'olv-analyse-why-summary',
      text: "Why? — what's holding this back",
    }),
  );

  const whyHead = el('div', { className: 'olv-analyse-why-subhead', text: 'Why' });
  const whyList = el('ul', { className: 'olv-analyse-why-list' });
  for (const cause of limitations.causes) {
    whyList.append(el('li', { className: 'olv-analyse-why-cause', text: cause.text }));
  }

  const fixHead = el('div', { className: 'olv-analyse-why-subhead', text: 'How to improve' });
  const fixList = el('ul', { className: 'olv-analyse-why-list' });
  for (const fix of limitations.fixes) {
    fixList.append(el('li', { className: 'olv-analyse-why-fix', text: fix.text }));
  }

  details.append(whyHead, whyList, fixHead, fixList);
  return details;
}
