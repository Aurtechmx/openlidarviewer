/**
 * ExportPanel.ts — in-project "Export to other formats".
 *
 * A collapsible left panel (same shell as the Analyse/Measure panels) that
 * converts the currently-open cloud to LAS / XYZ / ASC with the same CRS
 * choices as the batch converter (keep / assign / reproject). It mounts on
 * every scan load, so the heavy engine (proj4) is imported lazily on Export
 * rather than at module load.
 *
 * Reuses the converter's pill/field classes (`olv-bc-*`) for visual
 * consistency with the splash batch converter.
 */

import { el } from './dom';
import { downloadBytes } from '../io/download';
import { loadConvertEngine } from '../lazyChunks';
import { CONVERT_FORMATS, type ConvertFormat, type CrsMode, type ConvertOptions } from '../convert/types';
import type { PointCloud } from '../model/PointCloud';
import { gzipConvertedFile, gzipAvailable } from '../convert/gzip';
import { buildExportSummary, type ExportSummaryInput } from '../export/exportSummary';
import { clipCloud } from '../render/clip/clipCloud';
import type { ClipBox } from '../render/clip/clipBox';

export interface ExportPanelCallbacks {
  /** Return the loaded (display-resolution) cloud, or null when none is active. */
  getCloud: () => PointCloud | null;
  /** Whether a full-resolution re-decode of the source is possible (local file). */
  hasFullSource: () => boolean;
  /** Whether the loaded cloud is a reduced subset of the source. */
  isReduced: () => boolean;
  /** Re-decode the original file at full resolution. Only call when `hasFullSource()`. */
  getFullCloud: () => Promise<PointCloud | null>;
  /** Count of placed measurements — drives the Products lane's enablement. */
  measurementCount?: () => number;
  /** Export the placed measurements to an open format (GeoJSON / CSV). */
  exportMeasurements?: (format: 'geojson' | 'csv') => void;
  /**
   * Export a signed, tamper-evident report (JSON) — the placed measurements as
   * findings, stamped with dataset provenance + the classification epoch + a
   * verifiable signature. Wired alongside {@link exportMeasurements}.
   */
  exportSignedReport?: () => void;
  /**
   * Export a site KML (annotations + measurements + viewpoints) for Google
   * Earth / QGIS. Wired only when the host can supply a lat/lon transform.
   */
  exportKml?: () => void;
  /**
   * Whether a KML export is possible right now, with a reason when not.
   * KML needs a georeferenced scan (it places features on a lat/lon map) and
   * at least one annotation or measurement to carry.
   */
  kmlStatus?: () => { ready: boolean; reason: string };
  /** The active clip box, if any — when enabled, the cloud export is restricted to it. */
  getActiveClip?: () => ClipBox | null;
}

export class ExportPanel {
  readonly element: HTMLElement;
  private readonly _formatRow: HTMLElement;
  private readonly _crsLabel: HTMLElement;
  private readonly _crsRow: HTMLElement;
  private readonly _crsExtra: HTMLElement;
  private readonly _crsLocalNote: HTMLElement;
  private readonly _exportBtn: HTMLButtonElement;
  private readonly _status: HTMLElement;
  private readonly _fullResRow: HTMLElement;
  private readonly _gzipRow: HTMLElement;
  private readonly _classRow: HTMLElement;
  private readonly _summary: HTMLElement;
  private readonly _products: HTMLElement;
  private readonly _cb: ExportPanelCallbacks;

  // LAS 1.4 is the converter's lead format (see CONVERT_FORMATS ordering) —
  // default the panel to it so the pill selection matches the recommended choice.
  private _format: ConvertFormat = 'las14';
  private _crsMode: CrsMode = 'keep';
  private _targetEpsg = '';
  private _sourceEpsg = '';
  private _fullRes = false;
  /** Gzip the output to `.las.gz` (binary LAS formats only). */
  private _gzip = false;
  /** Write the classification channel (false ⇒ omitted as class 0). */
  private _includeClass = true;
  private _busy = false;
  /**
   * Whether the active scan carries a real-world CRS (projected / geographic).
   * When false the Coordinate-System step is collapsed — a local-coordinate scan
   * has no real-world CRS to keep / assign / reproject, so the converter forces
   * 'keep' and shows a one-line note instead of the three pills.
   */
  private _crsKnown = true;

