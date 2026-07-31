/**
 * ContextViewPanel.ts
 *
 * The Context View panel shell: a consent-gated 2D world-context surface,
 * built in the same small-DOM-builder style as contourStudioLauncher. It
 * renders ONLY what the pure state decided:
 *
 *   - ineligible → a card listing the refusal reasons (from the pure
 *     eligibility core), no consent UI, no canvas;
 *   - eligible + consent 'unasked' → the consent gate FIRST (prompt + real
 *     grant/deny buttons), with the OFFLINE footprint canvas below it — the
 *     offline view works without consent;
 *   - 'denied' → the offline canvas plus one quiet line; no re-prompt, only a
 *     small change affordance;
 *   - 'granted' → the offline canvas plus the provider attribution line and a
 *     staged-tiles status note.
 *
 * PRIVACY / NETWORK INVARIANT — this build performs NO tile fetch anywhere.
 * Remote tiles are STAGED only: this module contains zero fetch / Image /
 * XMLHttpRequest / network calls, and no element it builds carries a `src` or
 * `href`. Granting consent records intent; nothing downloads until a later
 * build wires a tile layer behind `networkPermitted()`.
 *
 * Every user-facing status string comes from {@link CONTEXT_STATUS} — nothing
 * is minted here.
 */

import {
  CONTEXT_STATUS,
  OSM_PROVIDER,
  type ContextConsent,
  type ContextFootprint,
} from '../../geo/context/index';
import { drawFootprints, type ContextCameraMarker } from './footprintCanvas';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text) node.textContent = opts.text;
  return node;
}

/** The pure facts the panel renders. All decided elsewhere; nothing re-derived here. */
export interface ContextViewPanelState {
  readonly consent: ContextConsent;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly footprints: readonly ContextFootprint[];
  /**
   * No layer is loaded at all. Distinct from a refusal: there is no scan to
   * refuse, so the panel says only that, and never a word about CRS, datum, or
   * a transform probe it never ran. Absent/false means the normal states apply.
   */
  readonly empty?: boolean;
}

/** Callbacks + optional camera marker. Grant/deny fire only from real button clicks. */
export interface ContextViewPanelOptions {
  readonly onGrant?: () => void;
  readonly onDeny?: () => void;
  readonly camera?: ContextCameraMarker;
}

/** Pixel size of the offline footprint canvas. */
const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 260;

/** Build the labelled offline footprint canvas section (all eligible states). */
function buildOfflineSection(
  state: ContextViewPanelState,
  opts: ContextViewPanelOptions,
): HTMLElement {
  const section = el('div', { className: 'olv-context-offline' });
  section.append(
    el('div', {
      className: 'olv-context-offline-label',
      text: CONTEXT_STATUS.offlineMode,
    }),
  );

  const canvas = el('canvas', { className: 'olv-context-canvas' });
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  canvas.setAttribute('role', 'img');
  const n = state.footprints.length;
  canvas.setAttribute(
    'aria-label',
    `Offline context map: ${n} scan footprint${n === 1 ? '' : 's'}`,
  );
  drawFootprints(canvas, state.footprints, opts.camera);
  section.append(canvas);

  return section;
}

/**
 * Build the Context View panel for a pure state. The returned element carries
 * a status class (`is-ineligible` / `is-unasked` / `is-denied` / `is-granted`)
 * for the stylesheet; the text always carries the meaning on its own.
 */
export function renderContextViewPanel(
  state: ContextViewPanelState,
  opts: ContextViewPanelOptions = {},
): HTMLElement {
  const status = state.empty === true ? 'empty' : state.eligible ? state.consent : 'ineligible';
  const panel = el('div', { className: `olv-context-panel is-${status}` });
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'World context');

  panel.append(el('div', { className: 'olv-context-head', text: 'World context' }));

  // (a0) Nothing loaded: say so and stop. No refusal card, because there is no
  // scan to refuse, and no claim about a CRS or a transform that was never
  // examined.
  if (state.empty === true) {
    panel.append(
      el('p', {
        className: 'olv-context-empty',
        text: 'No scan is loaded, so there is nothing to place on a world map.',
      }),
    );
    return panel;
  }

  // (a) Ineligible: the refusal reasons, nothing else — no consent UI, no canvas.
  if (!state.eligible) {
    const card = el('div', { className: 'olv-context-refusal' });
    card.append(
      el('p', {
        className: 'olv-context-refusal-title',
        text: 'This scan cannot be shown on a world map.',
      }),
    );
    const list = el('ul', { className: 'olv-context-reasons' });
    for (const reason of state.reasons) {
      list.append(el('li', { text: reason }));
    }
    card.append(list);
    panel.append(card);
    return panel;
  }

  // (b) Eligible + unasked: consent gate FIRST, offline canvas below it.
  if (state.consent === 'unasked') {
    const gate = el('div', { className: 'olv-context-consent' });
    gate.append(
      el('p', {
        className: 'olv-context-consent-prompt',
        text: CONTEXT_STATUS.consentUnasked,
      }),
    );

    const grant = el('button', {
      className: 'olv-context-grant',
      text: 'Allow map tiles',
    });
    grant.type = 'button';
    if (opts.onGrant) grant.addEventListener('click', () => opts.onGrant?.());
    gate.append(grant);

    const deny = el('button', {
      className: 'olv-context-deny',
      text: 'No map tiles',
    });
    deny.type = 'button';
    if (opts.onDeny) deny.addEventListener('click', () => opts.onDeny?.());
    gate.append(deny);

    panel.append(gate);
  }

  // (c) Denied: one quiet line, no nagging re-prompt — a single small change
  // affordance that grants (honestly labelled), nothing more.
  if (state.consent === 'denied') {
    panel.append(
      el('p', { className: 'olv-context-denied', text: CONTEXT_STATUS.consentDenied }),
    );
    const change = el('button', {
      className: 'olv-context-change',
      text: 'Allow map tiles',
    });
    change.type = 'button';
    if (opts.onGrant) change.addEventListener('click', () => opts.onGrant?.());
    panel.append(change);
  }

  // (d) Granted: visible attribution + the staged-tiles note. NO tile fetch
  // happens in this build — see the module header invariant.
  if (state.consent === 'granted') {
    panel.append(
      el('p', {
        className: 'olv-context-attribution',
        text: OSM_PROVIDER.attribution,
      }),
    );
    panel.append(
      el('p', {
        className: 'olv-context-staged',
        text: 'Remote map tiles are staged for a later build; no tile has been requested.',
      }),
    );
  }

  // The offline footprint view renders in every eligible state, consent or not.
  panel.append(buildOfflineSection(state, opts));

  return panel;
}
