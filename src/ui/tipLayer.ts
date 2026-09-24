/**
 * tipLayer.ts — the single top-level `[data-tip]` glass tooltip layer.
 *
 * `el({ tip })` (src/ui/dom.ts) still wires `data-tip` plus an
 * `aria-describedby` text node onto the control itself — that accessible
 * description is unchanged. What moved is the VISIBLE tip: instead of a
 * `[data-tip]::after` pseudo-element painted inside the control's own
 * (possibly low) stacking context, one shared element is appended to
 * `document.body` and positioned from the hovered/focused control's
 * `getBoundingClientRect()` (see tipPositioning.ts for the placement math).
 * `document.body`'s stacking context is the root one, so this layer always
 * paints above every panel — no z-index tuning can substitute for that,
 * because z-index only resolves ties *within* a stacking context.
 *
 * Shown on real pointer hover (`pointerType === 'mouse'`; `(hover: none)`
 * devices never call `showTip` from a pointer event, matching the old
 * `@media (hover: none)` suppression) and on `:focus-visible` (keyboard
 * focus, not a mouse-driven focus). Hidden on Escape, `pointerleave` /
 * `pointerout` off the anchor, `focusout` off the anchor, `scroll`, and
 * `resize` — a stale position after any of those is worse than no tip.
 */

import { computeTipPosition, type TipPosition } from './tipPositioning';

let layerEl: HTMLElement | null = null;
// Tracked alongside `layerEl` rather than read back via `layerEl.ownerDocument`
// — the minimal test DOM shim's elements carry no such property, and this is
// simpler than teaching the shim one just for this comparison.
let layerDoc: Document | null = null;
let activeAnchor: HTMLElement | null = null;

function ensureLayer(doc: Document): HTMLElement {
  if (layerEl && layerDoc === doc) return layerEl;
  const el = doc.createElement('div');
  el.className = 'olv-tip-layer';
  // Purely visual: the control's own `aria-describedby` text node (wired in
  // `el()`) is what assistive tech reads, so this layer is redundant to
  // announce and is hidden from the accessibility tree.
  el.setAttribute('aria-hidden', 'true');
  doc.body.appendChild(el);
  layerEl = el;
  layerDoc = doc;
  return el;
}

function applyPosition(el: HTMLElement, pos: TipPosition): void {
  el.style.top = `${pos.top}px`;
  el.style.left = `${pos.left}px`;
  el.dataset.placement = pos.placement;
  el.style.setProperty('--olv-tip-connector-x', `${pos.connectorX}px`);
}

function reposition(doc: Document): void {
  if (!layerEl || !activeAnchor) return;
  const view = doc.defaultView;
  if (!view) return;
  const anchorRect = activeAnchor.getBoundingClientRect();
  const tipRect = layerEl.getBoundingClientRect();
  const pos = computeTipPosition(
    anchorRect,
    { width: tipRect.width, height: tipRect.height },
    { width: view.innerWidth, height: view.innerHeight },
  );
  applyPosition(layerEl, pos);
}

function showTip(doc: Document, anchor: HTMLElement): void {
  const text = anchor.dataset.tip;
  if (!text) return;
  const layer = ensureLayer(doc);
  layer.textContent = text;
  layer.classList.add('olv-tip-layer--visible');
  activeAnchor = anchor;
  reposition(doc);
}

/** Hide the layer. Exported so Escape-dismiss and other callers can force it
 * shut without reaching into module state. */
export function hideTip(): void {
  if (!layerEl) return;
  layerEl.classList.remove('olv-tip-layer--visible');
  activeAnchor = null;
}

function closestTipAnchor(doc: Document, target: EventTarget | null): HTMLElement | null {
  const view = doc.defaultView;
  if (!view || !(target instanceof view.HTMLElement)) return null;
  return target.closest('[data-tip]');
}

function prefersNoHover(doc: Document): boolean {
  const view = doc.defaultView;
  return Boolean(view?.matchMedia?.('(hover: none)').matches);
}

/**
 * Wire the delegated listeners that drive the single tip layer. Idempotent
 * per document via the caller's own installed-once guard (see the bottom of
 * this file for the production instance).
 */
export function installTipLayer(doc: Document): void {
  if (typeof doc.addEventListener !== 'function') return; // minimal test DOM shim
  const view = doc.defaultView;

  doc.addEventListener('pointerover', (event) => {
    const pe = event as PointerEvent;
    if (pe.pointerType && pe.pointerType !== 'mouse') return; // touch: no hover tip
    if (prefersNoHover(doc)) return;
    const anchor = closestTipAnchor(doc, event.target);
    if (anchor) showTip(doc, anchor);
  });

  doc.addEventListener('pointerout', (event) => {
    if (!activeAnchor) return;
    const pe = event as PointerEvent;
    // Duck-typed (`.contains`) rather than `instanceof Node`: the unit-test
    // DOM shim (no jsdom in this repo) has no global `Node`.
    const target = pe.target as (Node & { contains?: (n: Node) => boolean }) | null;
    if (!target) return;
    const leavingAnchor = activeAnchor === target || activeAnchor.contains(target);
    if (!leavingAnchor) return;
    const to = pe.relatedTarget as Node | null;
    if (to && activeAnchor.contains(to)) return; // moved to a child, still inside
    hideTip();
  });

  // Keyboard focus only: a mouse-driven focus is covered by pointerover
  // already, and re-showing on it would just repeat the position work.
  doc.addEventListener('focusin', (event) => {
    const anchor = closestTipAnchor(doc, event.target);
    if (!anchor) return;
    const focusVisible =
      typeof anchor.matches === 'function' ? anchor.matches(':focus-visible') : true;
    if (focusVisible) showTip(doc, anchor);
  });

  doc.addEventListener('focusout', (event) => {
    if (activeAnchor && event.target === activeAnchor) hideTip();
  });

  doc.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') hideTip();
  });

  view?.addEventListener('scroll', () => hideTip(), true);
  view?.addEventListener('resize', () => hideTip());
}

if (
  typeof document !== 'undefined' &&
  typeof document.addEventListener === 'function' &&
  !(document as { __olvTipLayerInstalled?: boolean }).__olvTipLayerInstalled
) {
  (document as { __olvTipLayerInstalled?: boolean }).__olvTipLayerInstalled = true;
  installTipLayer(document);
}
