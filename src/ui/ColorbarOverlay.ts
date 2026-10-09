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
 *   - a full-width ramp (`buildLegendRampSvg`, the SAME palette the points
 *     use) with, for elevation, a distribution strip of the sample the
 *     window was taken from and the share of it clipped below / above;
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
import { formatColorbarValue } from '../render/colorbar';
import type { ActiveColorbar } from '../render/activeColorbar';
import {
  buildElevationHistogram,
  clipShares,
  describeHistogram,
  formatShare,
  ordinal,
  percentileOf,
  type ElevationHistogram,
} from '../render/elevationHistogram';
import type { PointInfo } from '../render/pointInfo';
import { buildLegendRampSvg } from './legendRampSvg';
import { MOBILE_LAYOUT_QUERY } from './isMobileDevice';

export class ColorbarOverlay {
  /** The overlay card — append to `stage.overlay`. Hidden until a spec arrives. */
  readonly element: HTMLElement;

  private readonly _svgHost: HTMLElement;
  private readonly _range: HTMLElement;
  private readonly _note: HTMLElement;
  private readonly _caps: HTMLElement;
  private readonly _below: HTMLElement;
  private readonly _above: HTMLElement;
  private readonly _readout: HTMLElement;
  private readonly _marker: HTMLElement;

  /** Distribution of the current elevation sample, or null. */
  private _hist: ElevationHistogram | null = null;
  /** The cloud the histogram was built from (identity check). */
  private _histSample: unknown = null;
  /** Latest probe hover, drawn on the next animation frame. */
  private _hover: PointInfo | null = null;
  private _hoverFrame = 0;
  /** Up axis of the histogram's cloud: 2 = Z, 1 = Y. */
  private _axis: 1 | 2 = 2;

  /** Render key of the last spec drawn — identical specs skip the re-render. */
  private _lastKey: string | null = null;
  /** The mode whose legend the user dismissed, or null when armed. */
  private _dismissedMode: string | null = null;
  /** The last spec drawn, to redraw when the layout switches orientation. */
  private _last: ActiveColorbar | null = null;
  /** The mode currently on display (dismissal bookkeeping). */
  private _mode: string | null = null;

