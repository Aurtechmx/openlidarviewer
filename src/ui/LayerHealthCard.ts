/**
 * LayerHealthCard.ts
 *
 * Inspector card that answers, per layer, "why can (or can't) this layer
 * interact with the others" — CRS identity, units, datum, the four-state
 * compatibility with its consequence, frame membership, mount geometry,
 * the precision readout, and streaming residency — plus the cross-layer
 * Spatial Compatibility report (per-axis pass/fail lines and a one-sentence
 * verdict).
 *
 * Pure presentation, same contract as DatasetIntelligenceCard: every string
 * and status is decided in `src/app/layerHealth.ts` (fail-closed wording,
 * banned-claim tests live there); the card just renders what it is handed.
 * The integrator assembles `LayerHealthInput` per layer, runs the builders,
 * and calls `update()` — see INTEGRATION.md at the repo root.
 *
 * Monospace is reserved for numeric values (coordinates, offsets, mm
 * figures) via the row's `mono` flag; labels and prose stay in the UI face.
 */

import { el } from './dom';
import type { CompatibilityReport, LayerHealthRow } from '../app/layerHealth';

/** One layer's heading + built rows, ready to render. */
export interface LayerHealthSection {
  readonly name: string;
  readonly rows: readonly LayerHealthRow[];
}

const EMPTY_TEXT = 'Layer health unavailable — no layers loaded.';

/**
 * Construct once at Inspector build time; call `update()` on every
 * layer-set change (the same cadence as `setLayerCrsFlags`); `clear()`
 * hides the card when the last layer closes.
 */
export class LayerHealthCard {
  /** Root element — mount inside the Inspector. */
  readonly root: HTMLElement;

  private readonly _layers: HTMLElement;
  private readonly _report: HTMLElement;
  private readonly _reportLines: HTMLElement;
  private readonly _verdict: HTMLElement;
  private readonly _empty: HTMLElement;

  constructor() {
    this._layers = el('div', { className: 'olv-layerhealth-layers' });
    this._reportLines = el('div', { className: 'olv-layerhealth-report-lines' });
    this._verdict = el('p', { className: 'olv-layerhealth-verdict' });
    this._report = el('div', { className: 'olv-layerhealth-report' }, [
      el('div', { className: 'olv-layerhealth-report-title', text: 'Spatial compatibility' }),
      this._reportLines,
      this._verdict,
    ]);
    // Kept in the tree for assistive callers, hidden alongside the card —
    // the card collapses entirely rather than showing a placeholder block.
    this._empty = el('div', { className: 'olv-layerhealth-empty olv-hidden', text: EMPTY_TEXT });

    this.root = el(
      'section',
      { className: 'olv-section olv-layerhealth-card olv-hidden', ariaLabel: 'Layer Health' },
      [
        el('div', { className: 'olv-panel-title olv-layerhealth-title', text: 'Layer Health' }),
        this._layers,
        this._report,
        this._empty,
      ],
    );
  }

  /**
   * Replace the card's contents. `report` may be null (single layer — the
   * builder's verdict already says comparison does not apply, but a caller
   * that wants no report block at all can withhold it).
   */
  update(layers: readonly LayerHealthSection[], report: CompatibilityReport | null): void {
    if (layers.length === 0) {
      this.clear();
      return;
    }
    this.root.classList.remove('olv-hidden');
    this._layers.replaceChildren(...layers.map((l) => this._layerBlock(l)));

    if (report === null) {
      this._report.classList.add('olv-hidden');
      return;
    }
    this._report.classList.remove('olv-hidden');
    this._reportLines.replaceChildren(
      ...report.lines.map((line) => {
        const p = el('p', { className: 'olv-layerhealth-report-line', text: line.text });
        p.dataset.status = line.status;
        return p;
      }),
    );
    this._verdict.textContent = report.verdict;
  }

  /** Hide the card (last layer closed / scan reset). */
  clear(): void {
    this.root.classList.add('olv-hidden');
    this._layers.replaceChildren();
    this._reportLines.replaceChildren();
    this._verdict.textContent = '';
  }

  // ── private ──────────────────────────────────────────────────────

  /** One layer: name heading + its fact rows as a term/definition list. */
  private _layerBlock(layer: LayerHealthSection): HTMLElement {
    const rows = el(
      'dl',
      { className: 'olv-layerhealth-rows' },
      layer.rows.map((r) => this._row(r)),
    );
    return el('div', { className: 'olv-layerhealth-layer' }, [
      el('div', { className: 'olv-layerhealth-layer-name', text: layer.name }),
      rows,
    ]);
  }

  /**
   * One fact row — dt/dd inside a flex wrapper, the same HTML 5.2 grouping
   * pattern DatasetIntelligenceCard uses. `data-status` drives the quiet
   * status dot; the WORD always carries the meaning, colour is supplementary.
   */
  private _row(r: LayerHealthRow): HTMLElement {
    const value = el('dd', {
      className: `olv-layerhealth-row-value${r.mono ? ' is-mono' : ''}`,
      text: r.value,
    });
    value.dataset.status = r.status;
    return el('div', { className: 'olv-layerhealth-row' }, [
      el('dt', { className: 'olv-layerhealth-row-name', text: r.label }),
      value,
    ]);
  }
}
