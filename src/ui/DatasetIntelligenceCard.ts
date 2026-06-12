/**
 * DatasetIntelligenceCard.ts
 *
 * Compact Inspector card that surfaces the Terrain Foundation's
 * summarised view of a loaded dataset:
 *
 *   - Point Density            (Sparse / Moderate / Dense / Very Dense)
 *   - Terrain Complexity       (Low / Moderate / High / Very High)
 *   - Ground Visibility        (Poor / Fair / Good / Excellent)
 *   - Streaming Coverage       (Full / Resident Nodes / Sampled)
 *   - Metric Stability         (0–100% with green/yellow/red band)
 *
 * Plus an expandable Details panel for coverage mode, source point
 * count, analyzed point count, metric version, and engine status.
 *
 * The card NEVER claims to perform terrain classification. The brief
 * is explicit about this: ground extraction, DTM/DSM, contours, and
 * vegetation / building detection stay hidden until a future release.
 *
 * Pure presentation — every numeric decision lives in
 * `src/terrain/datasetIntelligence.ts`. The card just renders.
 */

import { el } from './dom';
import {
  summariseDataset,
  type DatasetIntelligence,
  type DatasetIntelligenceInput,
} from '../terrain/datasetIntelligence';

const EMPTY_TEXT = 'Terrain Intelligence unavailable for this dataset.';

/**
 * v0.3.10 trust-pass — "Terrain Confidence" can be misread as
 * ground-classification accuracy by an analyst skimming the panel.
 * Renamed to "Metric Stability" so the row reads as what it actually
 * measures: how stable the underlying terrain signals are given the
 * coverage + sample-count budget. The tooltip below makes the
 * disclaimer explicit so a screen reader / hover lookup carries the
 * same disambiguation a label-only redesign would have lost.
 */
const TOOLTIP_METRIC_STABILITY =
  'Metric Stability — how stable the dataset-level terrain signals ' +
  'are given coverage and analysed point count. This is NOT ground-' +
  'classification accuracy. Renders "—" until the engine has produced ' +
  'a measurement.';

/**
 * Five-row card with a Details disclosure. Construct once at Inspector
 * build time; call `update(input)` whenever the orchestrator has new
 * data; call `clear()` to drop the dataset back to the empty state.
 */
export class DatasetIntelligenceCard {
  /** Root element — mount inside the Inspector. */
  readonly element: HTMLElement;

  private readonly _body: HTMLElement;
  private readonly _empty: HTMLElement;
  private readonly _rows: HTMLElement;
  private readonly _details: HTMLDetailsElement;
  private readonly _detailsBody: HTMLElement;

  private readonly _densityValue: HTMLElement;
  private readonly _complexityValue: HTMLElement;
  private readonly _groundValue: HTMLElement;
  private readonly _coverageValue: HTMLElement;
  private readonly _coverageWarning: HTMLElement;
  private readonly _confidenceValue: HTMLElement;
  private readonly _confidenceChip: HTMLElement;

  /** The summary currently on display — see the `current` getter. */
  private _current: DatasetIntelligence | null = null;

