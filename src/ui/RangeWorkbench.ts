/**
 * RangeWorkbench.ts — the acquisition grid, on screen at last.
 *
 * A scanner's grid has been decoded, carried across the worker boundary and
 * stored on the cloud since v0.6.6, and nothing in the interface layer read a
 * byte of it. This is the surface that does: a 2D raster of one frame, the
 * diagnostics that describe it, and the identity link in both directions.
 *
 * THE SPLIT THAT MATTERS. Every decision — which source cell a display pixel
 * shows, what colour a cell takes, whether a cell can name a display record and
 * what to say when it cannot — lives in `diagnostics/rangeRaster.ts` and
 * `diagnostics/rangeCellLink.ts`, which are pure and tested under Node. This
 * file is the canvas adapter and the DOM around it: it copies bytes, positions
 * a marker, and writes strings it was given. A rendering bug here is visible; a
 * mapping bug there would not be, which is why the mapping is not here.
 *
 * WHAT IS NOT HERE, DELIBERATELY. There is no returns view and no residual
 * view. The per-cell return description is optional and no shipping loader
 * populates it, so a returns view would be a mode that is empty for every file
 * a user can currently open. There is no colour-menu entry either: these are
 * views of the acquisition grid, not of the display cloud, and offering them
 * beside the cloud's own colour modes would imply they colour the same thing.
 */

import {
  CELL_STATE_LABEL,
  CELL_STATES,
  type CellStateValue,
  type OrganizedRangeFrame,
  type OrganizedRangeSet,
} from '../model/OrganizedRange';
import {
  CELL_STATE_RGB,
  RANGE_ABSENT_RGB,
  cellForRecord,
  displayPixelOf,
  planRangeRaster,
  rangeDomainOf,
  rangeRampRgb,
  rasterizeRangeFrame,
  sourceCellAt,
  type RangeRasterMode,
  type RasterPlan,
  type Rgb,
} from '../diagnostics/rangeRaster';
import { cellText, linkageText, resolveCellLink } from '../diagnostics/rangeCellLink';
import {
  buildAcquisitionCoverage,
  type AcquisitionCoverageIndex,
  type RecordPosition,
  type UpAxis,
} from '../model/acquisitionCoverage';
import {
  summariseRangeFrame,
  type BandCoverage,
  type RangeFrameSummary,
} from '../diagnostics/rangeFrameDiagnostics';
import { el } from './dom';

/** The largest raster this widget ever builds, whatever the grid's size. */
const MAX_RASTER_WIDTH = 720;
const MAX_RASTER_HEIGHT = 480;

const css = (rgb: Rgb): string => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;

/** Percent to one decimal, or an em dash when the fraction does not exist. */
function pct(fraction: number | null): string {
  return fraction === null ? '—' : `${(fraction * 100).toFixed(1)}%`;
}

/**
 * A range figure in the frame's own units.
 *
 * No unit suffix is appended. Geometric range is expressed in the source's own
 * units and the frame declares none, so printing "m" here would assert a unit
 * the file never stated. Three decimals is the display convention the rest of
 * the app uses for a linear quantity.
 */
function rangeNum(v: number | null): string {
  return v === null ? 'Not available' : v.toFixed(3);
}

export interface RangeWorkbenchOptions {
  readonly set: OrganizedRangeSet;
  /** The layer the set belongs to, for the identity link. */
  readonly layerId: string;
  /** Ask the renderer to mark a display record, or clear with null. */
  readonly onHighlightRecord?: (record: number | null) => void;
  /** Record → position, for the set-level acquisition-extent summary. */
  readonly recordPosition?: RecordPosition;
  /** The layer's up axis, so the extent fit projects onto the ground plane. */
  readonly upAxis?: UpAxis;
}

/**
 * The docked workbench. Owns one `element`; the host reveals and disposes it.
 */
export class RangeWorkbench {
  readonly element: HTMLElement;

