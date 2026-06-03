/**
 * MeasurePanel.ts
 *
 * The Measurements panel — a compact list of every placed measurement plus a
 * footer to export / import a measurement session (measurements and saved
 * camera views together, as one JSON file). A dumb view: the controller
 * computes the summaries; the panel renders them and reports intents back.
 */

import { el } from './dom';
import type { MeasurementSummary } from '../render/measure/MeasureController';
import {
  DIMENSION_LABEL,
  OPERATION_LABEL,
  formatChainResult,
  type ChainDimension,
  type ChainOperation,
  type ChainResult,
} from '../render/measure/measurementChains';

/**
 * v0.3.10 (issue #402 — the profile chart used to be 36 px tall,
 * which was too small to read slope, pick out features, or treat as a
 * deliverable. The CSS now defaults to ~140 px and lets the user drag
 * the south-east handle (CSS `resize: vertical`). We persist the
 * chosen height under this key so the panel doesn't snap back on every
 * re-render. One key shared across all profile rows — users want
 * consistent reading height, not per-profile memory.
 */
const PROFILE_CHART_HEIGHT_KEY = 'olv:measure:profile:chartHeightPx:v1';

/**
 * Lower bound on the user-resizable profile chart height, in CSS
 * pixels. Exported so the matching unit test (and any future code
 * path that needs to clamp a stored height) can read from the same
 * source of truth as the JS clamp below. Mirrored in `style.css`
 * (`.olv-mp-chart { min-height: 80px; }`); the
 * `profileChartHeightBounds.test.ts` spec pins the two against drift.
 * v0.3.10 honesty-patch code-review #4.
 */
export const PROFILE_CHART_MIN_HEIGHT_PX = 80;
/** Upper bound on the resizable profile chart height. See
 * `PROFILE_CHART_MIN_HEIGHT_PX` for the source-of-truth rationale. */
export const PROFILE_CHART_MAX_HEIGHT_PX = 360;

/**
 * v0.3.10 Profile-as-Deliverable — the profile chart now exposes a
 * vertical-exaggeration (VEX) picker so an analyst can read slope
 * discontinuities that a 1:1 chart would hide. Four canonical values
 * are surfaced: 1:1 (true scale), 2:1, 5:1, 10:1. Persisted globally
 * across all profile rows under the same key so the panel doesn't
 * snap back between renders. One key, all profiles — civil/survey
 * users want consistent reading scale, not per-profile memory.
 */
export const PROFILE_VEX_OPTIONS = [1, 2, 5, 10] as const;
const PROFILE_VEX_KEY = 'olv:measure:profile:vex:v1';

/**
 * Pick the largest "nice" station interval that produces no more
 * than ~10 stations across the given chainage. Civil convention
 * prefers multiples of 1/2/5/10/20/25/50/100/200/500 metres.
 * v0.3.10 Profile-as-Deliverable stream — used by the chart renderer
 * to draw station tick marks at a survey-shaped spacing instead of
 * picking arbitrary 8/10 divisions of the X axis.
 */
export function autoStationInterval(totalChainageM: number): number {
  if (!Number.isFinite(totalChainageM) || totalChainageM <= 0) return 1;
  const ladder = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000];
  for (const v of ladder) {
    if (totalChainageM / v <= 10) return v;
  }
  // Very long sections — keep scaling decade by decade.
  let v = 10_000;
  while (totalChainageM / v > 10) v *= 2;
  return v;
}

/** Hooks the panel calls back into. */
export interface MeasurePanelCallbacks {
  /** Delete the measurement with this id. */
  onDelete: (id: string) => void;
  /** Rename the measurement with this id. */
  onRename: (id: string, name: string) => void;
  /** Export the current session to a JSON file. */
  onExport: () => void;
  /** Import a session from a picked JSON file. */
  onImport: (file: File) => void;
  /**
   * Aggregate the given measurement ids by dimension + operation. The
   * controller owns the measurement data and the unit system; the
   * panel is the dumb view that asks for the result.
   *
   * Returns `null` when no scan / measurements are loaded.
   */
  onChainAggregate?: (
    ids: ReadonlyArray<string>,
    dimension: ChainDimension,
    operation: ChainOperation,
  ) => ChainResult | null;
  /**
   * Current unit system — the panel needs it for the profile chart's
   * axis labels (metric → m / km, imperial → ft / mi). Returns
   * `'metric'` when no controller is wired (defensive default).
   * v0.3.10 Profile-as-Deliverable stream.
   */
  getUnitSystem?: () => 'metric' | 'imperial';
}