  constructor() {
    // v0.3.10 a11y patch #375 — the five card rows and the Details
    // disclosure are semantic term/definition pairs ("Point Density"
    // → "Dense", "Terrain Complexity" → "Moderate", etc.). Marking
    // them up with `<dl>/<dt>/<dd>` lets screen readers announce them
    // as definition lists instead of unstructured spans of text.
    // The `<div class="olv-di-row">` wrapper between `<dl>` and the
    // `<dt>/<dd>` pair is explicitly allowed by HTML 5.2 for
    // grouping, and preserves the existing flex-row CSS layout.
    this._densityValue = el('dd', { className: 'olv-di-row-value' });
    this._complexityValue = el('dd', { className: 'olv-di-row-value' });
    this._groundValue = el('dd', { className: 'olv-di-row-value' });
    this._coverageValue = el('dd', { className: 'olv-di-row-value' });
    // The Terrain Confidence row wraps the chip + numeric value in a
    // single `<dd>`, so its value span is plain inline content rather
    // than its own `<dd>`. No className — the parent `<dd>` carries
    // `.olv-di-row-value` (color + font-weight + tabular-nums), and the
    // child `<span>` inherits all three. v0.3.10 phantom-class sweep
    // caught a stray `.olv-di-confidence-value` here that had no
    // matching CSS rule.
    this._confidenceValue = el('span', {});
    this._confidenceChip = el('span', {
      className: 'olv-di-confidence-chip',
      title: TOOLTIP_METRIC_STABILITY,
    });

    // Streaming coverage warning — initially hidden, populated by
    // `update()` when coverage is partial. v0.3.10 a11y #375: pulled
    // OUT of the `<dl>` (it isn't a dt/dd pair) and given
    // `role="note"` so screen readers announce it as a sidebar note
    // rather than reading it as a definition.
    this._coverageWarning = el('div', { className: 'olv-di-warning olv-hidden' });
    this._coverageWarning.setAttribute('role', 'note');

    // v0.3.10 trust-pass — every row gets a "what this means" tooltip
    // attached to the term (<dt>) so a hover lookup explains the
    // bucket vocabulary. The five rows describe technical signals
    // that are obvious to a survey/civil analyst but read as jargon
    // to a first-time user; the tooltips disambiguate without adding
    // visible clutter to the panel.
    this._rows = el('dl', { className: 'olv-di-rows' }, [
      this._row(
        'Point Density',
        this._densityValue,
        'Points per cubic metre, derived from the loader-declared point ' +
          'count and the bounding-box volume. Bucket label: sparse / ' +
          'moderate / dense / very dense.',
      ),
      this._row(
        'Terrain Complexity',
        this._complexityValue,
        'How varied the underlying surface is — based on slope, ' +
          'roughness, and elevation variance once the engine has ' +
          'sampled the cloud. Renders "—" until a measurement is ' +
          'available.',
      ),
      this._row(
        'Ground Visibility',
        this._groundValue,
        'How clearly the terrain surface can be inferred from the ' +
          'points — combines roughness, density, and any classification ' +
          'signal in the source file. Renders "—" until the engine has ' +
          'a measurement. This is NOT ground-classification accuracy.',
      ),
      this._row(
        'Streaming Coverage',
        this._coverageValue,
        'Whether the analysis used the full cloud (static load), only ' +
          'the nodes resident in memory (streaming clouds mid-load), or ' +
          'a sampled subset. Drives the "may refine" caveat below.',
      ),
      this._row(
        'Metric Stability',
        el('dd', { className: 'olv-di-row-value olv-di-confidence-cell' }, [
          this._confidenceChip,
          this._confidenceValue,
        ]),
        TOOLTIP_METRIC_STABILITY,
      ),
    ]);

    this._detailsBody = el('dl', { className: 'olv-di-details-body' });
    this._details = el('details', { className: 'olv-di-details' }) as HTMLDetailsElement;
    this._details.append(
      el('summary', { className: 'olv-di-details-summary', text: 'Details' }),
      this._detailsBody,
    );

    // Kept in the DOM tree for ARIA assistive callers but never
    // rendered as a visible block — the card collapses to zero
    // height when no terrain summary is available so it doesn't
    // displace controls below it in the Inspector.
    this._empty = el('div', { className: 'olv-di-empty olv-hidden', text: EMPTY_TEXT });

    // Body now holds three siblings: the dl of rows, the (initially
    // hidden) coverage warning, and the Details disclosure. The
    // warning sits between the rows and the Details so a screen
    // reader announces it inline with the rest of the card
    // summary, not buried in the disclosure.
    this._body = el('div', { className: 'olv-di-body' }, [
      this._rows,
      this._coverageWarning,
      this._details,
    ]);

    this.element = el('section', {
      className: 'olv-section olv-di-card olv-hidden',
      ariaLabel: 'Dataset Intelligence',
    }, [
      el('div', { className: 'olv-panel-title olv-di-title', text: 'Dataset Intelligence' }),
      this._body,
      this._empty,
    ]);
  }

  /** Replace the card's contents with a fresh summary, or empty state. */
  update(input: DatasetIntelligenceInput): void {
    const intel = summariseDataset(input);
    if (!intel) {
      this.clear();
      return;
    }
    this._current = intel;
    this._render(intel);
  }

