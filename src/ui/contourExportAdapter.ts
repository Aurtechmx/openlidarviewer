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

/** The vector contour formats the adapter dispatches to the host. */
export type ContourVectorFormat = Extract<ContourStudioExportProduct, 'geojson' | 'dxf' | 'svg'>;

/**
 * What the adapter needs the host (AnalysePanel) to provide. Every method that
 * touches the panel's result or DOM stays on the panel; the adapter only
 * decides and sequences.
 */
export interface ContourExportHost {
  /** Adopt the intent's geometry style so the export regenerates at it. */
  setContourStyle(style: ContourShapeStyle): void;
  /** Serialize + download one vector format with its granted permit + provenance. */
  exportVector(
    fmt: ContourVectorFormat,
    opts: { contourMethod?: string; deliverablePurpose?: string; permit: ContourExportPermit },
  ): Promise<void>;
  /** Stash the granted permit for the async map-sheet dialog, then open it. */
  openMapPdf(permit: ContourExportPermit): void;
  /** Run the DEM package export (governed by its own evidence gate). */
  exportDemPackage(): Promise<void>;
  /** Run the terrain intelligence report export (its own gate). */
  exportTerrainReport(): Promise<void>;
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
   * facts; `intent` the per-click purpose/geometry. Vector + map-PDF products are
   * gated here by the single authoritative permit; the DEM package and report
   * route through their own existing gates.
   */
  handle(
    product: ContourStudioExportProduct,
    srcBtn: HTMLButtonElement,
    intent: ContourExportIntent,
    frame: ContourExportFrameFacts,
  ): void {
    // Make the purpose real: two purposes regenerate different geometry.
    this.host.setContourStyle(intent.shapeStyle);

    // DEM package + report carry their own evidence gate; run them (with the
    // clicked button showing busy) without minting a contour permit.
    if (product === 'package') {
      void this._busy(srcBtn, () => this.host.exportDemPackage());
      return;
    }
    if (product === 'report') {
      void this._busy(srcBtn, () => this.host.exportTerrainReport());
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
    window.setTimeout(() => {
      btn.textContent = restore;
      btn.disabled = false;
    }, BLOCKED_FLASH_MS);
  }
}
