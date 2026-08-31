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
import type { CrsInfo } from '../io/crs';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { PointCloud } from '../model/PointCloud';
import { gzipConvertedFile, gzipAvailable } from '../convert/gzip';
import { buildExportSummary, type ExportSummaryInput } from '../export/exportSummary';
import {
  evaluateFullResClassExport,
  FULL_RES_CLASS_EDITS_MID_EXPORT_REFUSAL,
} from '../export/fullResClassGuard';
import { sameExportTarget, EXPORT_SCAN_CHANGED_REFUSAL } from '../export/exportScanIdentity';
import { clipCloud } from '../render/clip/clipCloud';
import type { ClipBox } from '../render/clip/clipBox';
import type { ExportFormat } from '../io/exporters';
import type { ExportMode } from '../export/types';
import { buildExportDeliverables, type ExportDeliverables } from './export/exportDeliverables';
import type { ReportFinding } from '../render/measure/reportManifest';
import { SessionFindings } from '../render/measure/sessionFindings';
import { buildFindingsPanel, type MountedFindingsPanel } from './findingsPanel';

/**
 * Lightweight, allocation-free description of the exportable cloud, used to
 * render the live summary/enablement WITHOUT materializing the point buffers.
 * For a streaming scan, building the actual export cloud snapshots every
 * resident node into a fresh PointCloud (~150 MB at 5M points with common
 * attributes) — far too heavy to run on every option toggle. This carries only
 * the scalar facts the summary needs; the full cloud is built once, on Export.
 */
export interface ExportCloudSummary {
  /** Points that WILL export (resident count for streaming; full count static). */
  pointCount: number;
  hasRgb: boolean;
  hasGpsTime: boolean;
  crsName: string | null;
  hasWkt: boolean;
  /**
   * Classification provenance as scalar metadata, so the class row can render
   * without materializing a streaming snapshot to inspect a `PointCloud`.
   */
  classProvenance: 'none' | 'source' | 'derived';
}

/** Fallback: derive a summary from an already-materialized cloud (no host summaryInfo). */
function cloudToSummary(cloud: PointCloud | null): ExportCloudSummary | null {
  if (!cloud) return null;
  const crs = cloud.metadata?.crs ?? null;
  let classProvenance: ExportCloudSummary['classProvenance'];
  if (cloud.classificationIsDerived) {
    classProvenance = 'derived';
  } else if (cloud.classification != null) {
    classProvenance = 'source';
  } else {
    classProvenance = 'none';
  }
  return {
    pointCount: cloud.pointCount,
    hasRgb: cloud.colors != null,
    hasGpsTime: cloud.gpsTime != null,
    crsName: crs?.name ?? null,
    hasWkt: crs?.wkt != null,
    classProvenance,
  };
}