export class MeasurePanel {
  /** The panel element — append to the stage overlay. */
  readonly element: HTMLElement;
  private readonly _cb: MeasurePanelCallbacks;
  private readonly _list: HTMLElement;
  /** Chain mode state — owned by the panel. */
  private _chainOn = false;
  /** Set of measurement ids checked in chain mode. */
  private readonly _chainSelection = new Set<string>();
  /** Active chain operation. Defaults to 'sum'. */
  private _chainOp: ChainOperation = 'sum';
  /** Active chain dimension. Defaults to 'length'. */
  private _chainDim: ChainDimension = 'length';
  /** Chain UI surfaces, populated in the constructor. */
  private readonly _chainBar: HTMLElement;
  private readonly _chainResult: HTMLElement;
  /** Most recently rendered summaries — used by the chain redraw path. */
  private _summaries: MeasurementSummary[] = [];
  /**
   * Active `ResizeObserver` instances created for the profile-chart
   * persistence path. Each `_renderList()` call detaches and replaces
   * the existing chart DOM nodes; without an explicit teardown, the
   * observers they were attached to would leak (they still hold a
   * closure over the now-detached chart and over the localStorage
   * write callback). Tracking them here lets the next render
   * `disconnect()` every one before rebuilding the list.
   * v0.3.10 honesty-patch code-review #1.
   */
  private _chartObservers: ResizeObserver[] = [];

