/**
 * StreamingPanel.ts
 *
 * The user-facing panel for a streaming COPC scan: a metadata scan summary,
 * the live load phase and status (nodes, points, cache), and the streaming
 * controls (colour, quality, pause/resume, clear cache, full-cloud grade).
 *
 * Saved camera views are NOT here. No panel renders them: they are reached
 * through the command palette, whose actions in `src/app/actionDefinitions.ts`
 * are the only surface the bookmark store has.
 *
 * It is calm by design — a few clear sections, no technical noise. The deep
 * counters belong to the `?debug=1` overlay, not here.
 */

import { clamp01 } from '../numeric';
import { el, formatCount } from './dom';
import { CURATED_LICENSE_LABELS, curatedCreditFor } from '../io/catalog/curatedLocations';
import { formatByteSize as formatBytes } from '../io/formatByteSize';
import type { ColorMode } from '../render/colorModes';
import type { StreamingQuality } from '../render/streaming/streamingBudget';
import type { CrsLinearUnit } from '../io/crs';

/**
 * The CRS facts the spacing row needs to state its unit honestly — a structural
 * subset of `CrsInfo`, so `cloud.crs()` (which returns a full `CrsInfo`) is
 * assignable without coupling the panel to the loader's shape.
 */
export interface SpacingCrs {
  /** Horizontal linear unit. `'unknown'` / absent ⇒ spacing shown in source units. */
  readonly linearUnit?: CrsLinearUnit;
  /** Linear unit → metres factor (1 metre, ~0.3048 foot). Used to convert feet to m. */
  readonly linearUnitToMetres?: number;
  /** Geographic (degrees) CRS — a linear spacing is undefined. */
  readonly isGeographic?: boolean;
}

/** Live status numbers for the panel. */
export interface StreamingStatus {
  loadedNodes: number;
  knownNodes: number;
  displayedPoints: number;
  /** Total in the source, or null when the source cannot state one. */
  sourcePoints: number | null;
  cacheBytes: number;
}

/** The streaming formats the panel labels a scan with. */
export type StreamingSummaryFormat = 'copc' | 'ept' | '3dtiles';

/**
 * The card title, per format. It is rebuilt on every `setSummary`, so a scan
 * opened over another one cannot keep the previous format's name, and
 * {@link DEFAULT_TITLE} is what `hide()` returns it to when no scan is
 * streaming. A format missing from this table falls back to the neutral title
 * rather than to whichever entry happened to be the else-branch.
 */
const DEFAULT_TITLE = 'Streaming scan';
const FORMAT_TITLE: Record<StreamingSummaryFormat, string> = {
  copc: 'Streaming COPC',
  ept: 'Streaming EPT',
  '3dtiles': 'Streaming 3D Tiles',
};

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
  /** Total in the source, or null when the source cannot state one. */
  sourcePoints: number | null;
  width: number;
  depth: number;
  height: number;
  /**
   * The source's own resolution figure: COPC's root-node spacing, EPT's node
   * budget. Absent where the format states neither — a 3D Tiles tileset
   * declares no point spacing, and the resolution row is omitted rather than
   * shown as a dash a future number could appear in.
   */
  spacing?: number;
  octreeDepth: number;
  nodeCount: number;
  /** which streaming format the source is. */
  format?: StreamingSummaryFormat;
  /** EPT-only: schema summary string for the Format row. */
  schemaSummary?: string;
  /**
   * Source CRS, when known — carried so the COPC `spacing` row can state its
   * unit honestly (metre / foot→m / source units / geographic) instead of
   * unconditionally labelling the CRS-unit distance "m". Absent ⇒ the unit is
   * unconfirmed and the spacing is shown in source units.
   */
  crs?: SpacingCrs | null;
}

/** Callbacks the panel raises. */
export interface StreamingPanelCallbacks {
  onColorMode(mode: ColorMode): void;
  onQuality(quality: StreamingQuality): void;
  onPauseToggle(paused: boolean): void;
  onClearCache(): void;
  /** Run the full-cloud grade (decode a representative octree sample + grade it). */
  onGradeFullCloud(): void;
  /** Cancel a full-cloud grade that is currently running. */
  onCancelGrade(): void;
}

/** Friendly labels for each colour mode. */
const MODE_LABEL: Record<ColorMode, string> = {
  rgb: 'Color',
  intensity: 'Intensity',
  elevation: 'Height',
  classification: 'Class',
  normal: 'Normal',
  density: 'Density',
  gpsTime: 'GPS time',
  returnNumber: 'Return',
  // Streaming clouds don't expose the Coverage / Confidence modes (they're
  // static-terrain products); the labels are here only to satisfy the
  // exhaustive ColorMode map.
  coverage: 'Coverage',
  confidence: 'Confidence',
};