export interface ExportPanelCallbacks {
  /**
   * Lightweight summary of the exportable cloud for the live panel, or null when
   * no scan is exportable. MUST NOT materialize streaming buffers. When omitted,
   * the panel falls back to `getCloud()` (which may allocate) for compatibility.
   */
  summaryInfo?: () => ExportCloudSummary | null;
  /** Return the loaded (display-resolution) cloud, or null when none is active. */
  getCloud: () => PointCloud | null;
  /**
   * The active scan's RESOLVED source CRS (CRS authority, override applied), or
   * null for a local / code-less scan. Passed to the converter as the
   * authoritative source CRS so a user override wins over the file's declared
   * `metadata.crs` — a rejected CRS can never reproject or tag the output
   * (blocker #2D). Omitted → the converter falls back to the detected metadata.
   */
  getResolvedSourceCrs?: () => CrsInfo | ResolvedCrs | null;
  /** Whether a full-resolution re-decode of the source is possible (local file). */
  hasFullSource: () => boolean;
  /** Whether the loaded cloud is a reduced subset of the source. */
  isReduced: () => boolean;
  /** Re-decode the original file at full resolution. Only call when `hasFullSource()`. */
  getFullCloud: () => Promise<PointCloud | null>;
  /**
   * Whether the active cloud has in-session classification edits (manual
   * reclassify) that live only in the display-resolution buffer. Drives the
   * full-resolution disclosure — a full-res export re-decodes the original file
   * and drops them.
   */
  hasClassEdits?: () => boolean;
  /** Count of placed measurements — drives the Products lane's enablement. */
  measurementCount?: () => number;
  /** Export the placed measurements to an open format (GeoJSON / CSV). */
  exportMeasurements?: (format: 'geojson' | 'csv') => void;
  /**
   * Export a tamper-evident integrity report (JSON) — the placed measurements as
   * findings, stamped with dataset provenance + the classification epoch + a
   * verifiable content digest. Wired alongside {@link exportMeasurements}.
   */
  exportIntegrityReport?: () => void;
  /**
   * Convert the placed measurements into report findings for the findings
   * ledger. Async because the converter lives in a lazy chunk. Wiring this AND
   * {@link exportFindingsReport} mounts the durable findings ledger under the
   * Measurements group.
   */
  collectMeasurementFindings?: () => Promise<readonly ReportFinding[]>;
  /** Export the curated findings ledger as the signed integrity report (JSON). */
  exportFindingsReport?: (findings: readonly ReportFinding[]) => void;
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
  /**
   * Export the scanned area as a KML polygon (the bounding rectangle of the
   * scan, reprojected to lon/lat). Carries no features, so it is available on a
   * georeferenced scan with nothing measured yet.
   */
  exportScanFootprint?: () => void;
  /**
   * Whether the footprint export is possible right now, with a reason when not.
   * The reason is the user-facing refusal from the CRS gate, so it explains what
   * to fix rather than restating that the button is off.
   */
  scanFootprintStatus?: () => { ready: boolean; reason: string };
  /** The active clip box, if any — when enabled, the cloud export is restricted to it. */
  getActiveClip?: () => ClipBox | null;
  /**
   * Which scan the panel is exporting, as the shell's own active-scan id (null
   * for a streaming scan). Read once before the export's first await and again
   * before the bytes are written: a full-resolution re-decode takes seconds
   * off-thread and nothing stops the user opening another scan meanwhile, which
   * would otherwise write one scan's points under another's name and CRS. When
   * omitted the panel cannot make that comparison and exports as before.
   */
  getActiveScanId?: () => string | null;
  /**
   * Whether a streaming scan is attached but has no resident points to export
   * yet. Lets the gate say "still streaming in" instead of the misleading
   * "open a scan first" during the brief window before the first node lands.
   */
  isStreamingPending?: () => boolean;
  /** Export the active cloud to a point-cloud file format (ply / obj / xyz / csv). */
  onExport?: (format: ExportFormat) => void;
  /** Render the live scan in one Visual Export Studio mode and download a PNG. */
  onExportImage?: (mode: ExportMode) => void;
  /** Generate a PDF report from the live scan using the named template. */
  onExportReport?: (templateId: string) => void;
}

export class ExportPanel {
  readonly element: HTMLElement;
  /** The moved deliverables (formats / image / report), or null when not wired. */
  private readonly _deliverables: ExportDeliverables | null;
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
  /** The session findings ledger, owned here and rendered by the findings panel. */
  private readonly _findings = new SessionFindings();
  private _findingsPanel: MountedFindingsPanel | null = null;

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
  /**
   * Whether the Products section is expanded. Open by default: measurements and
   * the map outlines are primary outputs of a session, and a collapsed lane made
   * them read as an appendix to the point-cloud converter. Held on the instance
   * so a `refresh()` re-render does not fold the section back up under the user.
   */
  private _productsOpen = true;

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

    // The Output Center's deliverables — point-cloud formats, image export, PDF
    // report — moved here from the Inspector so every export lives in one place.
    // Wired only when the host supplies the callbacks; the controller drives the
    // load-time gating.
    if (callbacks.onExport && callbacks.onExportImage && callbacks.onExportReport) {
      this._deliverables = buildExportDeliverables({
        onExport: callbacks.onExport,
        onExportImage: callbacks.onExportImage,
        onExportReport: callbacks.onExportReport,
      });
      body.append(this._deliverables.element);
    } else {
      this._deliverables = null;
    }

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

