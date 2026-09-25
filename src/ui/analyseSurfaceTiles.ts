/**
 * analyseSurfaceTiles.ts
 *
 * The Analyse panel's raster and relief previews: the surface statistics, the
 * bare-earth elevation histogram, the canopy-height tile, the coverage
 * (trust) tile with its confidence toggle, and the relief tile with its
 * interactive sun and palette. Each tile carries its legend, a click-to-sample
 * readout and a print-resolution PNG export. The host is what the panel
 * lends: its callbacks for the map context, the export basename and the
 * confidence colour toggle, the current result for the samplers, and the slot
 * for the confidence button so the panel keeps its label in step. Browser-
 * bound (DOM and canvas); the readout formatting is exported for Node tests.
 */
import { el } from './dom';
import type { AnalyseContoursResult } from '../terrain/contour/analyseContours';
import type { AnalysePanelCallbacks } from './AnalysePanel';
import { confidenceWord } from '../terrain/contour/contourCopy';
import { gradeForConfidence } from '../terrain/ground/cellConfidence';
import { triggerDownload } from '../io/download';
import { coverageHeatmapImage, COVERAGE_LEGEND, COVERAGE_CAPTION } from '../terrain/surface/coverageHeatmap';
import { confidenceOverlayImage, CONFIDENCE_LEGEND, CONFIDENCE_CAPTION } from '../terrain/surface/confidenceOverlay';
import { colorblindSafeClasses } from '../render/colorModes';
import type { ElevationPalette } from '../render/colorModes';
import { hypsometricColor, DEFAULT_CANOPY_PALETTE, type ColorStop } from '../terrain/contour/hypsometric';
import { builtinHypsometricStops } from '../render/hypsometricPalette';
import { listBuiltinPalettes } from '../render/paletteCatalog';
import { histogramBins, type Histogram } from '../terrain/contour/histogram';
import { computeMultiHillshade, shadeFromSlopeAspect } from '../terrain/surface/hillshade';
import { sampleTerrain } from '../terrain/contour/sampleTerrain';
import { verticalUnitSuffix, verticalUnitLabel } from '../units/units';

const SAMPLE_HINT = 'Click the map to sample a point.';

/** What the panel lends the tiles. */
export interface SurfaceTilesHost {
  readonly cb: Pick<AnalysePanelCallbacks, 'getMapContext' | 'getExportBasename' | 'onColorByConfidence'>;
  /** The result the samplers read at click time; null once the panel cleared it. */
  getResult(): AnalyseContoursResult | null;
  /** The coverage tile built its confidence toggle; the panel owns its label. */
  setConfidenceColorButton(button: HTMLButtonElement): void;
}

export interface MountedSurfaceTiles {
  readonly elements: readonly HTMLElement[];
  /** Cancels a relief repaint the tile queued, or null when none can be pending. */
  readonly cancelRepaint: (() => void) | null;
}

/** The vertical-unit token ('m' | 'ft' | 'units') for legend captions. */
export function verticalUnitTokenFor(metresPerUnit: number | null | undefined): string {
  return metresPerUnit != null && Number.isFinite(metresPerUnit) && metresPerUnit > 0 ? verticalUnitLabel(metresPerUnit) : 'units';
}

/** Format a terrain sample for the readout line; `suffix` is the vertical unit. */
export function sampleReadoutText(sample: ReturnType<typeof sampleTerrain>, suffix: string): string {
  if (!sample) return SAMPLE_HINT;
  if (!sample.covered) return 'Sample · outside coverage';
  const f = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
  return `Sample · ${f(sample.elevationM, 2)}${suffix} · slope ${f(sample.slopeDeg)}° · canopy ${f(sample.canopyM)}${suffix}`;
}

/** Where a click landed on a north-up raster: the fractional position and the DTM cell, or null off the canvas. */
function cellAtClick(canvas: HTMLCanvasElement, e: MouseEvent, cols: number, rows: number): { fx: number; fy: number; col: number; row: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const fx = (e.clientX - rect.left) / rect.width;
  const fy = (e.clientY - rect.top) / rect.height;
  const col = Math.max(0, Math.min(cols - 1, Math.floor(fx * cols)));
  const displayRow = Math.max(0, Math.min(rows - 1, Math.floor(fy * rows)));
  return { fx, fy, col, row: rows - 1 - displayRow }; // undo the north-up flip
}

/** Drop the crosshair at a fractional position; percentages survive a resize. */
function placeCrosshair(crosshair: HTMLElement, fx: number, fy: number): void {
  crosshair.style.left = `${(fx * 100).toFixed(2)}%`;
  crosshair.style.top = `${(fy * 100).toFixed(2)}%`;
  crosshair.style.display = 'block';
}