  constructor(callbacks: ExportPanelCallbacks) {
    this._cb = callbacks;
    this.element = el('section', { className: 'olv-export-panel' });

    const title = el('div', {
      className: 'olv-panel-title olv-panel-title-ico',
      unsafeHtml:
        '<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" ' +
        'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>' +
        '<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/></svg>' +
        '<span>Export / Convert</span>',
    });
    const chevron = el('span', { className: 'olv-chevron', text: '▾' });
    const collapseBtn = el('button', { className: 'olv-collapse-toggle', title: 'Collapse this panel' });
    collapseBtn.setAttribute('type', 'button');
    collapseBtn.setAttribute('aria-label', 'Collapse Export panel');
    collapseBtn.append(chevron);
    const head = el('div', { className: 'olv-panel-head' });
    head.append(title, collapseBtn);
    const toggle = () => this.element.classList.toggle('olv-collapsed');
    collapseBtn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    // Toggle on a click anywhere in the head EXCEPT the collapse button (which
    // handles itself + stops propagation). `title` now holds an icon + a
    // <span>, so a click lands on those children — match any descendant of the
    // title, not just the title node itself, or the head row never expands.
    head.addEventListener('click', (e) => {
      const node = e.target as Node;
      if (e.target === head || title.contains(node)) toggle();
    });

    this._formatRow = el('div', { className: 'olv-bc-pills' });
    this._crsLabel = this._label('Coordinate system');
    this._crsRow = el('div', { className: 'olv-bc-pills' });
    this._crsExtra = el('div', { className: 'olv-bc-crs-extra' });
    this._crsLocalNote = el('p', {
      className: 'olv-export-crs-note',
      text: 'Local coordinates — no real-world CRS to assign or reproject.',
    });
    this._crsLocalNote.style.display = 'none';
    this._fullResRow = el('div', { className: 'olv-export-fullres' });
    this._gzipRow = el('div', { className: 'olv-export-fullres' });
    this._classRow = el('div', { className: 'olv-export-fullres' });
    // The live "what you'll get" line — size, CRS, classification, before any write.
    this._summary = el('p', { className: 'olv-export-summary', text: '' });
    this._exportBtn = el('button', { className: 'olv-bc-convert olv-export-btn', type: 'button', text: 'Export' }) as HTMLButtonElement;
    this._exportBtn.addEventListener('click', () => void this._export());
    this._status = el('p', { className: 'olv-export-status', text: 'Export the open scan to another format.' });
    // The collapsed "Products" lane — derived artifacts (measurements today;
    // rasters / report / session to follow) kept out of the primary save flow.
    this._products = el('div', { className: 'olv-export-products' });

    const body = el('div', { className: 'olv-export-body' });
    body.append(
      this._label('Point cloud'),
      this._formatRow,
      this._gzipRow,
      this._crsLabel,
      this._crsRow,
      this._crsExtra,
      this._crsLocalNote,
      this._fullResRow,
      this._classRow,
      this._summary,
      this._exportBtn,
      this._status,
      this._products,
    );

    this.element.append(head, body);
    this.element.classList.add('olv-collapsed');
    this.setVisible(false);

    this._renderFormatPills();
    this._renderCrsPills();
    this._renderCrsExtra();
    this._renderFullResRow();
    this._renderGzipRow();
    this._renderClassRow();
    this._renderSummary();
    this._renderProducts();
  }

  setVisible(on: boolean): void {
    this.element.style.display = on ? '' : 'none';
  }

  /** Re-evaluate the full-resolution availability for the active cloud. */
  refresh(): void {
    this._renderFullResRow();
    this._renderGzipRow();
    this._renderClassRow();
    this._renderSummary();
    this._renderProducts();
  }