  /** Enable or disable the image-export + report buttons as a group (see the deliverables). */
  setImageExportEnabled(enabled: boolean): void {
    this._deliverables?.setImageExportEnabled(enabled);
  }

  /** Per-mode availability override for the image-export buttons (see the deliverables). */
  setImageExportAvailability(
    availability: ReadonlyMap<ExportMode, { readonly available: boolean; readonly reason?: string }>,
  ): void {
    this._deliverables?.setImageExportAvailability(availability);
  }

  /**
   * Hide the point-cloud file-format quick export while a streaming scan is
   * active — a streaming cloud has no resident file to write those formats from.
   * Image export and the PDF report stay available (they render the live view).
   */
  setStreamingMode(streaming: boolean): void {
    if (this._deliverables) this._deliverables.formatSection.style.display = streaming ? 'none' : '';
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
    // Read the allocation-free summary — materializing a streaming snapshot just
    // to inspect its classification (which the class row is rendered from on
    // panel construction) concatenated every resident node into a PointCloud
    // before the user pressed Export. Fall back to a materialized cloud only
    // when the host provides no summary.
    const summary = this._cb.summaryInfo?.() ?? cloudToSummary(this._cb.getCloud());
    return summary?.classProvenance ?? 'none';
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
    // Prefer the allocation-free summary; only fall back to getCloud() (which can
    // materialize a streaming snapshot) when no host summaryInfo is wired. This
    // keeps the live summary off the heavy path — the snapshot is built on Export.
    const info: ExportCloudSummary | null = this._cb.summaryInfo
      ? this._cb.summaryInfo()
      : cloudToSummary(this._cb.getCloud());
    if (!info) {
      this._summary.textContent = '';
      return;
    }
    const input: ExportSummaryInput = {
      pointCount: info.pointCount,
      format: this._format,
      hasRgb: info.hasRgb,
      hasGpsTime: info.hasGpsTime,
      crsMode: this._crsMode,
      crsLabel: info.crsName,
      targetEpsg: parseEpsg(this._targetEpsg),
      hasWkt: info.hasWkt,
      classification: this._classProvenance(),
      includeClassification: this._includeClass,
      viewDecimated: this._cb.isReduced(),
      fullRes: this._fullRes,
      hasClassEdits: this._cb.hasClassEdits?.() ?? false,
      gzip: this._gzip,
    };
    const s = buildExportSummary(input);
    const warn = s.warnings.find((w) => w.level === 'error') ?? s.warnings.find((w) => w.level === 'warn');
    this._summary.textContent = warn ? `${s.line} — ${warn.message}` : s.line;
    const summaryModifier = warn ? ` is-${warn.level}` : '';
    this._summary.className = `olv-export-summary${summaryModifier}`;
  }