  constructor(callbacks: MeasurePanelCallbacks) {
    this._cb = callbacks;
    this._list = el('div', { className: 'olv-mp-list' });
    this._chainBar = this._buildChainBar();
    this._chainResult = this._chainBar.querySelector('.olv-mp-chain-result') as HTMLElement;

    // Export / import a measurement session.
    const fileInput = el('input', { className: 'olv-file-input', type: 'file' });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) this._cb.onImport(file);
      fileInput.value = ''; // let the same file be re-picked
    });
    const exportBtn = el('button', {
      className: 'olv-mp-action',
      text: 'Export',
      // v0.3.10 — the .olvsession file is useful
      // standalone (it carries measurement coordinates, annotation text,
      // and named views the recipient can read as plain JSON in any text
      // editor or import into another tool). It is NOT a replay artefact
      // like .olvworkflow — the recipient does not need the same scan to
      // extract value. The tooltip below sets that expectation so users
      // don't conflate the two export paths.
      title:
        'Save measurements, annotations, named views, and render settings ' +
        'as a JSON file — readable standalone; re-import re-applies the views.',
    });
    exportBtn.addEventListener('click', () => {
      exportBtn.blur();
      this._cb.onExport();
    });
    const importBtn = el('button', {
      className: 'olv-mp-action',
      text: 'Import',
      title: 'Load measurements and saved views from a JSON session file',
    });
    importBtn.addEventListener('click', () => {
      importBtn.blur();
      fileInput.click();
    });

    // v0.3.9 — Chain toggle. Surfaces a per-row checkbox + a header bar
    // with operation/dimension chip rails and a live aggregate result.
    const chainBtn = el('button', {
      className: 'olv-mp-action',
      text: 'Chain',
      title:
        'Aggregate selected measurements — sum / average / min / max across length, area, volume, height, grade, or angle.',
    });
    chainBtn.addEventListener('click', () => {
      chainBtn.blur();
      this._chainOn = !this._chainOn;
      chainBtn.classList.toggle('olv-mp-action-active', this._chainOn);
      this._chainBar.classList.toggle('olv-hidden', !this._chainOn);
      this._renderList();
      this._recomputeChain();
    });

    // v0.3.6 mobile collapse — chevron toggle in the head row, hidden
    // on desktop, lets thumb users reclaim canvas with one tap.
    const collapseBtn = el('button', {
      className: 'olv-collapse-toggle',
      type: 'button',
      ariaLabel: 'Collapse panel',
      title: 'Collapse this panel',
    });
    collapseBtn.append(el('span', { className: 'olv-chevron', text: '▾' }));
    const title = el('div', { className: 'olv-mp-title', text: 'Measurements' });
    const head = el('div', { className: 'olv-panel-head' }, [title, collapseBtn]);
    const toggleCollapsed = () => {
      this.element.classList.toggle('olv-collapsed');
    };
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapsed();
    });
    head.addEventListener('click', (e) => {
      if (e.target === head || e.target === title) toggleCollapsed();
    });
    this.element = el('aside', { className: 'olv-measure-panel olv-hidden' }, [
      head,
      this._chainBar,
      this._list,
      el('div', { className: 'olv-mp-footer' }, [
        chainBtn,
        exportBtn,
        importBtn,
        fileInput,
      ]),
    ]);
  }

  /** Build the chain bar that sits above the list when chain mode is on. */
  private _buildChainBar(): HTMLElement {
    const ops: ChainOperation[] = ['sum', 'mean', 'min', 'max', 'count'];
    const dims: ChainDimension[] = [
      'length',
      'area',
      'volume-fill',
      'volume-cut',
      'volume-net',
      'height',
      'angle',
      'grade',
    ];

    const opRow = el('div', { className: 'olv-mp-chain-chips' });
    for (const op of ops) {
      const chip = el('button', {
        className: 'olv-mp-chain-chip',
        text: OPERATION_LABEL[op],
        title: `Aggregate by ${OPERATION_LABEL[op].toLowerCase()}.`,
      });
      chip.dataset.op = op;
      chip.addEventListener('click', () => {
        chip.blur();
        this._chainOp = op;
        this._paintChipActive(opRow, 'op', op);
        this._recomputeChain();
      });
      opRow.append(chip);
    }
    this._paintChipActive(opRow, 'op', this._chainOp);

    const dimRow = el('div', { className: 'olv-mp-chain-chips' });
    for (const dim of dims) {
      const chip = el('button', {
        className: 'olv-mp-chain-chip',
        text: DIMENSION_LABEL[dim],
        title: `Aggregate over ${DIMENSION_LABEL[dim].toLowerCase()}.`,
      });
      chip.dataset.dim = dim;
      chip.addEventListener('click', () => {
        chip.blur();
        this._chainDim = dim;
        this._paintChipActive(dimRow, 'dim', dim);
        this._recomputeChain();
      });
      dimRow.append(chip);
    }
    this._paintChipActive(dimRow, 'dim', this._chainDim);

    const result = el('div', {
      className: 'olv-mp-chain-result',
      text: '— · select rows below',
    });

    return el('div', { className: 'olv-mp-chain-bar olv-hidden' }, [
      el('div', { className: 'olv-mp-chain-label', text: 'Chain' }),
      opRow,
      dimRow,
      result,
    ]);
  }

  /** Paint the active chip in a row by data attribute. */
  private _paintChipActive(
    row: HTMLElement,
    attr: 'op' | 'dim',
    value: string,
  ): void {
    const chips = row.querySelectorAll<HTMLElement>('.olv-mp-chain-chip');
    chips.forEach((c) => {
      c.classList.toggle(
        'olv-mp-chain-chip-active',
        c.dataset[attr] === value,
      );
    });
  }

  /**
   * Recompute the chain aggregate against the current selection and
   * paint the result chip. No-op when chain mode is off or no
   * `onChainAggregate` callback is wired.
   */
  private _recomputeChain(): void {
    if (!this._chainOn) return;
    if (this._chainSelection.size === 0) {
      this._chainResult.textContent = '— · select rows below';
      return;
    }
    if (!this._cb.onChainAggregate) {
      this._chainResult.textContent = '—';
      return;
    }
    const result = this._cb.onChainAggregate(
      [...this._chainSelection],
      this._chainDim,
      this._chainOp,
    );
    if (!result) {
      this._chainResult.textContent = '—';
      return;
    }
    const opLabel = OPERATION_LABEL[result.operation];
    const dimLabel = DIMENSION_LABEL[result.dimension];
    const formatted = formatChainResult(result);
    // Caveat: when the operation skipped some rows because they don't
    // contribute to the chosen dimension, surface the gap.
    const coverage =
      result.contributingCount < result.totalCount
        ? ` · ${result.contributingCount}/${result.totalCount} rows`
        : '';
    this._chainResult.textContent = `${opLabel} ${dimLabel}: ${formatted}${coverage}`;
  }

  /** Show or hide the panel. */
  setVisible(visible: boolean): void {
    this.element.classList.toggle('olv-hidden', !visible);
  }

  /** Rebuild the measurement list from the controller's summaries. */
  update(summaries: MeasurementSummary[]): void {
    this._summaries = summaries;
    // Prune chain selection of any ids that no longer exist (a row
    // that the user deleted, or a session load that swapped the set).
    const valid = new Set(summaries.map((s) => s.id));
    for (const id of this._chainSelection) {
      if (!valid.has(id)) this._chainSelection.delete(id);
    }
    this._renderList();
    if (this._chainOn) this._recomputeChain();
  }

  /** Internal — rebuild the list DOM from `_summaries`. */
  private _renderList(): void {
    // Disconnect any ResizeObservers attached to the old chart
    // nodes BEFORE we drop those nodes on the floor. Otherwise
    // the observers keep their callbacks (and the chart elements
    // they close over) alive until GC happens to collect both —
    // see `_chartObservers` for the full rationale.
    // v0.3.10 honesty-patch code-review #1.
    for (const ro of this._chartObservers) ro.disconnect();
    this._chartObservers = [];

    if (this._summaries.length === 0) {
      this._list.replaceChildren(
        el('div', { className: 'olv-mp-empty', text: 'No measurements yet.' }),
      );
      return;
    }
    this._list.replaceChildren(...this._summaries.map((s) => this._row(s)));
  }

  private _row(s: MeasurementSummary): HTMLElement {
    const dot = el('span', { className: 'olv-mp-kind', title: s.kind });

    const name = el('input', {
      className: 'olv-mp-name',
      title: 'Type to rename this measurement',
    });
    name.value = s.name;
    name.addEventListener('change', () => this._cb.onRename(s.id, name.value));

    const value = el('span', { className: 'olv-mp-value', text: s.value });

    const del = el('button', {
      className: 'olv-mp-del',
      text: '×',
      title: `Delete ${s.name}`,
      ariaLabel: `Delete ${s.name}`,
    });
    del.addEventListener('click', () => this._cb.onDelete(s.id));

    // Chain mode adds a leading checkbox so the user can mark which
    // measurements feed the aggregate. Owned by the panel — the
    // controller is informed only at aggregate time.
    const children: HTMLElement[] = [dot, name, value, del];
    if (this._chainOn) {
      const check = el('input', {
        className: 'olv-mp-chain-check',
        ariaLabel: `Include ${s.name} in chain`,
      }) as HTMLInputElement;
      check.type = 'checkbox';
      check.checked = this._chainSelection.has(s.id);
      check.addEventListener('change', () => {
        if (check.checked) this._chainSelection.add(s.id);
        else this._chainSelection.delete(s.id);
        this._recomputeChain();
      });
      children.unshift(check);
    }
    const headRow = el('div', { className: 'olv-mp-row' }, children);

    // Profile-only: render a compact height-vs-distance chart strip
    // beneath the headline row. The chart is a single inline SVG, no
    // external libraries — keeps the Measurements panel a leaf module.
    if (s.kind === 'profile' && s.profileChart && s.profileChart.length >= 2) {
      // v0.3.10 Profile-as-Deliverable — VEX is persisted globally
      // across all profile rows; one key, all profiles. Clamp to a
      // member of the canonical 1/2/5/10 set so a hand-edited
      // localStorage value can't blow up the chart.
      const storedVex = Number(localStorage.getItem(PROFILE_VEX_KEY));
      const vex = PROFILE_VEX_OPTIONS.includes(storedVex as 1 | 2 | 5 | 10)
        ? storedVex
        : 1;
      const system = this._cb.getUnitSystem ? this._cb.getUnitSystem() : 'metric';
      const chart = renderProfileChart(s.profileChart, vex, system);
      // VEX chip strip — sits beneath the chart wrapper. Clicking a
      // chip writes the new VEX to localStorage and triggers a
      // re-render of the whole measurements list, so every profile
      // row picks up the new scale consistently.
      const vexStrip = el('div', {
        className: 'olv-mp-vex-strip',
        title: 'Vertical exaggeration — visually scales the elevation axis',
        ariaLabel: 'Vertical exaggeration',
      });
      vexStrip.setAttribute('role', 'radiogroup');
      for (const v of PROFILE_VEX_OPTIONS) {
        const chip = el('button', {
          className: 'olv-mp-vex-chip' + (v === vex ? ' olv-mp-vex-chip-active' : ''),
          text: `${v}:1`,
          title: `${v}:1 vertical exaggeration`,
          ariaLabel: `Set vertical exaggeration to ${v} to 1`,
        });
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-checked', v === vex ? 'true' : 'false');
        chip.addEventListener('click', () => {
          chip.blur();
          if (v === vex) return;
          localStorage.setItem(PROFILE_VEX_KEY, String(v));
          this._renderList();
        });
        vexStrip.append(chip);
      }
      // v0.3.10 (issue #402: the profile chart is now resizable
      // (CSS `resize: vertical` on `.olv-mp-chart`). Restore the
      // user's last chosen height from localStorage and persist any
      // resize so the panel doesn't snap back to 140 px on every
      // re-render. One key shared across all profiles — users want
      // consistent reading height, not per-profile memory.
      if (chart.classList.contains('olv-mp-chart')) {
        const stored = Number(localStorage.getItem(PROFILE_CHART_HEIGHT_KEY));
        if (
          Number.isFinite(stored) &&
          stored >= PROFILE_CHART_MIN_HEIGHT_PX &&
          stored <= PROFILE_CHART_MAX_HEIGHT_PX
        ) {
          chart.style.height = `${stored}px`;
        }
        // ResizeObserver fires whenever the user drags the south-east
        // handle. Save the clamped height back to localStorage so the
        // next render starts at that size.
        //
        // `primed` skips the first callback, which fires synchronously
        // on `observe()` with the initial box size — without it, every
        // panel re-render would write the default 140 to localStorage
        // even when the user never touched the handle.
        // v0.3.10 honesty-patch code-review #2.
        //
        // The observer is pushed onto `_chartObservers` so the next
        // `_renderList()` can `disconnect()` it before replacing the
        // chart DOM nodes (code-review #1).
        try {
          let primed = false;
          const ro = new ResizeObserver(() => {
            if (!primed) {
              primed = true;
              return;
            }
            const h = chart.clientHeight;
            if (
              h >= PROFILE_CHART_MIN_HEIGHT_PX &&
              h <= PROFILE_CHART_MAX_HEIGHT_PX
            ) {
              localStorage.setItem(PROFILE_CHART_HEIGHT_KEY, String(Math.round(h)));
            }
          });
          ro.observe(chart);
          this._chartObservers.push(ro);
        } catch (err) {
          // ResizeObserver is unsupported (jsdom, very old browsers).
          // The chart still renders and resizes via CSS; only the
          // persistence path drops out. v0.3.10 honesty-patch
          // code-review #5 — surface the diagnostic instead of a
          // silent swallow.
          console.warn(
            'OpenLiDARViewer: ResizeObserver unavailable; profile chart height will not persist across renders.',
            err,
          );
        }
      }
      const children: HTMLElement[] = [headRow, chart, vexStrip];
      // Streaming-resident caveat: surface a coverage caption beneath the
      // chart so the analyst understands the profile only reflects the
      // points currently resident in memory, and may refine as more
      // nodes stream in.
      if (s.profileChartResidentOnly) {
        children.push(
          el('div', {
            className: 'olv-mp-chart-caveat',
            text: 'Resident-node analysis only — profile may refine as streaming loads.',
          }),
        );
      }
      // v0.3.10: explicit "Clear profile" action under the
      // chart. The per-row `×` delete button already removed any
      // measurement (including profiles), but it's a small icon at the
      // far right of the headline row and users reported they couldn't
      // find an obvious way to dismiss a finished profile. A bigger,
      // labelled button in the destructive rose vocabulary makes the
      // dismiss path discoverable at the moment of "I'm done with this
      // profile." Wires to the same controller delete callback.
      const clearAction = el('div', { className: 'olv-mp-row-action' }, [
        el('button', {
          className: 'olv-mp-profile-clear',
          text: 'Clear profile',
          title: `Remove this profile (${s.name})`,
          ariaLabel: `Clear profile ${s.name}`,
        }),
      ]);
      const clearBtn = clearAction.firstElementChild as HTMLButtonElement;
      clearBtn.addEventListener('click', () => {
        clearBtn.blur();
        this._cb.onDelete(s.id);
      });
      children.push(clearAction);
      return el('div', { className: 'olv-mp-row-stack' }, children);
    }

    // Volume-only: surface the streaming-resident caveat beneath the
    // headline row when the cut/fill record was sampled against
    // resident nodes only. Same caption style as the profile branch so
    // the analyst's eye reads them as the same "may refine" signal.
    if (s.kind === 'volume' && s.volumeResidentOnly) {
      const caveat = el('div', {
        className: 'olv-mp-chart-caveat',
        text: 'Resident-node analysis only — cut / fill may refine as streaming loads.',
      });
      return el('div', { className: 'olv-mp-row-stack' }, [headRow, caveat]);
    }

    return headRow;
  }
}