  /**
   * Tell the panel whether the active scan has a real-world CRS (projected /
   * geographic). When `false` the Coordinate-System step collapses: the Keep /
   * Assign EPSG / Reproject pills + any EPSG fields are hidden, the mode is
   * forced back to 'keep' (a local scan can only be kept), and a one-line note
   * explains why. When `true` the step behaves exactly as before. The format
   * conversion (LAS / LAZ / XYZ / ASC) and full-resolution behaviour are
   * untouched either way.
   */
  setCrsKnown(known: boolean): void {
    this._crsKnown = known;
    if (!known && this._crsMode !== 'keep') {
      // A local scan cannot assign / reproject — reset to keep so an export can't
      // carry a stale mode from a previously-loaded georeferenced scan.
      this._crsMode = 'keep';
      this._renderCrsPills();
      this._renderCrsExtra();
    }
    this._renderCrsStep();
    this._renderGzipRow();
    this._renderSummary();
  }

  /** Show or collapse the Coordinate-System step per the known-CRS signal. */
  private _renderCrsStep(): void {
    const collapsed = !this._crsKnown;
    this._crsLabel.style.display = collapsed ? 'none' : '';
    this._crsRow.style.display = collapsed ? 'none' : '';
    this._crsExtra.style.display = collapsed ? 'none' : '';
    this._crsLocalNote.style.display = collapsed ? '' : 'none';
  }

  /**
   * Full-resolution checkbox. The viewer reduces large scans for display, so
   * this re-decodes the original file to convert every point. It's only
   * available for local files (a streamed/remote scan has no full source to
   * re-read) and only useful when the loaded view is actually reduced.
   */
  private _renderFullResRow(): void {
    this._fullResRow.replaceChildren();
    const available = this._cb.hasFullSource();
    const reduced = this._cb.isReduced();
    // The toggle is only meaningful when there's a local source AND the loaded
    // view was actually reduced. Otherwise force it off so it can't carry a
    // stale `checked` across cloud switches (which would re-decode pointlessly).
    const usable = available && reduced;
    if (!usable) this._fullRes = false;

    const label = el('label', { className: 'olv-export-fullres-label' });
    const box = el('input', { className: 'olv-export-fullres-box', type: 'checkbox' }) as HTMLInputElement;
    box.checked = this._fullRes;
    box.disabled = !usable;
    box.addEventListener('change', () => { this._fullRes = box.checked; this._renderSummary(); });
    label.append(box, el('span', { text: 'Convert at full resolution' }));

    let hint: string;
    if (!available) hint = 'Full-resolution re-read isn’t available for streamed or remote scans.';
    else if (reduced) hint = 'The loaded view is reduced for display — tick this to convert every point (slower).';
    else hint = 'The loaded scan is already full resolution.';

    this._fullResRow.append(label, el('span', { className: 'olv-export-fullres-hint', text: hint }));
  }

  /**
   * "Compress (.las.gz)" checkbox. Only meaningful for the binary LAS writers —
   * XYZ/ASC are text and the LAZ pill is its own (disabled) format — and only
   * when the platform provides `CompressionStream`. Gzip wraps the written LAS
   * bytes into a `.las.gz` that PDAL / las2las read after gunzip.
   */
  private _renderGzipRow(): void {
    this._gzipRow.replaceChildren();
    const isLas = this._format === 'las' || this._format === 'las14';
    const usable = isLas && gzipAvailable();
    if (!usable) this._gzip = false;

    const label = el('label', { className: 'olv-export-fullres-label' });
    const box = el('input', { className: 'olv-export-fullres-box', type: 'checkbox' }) as HTMLInputElement;
    box.checked = this._gzip;
    box.disabled = !usable;
    box.addEventListener('change', () => { this._gzip = box.checked; this._renderSummary(); });
    label.append(box, el('span', { text: 'Compress (.las.gz)' }));

    let hint: string;
    if (!isLas) hint = 'Compression applies to LAS output — pick LAS 1.4 or LAS 1.2.';
    else if (!gzipAvailable()) hint = 'Compression isn’t available in this browser.';
    else hint = 'Gzip the LAS to a smaller .las.gz (read by PDAL / las2las after gunzip).';
    this._gzipRow.append(label, el('span', { className: 'olv-export-fullres-hint', text: hint }));
  }

