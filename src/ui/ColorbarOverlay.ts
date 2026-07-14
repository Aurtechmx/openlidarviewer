/**
 * ColorbarOverlay.ts
 *
 * The live on-screen colorbar legend — a small dismissible card near the
 * viewport edge showing the labelled min/max colorbar for the ACTIVE
 * continuous colour mode (elevation / intensity / gpsTime / returnNumber).
 * Hidden for rgb / classification / every categorical mode: a continuous bar
 * on categorical data would fabricate an ordering the renderer never used.
 *
 * DISPLAY ONLY, and deliberately dumb: the host (main.ts) reads the current
 * {@link ActiveColorbar} off the Viewer (`viewer.activeColorbar()` — the same
 * spec-builder the snapshot burn-in consumes, so the two can never disagree)
 * and pushes it through `update()` on every colour-context change. The
 * overlay renders three things:
 *
 *   - the generator's SVG (`buildColorbarSvg` — the SAME ramp the points use);
 *   - an explicit "min – max unit" range line (the requirement is that the
 *     legend SHOWS min/max; nice ticks round the ends, so the exact window
 *     endpoints get their own line);
 *   - the honesty note (percentile-trim window / gpsTime normalisation).
 *
 * Update is keyed: an identical spec is a no-op, because the streaming path
 * refreshes on every node-ready event and the overlay must be free under a
 * no-change poll. Dismissal (the × button) sticks for the current mode —
 * a streaming range refinement must not resurrect a legend the user closed —
 * but selecting a different continuous mode re-arms it.
 *
 * Ships in its own lazy chunk (`loadColorbarOverlay` in lazyChunks.ts): the
 * eager shell only carries the sub-KB host trigger, per the bundle-budget
 * contract.
 */

import { el } from './dom';
import { buildColorbarSvg, formatColorbarValue } from '../render/colorbar';
import type { ActiveColorbar } from '../render/activeColorbar';

export class ColorbarOverlay {
  /** The overlay card — append to `stage.overlay`. Hidden until a spec arrives. */
  readonly element: HTMLElement;

  private readonly _svgHost: HTMLElement;
  private readonly _range: HTMLElement;
  private readonly _note: HTMLElement;

  /** Render key of the last spec drawn — identical specs skip the re-render. */
  private _lastKey: string | null = null;
  /** The mode whose legend the user dismissed, or null when armed. */
  private _dismissedMode: string | null = null;
  /** The mode currently on display (dismissal bookkeeping). */
  private _mode: string | null = null;

  constructor() {
    this._svgHost = el('div', { className: 'olv-colorbar-svg' });
    this._range = el('div', { className: 'olv-colorbar-range' });
    this._note = el('div', { className: 'olv-colorbar-note olv-hidden' });
    const close = el('button', {
      className: 'olv-colorbar-close',
      ariaLabel: 'Hide colour legend',
      title: 'Hide legend',
      text: '×',
    });
    close.addEventListener('click', () => {
      // Dismissal is scoped to the CURRENT mode: the user said "hide this
      // legend", so later range refinements of the same mode stay hidden,
      // while picking a different continuous mode is a new decision and
      // shows its legend again.
      this._dismissedMode = this._mode;
      this._setVisible(false);
    });
    this.element = el('div', { className: 'olv-colorbar olv-hidden' }, [
      el('div', { className: 'olv-colorbar-head' }, [this._range, close]),
      this._svgHost,
      this._note,
    ]);
  }

  /**
   * Show / refresh the legend for `active`, or hide it when `null` (the
   * active mode carries no continuous colorbar). Cheap when nothing changed.
   */
  update(active: ActiveColorbar | null): void {
    if (!active) {
      this._mode = null;
      this._lastKey = null;
      // Leaving the continuous mode ends the dismissal's scope: the user
      // dismissed THIS legend for THIS selection. Coming back to the same
      // mode later (even via an rgb/classification detour) is a fresh
      // selection and shows the legend again — verified against the live
      // app, where Height → Density → Height must resurface the legend.
      this._dismissedMode = null;
      this._setVisible(false);
      return;
    }
    // A new continuous mode re-arms a dismissal left behind by another mode.
    if (this._dismissedMode !== null && this._dismissedMode !== active.mode) {
      this._dismissedMode = null;
    }
    this._mode = active.mode;
    if (this._dismissedMode === active.mode) {
      this._setVisible(false);
      return;
    }
    const s = active.spec;
    const key = [active.mode, s.palette, s.min, s.max, s.unit ?? '', active.note ?? ''].join('|');
    if (key === this._lastKey) {
      this._setVisible(true);
      return;
    }
    this._lastKey = key;

    // The SVG string comes from the pure generator, which XML-escapes every
    // text value; nothing user-derived flows in (labels / units / notes are
    // all app-chosen constants). Routed through el()'s `unsafeHtml` funnel —
    // the one audited innerHTML sink — rather than a raw assignment, per the
    // unsafeHtmlGuard contract.
    this._svgHost.replaceChildren(el('div', { unsafeHtml: buildColorbarSvg(s) }));
    // The explicit endpoint line — nice ticks round the ends, so the exact
    // ramp window gets stated verbatim, with the unit only when known.
    const unitSuffix = s.unit ? ` ${s.unit}` : '';
    this._range.textContent =
      `${formatColorbarValue(s.min)} – ${formatColorbarValue(s.max)}${unitSuffix}`;
    this._note.textContent = active.note ?? '';
    this._note.classList.toggle('olv-hidden', !active.note);
    this._setVisible(true);
  }

  private _setVisible(visible: boolean): void {
    this.element.classList.toggle('olv-hidden', !visible);
  }
}