const QUALITIES: StreamingQuality[] = ['low', 'balanced', 'high'];

/** Grade button labels — it toggles between starting and cancelling a run. */
const GRADE_LABEL = 'Grade full cloud';
const GRADE_CANCEL_LABEL = 'Cancel grade';

/** Render a world dimension — coarse for large extents, finer for small ones. */
function formatDim(n: number): string {
  const v = Math.abs(n);
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

/**
 * Label + value for the resolution row of the scan summary.
 *
 * COPC's metadata `spacing` is a METRIC root-node point spacing in the dataset's
 * CRS units. EPT's `span` is a DIMENSIONLESS points-per-tile budget (the octree
 * resolution analogue), NOT a distance — feeding it into the same bare "Spacing"
 * row read as "128 m" of spacing, a label-vs-value drift. EPT therefore gets its
 * own "Node budget" label and a "pts/node" value so the number is never mistaken
 * for a distance.
 *
 * The COPC spacing FAILS CLOSED on its unit, the same gate the rest of the
 * platform applies: it is only labelled "m" when the CRS declares a metre unit;
 * a foot CRS is converted to metres, a geographic CRS has no linear spacing at
 * all, and an unknown / absent unit is shown in raw source units rather than
 * stamped "m". Previously the value was unconditionally suffixed " m", so a
 * state-plane-FEET COPC read ~3.28× too large mislabelled as metres.
 *
 * Pure + DOM-free so the decision is unit-tested without standing up the panel.
 */
export function spacingRowFor(
  format: StreamingSummaryFormat | undefined,
  spacing: number,
  crs?: SpacingCrs | null,
): { readonly label: string; readonly value: string; readonly title: string } {
  if (format === 'ept') {
    return {
      label: 'Node budget',
      value: `~${Math.round(spacing).toLocaleString()} pts/node`,
      title: 'EPT octree resolution — target points per node, not a metric spacing.',
    };
  }
  // COPC: spacing is a root-node point spacing in the dataset's CRS units.
  if (crs?.isGeographic) {
    // Degrees of longitude are not a linear distance; a "spacing in metres"
    // would be latitude-dependent and is not defined here.
    return {
      label: 'Spacing',
      value: '— (geographic CRS)',
      title: 'Spacing is not a linear distance for a geographic (degrees) CRS.',
    };
  }
  if (crs?.linearUnit === 'metre') {
    return {
      label: 'Spacing',
      value: `${spacing.toFixed(2)} m`,
      title: 'Root-node point spacing in metres.',
    };
  }
  if (crs?.linearUnit === 'foot' || crs?.linearUnit === 'us-survey-foot') {
    // Spacing is in feet; convert to metres so the number is comparable.
    const factor = crs.linearUnitToMetres;
    const metres = Number.isFinite(factor) ? spacing * (factor as number) : spacing;
    return {
      label: 'Spacing',
      value: `${metres.toFixed(2)} m`,
      title: 'Root-node point spacing, converted from the source foot unit to metres.',
    };
  }
  // Unknown / absent linear unit — fail closed: show the raw source figure and
  // do NOT claim metres.
  return {
    label: 'Spacing',
    value: `${spacing.toFixed(2)} (source units)`,
    title: 'Linear unit unconfirmed — spacing shown in the source CRS units, not metres.',
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
    ? clamp01(status.loadedNodes / known)
    : null;
  return {
    fraction,
    determinate,
    nodesLabel: `${status.loadedNodes} / ${determinate ? known : '?'} nodes resident`,
    pointsLabel: `${pointsMillions(status.displayedPoints)} / ${
      status.sourcePoints === null ? '?' : pointsMillions(status.sourcePoints)
    } pts`,
  };
}

/** The streaming-scan panel. */
export class StreamingPanel {
  readonly element: HTMLElement;
  private readonly _callbacks: StreamingPanelCallbacks;
  private readonly _title: HTMLElement;
  private readonly _phase: HTMLElement;
  private readonly _credit: HTMLElement;
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
  private readonly _pause: HTMLButtonElement;
  // Full-cloud grade: a button that decodes a representative octree
  // sample across the whole cloud and grades it, plus a result/status area.
  private readonly _gradeBtn: HTMLButtonElement;
  private readonly _gradeResult: HTMLElement;
  /** True while a grade is running — flips the grade button into a Cancel control. */
  private _gradeRunning = false;
  private _modeButtons = new Map<ColorMode, HTMLButtonElement>();
  private _paused = false;

  constructor(callbacks: StreamingPanelCallbacks) {
    this._callbacks = callbacks;

    this._phase = el('div', { className: 'olv-streaming-phase', text: 'Detecting COPC…' });
    // Several curated sources make crediting the publisher a condition of
    // use, so the credit belongs on screen while their data is, not only
    // on the credits page. Hidden until a source that needs one loads.
    this._credit = el('div', { className: 'olv-streaming-credit olv-hidden' });

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

    // ── Full-cloud grade ──
    // The resident view only shows the nodes the camera pulled in; this button
    // decodes a representative breadth-first sample across the WHOLE octree and
    // grades its density, vertical extent, and footprint coverage — with an
    // honest "exact vs sampled at N%" label so the figure never implies a
    // completeness it doesn't have.
    this._gradeBtn = el('button', { className: 'olv-streaming-btn', text: GRADE_LABEL });
    // One button, two roles: it starts the grade, and while a grade runs it
    // becomes a Cancel control. Branch on the running flag so a single click
    // handler serves both without a second button.
    this._gradeBtn.addEventListener('click', () => {
      if (this._gradeRunning) this._callbacks.onCancelGrade();
      else this._callbacks.onGradeFullCloud();
    });
    this._gradeResult = el('div', { className: 'olv-streaming-grade-result' });
    this._gradeResult.style.display = 'none';

    // The title's text is rebuilt from setSummary's `format` field so it
    // tracks the actual streaming source rather than the initial hardcoded
    // label, and `hide()` puts it back so a closed scan's format does not name
    // the next one.
    this._title = el('div', { className: 'olv-streaming-title', text: DEFAULT_TITLE });
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
      el('div', { className: 'olv-streaming-label', text: 'Full-cloud grade' }),
      el('div', { className: 'olv-streaming-actions' }, [this._gradeBtn]),
      this._gradeResult,
      el('div', { className: 'olv-streaming-actions' }, [this._pause]),
      el('div', { className: 'olv-streaming-actions' }, [clearCache]),
      this._credit,
    ]);
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
    // The Scan section describes the scan that was streaming. It is not reset
    // anywhere else, so leaving it here carried a closed scan's File, Format,
    // Source, Extent and Octree rows — and its format title — into the next
    // open, where they read as that scan's figures until a `setSummary` for the
    // new one replaced them.
    this._title.textContent = DEFAULT_TITLE;
    this._summary.replaceChildren();
    this._paused = false;
    this._pause.textContent = 'Pause';
    // Reset the progress treatment for the next scan.
    this._streamReady = false;
    this._progress.classList.add('olv-hidden');
    this._progressTrack.classList.remove('olv-stream-prog-shimmer');
    this._progressFill.style.width = '0%';
    // Reset the full-cloud grade affordance for the next scan.
    this._gradeRunning = false;
    this._gradeBtn.disabled = false;
    this._gradeBtn.textContent = GRADE_LABEL;
    this._gradeResult.style.display = 'none';
    this._gradeResult.replaceChildren();
    this._gradeResult.classList.remove('olv-streaming-grade-error');
  }

  /**
   * Set the high-level load phase line.
   *
   * The terminal "Streaming ready" phase latches a sticky 100% on the bar
   * (`_streamReady`) so the determinate fill reads full and stops reacting to
   * late counter jitter; any earlier phase un-latches it.
   */
  /**
   * Show the credit a curated source requires, for the URL being streamed.
   *
   * A URL this catalog does not know carries no credit obligation here, so
   * the line hides rather than inventing one.
   */
  setSourceUrl(url: string): void {
    const credit = curatedCreditFor(url);
    this._credit.replaceChildren();
    if (!credit) {
      this._credit.classList.add('olv-hidden');
      return;
    }
    this._credit.classList.remove('olv-hidden');
    this._credit.append(credit.attribution);
    if (credit.licenseUrl !== 'unknown') {
      const a = el('a', { text: CURATED_LICENSE_LABELS[credit.licenseId], href: credit.licenseUrl });
      a.target = '_blank';
      a.rel = 'noreferrer';
      this._credit.append(' · ', a);
    }
  }

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
    // COPC", then a two-way EPT-or-COPC branch, which named a third format's
    // scan "Streaming COPC" for the same reason the hardcode did.
    this._title.textContent =
      summary.format === undefined ? DEFAULT_TITLE : FORMAT_TITLE[summary.format];
    const file = this._statRow('File', this._value(summary.fileName, summary.fileName));
    // format-aware Format row. COPC shows the LAS PDRF; EPT shows the schema
    // summary (when supplied) or just "EPT"; 3D Tiles carries no LAS header, so
    // it states the format and the tile type it serves and no record format.
    let formatText: string;
    if (summary.format === 'ept') {
      formatText = summary.schemaSummary ? `EPT · ${summary.schemaSummary}` : 'EPT';
    } else if (summary.format === '3dtiles') {
      formatText = '3D Tiles · pnts';
    } else {
      formatText = `COPC LAZ · PDRF ${summary.pointFormat}`;
    }
    const rows = [
      file,
      this._statRow('Format', this._value(formatText)),
      this._statRow('Source', this._value(
        summary.sourcePoints === null
          ? 'Unknown from source metadata'
          : `${formatCount(summary.sourcePoints)} points`,
      )),
      this._statRow(
        'Extent',
        this._value(
          `${formatDim(summary.width)} × ${formatDim(summary.depth)} × ${formatDim(summary.height)}`,
        ),
      ),
    ];
    // COPC `spacing` is a metric distance; EPT `span` is a points-per-tile
    // budget. `spacingRowFor` labels + units each correctly so neither is
    // misread (see its doc-comment for the label-vs-value drift it fixes). A
    // format that states neither gets no row at all — a dash here would be a
    // slot a number could later appear in without a source having stated one.
    if (summary.spacing !== undefined) {
      const r = spacingRowFor(summary.format, summary.spacing, summary.crs);
      rows.push(this._statRow(r.label, this._value(r.value, r.title)));
    }
    rows.push(
      this._statRow(
        'Octree',
        this._value(`depth ${summary.octreeDepth} · ${summary.nodeCount} nodes`),
      ),
    );
    this._summary.replaceChildren(...rows);
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

  /**
   * Mark the grade busy with a progress line. The button stays ENABLED and
   * becomes a Cancel control (re-entry is guarded by the caller's running flag,
   * so the button's job while busy is to let the user cancel a slow decode).
   */
  setGradeBusy(text: string): void {
    this._gradeBtn.textContent = GRADE_CANCEL_LABEL;
    this._gradeRunning = true;
    this._showGrade(false, this._gradeLine(text));
  }

  /**
   * Render the finished full-cloud grade: the honest coverage scope label
   * (exact vs sampled at N%), the summary lines, and an optional honesty note.
   * Resets the button to "Grade" so it can be re-run after the view changes.
   */
  setGradeResult(coverageLabel: string, lines: readonly string[], note: string): void {
    const kids: HTMLElement[] = [
      el('div', { className: 'olv-streaming-grade-scope', text: coverageLabel }),
    ];
    for (const l of lines) kids.push(this._gradeLine(l));
    if (note) kids.push(el('div', { className: 'olv-streaming-grade-note', text: note }));
    this._endGradeRun();
    this._showGrade(false, ...kids);
  }

  /** Show an error against the grade action and reset the button to "Grade". */
  setGradeError(text: string): void {
    this._endGradeRun();
    this._showGrade(true, this._gradeLine(text));
  }

  /** Neutral end state for a user-cancelled grade (not an error). */
  setGradeCancelled(): void {
    this._endGradeRun();
    this._showGrade(false, this._gradeLine('Grade cancelled.'));
  }

  /** One grade-result line. */
  private _gradeLine(text: string): HTMLElement {
    return el('div', { className: 'olv-streaming-grade-line', text });
  }

  /** Reveal the result box with `kids`, toggling the error styling. */
  private _showGrade(isError: boolean, ...kids: HTMLElement[]): void {
    this._gradeResult.style.display = '';
    this._gradeResult.classList.toggle('olv-streaming-grade-error', isError);
    this._gradeResult.replaceChildren(...kids);
  }

  /** Shared reset: clear the running flag and restore the "Grade" label. */
  private _endGradeRun(): void {
    this._gradeRunning = false;
    this._gradeBtn.disabled = false;
    this._gradeBtn.textContent = GRADE_LABEL;
  }

  /** Update the live status numbers + the determinate progress treatment. */
  setStatus(status: StreamingStatus): void {
    this._nodes.textContent = `${status.loadedNodes} / ${status.knownNodes}`;
    this._points.textContent = `${formatCount(status.displayedPoints)} / ${
      status.sourcePoints === null ? 'Unknown' : formatCount(status.sourcePoints)
    }`;
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