  /** Where the active cloud's classification came from. */
  private _classProvenance(): 'none' | 'source' | 'derived' {
    const cloud = this._cb.getCloud();
    if (!cloud) return 'none';
    if (cloud.classificationIsDerived) return 'derived';
    return cloud.classification != null ? 'source' : 'none';
  }

  /**
   * Classification guard. Shown only when the cloud carries a classification.
   * For a DERIVED (heuristic) classification the row reads honestly — "not
   * survey-grade" — and the checkbox lets the user omit it from the written
   * file rather than ship a guess as if it were a producer classification.
   */
  private _renderClassRow(): void {
    this._classRow.replaceChildren();
    const provenance = this._classProvenance();
    if (provenance === 'none') {
      this._includeClass = true; // no class to omit — never carry a stale opt-out
      return;
    }
    const label = el('label', { className: 'olv-export-fullres-label' });
    const box = el('input', { className: 'olv-export-fullres-box', type: 'checkbox' }) as HTMLInputElement;
    box.checked = this._includeClass;
    box.addEventListener('change', () => { this._includeClass = box.checked; this._renderSummary(); });
    label.append(box, el('span', { text: 'Include classification' }));

    const hint = provenance === 'derived'
      ? 'Derived (heuristic) — not survey-grade. Untick to omit it from the file.'
      : 'From the source file.';
    this._classRow.append(label, el('span', { className: 'olv-export-fullres-hint', text: hint }));
  }

  /** Recompute the live "what you'll get" line from the active cloud + options. */
  private _renderSummary(): void {
    const cloud = this._cb.getCloud();
    if (!cloud) {
      this._summary.textContent = '';
      return;
    }
    const crs = cloud.metadata?.crs ?? null;
    const input: ExportSummaryInput = {
      pointCount: cloud.pointCount,
      format: this._format,
      hasRgb: cloud.colors != null,
      hasGpsTime: cloud.gpsTime != null,
      crsMode: this._crsMode,
      crsLabel: crs?.name ?? null,
      targetEpsg: parseEpsg(this._targetEpsg),
      hasWkt: crs?.wkt != null,
      classification: this._classProvenance(),
      includeClassification: this._includeClass,
      viewDecimated: this._cb.isReduced(),
      fullRes: this._fullRes,
      gzip: this._gzip,
    };
    const s = buildExportSummary(input);
    const warn = s.warnings.find((w) => w.level === 'error') ?? s.warnings.find((w) => w.level === 'warn');
    this._summary.textContent = warn ? `${s.line} — ${warn.message}` : s.line;
    this._summary.className = `olv-export-summary${warn ? ` is-${warn.level}` : ''}`;
  }

