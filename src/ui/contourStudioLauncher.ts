/**
 * contourStudioLauncher.ts
 *
 * The Terrain Products launcher surface for Contour Studio (v0.5.9 spec §3/§5).
 * A small, self-contained DOM builder — same recording-DOM-stub-testable style
 * as workflowCardRender — that renders a launch state produced by the pure
 * `evaluateContourStudioLaunchState` core into a calm, noticed launcher card.
 *
 * It renders ONLY what the pure state decided:
 *   - not-analyzed  → returns null (nothing to show; the panel shows its own
 *                     quiet "available after analysis" hint elsewhere);
 *   - unavailable   → disabled card with the blocking reasons;
 *   - exploratory   → enabled card, exploratory label + reasons + watermark note;
 *   - available     → enabled card, full "Create Contour Deliverable" action.
 *
 * Honesty-first: no claim is minted here. The button's label and enabled state,
 * and every reason line, come straight from the launch state. The caller wires
 * `onLaunch` to open the Contour Studio workspace; this file starts no heavy
 * computation and tracks no file paths.
 */

import type { ContourStudioLaunchState } from '../terrain/contourStudio/contourStudioLaunchState';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text) node.textContent = opts.text;
  return node;
}

/** Options for the launcher. `onLaunch` fires only for enabled states. */
export interface ContourStudioLauncherOptions {
  readonly onLaunch?: () => void;
}

/**
 * Build the launcher card for a launch state, or `null` when the state is not
 * visible (before analysis). The returned element carries a status class
 * (`is-unavailable` / `is-exploratory` / `is-available`) so the stylesheet can
 * theme it, and never relies on colour alone — the title and reasons carry the
 * meaning in text.
 */
export function renderContourStudioLauncher(
  state: ContourStudioLaunchState,
  opts: ContourStudioLauncherOptions = {},
): HTMLElement | null {
  if (state.status === 'not-analyzed' || !state.visible) return null;

  const card = el('div', { className: `olv-terrain-products olv-contour-launcher is-${state.status}` });
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Terrain products');

  card.append(el('div', { className: 'olv-contour-launcher-head', text: 'Terrain Products' }));
  card.append(el('div', { className: 'olv-contour-launcher-title', text: state.title }));
  card.append(el('p', { className: 'olv-contour-launcher-message', text: state.message }));

  // Reasons (present on unavailable + exploratory states).
  if (state.status === 'unavailable' || state.status === 'exploratory') {
    if (state.reasons.length > 0) {
      const list = el('ul', { className: 'olv-contour-launcher-reasons' });
      for (const reason of state.reasons) {
        list.append(el('li', { text: reason }));
      }
      card.append(list);
    }
  }

  const button = el('button', { className: 'olv-contour-launcher-action' });
  button.type = 'button';

  if (state.status === 'unavailable') {
    button.textContent = 'Create Contour Deliverable';
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
  } else {
    // exploratory | available both carry an actionLabel + enabled action.
    button.textContent = state.actionLabel;
    button.disabled = false;
    if (opts.onLaunch) {
      button.addEventListener('click', () => opts.onLaunch?.());
    }
  }
  card.append(button);

  return card;
}
