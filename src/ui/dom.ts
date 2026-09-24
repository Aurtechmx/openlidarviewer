/** Tiny DOM helpers — keeps the UI modules free of repetitive boilerplate. */

// Re-exported so src/render/InspectTool.ts's copy-confirmation announcement
// reaches politeAnnounce.ts through this file's already-existing render->ui
// edge (InspectTool.ts already imports `el` from here) rather than opening a
// second one, which lint:module-graph's shrink-only ratchet would refuse.
export { announcePolite } from './politeAnnounce';

// Side-effect import: installs the single top-level `[data-tip]` glass
// tooltip layer (see tipLayer.ts for why it has to be one shared layer,
// appended to `document.body`, rather than a per-control pseudo-element).
// Every module that builds a `data-tip` control already imports `el` from
// this file, so importing it here — rather than wiring it from main.ts —
// guarantees the layer exists before any control can be hovered/focused.
import './tipLayer';

interface ElProps {
  className?: string;
  text?: string;
  /**
   * RAW HTML / SVG markup, assigned verbatim via `innerHTML`. The
   * deliberately-ugly name makes call sites stand out: using this option
   * asserts "the markup I'm passing is trusted static text, NOT
   * user-derived". Never pass scan names, file
   * names, URL params, message-event payloads, or any other
   * user-influenced string here — those must use `text` (which
   * routes through `textContent` and escapes automatically) or a
   * dedicated escaping helper.
   *
   * The valid uses today are: inline SVG icon strings literally
   * embedded in the source, and chart paths the renderer composed
   * itself from numeric inputs.
   */
  unsafeHtml?: string;
  title?: string;
  /** Short label surfaced by the custom CSS tooltip (`data-tip`). */
  tip?: string;
  href?: string;
  type?: string;
  ariaLabel?: string;
}

let tipIdCounter = 0;

/**
 * Wire a `data-tip` explanation onto a node: the visible glass tooltip
 * (CSS, `[data-tip]::after`) plus a hidden description node the control
 * points to via `aria-describedby`, so assistive tech gets the same text a
 * sighted hovering/keyboard user sees. Icon-only controls (no visible text,
 * no explicit aria-label) also get the tip as their accessible name.
 */
function wireTip(node: HTMLElement, tip: string, hasVisibleLabel: boolean): void {
  node.dataset.tip = tip;
  // The visible label already says exactly this — appending a duplicate
  // hidden description would double the announced (and `textContent`-read)
  // text for no accessibility gain.
  if (hasVisibleLabel && (node.textContent ?? '').trim() === tip.trim()) return;
  const descId = `olv-tip-${++tipIdCounter}`;
  const desc = document.createElement('span');
  desc.id = descId;
  desc.className = 'olv-visually-hidden';
  desc.textContent = tip;
  node.append(desc);
  node.setAttribute('aria-describedby', descId);
  if (!hasVisibleLabel && !node.getAttribute('aria-label')) node.setAttribute('aria-label', tip);
}