  /**
   * The collapsed "Products" lane — derived artifacts kept out of the primary
   * point-cloud save flow. Today it surfaces the measurement GeoJSON/CSV export;
   * rasters / report / session will move here as they're wired. Renders nothing
   * when the host wires no product callbacks.
   */
  private _renderProducts(): void {
    this._products.replaceChildren();
    if (!this._cb.exportMeasurements) return;
    // Defensive: this runs during construction, before the host's lazy viewer
    // resolves. A callback that throws (e.g. dereferencing a not-yet-ready
    // viewer) must degrade to 0, never take down panel/app init.
    let count = 0;
    try {
      count = this._cb.measurementCount?.() ?? 0;
    } catch {
      count = 0;
    }

    const head = el('button', {
      className: 'olv-export-products-head',
      type: 'button',
      text: 'Products ▾',
    });
    const content = el('div', { className: 'olv-export-products-body olv-hidden' });
    head.addEventListener('click', () => content.classList.toggle('olv-hidden'));

    const row = el('div', { className: 'olv-bc-pills' });
    ([['geojson', 'GeoJSON'], ['csv', 'CSV']] as const).forEach(([fmt, label]) => {
      const btn = el('button', { className: 'olv-bc-pill', type: 'button', text: label }) as HTMLButtonElement;
      btn.disabled = count === 0;
      btn.addEventListener('click', () => this._cb.exportMeasurements?.(fmt));
      row.append(btn);
    });
    // Signed, tamper-evident report (JSON) — the same measurements, but stamped
    // with provenance + a verifiable signature. The honest deliverable.
    if (this._cb.exportSignedReport) {
      const btn = el('button', {
        className: 'olv-bc-pill',
        type: 'button',
        text: 'Signed report',
      }) as HTMLButtonElement;
      btn.disabled = count === 0;
      btn.setAttribute('data-testid', 'export-signed-report');
      btn.addEventListener('click', () => this._cb.exportSignedReport?.());
      row.append(btn);
    }

    const hint =
      count === 0
        ? 'Place measurements, then export them as open vector formats.'
        : `${count} measurement${count === 1 ? '' : 's'} ready to export.`;
    content.append(
      this._label('Measurements'),
      row,
      el('span', { className: 'olv-export-fullres-hint', text: hint }),
    );

    // Site KML — annotations + measurements + viewpoints for Google Earth / QGIS.
    // Offered only when the host wires the export AND the scan is georeferenced
    // with something to carry (the status callback owns that judgement).
    if (this._cb.exportKml) {
      let status = { ready: false, reason: '' };
      try {
        status = this._cb.kmlStatus?.() ?? status;
      } catch {
        status = { ready: false, reason: '' };
      }
      const kmlRow = el('div', { className: 'olv-bc-pills' });
      const kmlBtn = el('button', { className: 'olv-bc-pill', type: 'button', text: 'KML' }) as HTMLButtonElement;
      kmlBtn.disabled = !status.ready;
      kmlBtn.addEventListener('click', () => this._cb.exportKml?.());
      kmlRow.append(kmlBtn);
      content.append(
        this._label('Site KML (Google Earth)'),
        kmlRow,
        el('span', {
          className: 'olv-export-fullres-hint',
          text: status.ready
            ? 'Annotations, measurements, and views as a georeferenced .kml.'
            : status.reason || 'Needs a georeferenced scan with a measurement or annotation.',
        }),
      );
    }
    this._products.append(head, content);
  }

  private _label(text: string): HTMLElement {
    return el('div', { className: 'olv-bc-section-label', text });
  }

  private _renderFormatPills(): void {
    this._formatRow.replaceChildren();
    (Object.keys(CONVERT_FORMATS) as ConvertFormat[]).forEach((fmt) => {
      const spec = CONVERT_FORMATS[fmt];
      const pill = el('button', {
        className: `olv-bc-pill${this._format === fmt ? ' is-active' : ''}${spec.available ? '' : ' is-disabled'}`,
        text: spec.label,
        type: 'button',
      }) as HTMLButtonElement;
      if (!spec.available) {
        pill.disabled = true;
        pill.title = 'In-browser LAZ compression isn’t available yet — choose LAS for an uncompressed file.';
      } else {
        pill.addEventListener('click', () => {
          this._format = fmt;
          this._renderFormatPills();
          this._renderGzipRow();
          this._renderSummary();
        });
      }
      this._formatRow.append(pill);
    });
  }

  private _renderCrsPills(): void {
    this._crsRow.replaceChildren();
    const modes: { mode: CrsMode; label: string }[] = [
      { mode: 'keep', label: 'Keep' },
      { mode: 'assign', label: 'Assign EPSG' },
      { mode: 'reproject', label: 'Reproject' },
    ];
    modes.forEach(({ mode, label }) => {
      const pill = el('button', {
        className: `olv-bc-pill${this._crsMode === mode ? ' is-active' : ''}`,
        text: label,
        type: 'button',
      });
      pill.addEventListener('click', () => {
        this._crsMode = mode;
        this._renderCrsPills();
        this._renderCrsExtra();
        this._renderSummary();
      });
      this._crsRow.append(pill);
    });
  }

