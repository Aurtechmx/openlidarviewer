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
import type { TerrainProduct } from '../terrain/contour/terrainProducts';
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
 * Build the "Terrain Products" status list (v0.4.5) — the compact per-product
 * re-presentation of the workflow grades the panel leads with. Real list
 * semantics (<ul>/<li>) so assistive tech announces "list, 6 items", and the
 * verdict travels as TEXT (the status word) beside the decorative glyph —
 * never colour-only. Each row is TWO lines: the product + glyph + status word,
 * then — only when the product sits below Ready — a smaller "Reason:" line
 * carrying the engine-selected reason IN FULL (wrapping, never ellipsized).
 * The reason lives inside the same <li> as the verdict, so a screen reader
 * hears product, status and reason as one list item. The pure mapper
 * (`terrainProducts`) supplies every string; this builder only lays them out.
 */
export function renderTerrainProducts(
  products: ReadonlyArray<TerrainProduct>,
  sharedReason?: string,
): HTMLElement {
  const card = el('div', { className: 'olv-analyse-products' });
  card.append(el('div', { className: 'olv-analyse-products-head', text: 'Terrain products' }));
  const list = el('ul', { className: 'olv-analyse-products-list' });
  for (const p of products) {
    const row = el('li', { className: `olv-analyse-product is-${p.status}` });
    const glyph = el('span', { className: 'olv-analyse-product-glyph', text: p.glyph });
    glyph.setAttribute('aria-hidden', 'true'); // decorative — the word carries it
    const head = el('div', { className: 'olv-analyse-product-head' });
    head.append(
      glyph,
      el('span', { className: 'olv-analyse-product-label', text: p.label }),
      el('span', { className: 'olv-analyse-product-status', text: p.statusWord }),
    );
    row.append(head);
    // De-dup: when a product is held back by the SAME surface reason already
    // shown once on the verdict above, repeating it on every row is noise — the
    // common case where one weak surface caps all six products. Show the per-row
    // reason only when it ADDS information (differs from the verdict reason), and
    // even then collapse it behind a toggle so the list stays scannable.
    if (p.reason && p.reason !== sharedReason) {
      const details = el('details', { className: 'olv-analyse-product-reason' });
      details.append(
        el('summary', { className: 'olv-analyse-product-reason-label', text: 'Reason' }),
        el('div', { className: 'olv-analyse-product-reason-text', text: p.reason }),
      );
      row.append(details);
    }
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