/**
 * Render a profile chart as an inline SVG, deliverable-grade.
 *
 * v0.3.10 Profile-as-Deliverable stream — the prior renderer drew a
 * single line at 36 px tall with no grid, no axis labels, and no
 * station markers. That was fine for "confirm the profile exists" but
 * useless for "read the slope of segment 3." This version adds:
 *
 *   - Background grid (major + minor) keyed to a nice station
 *     interval (1 / 2 / 5 / 10 / 20 / 25 / 50 / 100 / … metres).
 *   - X-axis chainage labels at every major gridline.
 *   - Y-axis elevation labels at the top and bottom of the band.
 *   - Station tick marks above the X axis at every major chainage.
 *   - Vertical exaggeration (VEX) applied to the Y mapping — chart is
 *     drawn at the chosen ratio so a 1 % grade reads as 1 % on the
 *     wall (or 10 % at VEX 10:1).
 *   - The "what scale is this" indicator burned into the bottom-right
 *     corner so a screenshot or PDF export is unambiguous.
 *
 * NaN samples still split the line — a gap reads as a discontinuity,
 * not a phantom interpolation. The "no coverage" empty state is
 * preserved verbatim.
 *
 * Width is the panel's available column; vertical height comes from
 * the resizable wrapper (`.olv-mp-chart`). `preserveAspectRatio="none"`
 * stretches the viewBox to fill the box.
 */