  private _renderCrsExtra(): void {
    this._crsExtra.replaceChildren();
    if (this._crsMode === 'keep') return;
    if (this._crsMode === 'reproject') {
      this._crsExtra.append(this._field('Source EPSG (optional)', this._sourceEpsg, (v) => { this._sourceEpsg = v; this._renderSummary(); }));
    }
    this._crsExtra.append(this._field('Target EPSG', this._targetEpsg, (v) => { this._targetEpsg = v; this._renderSummary(); }));
  }

  private _field(label: string, value: string, onInput: (v: string) => void): HTMLElement {
    const wrap = el('label', { className: 'olv-bc-field' });
    const input = el('input', { className: 'olv-bc-input', type: 'text' }) as HTMLInputElement;
    input.inputMode = 'numeric';
    input.placeholder = 'EPSG code';
    input.value = value;
    input.addEventListener('input', () => onInput(input.value.trim()));
    wrap.append(el('span', { className: 'olv-bc-field-label', text: label }), input);
    return wrap;
  }

  private _setStatus(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this._status.textContent = text;
    this._status.className = `olv-export-status is-${level}`;
  }

  private async _export(): Promise<void> {
    if (this._busy) return;
    if (!this._cb.getCloud()) {
      this._setStatus('Open a scan first, then export.', 'warn');
      return;
    }
    const target = parseEpsg(this._targetEpsg);
    if (this._crsMode !== 'keep' && target == null) {
      this._setStatus('Enter the target EPSG code first.', 'warn');
      return;
    }

    this._busy = true;
    this._exportBtn.disabled = true;
    const useFull = this._fullRes && this._cb.hasFullSource();
    this._exportBtn.textContent = useFull ? 'Re-decoding…' : 'Exporting…';
    try {
      // Full resolution re-decodes the original file; otherwise convert the
      // loaded (display-resolution) cloud.
      const sourceCloud = useFull ? await this._cb.getFullCloud() : this._cb.getCloud();
      if (!sourceCloud) {
        this._setStatus('Could not read the source at full resolution.', 'error');
        return;
      }
      // Respect an active clip: export only the points inside (or outside) the box.
      const clip = this._cb.getActiveClip?.() ?? null;
      const clipped = clip != null && clip.enabled;
      const cloud = clipped ? clipCloud(sourceCloud, clip) : sourceCloud;
      this._exportBtn.textContent = 'Exporting…';
      const { convertCloud } = await loadConvertEngine();
      const options: ConvertOptions = {
        format: this._format,
        crsMode: this._crsMode,
        targetEpsg: target,
        sourceEpsg: parseEpsg(this._sourceEpsg),
        omitClassification: !this._includeClass,
      };
      const { file, report } = convertCloud(cloud, options);
      if (file) {
        // Gzip the written LAS to `.las.gz` when requested (binary LAS only).
        const wantGzip = this._gzip && (this._format === 'las' || this._format === 'las14');
        const out = wantGzip ? await gzipConvertedFile(file, true) : file;
        downloadBytes(out.filename, out.bytes, out.mime);
        // ASCII keep-mode: also emit a `.prj` sidecar with the source WKT.
        const wkt = cloud.metadata?.crs?.wkt;
        if ((this._format === 'xyz' || this._format === 'asc') && this._crsMode === 'keep' && wkt) {
          downloadBytes(file.filename.replace(/\.[^.]+$/, '.prj'), new TextEncoder().encode(wkt), 'text/plain');
        }
        const warn = report.log.find((l) => l.level === 'warn');
        const reducedNote = !useFull && this._cb.isReduced() ? ' · reduced view' : '';
        const clipNote = clipped ? ' · clipped to box' : '';
        this._setStatus(
          warn ? warn.message : `Exported ${report.pointCount.toLocaleString()} points${reducedNote}${clipNote} · ${report.crsNote}`,
          warn || reducedNote ? 'warn' : 'info',
        );
      } else {
        const err = report.log.find((l) => l.level === 'error');
        this._setStatus(err ? err.message : 'Export failed.', 'error');
      }
    } catch (err) {
      this._setStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      this._busy = false;
      this._exportBtn.disabled = false;
      this._exportBtn.textContent = 'Export';
    }
  }
}

function parseEpsg(v: string): number | null {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

