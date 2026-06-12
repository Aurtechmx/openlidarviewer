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

/** Render a byte count compactly. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Render a world dimension — coarse for large extents, finer for small ones. */
function formatDim(n: number): string {
  const v = Math.abs(n);
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

/** The streaming-scan panel. */
export class StreamingPanel {
  readonly element: HTMLElement;
  private readonly _callbacks: StreamingPanelCallbacks;
  private readonly _title: HTMLElement;
  private readonly _phase: HTMLElement;
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
  }

  /** Set the high-level load phase line. */
  setPhase(phase: string): void {
    this._phase.textContent = phase;
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
      this._statRow('Spacing', this._value(summary.spacing.toFixed(2))),
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

  /** Update the live status numbers. */
  setStatus(status: StreamingStatus): void {
    this._nodes.textContent = `${status.loadedNodes} / ${status.knownNodes}`;
    this._points.textContent = `${formatCount(status.displayedPoints)} / ${formatCount(
      status.sourcePoints,
    )}`;
    this._cache.textContent = formatBytes(status.cacheBytes);
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