  /**
   * The "Products" section: the artifacts derived from a scan (measurements as
   * open vector formats, the integrity report, the map outlines) as opposed to
   * the point-cloud file the panel's primary flow writes.
   *
   * It used to be a one-line text toggle over a collapsed strip of small pills,
   * which put a session's actual deliverables below the fold and made them read
   * like an appendix. It is now a titled section, open by default, with each
   * product a full-width button under a group label and a line saying what the
   * file contains or why it is unavailable. Renders nothing when the host wires
   * no product callbacks.
   */
  private _renderProducts(): void {
    this._products.replaceChildren();
    // The Products section carries two independent lanes: the measurement
    // deliverables (which need the measure surface wired) and the map outlines
    // (the Site KML and the Scan-area polygon). The scan-area polygon is derived
    // from the loaded cloud's footprint, so it does not depend on a measurement
    // ever being placed — nor on the measurement export being wired. Render the
    // section whenever EITHER lane has a host callback, so the always-available
    // scan-area control surfaces even when no measurement tool is in play.
    const hasMeasureLane = Boolean(this._cb.exportMeasurements);
    const hasMapLane = Boolean(this._cb.exportKml || this._cb.exportScanFootprint);
    if (!hasMeasureLane && !hasMapLane) return;
    // Defensive: this runs during construction, before the host's lazy viewer
    // resolves. A callback that throws (e.g. dereferencing a not-yet-ready
    // viewer) must degrade to 0, never take down panel/app init.
    let count = 0;
    try {
      count = this._cb.measurementCount?.() ?? 0;
    } catch {
      count = 0;
    }

    const head = el('button', { className: 'olv-export-products-head', type: 'button' });
    const chevron = el('span', { className: 'olv-export-products-chevron', text: '▾' });
    head.append(el('span', { text: 'Products' }), chevron);
    const content = el('div', { className: 'olv-export-products-body' });
    const applyOpen = (): void => {
      head.setAttribute('aria-expanded', this._productsOpen ? 'true' : 'false');
      content.classList.toggle('olv-hidden', !this._productsOpen);
      chevron.classList.toggle('is-closed', !this._productsOpen);
    };
    applyOpen();
    head.addEventListener('click', () => {
      this._productsOpen = !this._productsOpen;
      applyOpen();
    });

    if (hasMeasureLane) {
      const measureRow = el('div', { className: 'olv-export-product-actions' });
      ([['geojson', 'GeoJSON'], ['csv', 'CSV']] as const).forEach(([fmt, label]) => {
        measureRow.append(
          this._productButton(label, count > 0, () => this._cb.exportMeasurements?.(fmt)),
        );
      });
      // Tamper-evident integrity report (JSON) — the same measurements, stamped
      // with provenance + a verifiable content digest (catches accidental/casual
      // edits; not a cryptographic signature). The honest deliverable.
      if (this._cb.exportIntegrityReport) {
        const btn = this._productButton(
          'Integrity report',
          count > 0,
          () => this._cb.exportIntegrityReport?.(),
        );
        btn.setAttribute('data-testid', 'export-integrity-report');
        measureRow.append(btn);
      }
      const measurePlural = count === 1 ? '' : 's';
      content.append(
        this._productGroup(
          'Measurements',
          measureRow,
          count === 0
            ? 'Place measurements, then export them as open vector formats.'
            : `${count} measurement${measurePlural} ready to export.`,
        ),
      );
      // The durable findings ledger: curate the results worth keeping (each with
      // its band and caveats), then export the whole ledger as the same signed
      // integrity report. Mounted only when the host wires both halves.
      if (this._cb.collectMeasurementFindings && this._cb.exportFindingsReport) {
        const collect = this._cb.collectMeasurementFindings;
        const exportReport = this._cb.exportFindingsReport;
        this._findingsPanel = buildFindingsPanel({
          findings: this._findings,
          collectMeasurements: () => collect(),
          exportReport: (f) => exportReport(f),
        });
        content.append(this._productGroup('Findings ledger', this._findingsPanel.element));
      }
    }

    // The map lane: everything that lands in Google Earth / QGIS as lon/lat.
    // Each entry is offered only when the host wires it, and each carries its
    // own readiness because they gate on different things: the site file needs
    // features to place, the outline needs only a known coordinate system.
    const mapRow = el('div', { className: 'olv-export-product-actions' });
    const mapHints: string[] = [];
    if (this._cb.exportKml) {
      const status = this._readStatus(this._cb.kmlStatus);
      mapRow.append(
        this._productButton('Site KML', status.ready, () => this._cb.exportKml?.()),
      );
      mapHints.push(
        status.ready
          ? 'Site KML: annotations, measurements, and saved views.'
          : `Site KML: ${status.reason || 'needs a georeferenced scan with a measurement or annotation.'}`,
      );
    }
    if (this._cb.exportScanFootprint) {
      const status = this._readStatus(this._cb.scanFootprintStatus);
      const btn = this._productButton(
        'Scan area (KML polygon)',
        status.ready,
        () => this._cb.exportScanFootprint?.(),
      );
      btn.setAttribute('data-testid', 'export-scan-footprint');
      mapRow.append(btn);
      mapHints.push(
        status.ready
          ? 'Scan area: the bounding rectangle of the scan, as a lon/lat polygon.'
          : `Scan area: ${status.reason || 'needs a scan with a known coordinate system.'}`,
      );
    }
    if (mapHints.length > 0) {
      content.append(this._productGroup('Google Earth', mapRow, mapHints.join(' ')));
    }
    this._products.append(head, content);
  }