  /**
   * The summary currently on display, or null after `clear()`. Exposed so the
   * Terrain Intelligence Report can stamp the SAME bucket labels the card
   * shows (v0.4.5) — re-running `summariseDataset` at export time could drift
   * if the orchestrator pushed fresher inputs between paint and export.
   */
  get current(): DatasetIntelligence | null {
    return this._current;
  }

  /**
   * Drop the card. We hide the whole card root instead of showing
   * an "unavailable" placeholder, because a placeholder card pushes
   * the Visuals Studio rail and other Inspector content down for no
   * informational gain.
   */
  clear(): void {
    this._current = null;
    this.element.classList.add('olv-hidden');
  }

  // ── private ──────────────────────────────────────────────────────

  /**
   * Build one term / definition row. The `<div class="olv-di-row">`
   * wrapper between `<dl>` and the `<dt>/<dd>` pair is allowed per
   * HTML 5.2 for grouping; it lets the existing flex layout keep
   * working unchanged while still surfacing the semantic
   * relationship to assistive tech.
   *
   * v0.3.10 trust-pass — accepts an optional `tooltip` that becomes
   * the `title` attribute on the `<dt>` (the term, not the value)
   * so a hover lookup explains what the bucket label actually means.
   * The cursor on `<dt>` becomes `help` when a tooltip is present
   * so users see a hint that more info is one hover away.
   */
  private _row(
    label: string,
    value: HTMLElement,
    tooltip?: string,
  ): HTMLElement {
    const dt = el('dt', { className: 'olv-di-row-name', text: label });
    if (tooltip) {
      dt.title = tooltip;
      dt.style.cursor = 'help';
      dt.setAttribute('aria-describedby', '');
    }
    return el('div', { className: 'olv-di-row' }, [dt, value]);
  }

  /** Apply a fresh summary to the DOM. */
  private _render(intel: DatasetIntelligence): void {
    // Reveal the card now that we have something useful to show.
    this.element.classList.remove('olv-hidden');
    this._empty.classList.add('olv-hidden');

    this._densityValue.textContent = intel.density.label;
    this._densityValue.dataset.bucket = intel.density.bucket;

    this._complexityValue.textContent = intel.complexity.label;
    this._complexityValue.dataset.bucket = intel.complexity.bucket;

    this._groundValue.textContent = intel.groundVisibility.label;
    this._groundValue.dataset.bucket = intel.groundVisibility.bucket;

    this._coverageValue.textContent = intel.coverage.label;
    this._coverageValue.dataset.bucket = intel.coverage.bucket;

    if (intel.coverage.streamingWarning) {
      this._coverageWarning.textContent = intel.coverage.streamingWarning;
      this._coverageWarning.classList.remove('olv-hidden');
    } else {
      this._coverageWarning.textContent = '';
      this._coverageWarning.classList.add('olv-hidden');
    }

    this._confidenceValue.textContent = intel.confidence.label;
    this._confidenceChip.dataset.band = intel.confidence.band;

    this._renderDetails(intel);
  }

  /** Re-render the Details disclosure block. */
  private _renderDetails(intel: DatasetIntelligence): void {
    const formatPoints = (n: number | null): string =>
      n === null || !Number.isFinite(n) ? '—' : compactPointCount(n);
    this._detailsBody.replaceChildren(
      this._detailRow('Coverage', intel.details.coverageMode),
      this._detailRow('Source Points', formatPoints(intel.details.sourcePointCount)),
      this._detailRow('Analyzed Points', formatPoints(intel.details.analyzedPointCount)),
      this._detailRow(
        'Terrain Engine',
        intel.details.engineStatus === 'active' ? 'Active' : 'Idle',
      ),
      this._detailRow('Metric Version', intel.details.metricVersion),
    );
  }

  /**
   * One key / value pair inside the Details panel — same dt/dd
   * pattern as the main rows. v0.3.10 a11y patch #375.
   */
  private _detailRow(name: string, value: string): HTMLElement {
    return el('div', { className: 'olv-di-detail' }, [
      el('dt', { className: 'olv-di-detail-name', text: name }),
      el('dd', { className: 'olv-di-detail-value', text: value }),
    ]);
  }
}

/** "1.2M" / "680K" / "342" formatting for point counts in Details. */
function compactPointCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}