function renderProfileChart(
  samples: readonly { distance: number; height: number }[],
  vex: number,
  system: 'metric' | 'imperial',
): HTMLElement {
  const W = 220;
  const H = 60; // Taller viewBox — gives the axis labels breathing room.
  const PAD_X = 18; // Room for Y-axis labels on the left.
  const PAD_TOP = 4;
  const PAD_BOTTOM = 10; // Room for X-axis labels below.

  // Find data bounds across hit samples only.
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of samples) {
    if (!Number.isFinite(s.height)) continue;
    if (s.distance < xMin) xMin = s.distance;
    if (s.distance > xMax) xMax = s.distance;
    if (s.height < yMin) yMin = s.height;
    if (s.height > yMax) yMax = s.height;
  }

  // If no hits at all, render a "no coverage" hint instead of a chart.
  if (!Number.isFinite(xMin)) {
    return el('div', {
      className: 'olv-mp-chart-empty',
      text: 'No points near the profile line — try a denser scan area.',
    });
  }

  const xSpan = Math.max(xMax - xMin, 1e-9);
  // VEX multiplier: visually scale the elevation axis by the
  // requested factor. The mapped Y still fills the same pixel band
  // (the renderer doesn't actually grow the viewBox — instead it
  // shrinks the apparent ySpan, which has the same visual effect of
  // exaggerating the curve in the available height).
  const ySpan = Math.max((yMax - yMin) / Math.max(0.0001, vex), 1e-9);

  // Drawable plot area.
  const plotLeft = PAD_X;
  const plotRight = W - 2;
  const plotTop = PAD_TOP;
  const plotBottom = H - PAD_BOTTOM;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  // Walk samples and emit one path per contiguous hit run.
  const paths: string[] = [];
  let cur = '';
  for (const s of samples) {
    if (!Number.isFinite(s.height)) {
      if (cur) {
        paths.push(cur);
        cur = '';
      }
      continue;
    }
    const x = plotLeft + ((s.distance - xMin) / xSpan) * plotW;
    // Centre the (yMax+yMin)/2 line vertically when VEX > 1 so the
    // exaggeration grows around the midline rather than collapsing
    // to the top or bottom of the band.
    const midY = (yMin + yMax) * 0.5;
    const dyVisual = (s.height - midY) / ySpan; // dimensionless
    // Invert: SVG y grows downward, but elevation grows upward.
    const y = plotTop + plotH * 0.5 - dyVisual * plotH;
    cur += cur === '' ? `M${x.toFixed(2)} ${y.toFixed(2)}` : ` L${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  if (cur) paths.push(cur);

  // Station spacing — civil convention.
  const stationInterval = autoStationInterval(xSpan);
  const stations: number[] = [];
  for (let c = 0; c <= xSpan + 1e-9; c += stationInterval) stations.push(c);
  // Minor grid: 5 divisions per major.
  const minorInterval = stationInterval / 5;
  const minorTicks: number[] = [];
  for (let c = 0; c <= xSpan + 1e-9; c += minorInterval) minorTicks.push(c);

  const formatChainage = (m: number): string => {
    if (system === 'imperial') {
      const ft = m * 3.28084;
      return ft >= 5280 ? `${(ft / 5280).toFixed(1)}mi` : `${Math.round(ft)}ft`;
    }
    return m >= 1000 ? `${(m / 1000).toFixed(2)}km` : `${Math.round(m)}m`;
  };
  const formatElevation = (m: number): string => {
    if (system === 'imperial') return `${Math.round(m * 3.28084)}ft`;
    return `${m.toFixed(1)}m`;
  };

  // Build SVG layers in z-order: minor grid → major grid → axis labels →
  // station ticks → profile path → VEX badge.
  const minorGridParts = minorTicks
    .map((c) => {
      const x = plotLeft + (c / xSpan) * plotW;
      return `<line x1="${x.toFixed(2)}" y1="${plotTop}" x2="${x.toFixed(2)}" y2="${plotBottom}" stroke="rgba(255,255,255,0.04)" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
    })
    .join('');
  const majorGridParts = stations
    .map((c) => {
      const x = plotLeft + (c / xSpan) * plotW;
      return `<line x1="${x.toFixed(2)}" y1="${plotTop}" x2="${x.toFixed(2)}" y2="${plotBottom}" stroke="rgba(255,255,255,0.10)" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
    })
    .join('');
  // Y-axis: top & bottom horizontal rules.
  const yAxisRules =
    `<line x1="${plotLeft}" y1="${plotTop}" x2="${plotRight}" y2="${plotTop}" stroke="rgba(255,255,255,0.10)" stroke-width="0.5" vector-effect="non-scaling-stroke"/>` +
    `<line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="rgba(255,255,255,0.18)" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
  // X-axis tick labels at each major station.
  const xLabelParts = stations
    .map((c, i) => {
      const x = plotLeft + (c / xSpan) * plotW;
      const anchor = i === 0 ? 'start' : i === stations.length - 1 ? 'end' : 'middle';
      return `<text x="${x.toFixed(2)}" y="${H - 2}" text-anchor="${anchor}" font-size="5.5" fill="rgba(255,255,255,0.55)" font-family="ui-monospace,monospace">${formatChainage(c)}</text>`;
    })
    .join('');
  // Y-axis tick labels — top and bottom only.
  const yLabelParts =
    `<text x="2" y="${plotTop + 4}" font-size="5.5" fill="rgba(255,255,255,0.55)" font-family="ui-monospace,monospace">${formatElevation(yMax)}</text>` +
    `<text x="2" y="${plotBottom - 1}" font-size="5.5" fill="rgba(255,255,255,0.55)" font-family="ui-monospace,monospace">${formatElevation(yMin)}</text>`;
  // Station tick caps above the X axis.
  const stationCaps = stations
    .map((c) => {
      const x = plotLeft + (c / xSpan) * plotW;
      return `<line x1="${x.toFixed(2)}" y1="${plotBottom - 2}" x2="${x.toFixed(2)}" y2="${plotBottom + 1}" stroke="rgba(255,255,255,0.4)" stroke-width="0.7" vector-effect="non-scaling-stroke"/>`;
    })
    .join('');
  // VEX indicator — burned into the chart so a screenshot or PDF
  // export carries the scale information unambiguously.
  const vexLabel =
    `<text x="${plotRight - 2}" y="${plotTop + 5}" text-anchor="end" font-size="5.5" font-weight="600" fill="rgba(255,255,255,0.55)" font-family="ui-monospace,monospace">VEX ${vex}:1</text>`;

  const pathParts = paths
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('');

  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    ${minorGridParts}${majorGridParts}${yAxisRules}${stationCaps}${pathParts}${xLabelParts}${yLabelParts}${vexLabel}
  </svg>`;

  const trueSpan = yMax - yMin;
  const title =
    `${samples.length} samples · Δh ${trueSpan.toFixed(2)} m · ` +
    `station interval ${formatChainage(stationInterval)} · VEX ${vex}:1 · ` +
    `drag bottom-right to resize`;
  return el('div', { className: 'olv-mp-chart', unsafeHtml: svg, title });
}