  private readonly _set: OrganizedRangeSet;
  private readonly _opts: RangeWorkbenchOptions;
  /** Fitted once from the whole set; null when no record positions were supplied. */
  private readonly _coverage: AcquisitionCoverageIndex | null;
  private _frameIndex = 0;
  private _mode: RangeRasterMode = 'validity';
  private _plan: RasterPlan = { sourceWidth: 0, sourceHeight: 0, displayWidth: 0, displayHeight: 0 };

  private readonly _canvas: HTMLCanvasElement;
  private readonly _marker: HTMLElement;
  private readonly _hover: HTMLElement;
  private readonly _readout: HTMLElement;
  private readonly _readoutDetail: HTMLElement;
  private readonly _legend: HTMLElement;
  private readonly _stats: HTMLElement;
  private readonly _linkage: HTMLElement;
  private readonly _modeButtons = new Map<RangeRasterMode, HTMLButtonElement>();

  constructor(opts: RangeWorkbenchOptions) {
    this._set = opts.set;
    this._opts = opts;
    // Fit the per-setup interrogation extent once, from the set's own valid
    // cells. Null when the mount supplied no record positions; the summary then
    // omits rather than inventing an extent.
    this._coverage = opts.recordPosition
      ? buildAcquisitionCoverage(this._set, {
          recordPosition: opts.recordPosition,
          upAxis: opts.upAxis,
        })
      : null;

    this.element = el('div', { className: 'olv-range-workbench' });
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Range frame workbench');

    const bar = el('div', { className: 'olv-range-bar' });

    if (this._set.frames.length > 1) {
      const label = el('label', { className: 'olv-range-frame-label', text: 'Scanner setup' });
      const select = el('select', { className: 'olv-range-frame-select' });
      this._set.frames.forEach((f, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = `${f.id} (${f.width} × ${f.height})`;
        select.append(option);
      });
      select.addEventListener('change', () => {
        this._frameIndex = Number(select.value) || 0;
        this._clearReadout();
        this.refresh();
      });
      label.append(select);
      bar.append(label);
    }

    const modes = el('div', { className: 'olv-range-modes' });
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'View mode');
    for (const [mode, text] of [
      ['validity', 'Validity'],
      ['range', 'Geometric range'],
    ] as ReadonlyArray<readonly [RangeRasterMode, string]>) {
      const btn = el('button', { className: 'olv-range-mode', text });
      btn.type = 'button';
      btn.addEventListener('click', () => this.setMode(mode));
      this._modeButtons.set(mode, btn);
      modes.append(btn);
    }
    bar.append(modes);

    this._linkage = el('div', { className: 'olv-range-linkage' });

    const stage = el('div', { className: 'olv-range-stage' });
    this._canvas = document.createElement('canvas');
    this._canvas.className = 'olv-range-canvas';
    this._marker = el('div', { className: 'olv-range-marker olv-hidden' });
    stage.append(this._canvas, this._marker);

    this._hover = el('div', { className: 'olv-range-hover' });
    this._canvas.addEventListener('mousemove', (e) => this._onHover(e));
    this._canvas.addEventListener('mouseleave', () => {
      this._hover.textContent = '';
    });
    this._canvas.addEventListener('click', (e) => this._onClick(e));

    this._readout = el('div', { className: 'olv-range-readout-head' });
    this._readoutDetail = el('p', { className: 'olv-range-readout-detail' });
    const readout = el('div', { className: 'olv-range-readout' });
    readout.setAttribute('role', 'status');
    readout.append(this._readout, this._readoutDetail);

    this._legend = el('div', { className: 'olv-range-legend' });
    this._stats = el('div', { className: 'olv-range-stats' });