/** Create an element with optional props and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.unsafeHtml !== undefined) node.innerHTML = props.unsafeHtml;
  if (props.title) node.title = props.title;
  if (props.ariaLabel) node.setAttribute('aria-label', props.ariaLabel);
  if (props.href && node instanceof HTMLAnchorElement) node.href = props.href;
  // `node.tagName === 'BUTTON'` rather than `instanceof HTMLButtonElement`: the
  // unit-test DOM shim defines HTMLInputElement/HTMLAnchorElement but not
  // HTMLButtonElement, so the instanceof would throw ReferenceError and break
  // every el() caller. tagName works in the shim and in the browser alike.
  if (props.type && (node instanceof HTMLInputElement || node.tagName === 'BUTTON'))
    (node as HTMLInputElement).type = props.type;
  for (const child of children) node.append(child);
  if (props.tip) wireTip(node, props.tip, Boolean(props.text) || children.length > 0);
  return node;
}

export interface IconButtonProps {
  /** The button's CSS class(es). */
  className: string;
  /**
   * Plain-text glyph/label (escaped via `textContent`). Give exactly one of
   * `text` or `unsafeHtml` — never both.
   */
  text?: string;
  /** Trusted raw markup (an inline SVG glyph, optionally with a label span);
   *  same "static text only, never user-derived" rule as `el()`'s own. */
  unsafeHtml?: string;
  /** Native hover tooltip. Optional — a couple of existing icon buttons
   *  (e.g. the group fold toggle) carry only an accessible name, no title. */
  title?: string;
  /** Accessible name — required, unlike `el()`'s optional `ariaLabel`: an
   *  icon-only action button has no text content to fall back to. */
  ariaLabel: string;
  /**
   * Pass a boolean when this button reflects a persistent ON/OFF state (lock,
   * solo, mute) so `aria-pressed` announces it, not just the `.is-active`
   * class. Omit for a one-shot action (remove, rename, fold) that has no
   * pressed state to report.
   */
  ariaPressed?: boolean;
  /** Wired with `addEventListener('click', ...)`. */
  onClick: () => void;
  /** Initially disabled. */
  disabled?: boolean;
}

/**
 * A small icon-action button — glyph (or label text) + title + ariaLabel +
 * `type="button"` + a click handler — the shape Inspector.ts, LayerGroupsPanel
 * and ClassLegendPanel each hand-rolled independently (solo / lock / remove /
 * fold / rename / pick). One constructor keeps that wiring, including
 * `aria-pressed` for the toggle ones, from having to be applied in N places
 * by hand.
 */
export function iconButton(props: IconButtonProps): HTMLButtonElement {
  const btn = el('button', {
    className: props.className,
    type: 'button',
    title: props.title,
    ariaLabel: props.ariaLabel,
    text: props.text,
  });
  // Assigned directly (matching `el()`'s own funnel shape) rather than
  // through `el()`'s `unsafeHtml` prop, so the unsafeHtml static-analysis
  // guard (tests/unsafeHtmlGuard.test.ts) still sees exactly one call-site
  // shape to review per caller, not a second one forwarded through here.
  if (props.unsafeHtml !== undefined) btn.innerHTML = props.unsafeHtml;
  if (props.ariaPressed !== undefined) {
    btn.setAttribute('aria-pressed', String(props.ariaPressed));
  }
  if (props.disabled) btn.disabled = true;
  btn.addEventListener('click', props.onClick);
  return btn;
}

/** Format a point count compactly: 4_200_000 → "4.2M", 1_100 → "1.1K". */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Escape dismisses a `[data-tip]` control explanation: blurs a
 * keyboard-focused control (hides its tooltip) and briefly suppresses hover
 * tooltips via a body class, so a still-hovered pointer doesn't bring the
 * bubble straight back. Installed once, from this module: every UI builder
 * already imports `el()`, so no separate wiring is needed in main.ts.
 */
export function installControlTipDismissal(root: Document): void {
  if (typeof root.addEventListener !== 'function') return; // minimal test DOM shim
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // Duck-typed rather than `instanceof HTMLElement`: the unit-test DOM shim
    // (no jsdom in this repo) has no HTMLElement global, and `dataset` +
    // `blur` are all this needs from the active element.
    const active = root.activeElement as { dataset?: DOMStringMap; blur?: () => void } | null;
    if (active?.dataset?.tip && typeof active.blur === 'function') active.blur();
    root.body?.classList.add('olv-tip-escaped');
    setTimeout(() => root.body?.classList.remove('olv-tip-escaped'), 600);
  });
}

if (
  typeof document !== 'undefined' &&
  typeof document.addEventListener === 'function' &&
  !(document as { __olvTipDismissalInstalled?: boolean }).__olvTipDismissalInstalled
) {
  (document as { __olvTipDismissalInstalled?: boolean }).__olvTipDismissalInstalled = true;
  installControlTipDismissal(document);
}
