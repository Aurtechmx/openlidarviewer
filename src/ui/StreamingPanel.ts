/**
 * StreamingPanel.ts
 *
 * The user-facing panel for a streaming COPC scan: a metadata scan summary,
 * the live load phase and status (nodes, points, cache), the streaming
 * controls (colour, quality, pause/resume, clear cache), and saved camera
 * views.
 *
 * It is calm by design — a few clear sections, no technical noise. The deep
 * counters belong to the `?debug=1` overlay, not here.
 */

import { el } from './dom';
import { formatCount } from './dom';
import { formatByteSize as formatBytes } from '../io/formatByteSize';
import type { ColorMode } from '../render/colorModes';
import type { StreamingQuality } from '../render/streaming/streamingBudget';

/** Live status numbers for the panel. */
export interface StreamingStatus {
  loadedNodes: number;
  knownNodes: number;
  displayedPoints: number;
  sourcePoints: number;
  cacheBytes: number;
}

/**
 * The one-time scan summary, derived from the source's metadata.
 *
 * added `format` ('copc' | 'ept') so the panel renders the right
 * format label. COPC fills the existing `pointFormat` (LAS PDRF 6/7/8);
 * EPT passes a sentinel `pointFormat: -1` and an optional `schemaSummary`
 * describing the EPT schema (e.g. "binary · 5 attrs"). The panel formats
 * either case correctly.
 */
export interface StreamingScanSummary {
  fileName: string;
  pointFormat: number;
  sourcePoints: number;
  width: number;
  depth: number;
  height: number;
  spacing: number;
  octreeDepth: number;
  nodeCount: number;
  /** which streaming format the source is. */
  format?: 'copc' | 'ept';
  /** EPT-only: schema summary string for the Format row. */
  schemaSummary?: string;
}

/** Callbacks the panel raises. */
export interface StreamingPanelCallbacks {
  onColorMode(mode: ColorMode): void;
  onQuality(quality: StreamingQuality): void;
  onPauseToggle(paused: boolean): void;
  onClearCache(): void;
  onSaveView(): void;
  onApplyView(index: number): void;
  onDeleteView(index: number): void;
}

/** Friendly labels for each colour mode. */
const MODE_LABEL: Record<ColorMode, string> = {
  rgb: 'Color',
  intensity: 'Intensity',
  elevation: 'Height',
  classification: 'Class',
  normal: 'Normal',
  density: 'Density',
  // Streaming clouds don't expose the Coverage / Confidence modes (they're
  // static-terrain products); the labels are here only to satisfy the
  // exhaustive ColorMode map.
  coverage: 'Coverage',
  confidence: 'Confidence',
};

const QUALITIES: StreamingQuality[] = ['low', 'balanced', 'high'];