export class SurfaceTiles {
  private _cancelRepaint: (() => void) | null = null;
  private readonly host: SurfaceTilesHost;

  constructor(host: SurfaceTilesHost) {
    this.host = host;
  }

  /** The tiles for a result: stats, histogram, canopy, coverage and relief, in order. */
  render(r: AnalyseContoursResult): MountedSurfaceTiles {
    this._cancelRepaint = null;
    const out: HTMLElement[] = [];
    const s = r.surface;
    if (!s) return { elements: out, cancelRepaint: null };
    const fmt = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '—');

    const vu = this._verticalSuffix();
    const stats = el('div', { className: 'olv-analyse-surface-stats' });
    stats.append(
      el('div', { className: 'olv-analyse-surface-stat', text: `Above-ground height: p95 ${fmt(s.canopy.p95HeightM)}${vu} · max ${fmt(s.canopy.maxHeightM)}${vu}` }),
      el('div', { className: 'olv-analyse-surface-stat', text: `Slope: mean ${fmt(s.slope.meanDeg)}° · max ${fmt(s.slope.maxDeg)}°` }),
    );
    const total = s.slope.bands.flat + s.slope.bands.moderate + s.slope.bands.steep;
    if (total > 0) {
      const pct = (n: number): number => Math.round((100 * n) / total);
      stats.append(el('div', {
        className: 'olv-analyse-surface-stat is-dim',
        text: `Flat ${pct(s.slope.bands.flat)}% · Moderate ${pct(s.slope.bands.moderate)}% · Steep ${pct(s.slope.bands.steep)}%`,
      }));
    }
    out.push(stats);

    // Bare-earth elevation distribution, a hypsometric read of the DTM.
    const hist = this._elevationHistogram(r.dtm);
    if (hist) out.push(hist);

    // Canopy height model, above-ground height (DSM − DTM) on a green ramp.
    // Ground (≈0 m) is left transparent so the eye reads structure, not a
    // flat green field.
    const canopyMax = Number.isFinite(s.canopy.maxHeightM) && s.canopy.maxHeightM > 0
      ? s.canopy.maxHeightM
      : 1;
    const chm = this._rasterPreview({
      label: 'Canopy height (CHM)',
      caption: `Above ground · p95 ${fmt(s.canopy.p95HeightM)}${vu} · max ${fmt(s.canopy.maxHeightM)}${vu}`,
      values: s.canopy.heightM,
      cols: r.dtm.cols,
      rows: r.dtm.rows,
      color: (v) => {
        const c = hypsometricColor(v, 0, canopyMax, DEFAULT_CANOPY_PALETTE);
        return [c.r, c.g, c.b];
      },
      visible: (v) => Number.isFinite(v) && v > 0.05,
      legend: { min: 0, max: s.canopy.maxHeightM, palette: DEFAULT_CANOPY_PALETTE, unit: this._verticalUnitToken() },
      filename: 'canopy-height',
    });
    if (chm) out.push(chm);

    // Coverage, a green/yellow/red trust read of the bare-earth DTM. Same
    // confidence the dashed-contour evidence uses, so the two agree.
    const coverage = this._coverageTile(r);
    if (coverage) out.push(coverage);