  /**
   * Read a readiness callback without letting it break the render. Same reason
   * as the measurement count above: this runs during construction, before the
   * host's lazy viewer exists, so a dereference in the host must degrade to "not
   * ready" rather than take down app init.
   */
  private _readStatus(
    fn: (() => { ready: boolean; reason: string }) | undefined,
  ): { ready: boolean; reason: string } {
    try {
      return fn?.() ?? { ready: false, reason: '' };
    } catch {
      return { ready: false, reason: '' };
    }
  }

  /** One labelled product group: label, its stacked actions, one line of hint. */
  private _productGroup(label: string, actions: HTMLElement, hint?: string): HTMLElement {
    const group = el('div', { className: 'olv-export-product-group' });
    group.append(this._label(label), actions);
    if (hint) {
      group.append(el('span', { className: 'olv-export-fullres-hint', text: hint }));
    }
    return group;
  }

  /**
   * One product action. Carries the converter's pill treatment so the border,
   * hover and type match every other button in the panel; the extra class makes
   * it a full-width, left-aligned row so a stack of them stays scannable.
   */
  private _productButton(label: string, enabled: boolean, onClick: () => void): HTMLButtonElement {
    const btn = el('button', {
      className: 'olv-bc-pill olv-export-product-btn',
      type: 'button',
      text: label,
    }) as HTMLButtonElement;
    btn.disabled = !enabled;
    btn.addEventListener('click', onClick);
    return btn;
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
    // Existence check via the lightweight summary so opening the panel / pressing
    // export doesn't materialize a streaming snapshot before we've committed to it.
    const exportable = this._cb.summaryInfo
      ? this._cb.summaryInfo() != null
      : this._cb.getCloud() != null;
    if (!exportable) {
      this._setStatus(
        this._cb.isStreamingPending?.()
          ? 'The scan is still streaming in — try export again once points appear.'
          : 'Open a scan first, then export.',
        'warn',
      );
      return;
    }
    const target = parseEpsg(this._targetEpsg);
    if (this._crsMode !== 'keep' && target == null) {
      this._setStatus('Enter the target EPSG code first.', 'warn');
      return;
    }

    const useFull = this._fullRes && this._cb.hasFullSource();
    // Refuse — never silently discard. A full-resolution export re-decodes the
    // original file and cannot carry in-session classification edits (they are
    // keyed by display-point index; the re-decode has no stable mapping back).
    // Block the write and steer the user to a lossless path instead of shipping
    // a file that quietly drops their edits.
    const classGate = evaluateFullResClassExport({
      fullRes: useFull,
      includeClassification: this._includeClass,
      hasClassEdits: this._cb.hasClassEdits?.() ?? false,
    });
    if (!classGate.allowed) {
      this._setStatus(classGate.reason ?? 'Export refused.', 'error');
      return;
    }

    // Snapshot the export's inputs BEFORE the first await. The clip box decides
    // which points reach the file, and the user can drag or disable it while the
    // decode runs — reading it afterwards would filter the export by a box that
    // was never part of the request. `scanId` is the identity re-verified below.
    const clip = this._cb.getActiveClip?.() ?? null;
    const scanId = this._cb.getActiveScanId?.() ?? null;
    // Snapshot the resolved source CRS with the other request inputs, so the
    // whole export — the converted data, its metadata, and the ASCII `.prj`
    // sidecar — describes ONE frame even if the user changes the CRS picker
    // mid-decode. `resolvedCrsGetter === undefined` means no resolver is wired
    // (legacy/pure caller → declared-metadata fallback); a wired getter returning
    // `null` is an explicit Local/no-CRS resolution and must NOT fall back to A.
    const resolvedCrsGetter = this._cb.getResolvedSourceCrs;
    const resolvedSourceCrs = resolvedCrsGetter ? resolvedCrsGetter() : undefined;

    this._busy = true;
    this._exportBtn.disabled = true;
    this._exportBtn.textContent = useFull ? 'Re-decoding…' : 'Exporting…';
    try {
      // Full resolution re-decodes the original file; otherwise convert the
      // loaded (display-resolution) cloud.
      const sourceCloud = useFull ? await this._cb.getFullCloud() : this._cb.getCloud();
      if (!sourceCloud) {
        this._setStatus('Could not read the source at full resolution.', 'error');
        return;
      }
      // The decode is over — prove the export still describes what was asked for
      // before any bytes are written. Nothing disables the scan list or the
      // reclassify tools while a multi-second full-res decode runs off-thread, so
      // both facts the gate above depends on can have moved underneath it. The
      // class gate is re-taken rather than re-implemented: an edit made during the
      // decode flips exactly the input it already reads.
      if (!sameExportTarget(this._cb.getActiveScanId?.() ?? null, scanId)) {
        this._setStatus(EXPORT_SCAN_CHANGED_REFUSAL, 'error');
        return;
      }
      const classGateAfter = evaluateFullResClassExport({
        fullRes: useFull,
        includeClassification: this._includeClass,
        hasClassEdits: this._cb.hasClassEdits?.() ?? false,
      });
      if (!classGateAfter.allowed) {
        this._setStatus(FULL_RES_CLASS_EDITS_MID_EXPORT_REFUSAL, 'error');
        return;
      }
      // Respect an active clip: export only the points inside (or outside) the
      // box the user had set when they pressed Export (captured above).
      const clipped = clip?.enabled;
      const cloud = clipped ? clipCloud(sourceCloud, clip) : sourceCloud;
      this._exportBtn.textContent = 'Exporting…';
      const { convertCloud } = await loadConvertEngine();
      const options: ConvertOptions = {
        format: this._format,
        crsMode: this._crsMode,
        targetEpsg: target,
        sourceEpsg: parseEpsg(this._sourceEpsg),
        // Resolved source CRS (override applied) is authoritative — the file's
        // declared metadata.crs is provenance only, so a rejected/local override
        // never tags or reprojects the output (blocker #2D). undefined when the
        // host wires no resolver, which keeps the detected-metadata fallback.
        // The request-time snapshot (not a fresh call) keeps the whole export
        // on one frame.
        resolvedSourceCrs,
        omitClassification: !this._includeClass,
      };
      const { file, report } = convertCloud(cloud, options);
      if (file) {
        // Gzip the written LAS to `.las.gz` when requested (binary LAS only).
        const wantGzip = this._gzip && (this._format === 'las' || this._format === 'las14');
        const out = wantGzip ? await gzipConvertedFile(file, true) : file;
        downloadBytes(out.filename, out.bytes, out.mime);
        // ASCII keep-mode: also emit a `.prj` sidecar. It carries the RESOLVED
        // WKT from the same request-time snapshot the converted data used, so the
        // sidecar and the data can never name different frames. A wired resolver
        // returning null (Local/no-CRS) yields no `.prj`, never the rejected
        // source WKT; only an unwired resolver falls back to declared metadata.
        const activeWkt = resolvedCrsGetter !== undefined
          ? (resolvedSourceCrs?.wkt ?? null)
          : (cloud.metadata?.crs?.wkt ?? null);
        if ((this._format === 'xyz' || this._format === 'asc') && this._crsMode === 'keep' && activeWkt) {
          downloadBytes(file.filename.replace(/\.[^.]+$/, '.prj'), new TextEncoder().encode(activeWkt), 'text/plain');
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
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