/** Render a world dimension — coarse for large extents, finer for small ones. */
function formatDim(n: number): string {
  const v = Math.abs(n);
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

/**
 * Label + value for the resolution row of the scan summary.
 *
 * COPC's metadata `spacing` is a METRIC root-node point spacing (CRS units —
 * metres for the usual projected scans), so it reads as "1.20 m". EPT's `span`
 * is a DIMENSIONLESS points-per-tile budget (the octree resolution analogue),
 * NOT a distance — feeding it into the same bare "Spacing" row read as "128 m"
 * of spacing, a label-vs-value drift. EPT therefore gets its own "Node budget"
 * label and a "pts/node" value so the number is never mistaken for a distance.
 * Pure + DOM-free so the decision is unit-tested without standing up the panel.
 */
export function spacingRowFor(
  format: 'copc' | 'ept' | undefined,
  spacing: number,
): { readonly label: string; readonly value: string; readonly title: string } {
  if (format === 'ept') {
    return {
      label: 'Node budget',
      value: `~${Math.round(spacing).toLocaleString()} pts/node`,
      title: 'EPT octree resolution — target points per node, not a metric spacing.',
    };
  }
  return {
    label: 'Spacing',
    value: `${spacing.toFixed(2)} m`,
    title: 'Root-node point spacing in the dataset’s CRS units.',
  };
}

/**
 * The determinate-progress readout for the streaming loader, derived purely
 * from the live status counters (no DOM) so the fraction/label logic is
 * unit-tested directly.
 *
 * HONESTY: `fraction` is RESIDENT nodes ÷ KNOWN nodes — the share of the
 * octree that is currently LOADED into the scene, NOT a download percentage
 * (a streaming source has no fixed "total bytes" to download against). The
 * label says "resident" for exactly this reason. When the total node count is
 * not yet known (knownNodes ≤ 0, the brief window before the root's hierarchy
 * is read), the fraction is `null` and the caller shows the indeterminate
 * shimmer instead of a misleading 0%/100% bar.
 */
export interface StreamingProgress {
  /** resident/known node fraction in [0,1], or null when total is unknown. */
  readonly fraction: number | null;
  /** Whether the fraction is known (drives determinate vs. shimmer). */
  readonly determinate: boolean;
  /** Compact "X / Y nodes resident" line. */
  readonly nodesLabel: string;
  /** Tabular "X.XM / Y.YM pts" line (millions, one decimal). */
  readonly pointsLabel: string;
}

/** Format a raw point count as "X.XM" (millions, one decimal). */
function pointsMillions(n: number): string {
  // Sub-100k reads as "0.0M", which is honest at this scale and keeps the two
  // sides of the ratio in the SAME unit (no "12k / 4.2M" mixed-unit row).
  return `${(Math.max(0, n) / 1_000_000).toFixed(1)}M`;
}

/**
 * Derive the streaming progress readout from the live counters. Pure; see
 * {@link StreamingProgress} for the honesty contract on the fraction.
 */
export function streamingProgress(status: StreamingStatus): StreamingProgress {
  const known = status.knownNodes;
  const determinate = known > 0;
  // Clamp to [0,1]: resident can momentarily exceed a stale known count
  // between hierarchy refreshes, and we never want a >100% bar.
  const fraction = determinate
    ? Math.min(1, Math.max(0, status.loadedNodes / known))
    : null;
  return {
    fraction,
    determinate,
    nodesLabel: `${status.loadedNodes} / ${determinate ? known : '?'} nodes resident`,
    pointsLabel: `${pointsMillions(status.displayedPoints)} / ${pointsMillions(
      status.sourcePoints,
    )} pts`,
  };
}

/** The streaming-scan panel. */
export class StreamingPanel {
  readonly element: HTMLElement;
  private readonly _callbacks: StreamingPanelCallbacks;
  private readonly _title: HTMLElement;
  private readonly _phase: HTMLElement;
  // Determinate load-progress treatment under the phase line: a thin
  // brand-gradient bar (resident/known node fraction) + a tabular pts readout.
  private readonly _progress: HTMLElement;
  private readonly _progressTrack: HTMLElement;
  private readonly _progressFill: HTMLElement;
  private readonly _progressNodes: HTMLElement;
  private readonly _progressPoints: HTMLElement;
  // Sticky terminal state: once "Streaming ready" lands, the bar reads 100%
  // and stops reacting to late jitter in the counters.
  private _streamReady = false;
  private readonly _summary: HTMLElement;
  private readonly _nodes: HTMLElement;
  private readonly _points: HTMLElement;
  private readonly _cache: HTMLElement;
  private readonly _modeRow: HTMLElement;
  private readonly _qualityRow: HTMLElement;
  private readonly _views: HTMLElement;
  private readonly _pause: HTMLButtonElement;
  private _modeButtons = new Map<ColorMode, HTMLButtonElement>();
  private _paused = false;

  constructor(callbacks: StreamingPanelCallbacks) {
    this._callbacks = callbacks;

    this._phase = el('div', { className: 'olv-streaming-phase', text: 'Detecting COPC…' });

    // ── Determinate progress treatment ──
    // The bar fill is a real ARIA progressbar; its value/text track the
    // resident-node fraction. When the total is unknown the track carries the
    // indeterminate-shimmer class instead (the fill is hidden), so the user
    // still sees motion without a fabricated percentage.
    this._progressFill = el('div', { className: 'olv-stream-prog-fill' });
    this._progressTrack = el('div', { className: 'olv-stream-prog-track' }, [this._progressFill]);
    this._progressTrack.setAttribute('role', 'progressbar');
    this._progressTrack.setAttribute('aria-label', 'Resident detail loaded');
    this._progressTrack.setAttribute('aria-valuemin', '0');
    this._progressTrack.setAttribute('aria-valuemax', '100');
    this._progressNodes = el('span', { className: 'olv-stream-prog-nodes', text: '—' });
    this._progressPoints = el('span', { className: 'olv-stream-prog-points', text: '—' });
    this._progress = el('div', { className: 'olv-stream-prog olv-hidden' }, [
      this._progressTrack,
      el('div', { className: 'olv-stream-prog-readout' }, [
        this._progressNodes,
        this._progressPoints,
      ]),
    ]);
    this._summary = el('div', { className: 'olv-streaming-rows' });
    this._nodes = el('span', { className: 'olv-streaming-stat', text: '—' });
    this._points = el('span', { className: 'olv-streaming-stat', text: '—' });
    this._cache = el('span', { className: 'olv-streaming-stat', text: '—' });
    this._modeRow = el('div', { className: 'olv-streaming-chips' });
    this._qualityRow = el('div', { className: 'olv-streaming-chips' });
    this._views = el('div', { className: 'olv-streaming-views' });

    for (const quality of QUALITIES) {
      const chip = el('button', {
        className: 'olv-chip',
        text: quality[0].toUpperCase() + quality.slice(1),
      });
      chip.addEventListener('click', () => {
        this._selectQuality(quality);
        this._callbacks.onQuality(quality);
      });
      this._qualityRow.append(chip);
    }

    const saveView = el('button', { className: 'olv-streaming-btn', text: 'Save view' });
    saveView.addEventListener('click', () => this._callbacks.onSaveView());

    this._pause = el('button', { className: 'olv-streaming-btn', text: 'Pause' });
    this._pause.addEventListener('click', () => {
      this._paused = !this._paused;
      this._pause.textContent = this._paused ? 'Resume' : 'Pause';
      this._callbacks.onPauseToggle(this._paused);
    });
    // Clear cache is destructive — adopt the same rose vocabulary used
    // by .olv-tool-close and .olv-measure-clear so the action type
    // reads at a glance (Gestalt similarity).
    const clearCache = el('button', {
      className: 'olv-streaming-btn olv-streaming-btn-danger',
      text: 'Clear cache',
    });
    clearCache.addEventListener('click', () => this._callbacks.onClearCache());

    // The title's text is rebuilt from setSummary's `format` field so it
    // tracks the actual streaming source (COPC vs. EPT) rather than the
    // initial hardcoded label.
    this._title = el('div', { className: 'olv-streaming-title', text: 'Streaming scan' });
    // v0.3.6 mobile collapse — chevron toggle in the head row. Hidden on
    // desktop (CSS handles the gate); on mobile, tapping it collapses the
    // panel body so the user can reclaim canvas with one tap. Tapping
    // the head row anywhere outside the chevron also toggles, so the
    // affordance is forgiving to thumb taps.
    const collapseBtn = el('button', {
      className: 'olv-collapse-toggle',
      type: 'button',
      ariaLabel: 'Collapse panel',
      title: 'Collapse this panel',
    });
    collapseBtn.append(el('span', { className: 'olv-chevron', text: '▾' }));
    const head = el('div', { className: 'olv-panel-head' }, [
      this._title,
      collapseBtn,
    ]);
    const toggleCollapsed = () => {
      this.element.classList.toggle('olv-collapsed');
    };
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapsed();
    });
    head.addEventListener('click', (e) => {
      // Forgive thumb taps anywhere on the head row.
      if (e.target === head || e.target === this._title) toggleCollapsed();
    });
    this.element = el('div', { className: 'olv-streaming-panel olv-hidden' }, [
      head,
      this._phase,
      this._progress,
      el('div', { className: 'olv-streaming-label', text: 'Scan' }),
      this._summary,
      el('div', { className: 'olv-streaming-label', text: 'Streaming' }),
      el('div', { className: 'olv-streaming-rows' }, [
        this._statRow('Nodes', this._nodes),
        this._statRow('Points', this._points),
        this._statRow('Cache', this._cache),
      ]),
      el('div', { className: 'olv-streaming-label', text: 'Colour' }),
      this._modeRow,
      el('div', { className: 'olv-streaming-label', text: 'Quality' }),
      this._qualityRow,
      el('div', { className: 'olv-streaming-label', text: 'Saved views' }),
      this._views,
      el('div', { className: 'olv-streaming-actions' }, [saveView, this._pause]),
      el('div', { className: 'olv-streaming-actions' }, [clearCache]),
    ]);
    this.setViews([]);
  }

  /** Show the panel. */
  show(): void {
    this.element.classList.remove('olv-hidden');
    // Stamp a one-way marker that the panel was opened at least once.
    // Tests use this to detect that openStreamingCopc reached the show()
    // call even if a fast-following error caused hide() to fire before
    // the next poll. It's never cleared — the panel can re-show with
    // the marker present without any side-effect.
    this.element.dataset.opened = '1';
  }

  /** Hide and reset the panel. */
  hide(): void {
    this.element.classList.add('olv-hidden');
    this._paused = false;
    this._pause.textContent = 'Pause';
    // Reset the progress treatment for the next scan.
    this._streamReady = false;
    this._progress.classList.add('olv-hidden');
    this._progressTrack.classList.remove('olv-stream-prog-shimmer');
    this._progressFill.style.width = '0%';
  }

  /**
   * Set the high-level load phase line.
   *
   * The terminal "Streaming ready" phase latches a sticky 100% on the bar
   * (`_streamReady`) so the determinate fill reads full and stops reacting to
   * late counter jitter; any earlier phase un-latches it.
   */
  setPhase(phase: string): void {
    this._phase.textContent = phase;
    const ready = phase === 'Streaming ready';
    if (ready !== this._streamReady) {
      this._streamReady = ready;
      if (ready) {
        // Full, determinate, no shimmer — the load has genuinely settled.
        this._progress.classList.remove('olv-hidden');
        this._progressTrack.classList.remove('olv-stream-prog-shimmer');
        this._progressFill.style.width = '100%';
        this._progressTrack.setAttribute('aria-valuenow', '100');
      }
    }
  }

  /** Populate the one-time scan summary from the streaming source's metadata. */
  setSummary(summary: StreamingScanSummary): void {
    // Title tracks the actual streaming source. Was hardcoded "Streaming
    // COPC", which lied during an EPT load.
    this._title.textContent = summary.format === 'ept' ? 'Streaming EPT' : 'Streaming COPC';
    const file = this._statRow('File', this._value(summary.fileName, summary.fileName));
    // format-aware Format row. COPC shows the LAS PDRF; EPT shows
    // the schema summary (when supplied) or just "EPT".
    const formatText = summary.format === 'ept'
      ? (summary.schemaSummary ? `EPT · ${summary.schemaSummary}` : 'EPT')
      : `COPC LAZ · PDRF ${summary.pointFormat}`;
    this._summary.replaceChildren(
      file,
      this._statRow('Format', this._value(formatText)),
      this._statRow('Source', this._value(`${formatCount(summary.sourcePoints)} points`)),
      this._statRow(
        'Extent',
        this._value(
          `${formatDim(summary.width)} × ${formatDim(summary.depth)} × ${formatDim(summary.height)}`,
        ),
      ),
      // COPC `spacing` is a metric distance; EPT `span` is a points-per-tile
      // budget. `spacingRowFor` labels + units each correctly so neither is
      // misread (see its doc-comment for the label-vs-value drift it fixes).
      (() => {
        const r = spacingRowFor(summary.format, summary.spacing);
        return this._statRow(r.label, this._value(r.value, r.title));
      })(),
      this._statRow(
        'Octree',
        this._value(`depth ${summary.octreeDepth} · ${summary.nodeCount} nodes`),
      ),
    );
  }

  /** Populate the colour-mode chips and select the active one. */
  setColorModes(modes: ColorMode[], active: ColorMode): void {
    this._modeRow.replaceChildren();
    this._modeButtons = new Map();
    for (const mode of modes) {
      const chip = el('button', { className: 'olv-chip', text: MODE_LABEL[mode] });
      chip.addEventListener('click', () => {
        this._selectMode(mode);
        this._callbacks.onColorMode(mode);
      });
      this._modeButtons.set(mode, chip);
      this._modeRow.append(chip);
    }
    this._selectMode(active);
  }

  /** Reflect the active quality preset. */
  setQuality(quality: StreamingQuality): void {
    this._selectQuality(quality);
  }

  /** Update the live status numbers + the determinate progress treatment. */
  setStatus(status: StreamingStatus): void {
    this._nodes.textContent = `${status.loadedNodes} / ${status.knownNodes}`;
    this._points.textContent = `${formatCount(status.displayedPoints)} / ${formatCount(
      status.sourcePoints,
    )}`;
    this._cache.textContent = formatBytes(status.cacheBytes);
    this._updateProgress(status);
  }

  /**
   * Drive the progress bar from the live counters. Determinate (brand-gradient
   * fill at resident/known fraction) when the total node count is known; the
   * indeterminate shimmer otherwise. Once "Streaming ready" has latched, the
   * bar stays full — the load is settled and late jitter must not pull it back.
   */
  private _updateProgress(status: StreamingStatus): void {
    if (this._streamReady) return;
    const p = streamingProgress(status);
    this._progress.classList.remove('olv-hidden');
    this._progressNodes.textContent = p.nodesLabel;
    this._progressPoints.textContent = p.pointsLabel;
    if (p.determinate && p.fraction != null) {
      this._progressTrack.classList.remove('olv-stream-prog-shimmer');
      const pct = Math.round(p.fraction * 100);
      this._progressFill.style.width = `${pct}%`;
      this._progressTrack.setAttribute('aria-valuenow', String(pct));
    } else {
      // Total unknown — honest indeterminate shimmer, no fabricated percentage.
      this._progressTrack.classList.add('olv-stream-prog-shimmer');
      this._progressFill.style.width = '0%';
      this._progressTrack.removeAttribute('aria-valuenow');
    }
  }

  /** Populate the saved-views list. */
  setViews(names: string[]): void {
    if (names.length === 0) {
      this._views.replaceChildren(
        el('div', { className: 'olv-streaming-empty', text: 'No saved views yet' }),
      );
      return;
    }
    this._views.replaceChildren(
      ...names.map((name, index) => {
        const apply = el('button', { className: 'olv-streaming-view-name', text: name });
        apply.addEventListener('click', () => this._callbacks.onApplyView(index));
        const del = el('button', {
          className: 'olv-streaming-view-del',
          text: '×',
          ariaLabel: `Delete ${name}`,
        });
        del.addEventListener('click', () => this._callbacks.onDeleteView(index));
        return el('div', { className: 'olv-streaming-view' }, [apply, del]);
      }),
    );
  }

  private _statRow(label: string, value: HTMLElement): HTMLElement {
    return el('div', { className: 'olv-streaming-row' }, [
      el('span', { className: 'olv-streaming-key', text: label }),
      value,
    ]);
  }

  private _value(text: string, title?: string): HTMLElement {
    return el('span', { className: 'olv-streaming-stat', text, title });
  }

  private _selectMode(mode: ColorMode): void {
    for (const [m, chip] of this._modeButtons) {
      chip.classList.toggle('olv-chip-active', m === mode);
    }
  }

  private _selectQuality(quality: StreamingQuality): void {
    const chips = [...this._qualityRow.children] as HTMLButtonElement[];
    chips.forEach((chip, i) => {
      chip.classList.toggle('olv-chip-active', QUALITIES[i] === quality);
    });
  }
}