    // Relief, multi-directional / single-sun hillshade with adjustable sun.
    const relief = this._reliefTile(r, s);
    if (relief) out.push(relief);
    return { elements: out, cancelRepaint: this._cancelRepaint };
  }

  /**
   * The coverage heatmap tile, green (strong/measured) / yellow (moderate/
   * interpolated) / red (weak/extrapolated or gap), with empty cells left
   * transparent. A projection of the per-cell DTM confidence the pipeline
   * already computes; no new analysis. Carries a 3-stop legend, a click-to-
   * sample readout reporting the cell's confidence + grade word, an Export PNG
   * button, and the honesty caption. Never claims survey-grade.
   */
  private _coverageTile(r: AnalyseContoursResult): HTMLElement | null {
    const cols = r.dtm.cols;
    const rows = r.dtm.rows;
    if (!(cols > 0 && rows > 0) || r.dtm.confidence.length !== cols * rows) return null;

    // Honour the app's colourblind-safe palette preference for this data tile.
    const cvd = colorblindSafeClasses();
    const canvas = this._makeCanvas(cols, rows);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(cols, rows);
      // The rasteriser flips north-up to match the other preview tiles; copy
      // its RGBA straight into the canvas ImageData. Under the colourblind-safe
      // palette, render the Cividis confidence twin instead of the green/yellow/
      // red ramp, same buckets, accessible colours.
      const raster = cvd
        ? confidenceOverlayImage(r.dtm, { northUp: true })
        : coverageHeatmapImage(r.dtm, { northUp: true });
      img.data.set(raster.data);
      ctx.putImageData(img, 0, 0);
    }

    const tile = el('div', { className: 'olv-analyse-raster-tile' });
    tile.append(el('div', { className: 'olv-analyse-sublabel', text: 'Coverage (trust)' }));
    const wrap = this._rasterWrap(canvas);
    tile.append(wrap.wrap);
    tile.append(this._coverageLegend(cvd));
    tile.append(el('div', { className: 'olv-analyse-caption', text: cvd ? CONFIDENCE_CAPTION : COVERAGE_CAPTION }));

    const readout = this._sampleReadout();
    this._attachCoverageSampler(canvas, wrap.crosshair, cols, rows, readout);

    const dl = el('button', {
      className: 'olv-analyse-surface-dl', text: 'Export PNG',
      title: 'Save this tile as a PNG image at its own cell grid. Not a georeferenced raster.',
    });
    dl.addEventListener('click', () => this._downloadRasterPng(canvas, cols, rows, 'coverage'));
    tile.append(this._tileFooter(readout, dl));

    // Link to the 3D 'Confidence' colour mode, the colourblind-safe twin of
    // this tile, painting the SAME buckets onto the point cloud itself. Lives
    // on the tile because the tile's legend is where the buckets are defined;
    // the Inspector's COLOR BY rail carries the matching chip.
    if (this.host.cb.onColorByConfidence) {
      const link = el('button', {
        className: 'olv-analyse-surface-dl',
        title:
          'Colour the 3D point cloud by this per-cell confidence — same ' +
          'strong/moderate/weak buckets, colourblind-safe (Cividis) ramp. ' +
          'Click again to restore the original colour.',
      });
      // The button is a TOGGLE: its label and pressed state reflect whether the
      // confidence overlay is currently on, so there is always an obvious way
      // back to the original colour (the COLOR BY rail on the right is the other
      // route, but the user clicked HERE so the way out belongs here too).
      this.host.setConfidenceColorButton(link);
      link.addEventListener('click', () => this.host.cb.onColorByConfidence?.());
      tile.append(link);
    }
    return tile;
  }

  /** A discrete 3-stop coverage legend: the green/yellow/red ramp, or the Cividis
   *  confidence twin when the colourblind-safe palette is active. Same buckets. */
  private _coverageLegend(colorblindSafe = false): HTMLElement {
    const wrap = el('div', { className: 'olv-analyse-coverage-legend' });
    for (const stop of colorblindSafe ? CONFIDENCE_LEGEND : COVERAGE_LEGEND) {
      const item = el('div', { className: 'olv-analyse-coverage-legend-item' });
      const sw = el('span', { className: 'olv-analyse-coverage-swatch' });
      sw.style.background = `rgb(${stop.color.r},${stop.color.g},${stop.color.b})`;
      item.append(sw, el('span', { text: `${stop.word} — ${stop.meaning}` }));
      wrap.append(item);
    }
    return wrap;
  }

  /**
   * Click-to-sample for the coverage tile: maps a click to a DTM cell and
   * reports that cell's confidence + grade word, reusing the readout style of
   * the other tiles. Reads the confidence grid directly (sampleTerrain doesn't
   * carry confidence), so the readout matches the pixel under the crosshair.
   */
  private _attachCoverageSampler(
    canvas: HTMLCanvasElement,
    crosshair: HTMLElement,
    cols: number,
    rows: number,
    readout: HTMLElement,
  ): void {
    canvas.classList.add('is-samplable');
    const sampleCell = (fx: number, fy: number, col: number, row: number): void => {
      const r = this.host.getResult();
      if (!r) return;
      const i = row * cols + col;
      const covered = r.dtm.coverage[i] !== 0;
      if (!covered) {
        readout.textContent = 'Sample · outside coverage';
        readout.classList.add('is-empty');
      } else {
        const conf = r.dtm.confidence[i];
        const grade = gradeForConfidence(conf);
        let support: 'strong' | 'moderate' | 'weak';
        if (grade === 'solid') {
          support = 'strong';
        } else if (grade === 'dashed') {
          support = 'moderate';
        } else {
          support = 'weak';
        }
        const c = Number.isFinite(conf) ? Math.round(conf) : 0;
        readout.textContent = `Sample · ${support} support · confidence ${c}% (${confidenceWord(conf)})`;
        readout.classList.remove('is-empty');
      }
      placeCrosshair(crosshair, fx, fy);
    };
    canvas.addEventListener('click', (e) => {
      const hit = cellAtClick(canvas, e, cols, rows);
      if (!hit) return;
      sampleCell(hit.fx, hit.fy, hit.col, hit.row);
    });
    this._attachKeyboardCursor(canvas, crosshair, cols, rows, sampleCell);
  }

  /**
   * Render a grid raster as a north-up preview tile with a heading, caption,
   * optional colour-ramp legend, click-to-sample, and a print-resolution PNG
   * export. Shared raster-preview system used by the canopy-height tile.
   */
  private _rasterPreview(opts: {
    label: string;
    caption: string;
    values: ArrayLike<number>;
    cols: number;
    rows: number;
    /** src grid index → RGB (0–255). */
    color: (value: number, srcIndex: number) => [number, number, number];
    /** src grid index → whether the cell is drawn (else transparent). */
    visible: (value: number, srcIndex: number) => boolean;
    filename: string;
    legend?: { min: number; max: number; palette: typeof DEFAULT_CANOPY_PALETTE; unit: string };
  }): HTMLElement | null {
    const { cols, rows, values } = opts;
    if (!(cols > 0 && rows > 0) || values.length !== cols * rows) return null;

    const canvas = this._makeCanvas(cols, rows);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(cols, rows);
      for (let row = 0; row < rows; row++) {
        const src = (rows - 1 - row) * cols; // flip so north reads up
        const dst = row * cols;
        for (let c = 0; c < cols; c++) {
          const si = src + c;
          const o = (dst + c) * 4;
          if (opts.visible(values[si], si)) {
            const [rr, gg, bb] = opts.color(values[si], si);
            img.data[o] = rr; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = 255;
          } else {
            img.data[o + 3] = 0;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    const tile = el('div', { className: 'olv-analyse-raster-tile' });
    tile.append(el('div', { className: 'olv-analyse-sublabel', text: opts.label }));
    const wrap = this._rasterWrap(canvas);
    tile.append(wrap.wrap);

    if (opts.legend && Number.isFinite(opts.legend.max) && opts.legend.max > 0) {
      tile.append(this._legendBar(opts.legend));
    }
    tile.append(el('div', { className: 'olv-analyse-caption', text: opts.caption }));

    const readout = this._sampleReadout();
    this._attachSampler(canvas, wrap.crosshair, cols, rows, readout);

    const dl = el('button', {
      className: 'olv-analyse-surface-dl', text: 'Export PNG',
      title: 'Save this tile as a PNG image at its own cell grid. Not a georeferenced raster.',
    });
    dl.addEventListener('click', () => this._downloadRasterPng(canvas, cols, rows, opts.filename));
    tile.append(this._tileFooter(readout, dl));
    return tile;
  }

  /**
   * The relief tile, a hillshade the user can re-light interactively. Defaults
   * to a soft multi-directional shade; a toggle drops to a single sun with an
   * azimuth slider, and altitude applies to both. Re-lighting reuses the cached
   * slope/aspect grids, so it's a cheap per-cell pass with no Horn recompute.
   */
  private _reliefTile(
    r: AnalyseContoursResult,
    s: AnalyseContoursResult['surface'],
  ): HTMLElement | null {
    const cols = r.dtm.cols;
    const rows = r.dtm.rows;
    const { slope, aspect } = s.relief;
    const coverage = r.dtm.coverage;
    if (!(cols > 0 && rows > 0) || slope.length !== cols * rows) return null;

    // Elevation range over the covered cells, for the coloured-relief tint. A
    // flat or empty surface leaves `elevRange` false, so the palette options
    // stay disabled and the tile is grayscale-only.
    const z = r.dtm.z;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 0; i < z.length; i++) {
      if (coverage[i] !== 0 && Number.isFinite(z[i])) {
        if (z[i] < zMin) zMin = z[i];
        if (z[i] > zMax) zMax = z[i];
      }
    }
    const elevRange = zMax > zMin;

    const tile = el('div', { className: 'olv-analyse-raster-tile' });
    tile.append(el('div', { className: 'olv-analyse-sublabel', text: 'Relief (hillshade)' }));
    const canvas = this._makeCanvas(cols, rows);
    const wrap = this._rasterWrap(canvas);
    tile.append(wrap.wrap);
    // A swappable legend slot: grayscale shade by default, an elevation colour
    // ramp when the analyst picks a palette.
    const legendSlot = el('div', { className: 'olv-analyse-legend-slot' });
    legendSlot.append(this._grayLegend());
    tile.append(legendSlot);

    const caption = el('div', { className: 'olv-analyse-caption' });
    let multi = true;
    let azimuth = 315;
    let altitude = 45;
    // null = grayscale shading; otherwise the coloured-relief ramp, sampled once
    // per selection into hypsometric stops.
    let paletteId: ElevationPalette | null = null;
    let stops: ColorStop[] = [];

    const repaint = (): void => {
      const res = multi
        ? computeMultiHillshade(slope, aspect, coverage, cols, rows, { altitudeDeg: altitude })
        : shadeFromSlopeAspect(slope, aspect, coverage, cols, rows, {
            azimuthDeg: azimuth,
            altitudeDeg: altitude,
          });
      const tinted = paletteId !== null && elevRange;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const img = ctx.createImageData(cols, rows);
        for (let row = 0; row < rows; row++) {
          const src = (rows - 1 - row) * cols;
          const dst = row * cols;
          for (let c = 0; c < cols; c++) {
            const si = src + c;
            const o = (dst + c) * 4;
            if (res.coverage[si] !== 0) {
              const v = res.shade[si];
              if (tinted) {
                // Coloured relief: the elevation ramp modulated by the shade, so
                // the hillshade's form reads through the hypsometric colour.
                const base = hypsometricColor(z[si], zMin, zMax, stops);
                const k = v / 255;
                img.data[o] = Math.round(base.r * k);
                img.data[o + 1] = Math.round(base.g * k);
                img.data[o + 2] = Math.round(base.b * k);
              } else {
                img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v;
              }
              img.data[o + 3] = 255;
            } else {
              img.data[o + 3] = 0;
            }
          }
        }
        ctx.putImageData(img, 0, 0);
      }
      const light = multi
        ? `Multi-directional · alt ${altitude}°`
        : `Sun ${String(azimuth).padStart(3, '0')}° · alt ${altitude}°`;
      caption.textContent = tinted ? `Coloured relief · ${light}` : light;
    };

    // Coalesce slider repaints into one rAF: dragging fires many `input`
    // events per frame, but a full per-cell hillshade + ImageData write is
    // expensive on a large grid. We keep only a single pending frame; when it
    // runs it reads the LATEST azimuth/altitude (the slider handlers update
    // those before scheduling), so intermediate positions are skipped and the
    // most recent one always wins, including the final value on release.
    // The pending frame is cancellable from outside (see _reliefRepaintCancel)
    // so a re-render or panel close can't leave a queued frame painting a
    // detached canvas.
    let reliefRafId: number | null = null;
    const canSchedule = typeof requestAnimationFrame === 'function';
    const cancelRepaint = (): void => {
      if (reliefRafId !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(reliefRafId);
        reliefRafId = null;
      }
    };
    const scheduleRepaint = (): void => {
      // No rAF (e.g. jsdom in tests), fall back to a synchronous repaint so
      // behaviour is unchanged where coalescing isn't available.
      if (!canSchedule) { repaint(); return; }
      if (reliefRafId !== null) return;
      reliefRafId = requestAnimationFrame(() => {
        reliefRafId = null;
        repaint();
      });
    };
    // Expose the cancel so teardown (surface re-render / panel hide) can drop a
    // queued frame before this tile is detached.
    this._cancelRepaint = cancelRepaint;

    // Controls: multi-directional toggle + azimuth + altitude.
    const controls = el('div', { className: 'olv-analyse-relief-controls' });
    const multiLabel = el('label', { className: 'olv-analyse-relief-toggle' });
    const multiCb = document.createElement('input');
    multiCb.type = 'checkbox';
    multiCb.checked = true;
    multiLabel.append(multiCb, el('span', { text: 'Multi-directional' }));

    const azRow = el('label', { className: 'olv-analyse-relief-slider is-off' });
    const azVal = el('span', { className: 'olv-analyse-relief-val', text: 'off' });
    const azInput = document.createElement('input');
    azInput.type = 'range'; azInput.min = '0'; azInput.max = '360'; azInput.step = '5';
    azInput.value = '315'; azInput.disabled = true;
    azInput.setAttribute('aria-label', 'Sun azimuth');
    azRow.append(el('span', { className: 'olv-analyse-relief-tag', text: 'Sun' }), azInput, azVal);

    const altRow = el('label', { className: 'olv-analyse-relief-slider' });
    const altVal = el('span', { className: 'olv-analyse-relief-val', text: '45°' });
    const altInput = document.createElement('input');
    altInput.type = 'range'; altInput.min = '5'; altInput.max = '85'; altInput.step = '5';
    altInput.value = '45';
    altInput.setAttribute('aria-label', 'Sun altitude');
    altRow.append(el('span', { className: 'olv-analyse-relief-tag', text: 'Alt' }), altInput, altVal);

    multiCb.addEventListener('change', () => {
      multi = multiCb.checked;
      azInput.disabled = multi;
      azRow.classList.toggle('is-off', multi);
      azVal.textContent = multi ? 'off' : `${String(azimuth).padStart(3, '0')}°`;
      repaint();
    });
    azInput.addEventListener('input', () => {
      azimuth = Number(azInput.value);
      azVal.textContent = `${String(azimuth).padStart(3, '0')}°`;
      scheduleRepaint();
    });
    altInput.addEventListener('input', () => {
      altitude = Number(altInput.value);
      altVal.textContent = `${altitude}°`;
      scheduleRepaint();
    });

    // Palette: grayscale shading, or an elevation ramp for coloured relief. The
    // colour-blind-safe ramps are marked so the choice is informed. Disabled on
    // a flat surface, where an elevation ramp would carry no information.
    const palRow = el('label', { className: 'olv-analyse-relief-slider' });
    const palSelect = document.createElement('select');
    palSelect.className = 'olv-analyse-relief-select';
    palSelect.setAttribute('aria-label', 'Relief palette');
    palSelect.setAttribute('data-tip', 'Shade the relief in grey, or colour it by elevation.');
    palSelect.disabled = !elevRange;
    const shadeOpt = document.createElement('option');
    shadeOpt.value = '';
    shadeOpt.textContent = 'Shading';
    palSelect.append(shadeOpt);
    for (const p of listBuiltinPalettes()) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.colorblindSafe ? `${p.label} (CVD-safe)` : p.label;
      palSelect.append(opt);
    }
    palRow.append(el('span', { className: 'olv-analyse-relief-tag', text: 'Colour' }), palSelect);
    palSelect.addEventListener('change', () => {
      paletteId = palSelect.value === '' ? null : (palSelect.value as ElevationPalette);
      stops = paletteId !== null ? builtinHypsometricStops(paletteId) : [];
      // Swap the legend to match: an elevation ramp when tinted, else the shade.
      legendSlot.replaceChildren(
        paletteId !== null && elevRange
          ? this._legendBar({ min: 0, max: zMax - zMin, palette: stops, unit: this._verticalUnitToken() })
          : this._grayLegend(),
      );
      repaint();
    });

    controls.append(multiLabel, azRow, altRow, palRow);
    tile.append(controls);
    tile.append(caption);

    const readout = this._sampleReadout();
    this._attachSampler(canvas, wrap.crosshair, cols, rows, readout);

    const dl = el('button', {
      className: 'olv-analyse-surface-dl', text: 'Export PNG',
      title: 'Save this tile as a PNG image at its own cell grid. Not a georeferenced raster.',
    });
    dl.addEventListener('click', () => this._downloadRasterPng(canvas, cols, rows, 'relief'));
    tile.append(this._tileFooter(readout, dl));

    repaint();
    return tile;
  }

  /**
   * v0.5.5 P12, compact per-tile footer. Adjacent raster tiles (coverage,
   * relief, canopy) each stacked a full-width "Click the map to sample a
   * point." row above a full-width "Export PNG" row, so the rail repeated
   * the same two blocks map after map. The readout and the tile's action
   * button now share ONE compact line per map. Nothing is removed, the
   * readout keeps its live-region semantics and its hint text, and the
   * button keeps its behaviour; only the presentation is consolidated.
   */
  private _tileFooter(readout: HTMLElement, ...actions: HTMLElement[]): HTMLElement {
    const footer = el('div', { className: 'olv-analyse-tile-footer' });
    footer.append(readout, ...actions);
    return footer;
  }

  /** A grid-sized canvas styled as a preview raster. */
  private _makeCanvas(cols: number, rows: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    canvas.className = 'olv-analyse-raster';
    return canvas;
  }

  /** A colour-ramp legend bar with min/max ticks. */
  private _legendBar(legend: {
    min: number; max: number; palette: typeof DEFAULT_CANOPY_PALETTE; unit: string;
  }): HTMLElement {
    const stops = legend.palette
      .map((s) => `rgb(${s.color.r},${s.color.g},${s.color.b}) ${Math.round(s.t * 100)}%`)
      .join(', ');
    const wrap = el('div', { className: 'olv-analyse-legend' });
    const bar = el('div', { className: 'olv-analyse-legend-bar' });
    bar.style.background = `linear-gradient(90deg, ${stops})`;
    const ticks = el('div', { className: 'olv-analyse-legend-ticks' });
    ticks.append(
      el('span', { text: `${legend.min}` }),
      el('span', { text: `${legend.max.toFixed(1)} ${legend.unit}` }),
    );
    wrap.append(bar, ticks);
    return wrap;
  }

  /** Wrap a raster canvas so a positioned crosshair can ride on top of it. */
  private _rasterWrap(canvas: HTMLCanvasElement): { wrap: HTMLElement; crosshair: HTMLElement } {
    const wrap = el('div', { className: 'olv-analyse-raster-wrap' });
    const crosshair = el('span', { className: 'olv-analyse-xhair' });
    crosshair.style.display = 'none';
    wrap.append(canvas, crosshair);
    return { wrap, crosshair };
  }

  /** A polite live region for sample readouts (screen readers announce updates). */
  private _sampleReadout(): HTMLElement {
    const readout = el('div', { className: 'olv-analyse-sample', text: SAMPLE_HINT });
    readout.setAttribute('role', 'status');
    readout.setAttribute('aria-live', 'polite');
    return readout;
  }

  /** A static dark→light legend strip for the grayscale relief tile. */
  private _grayLegend(): HTMLElement {
    const wrap = el('div', { className: 'olv-analyse-legend' });
    const bar = el('div', { className: 'olv-analyse-legend-bar' });
    bar.style.background = 'linear-gradient(90deg, #1a1d24 0%, #f4f6fb 100%)';
    const ticks = el('div', { className: 'olv-analyse-legend-ticks' });
    ticks.append(el('span', { text: 'shadow' }), el('span', { text: 'light' }));
    wrap.append(bar, ticks);
    return wrap;
  }

  /** Click-to-sample: map a click on a north-up raster to a DTM cell + readout. */
  private _attachSampler(
    canvas: HTMLCanvasElement,
    crosshair: HTMLElement,
    cols: number,
    rows: number,
    readout: HTMLElement,
  ): void {
    canvas.classList.add('is-samplable');
    const sampleCell = (fx: number, fy: number, col: number, row: number): void => {
      const r = this.host.getResult();
      if (!r) return;
      const sample = sampleTerrain(r, col, row);
      readout.textContent = this._sampleReadoutText(sample);
      readout.classList.toggle('is-empty', !sample?.covered);
      // Drop the crosshair at the sampled point, percentages survive resize.
      placeCrosshair(crosshair, fx, fy);
    };
    canvas.addEventListener('click', (e) => {
      const hit = cellAtClick(canvas, e, cols, rows);
      if (!hit) return;
      sampleCell(hit.fx, hit.fy, hit.col, hit.row);
    });
    this._attachKeyboardCursor(canvas, crosshair, cols, rows, sampleCell);
  }

  /**
   * The keyboard path onto a sampled raster: focusable, labelled, arrow keys
   * move a visible cursor cell (shown via the same crosshair the mouse
   * drops), Enter/Space samples the cursor cell through `onSample` — the
   * identical per-cell read a click produces. Mouse behaviour is unchanged;
   * this only adds a second way to reach it.
   */
  private _attachKeyboardCursor(
    canvas: HTMLCanvasElement,
    crosshair: HTMLElement,
    cols: number,
    rows: number,
    onSample: (fx: number, fy: number, col: number, row: number) => void,
  ): void {
    if (!(cols > 0 && rows > 0)) return;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'application');
    canvas.setAttribute(
      'aria-label',
      'Sampled raster. Arrow keys move the cell cursor, Enter samples the cursor cell.',
    );
    // Display-space cursor (north-up, as drawn) — converted to the source
    // row via the same flip `cellAtClick` undoes, so a keyboard sample lands
    // on the identical cell a click at that screen position would.
    let displayCol = 0;
    let displayRow = 0;
    const showCursor = (): void => {
      placeCrosshair(crosshair, (displayCol + 0.5) / cols, (displayRow + 0.5) / rows);
    };
    canvas.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          displayRow = Math.max(0, displayRow - 1);
          showCursor();
          return;
        case 'ArrowDown':
          e.preventDefault();
          displayRow = Math.min(rows - 1, displayRow + 1);
          showCursor();
          return;
        case 'ArrowLeft':
          e.preventDefault();
          displayCol = Math.max(0, displayCol - 1);
          showCursor();
          return;
        case 'ArrowRight':
          e.preventDefault();
          displayCol = Math.min(cols - 1, displayCol + 1);
          showCursor();
          return;
        case 'Enter':
        case ' ':
          e.preventDefault();
          showCursor();
          onSample(
            (displayCol + 0.5) / cols,
            (displayRow + 0.5) / rows,
            displayCol,
            rows - 1 - displayRow,
          );
          return;
        default:
          return;
      }
    });
  }

  /**
   * The surface rasters (elevation, canopy height) keep Z in the source file's
   * VERTICAL unit, the terrain core never converts it. So the on-screen labels
   * must name that unit, not hardcode "m": a US-foot scan's 30 ft canopy was
   * being printed as "30 m". Derived from the map context's
   * `verticalUnitToMetres`; unknown surfaces as an explicit "unverified" tag,
   * never a false metre claim.
   */
  private _verticalSuffix(): string {
    return verticalUnitSuffix(this.host.cb.getMapContext?.()?.verticalUnitToMetres);
  }

  /** The bare vertical-unit token ('m' | 'ft' | 'units') for legend captions. */
  private _verticalUnitToken(): string {
    return verticalUnitTokenFor(this.host.cb.getMapContext?.()?.verticalUnitToMetres);
  }

  /** Format a terrain sample for the readout line. */
  private _sampleReadoutText(sample: ReturnType<typeof sampleTerrain>): string {
    return sampleReadoutText(sample, this._verticalSuffix());
  }

  /** Upscale a preview canvas to ~2048 px long edge and download as PNG. */
  private _downloadRasterPng(
    source: HTMLCanvasElement,
    cols: number,
    rows: number,
    filename: string,
  ): void {
    const TARGET_LONG_EDGE = 2048;
    const longEdge = Math.max(cols, rows);
    const scale = longEdge > 0 ? Math.max(1, TARGET_LONG_EDGE / longEdge) : 1;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cols * scale));
    out.height = Math.max(1, Math.round(rows * scale));
    const octx = out.getContext('2d');
    if (octx) {
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(source, 0, 0, out.width, out.height);
    }
    (octx ? out : source).toBlob((blob) => {
      if (!blob) return;
      triggerDownload(blob, `${this.host.cb.getExportBasename?.() ?? 'terrain'}-${filename}.png`);
    });
  }

  /**
   * Compact SVG histogram of the bare-earth DTM elevations (covered cells
   * only). A quick read of the terrain's hypsometry, where the ground sits.
   * Returns null when there are too few cells to be meaningful.
   */
  private _elevationHistogram(dtm: { z: Float32Array; coverage: Uint8Array }): HTMLElement | null {
    // The analysis runs in the cloud's RECENTRED frame, so `dtm.z` is local ,
    // the DEM package adds the load-time vertical origin back before writing
    // absolute grids, and this panel must do the same or it labels a local
    // residual "Bare-earth elevation … m". On a Swiss LV95 scan whose true
    // ground sits at 330–467 m, the un-restored read showed −498.9 – −388.8:
    // the right SHAPE at the wrong datum, which is exactly the kind of wrong
    // that survives a glance. No origin ⇒ the frame is local anyway, so the
    // caption says so rather than implying an elevation.
    const oz = this.host.cb.getMapContext?.()?.worldOrigin?.z;
    const shift = Number.isFinite(oz) ? (oz as number) : 0;
    const absolute = shift !== 0;
    const covered: number[] = [];
    for (let i = 0; i < dtm.z.length; i++) {
      if (dtm.coverage[i] !== 0 && Number.isFinite(dtm.z[i])) covered.push(dtm.z[i] + shift);
    }
    if (covered.length < 16) return null;
    const hist = histogramBins(covered, 24);
    // Written as a negated comparison on purpose: a NaN bound must also bail out.
    if (hist.peak <= 0 || !(hist.max > hist.min)) return null; // NOSONAR S1940

    const wrap = el('div', { className: 'olv-analyse-hist' });
    wrap.append(el('div', { className: 'olv-analyse-sublabel', text: 'Bare-earth elevation' }));
    wrap.append(this._histogramSvg(hist));
    const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '—');
    wrap.append(el('div', {
      className: 'olv-analyse-caption',
      text:
        `${fmt(hist.min)} – ${fmt(hist.max)}${this._verticalSuffix()} · ${hist.total.toLocaleString()} cells` +
        (absolute ? '' : ' · local frame (no vertical origin)'),
    }));
    return wrap;
  }

  /** Build the bar SVG for a histogram. Pure layout, no labels (caption carries them). */
  private _histogramSvg(hist: Histogram): SVGSVGElement {
    const W = 240;
    const H = 56;
    const n = hist.counts.length;
    const gap = 1;
    const bw = (W - gap * (n - 1)) / n;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'olv-analyse-hist-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Bare-earth elevation distribution');
    for (let i = 0; i < n; i++) {
      const h = hist.peak > 0 ? (hist.counts[i] / hist.peak) * (H - 2) : 0;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', `${(bw + gap) * i}`);
      rect.setAttribute('y', `${H - h}`);
      rect.setAttribute('width', `${Math.max(0.5, bw)}`);
      rect.setAttribute('height', `${h}`);
      rect.setAttribute('class', 'olv-analyse-hist-bar');
      svg.append(rect);
    }
    return svg;
  }
}
