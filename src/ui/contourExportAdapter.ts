/**
 * contourExportAdapter.ts
 *
 * The Contour Studio export orchestration, extracted from AnalysePanel (the
 * v0.5.9 god-object) as a focused collaborator. It owns ONE responsibility:
 * turn a Studio export click (product + intent + frame facts) into a gated,
 * provenance-stamped export — mint the §19 permit, refuse when blocked, choose
 * the dispatch, and manage the button's busy state. The panel keeps only the
 * concrete exporters (which touch its result/DOM) and hands them in through the
 * small {@link ContourExportHost} seam, so the orchestration is testable and the
 * panel shrinks by exactly this cohesive slice.
 *
 * No DOM construction of its own beyond the busy/blocked state on the button the
 * user pressed; all file writing lives behind the host.
 */

import type { ContourStudioExportProduct, ContourExportIntent } from './contourStudioMount';
import type { ContourShapeStyle } from '../terrain/contour/contourShapeStyle';
import {
  resolveContourExportPermit,
  type ContourPermitProduct,
  type ContourExportFrameFacts,
  type ContourExportPermit,
} from '../export/contourExportPermit';
import { permitStamp } from '../export/permitStamp';
import type { ExportPermitStamp } from '../terrain/export/exportProvenance';

/** The vector contour formats the adapter dispatches to the host. */
export type ContourVectorFormat = Extract<ContourStudioExportProduct, 'geojson' | 'dxf' | 'svg'>;

/**
 * What the adapter needs the host (AnalysePanel) to provide. Every method that
 * touches the panel's result or DOM stays on the panel; the adapter only
 * decides and sequences.
 */
export interface ContourExportHost {
  /**
   * Adopt the intent's geometry style + generalization tolerance so the export
   * regenerates at them. `generalizeToleranceCells` (cells) tunes the
   * 'generalized' style per purpose; omitted/undefined leaves the host at its
   * default tolerance.
   */
  setContourStyle(style: ContourShapeStyle, generalizeToleranceCells?: number): void;
  /** Serialize + download one vector format with its granted permit + provenance. */
  exportVector(
    fmt: ContourVectorFormat,
    opts: { contourMethod?: string; deliverablePurpose?: string; permit: ContourExportPermit },
  ): Promise<void>;
  /** Stash the granted permit for the async map-sheet dialog, then open it. */
  openMapPdf(permit: ContourExportPermit): void;
  /**
   * Run the DEM raster package export, stamped with the evidence-gate permit the
   * adapter resolved (or null when unavailable). The DEM keeps its own internal
   * availability contract; the stamp records the unified gate decision.
   */
  exportDemPackage(permitStamp: ExportPermitStamp | null): Promise<void>;
  /**
   * Run the complete deliverable ZIP export (curated contours + DTM + provenance
   * + README + SHA256SUMS), gated + stamped by the resolved permit.
   */
  exportCompletePackage(permit: ContourExportPermit): Promise<void>;
  /**
   * Run the terrain intelligence report export, stamped with the evidence-gate
   * permit the adapter resolved (or null when unavailable). The report keeps its
   * honest describe-anything content contract; the stamp records the unified
   * gate decision in its provenance footer.
   */
  exportTerrainReport(permitStamp: ExportPermitStamp | null): Promise<void>;
}

/** Milliseconds the "Blocked" flash sits on a button before restoring. */
const BLOCKED_FLASH_MS = 1500;

export class ContourExportAdapter {
  private readonly host: ContourExportHost;

  constructor(host: ContourExportHost) {
    this.host = host;
  }