    this.element.append(bar, this._linkage, stage, this._hover, readout, this._legend, this._stats);
    this._clearReadout();
    this.refresh();
  }

  /** The frame currently shown. */
  get frame(): OrganizedRangeFrame {
    return this._set.frames[Math.min(this._frameIndex, this._set.frames.length - 1)];
  }

  setMode(mode: RangeRasterMode): void {
    if (this._mode === mode) return;
    this._mode = mode;
    this.refresh();
  }

  /** Redraw the raster, the legend and the diagnostics for the current frame. */
  refresh(): void {
    const frame = this.frame;
    for (const [mode, btn] of this._modeButtons) {
      btn.classList.toggle('is-active', mode === this._mode);
      btn.setAttribute('aria-pressed', mode === this._mode ? 'true' : 'false');
    }

    this._linkage.textContent = `${linkageText(frame.linkage)} · acquisition grid ${frame.width} × ${frame.height}`;

    this._plan = planRangeRaster(
      frame.width,
      frame.height,
      MAX_RASTER_WIDTH,
      MAX_RASTER_HEIGHT,
    );
    const raster = rasterizeRangeFrame(frame, this._mode, this._plan);
    this._canvas.width = Math.max(1, this._plan.displayWidth);
    this._canvas.height = Math.max(1, this._plan.displayHeight);
    const ctx = this._canvas.getContext('2d');
    if (ctx && this._plan.displayWidth > 0 && this._plan.displayHeight > 0) {
      const image = ctx.createImageData(this._plan.displayWidth, this._plan.displayHeight);
      image.data.set(raster.pixels);
      ctx.putImageData(image, 0, 0);
    }

    this._renderLegend(frame);
    this._renderStats(summariseRangeFrame(frame));
    this._marker.classList.add('olv-hidden');
  }

  /**
   * Mark the cell an inspected display record came from — the 3D to 2D half of
   * the link.
   *
   * The record is resolved through the frame's own `cellToRecord`, so a record
   * this grid did not produce marks nothing and says so. A frame whose linkage
   * is unavailable never matches, because the indices were erased rather than
   * left readable.
   */
  showRecord(record: number): void {
    for (let i = 0; i < this._set.frames.length; i++) {
      const cell = cellForRecord(this._set.frames[i], record);
      if (!cell) continue;
      if (i !== this._frameIndex) {
        this._frameIndex = i;
        this.refresh();
      }
      const at = displayPixelOf(this._plan, cell.row, cell.column);
      if (at) this._placeMarker(at.x, at.y);
      this._setReadout(
        `Display record ${record} came from ${cellText(cell.row, cell.column).toLowerCase()}`,
        `Frame ${this._set.frames[i].id}. The loader recorded this cell as the source of the inspected record.`,
      );
      return;
    }
    this._marker.classList.add('olv-hidden');
    this._setReadout(
      `Display record ${record} has no cell in this acquisition grid`,
      'No frame in this layer records that record as its own, so no cell is marked. Nothing near it is marked in its place.',
    );
  }

  /** Release the marker and drop the highlight the workbench asked for. */
  dispose(): void {
    this._opts.onHighlightRecord?.(null);
  }

  private _placeMarker(x: number, y: number): void {
    const w = Math.max(1, this._plan.displayWidth);
    const h = Math.max(1, this._plan.displayHeight);
    this._marker.style.left = `${((x + 0.5) / w) * 100}%`;
    this._marker.style.top = `${((y + 0.5) / h) * 100}%`;
    this._marker.classList.remove('olv-hidden');
  }

  /** Display-pixel coordinates for a pointer event over the canvas. */
  private _displayAt(e: MouseEvent): { x: number; y: number } | null {
    const rect = this._canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((e.clientX - rect.left) / rect.width) * this._plan.displayWidth,
      y: ((e.clientY - rect.top) / rect.height) * this._plan.displayHeight,
    };
  }

  private _onHover(e: MouseEvent): void {
    const at = this._displayAt(e);
    const cell = at ? sourceCellAt(this._plan, at.x, at.y) : null;
    if (!cell) {
      this._hover.textContent = '';
      return;
    }
    const frame = this.frame;
    const idx = cell.row * frame.width + cell.column;
    const state = frame.cellState[idx] as CellStateValue;
    const parts = [cellText(cell.row, cell.column), CELL_STATE_LABEL[state] ?? 'Unknown cell state'];
    const range = frame.geometricRange ? frame.geometricRange[idx] : undefined;
    if (range !== undefined) {
      parts.push(
        Number.isFinite(range)
          ? `geometric range ${range.toFixed(3)}`
          : 'geometric range not available for this cell',
      );
    }
    this._hover.textContent = parts.join(' · ');
  }

  private _onClick(e: MouseEvent): void {
    const at = this._displayAt(e);
    const cell = at ? sourceCellAt(this._plan, at.x, at.y) : null;
    if (!cell) return;
    const pixel = at ? { x: Math.floor(at.x), y: Math.floor(at.y) } : null;
    if (pixel) this._placeMarker(pixel.x, pixel.y);
    const resolution = resolveCellLink(this.frame, cell.row, cell.column);
    this._setReadout(resolution.headline, resolution.detail);
    // A refusal clears any previous mark rather than leaving the last successful
    // one on screen, where it would read as this cell's answer.
    this._opts.onHighlightRecord?.(resolution.kind === 'linked' ? resolution.record : null);
  }

  private _clearReadout(): void {
    this._setReadout(
      'Select a cell',
      'A cell resolves to the display record the loader decoded it from, or explains why no record can be named.',
    );
  }

  private _setReadout(headline: string, detail: string): void {
    this._readout.textContent = headline;
    this._readoutDetail.textContent = detail;
  }

  private _renderLegend(frame: OrganizedRangeFrame): void {
    this._legend.replaceChildren();
    const swatch = (rgb: Rgb, text: string): HTMLElement => {
      const row = el('span', { className: 'olv-range-key' });
      const box = el('span', { className: 'olv-range-swatch' });
      box.style.background = css(rgb);
      row.append(box, el('span', { text }));
      return row;
    };

    if (this._mode === 'validity') {
      for (const state of CELL_STATES) {
        this._legend.append(swatch(CELL_STATE_RGB[state], CELL_STATE_LABEL[state]));
      }
      return;
    }

    const domain = rangeDomainOf(frame);
    if (!domain) {
      this._legend.append(
        el('p', {
          className: 'olv-range-note',
          text: 'This acquisition grid carries no geometric range, so there is no scale to show.',
        }),
      );
      this._legend.append(swatch(RANGE_ABSENT_RGB, 'No geometric range'));
      return;
    }
    this._legend.append(swatch(rangeRampRgb(0), `Nearest ${domain.min.toFixed(3)}`));
    this._legend.append(swatch(rangeRampRgb(0.5), 'Between'));
    this._legend.append(swatch(rangeRampRgb(1), `Farthest ${domain.max.toFixed(3)}`));
    this._legend.append(swatch(RANGE_ABSENT_RGB, 'No geometric range'));
    this._legend.append(
      el('p', {
        className: 'olv-range-note',
        text: 'Geometric range is a distance in the scanner setup’s own acquisition frame, in the source’s own units. A cell with no return carries no range and is drawn in the flat swatch, never at the near end of the scale.',
      }),
    );
  }

  /**
   * The diagnostics module's summary, rendered.
   *
   * Only what the frame supports: a frame with no `geometricRange` gets NO
   * range block, rather than a block of zeros. Zero is a measurement; absent is
   * not, and a table that prints 0.000 for a frame that never carried a range
   * has invented one.
   */
  private _renderStats(summary: RangeFrameSummary): void {
    this._stats.replaceChildren();

    const validity = el('div', { className: 'olv-range-stat-block' });
    validity.append(el('h4', { text: 'Cell validity' }));
    const table = el('table', { className: 'olv-range-table' });
    for (const state of CELL_STATES) {
      const share = summary.validity.byState[state];
      const tr = el('tr');
      tr.append(
        el('th', { text: CELL_STATE_LABEL[state] }),
        el('td', { text: String(share.count) }),
        el('td', { text: pct(share.fraction) }),
      );
      table.append(tr);
    }
    const total = el('tr', { className: 'olv-range-total' });
    total.append(el('th', { text: 'Cells' }), el('td', { text: String(summary.validity.cells) }), el('td'));
    table.append(total);
    validity.append(table);
    this._stats.append(validity);

    if (summary.range) {
      const r = summary.range;
      const block = el('div', { className: 'olv-range-stat-block' });
      block.append(el('h4', { text: 'Geometric range' }));
      const rt = el('table', { className: 'olv-range-table' });
      const row = (name: string, value: string): void => {
        const tr = el('tr');
        tr.append(el('th', { text: name }), el('td', { text: value }));
        rt.append(tr);
      };
      row('Cells with a range', String(r.finiteCount));
      row('Returns with no representable range', String(r.excludedNonFinite));
      row('Cells that never carried a range', String(r.cellsWithoutRange));
      row('Nearest', rangeNum(r.min));
      row('Farthest', rangeNum(r.max));
      row('Median', rangeNum(r.median));
      row('95th percentile', rangeNum(r.p95));
      block.append(rt);
      this._stats.append(block);
    }

    const coverage = el('div', { className: 'olv-range-stat-block' });
    coverage.append(el('h4', { text: 'Sampling coverage' }));
    coverage.append(
      el('p', {
        className: 'olv-range-note',
        text: 'The share of each band this session delivered a record for. It says where the decoded cells fall on the acquisition grid and nothing about what those returns represent.',
      }),
    );
    coverage.append(this._bandRow('Columns', summary.coverage.columnBands));
    coverage.append(this._bandRow('Rows', summary.coverage.rowBands));
    this._stats.append(coverage);

    this._appendAcquisitionExtent();
  }

  /**
   * A set-level summary of the interrogation extent: how many scanner setups
   * have an angular extent this session could fit, and how many did not.
   *
   * The wording is load-bearing. "Interrogated" here means a ray addressed the
   * direction, NOT that a surface was seen there — a NO_RETURN cell is still
   * interrogated, and occlusion is not handled, so the extent is an upper bound.
   * This block is a set-level fact, not a per-frame one, so it is drawn from the
   * index fitted once in the constructor and does not depend on the shown frame.
   */
  private _appendAcquisitionExtent(): void {
    const index = this._coverage;
    if (!index) return;

    const total = this._set.frames.length;
    const fitted = index.setups.length;

    const block = el('div', { className: 'olv-range-stat-block olv-range-coverage' });
    block.append(el('h4', { text: 'Acquisition extent' }));
    block.append(
      el('p', {
        className: 'olv-range-note',
        text: `An interrogation extent was fitted for ${fitted} of ${total} scanner ${total === 1 ? 'setup' : 'setups'}. A fitted setup can answer whether a position lay within the directions its grid addressed; ${index.unfittedFrames} ${index.unfittedFrames === 1 ? 'setup was' : 'setups were'} too sparse to fit and answer indeterminate.`,
      }),
    );
    block.append(
      el('p', {
        className: 'olv-range-note',
        text: 'Interrogated means a ray addressed the direction — including cells that returned nothing — not that a surface was visible there. Occlusion is not modelled, so this is an upper bound on what was seen, not a measurement of coverage.',
      }),
    );
    this._stats.append(block);
  }

  private _bandRow(name: string, bands: readonly BandCoverage[]): HTMLElement {
    const wrap = el('div', { className: 'olv-range-bands' });
    wrap.append(el('span', { className: 'olv-range-bands-name', text: name }));
    for (const band of bands) {
      const cell = el('span', {
        className: 'olv-range-band',
        text: pct(band.decodedFraction),
        title: `${name} ${band.start} to ${band.end - 1}: ${band.decoded} of ${band.cells} cells decoded`,
      });
      wrap.append(cell);
    }
    return wrap;
  }
}