  constructor() {
    this._svgHost = el('div', { className: 'olv-colorbar-svg' });
    this._range = el('div', { className: 'olv-colorbar-range' });
    this._note = el('div', { className: 'olv-colorbar-note olv-hidden' });
    this._below = el('span', { className: 'olv-colorbar-cap' });
    this._above = el('span', { className: 'olv-colorbar-cap' });
    this._readout = el('span', { className: 'olv-colorbar-readout' });
    this._caps = el('div', { className: 'olv-colorbar-caps olv-hidden' }, [this._below, this._above]);
    this._marker = el('div', { className: 'olv-colorbar-marker olv-hidden' });
    if (typeof addEventListener === 'function') {
      addEventListener('olv:probe-hover', (e) => {
        this._hover = (e as CustomEvent<PointInfo | null>).detail;
        if (!this._hoverFrame) this._hoverFrame = requestAnimationFrame(() => this._drawHover());
      });
    }
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
    // On a phone the legend opens as its one-line head so it does not cover
    // the scan; this button shows the ramp. Hidden by CSS on wider layouts.
    const toggle = el('button', { className: 'olv-colorbar-toggle', ariaLabel: 'Show colour legend', title: 'Show legend', text: '▾' });
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => this._setCollapsed(!this.element.classList.contains('olv-colorbar-collapsed')));
    this._toggle = toggle;
    this.element = el('div', { className: 'olv-colorbar olv-hidden olv-colorbar-collapsed' }, [
      el('div', { className: 'olv-colorbar-head' }, [this._range, toggle, close]),
      el('div', { className: 'olv-colorbar-plot' }, [this._svgHost, this._marker, this._readout]),
      this._caps,
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
      this._last = null;
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
    this._last = active;
    if (key === this._lastKey && (active.cloud?.[0] ?? null) === this._histSample) {
      this._setVisible(true);
      return;
    }
    this._lastKey = key;

    // The histogram is rebuilt only here: when the window or the cloud
    // changed, never per frame or per hover.
    const [cloud, axis = 2] = active.cloud ?? [];
    this._histSample = cloud ?? null;
    this._axis = axis;
    // World heights on the window pass's own up axis (colorLegend.ts).
    const xyz: [number, number, number] = [0, 0, 0];
    this._hist = cloud
      ? buildElevationHistogram({ count: cloud.pointCount, value: (i) => cloud.worldXYZ(i, xyz)[axis] }, s.min, s.max)
      : null;
    this._renderRamp(s);
    // The explicit endpoint line — nice ticks round the ends, so the exact
    // ramp window gets stated verbatim, with the unit only when known.
    const unitSuffix = s.unit ? ` ${s.unit}` : '';
    this._range.textContent =
      `${formatColorbarValue(s.min)} – ${formatColorbarValue(s.max)}${unitSuffix}`;
    this._note.textContent = active.note ?? '';
    this._note.classList.toggle('olv-hidden', !active.note);
    this._setVisible(true);
  }

  /**
   * Draw the ramp, the strip (when a histogram is ready) and the clip caps.
   * The SVG string comes from a pure generator that XML-escapes every text
   * value; nothing user-derived flows in (labels, units and the summary are
   * app-chosen constants and formatted numbers). Routed through el()'s
   * `unsafeHtml` funnel, the one audited innerHTML sink, per the
   * unsafeHtmlGuard contract.
   */
  private _renderRamp(s: ActiveColorbar['spec']): void {
    const h = this._hist;
    const summary = h ? describeHistogram(h, formatColorbarValue, s.unit ?? 'source units') : '';
    this._svgHost.replaceChildren(el('div', { unsafeHtml: buildLegendRampSvg(s, h, summary) }));
    if (h) {
      const c = clipShares(h);
      this._below.textContent = `◂ ${formatShare(c.below)} below`;
      this._above.textContent = `${formatShare(c.above)} above ▸`;
    }
    this._caps.classList.toggle('olv-hidden', !h);
    this._drawHover();
  }

  /** Place the hover marker for the latest probe pick, or clear it. */
  private _drawHover(): void {
    this._hoverFrame = 0;
    const h = this._hist;
    const info = this._hover;
    const s = this._last?.spec;
    if (!h || !info || !s) {
      this._marker.classList.add('olv-hidden');
      this._readout.textContent = '';
      return;
    }
    // The hover carries world x/y/z; the legend's height is the sample's up axis.
    const v = this._axis === 1 ? info.y : info.z;
    const t = Math.min(1, Math.max(0, (v - s.min) / (s.max - s.min)));
    this._marker.style.left = `${(t * 100).toFixed(2)}%`;
    this._marker.classList.remove('olv-hidden');
    this._readout.textContent =
      `${formatColorbarValue(v)} ${s.unit ?? 'source units'} · ${ordinal(Math.round(percentileOf(h, v)))} pct`;
  }

  private readonly _toggle: HTMLButtonElement;

  /** Collapse the legend to its head row (phone only; CSS ignores it elsewhere). */
  private _setCollapsed(collapsed: boolean): void {
    this.element.classList.toggle('olv-colorbar-collapsed', collapsed);
    this._toggle.setAttribute('aria-expanded', String(!collapsed));
    this._toggle.textContent = collapsed ? '▾' : '▴';
    this._toggle.setAttribute('aria-label', collapsed ? 'Show colour legend' : 'Collapse colour legend');
    this._toggle.title = collapsed ? 'Show legend' : 'Collapse legend';
  }

  private _setVisible(visible: boolean): void {
    this.element.classList.toggle('olv-hidden', !visible);
    if (visible) this._place();
  }

  /** Where the overlay was mounted, so it can go back there. */
  private _home: HTMLElement | null = null;
  /** The rail whose collapse state is being watched, once found. */
  private _watched: HTMLElement | null = null;

  private _isPhone(): boolean {
    return typeof matchMedia === 'function' && matchMedia(MOBILE_LAYOUT_QUERY).matches;
  }

  /**
   * Wherever the workspace rails show (desktop and large-touch), the legend
   * docks at the top of the right rail beside the colour controls it
   * explains, as a compact horizontal bar. Floating mid-stage it landed on,
   * or showed through, the navigation card at common sizes. When that rail is
   * collapsed the legend floats instead (`olv-colorbar-floating`, top-right
   * of the stage, clear of the controls) so a colour-coded view always shows
   * its key, and docks again when the rail reopens. The phone layout keeps
   * the vertical floating card.
   */
  private _place(): void {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
    const rail = document.querySelector<HTMLElement>('.olv-right-rail');
    if (rail && rail !== this._watched && typeof MutationObserver !== 'undefined') {
      this._watched = rail;
      new MutationObserver(() => this._place()).observe(rail, { attributes: true, attributeFilter: ['class'] });
      if (typeof matchMedia === 'function') {
        matchMedia(MOBILE_LAYOUT_QUERY).addEventListener?.('change', () => {
          const last = this._last;
          this._lastKey = null;
          if (last) this.update(last);
        });
      }
    }
    const phone = this._isPhone();
    const parent = this.element.parentElement;
    const dock = Boolean(rail && !phone && !rail.classList.contains('olv-right-collapsed'));
    if (dock && rail) {
      if (parent !== rail) {
        if (parent) this._home = parent;
        rail.prepend(this.element);
      }
    } else if (this._home && parent !== this._home) {
      this._home.append(this.element);
    }
    this.element.classList.toggle('olv-colorbar-docked', dock);
    this.element.classList.toggle('olv-colorbar-floating', !dock && !phone);
  }
}