  /**
   * Handle one Studio export product. `frame` carries the stable per-frame gate
   * facts; `intent` the per-click purpose/geometry. EVERY product is gated here
   * by the single authoritative permit — vectors, map-PDF, DEM package, complete
   * deliverable and terrain report all resolve through the one evidence resolver.
   */
  handle(
    product: ContourStudioExportProduct,
    srcBtn: HTMLButtonElement,
    intent: ContourExportIntent,
    frame: ContourExportFrameFacts,
  ): void {
    // Make the purpose real: two purposes regenerate different geometry, each at
    // its own bounded generalization tolerance.
    this.host.setContourStyle(intent.shapeStyle, intent.generalizeToleranceCells);

    // DEM raster package: routed through the SAME resolver (DTM claim). A hard
    // block (no usable surface) refuses; otherwise it exports stamped with the
    // resolved decision — the raster keeps its preview-availability contract, so
    // an exploratory launch still exports, just labelled exploratory.
    if (product === 'package') {
      const demPermit = resolveContourExportPermit('dem', {
        launchStatus: frame.launchStatus,
        verticalUnitsKnown: frame.verticalUnitsKnown,
        crsProjected: frame.crsProjected,
        analyticalGeometry: false,
        blockedReasons: frame.blockedReasons,
      });
      if (!demPermit.ok) {
        this._flashBlocked(srcBtn, product, demPermit.reasons);
        return;
      }
      void this._busy(srcBtn, () => this.host.exportDemPackage(permitStamp(demPermit)));
      return;
    }
    // Complete deliverable ZIP: gated as the bundle product (contour.package /
    // CONTOURS claim). A hard block refuses; otherwise it assembles + downloads,
    // stamped with the resolved decision.
    if (product === 'deliverable') {
      const permit = resolveContourExportPermit('complete-package', {
        launchStatus: frame.launchStatus,
        verticalUnitsKnown: frame.verticalUnitsKnown,
        crsProjected: frame.crsProjected,
        analyticalGeometry: false,
        blockedReasons: frame.blockedReasons,
      });
      if (!permit.ok) {
        this._flashBlocked(srcBtn, product, permit.reasons);
        return;
      }
      void this._busy(srcBtn, () => this.host.exportCompletePackage(permit));
      return;
    }
    // Terrain intelligence report: routed through the SAME resolver (DTM claim,
    // contour.report). A hard block (no usable surface) refuses; otherwise it
    // exports stamped with the resolved decision — the report keeps describing
    // preview/blocked verdicts honestly in its body, and its provenance footer
    // records the gate decision that permitted the file.
    if (product === 'report') {
      const reportPermit = resolveContourExportPermit('report', {
        launchStatus: frame.launchStatus,
        verticalUnitsKnown: frame.verticalUnitsKnown,
        crsProjected: frame.crsProjected,
        analyticalGeometry: false,
        blockedReasons: frame.blockedReasons,
      });
      if (!reportPermit.ok) {
        this._flashBlocked(srcBtn, product, reportPermit.reasons);
        return;
      }
      void this._busy(srcBtn, () => this.host.exportTerrainReport(permitStamp(reportPermit)));
      return;
    }

    // §19: mint the permit for the contour product. analyticalGeometry keys off
    // the intent's method id so a generalized line is never minted as exact.
    const permit = resolveContourExportPermit(product as ContourPermitProduct, {
      launchStatus: frame.launchStatus,
      verticalUnitsKnown: frame.verticalUnitsKnown,
      crsProjected: frame.crsProjected,
      analyticalGeometry: intent.methodId === 'olv.contour.analytical',
      blockedReasons: frame.blockedReasons,
    });
    if (!permit.ok) {
      this._flashBlocked(srcBtn, product, permit.reasons);
      return;
    }

    if (product === 'pdf') {
      // The dialog is the feedback — no busy spinner; stash the permit + open it.
      this.host.openMapPdf(permit);
      return;
    }
    // geojson | dxf | svg → the gated vector exporter, stamped self-describing.
    const fmt = product as ContourVectorFormat;
    void this._busy(srcBtn, () =>
      this.host.exportVector(fmt, {
        contourMethod: intent.methodTag,
        deliverablePurpose: intent.purpose,
        permit,
      }),
    );
  }

  /** Toggle the clicked button's busy state around an async export. */
  private async _busy(btn: HTMLButtonElement, run: () => Promise<void>): Promise<void> {
    const label = btn.textContent ?? '';
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await run();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /**
   * Flash a "Blocked" state + log when the gate refuses. Defensive: the launcher
   * only exposes exports for exploratory / available states (which always mint a
   * granted permit), so a block here signals an inconsistent state rather than
   * silently doing nothing (which would read as a broken button).
   */
  private _flashBlocked(
    btn: HTMLButtonElement,
    product: ContourStudioExportProduct,
    reasons: readonly string[],
  ): void {
    // eslint-disable-next-line no-console
    console.warn(
      `OpenLiDARViewer: contour ${product} export blocked by the evidence gate — ${reasons.join(' ')}`,
    );
    const restore = btn.textContent ?? '';
    btn.textContent = 'Blocked';
    btn.disabled = true;
    // Global setTimeout (not window.*) so the adapter is also unit-testable in a
    // non-DOM environment; it resolves to the same timer in the browser.
    setTimeout(() => {
      btn.textContent = restore;
      btn.disabled = false;
    }, BLOCKED_FLASH_MS);
  }
}
