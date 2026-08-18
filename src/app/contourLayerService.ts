/**
 * contourLayerService.ts
 *
 * Lifecycle for the contours DERIVED LAYER: the first analytical product that
 * lives in the 3D scene as a first-class layer rather than only as an export.
 *
 * It owns exactly two things and nothing else: the `DerivedLayerStore` record
 * (what the layer IS — name, source scan, provenance, coverage, display state)
 * and the `ContourOverlay` (what is drawn). Everything three.js stays inside the
 * overlay; everything view-bound stays in the Viewer behind its structural
 * `derivedLayerHost()`. So this module is pure orchestration and is testable in
 * Node against fakes.
 *
 * WHY A SERVICE AND NOT A FEW CALLS IN THE RUNNER. Two invariants only hold if
 * one place owns them:
 *
 *  - a RE-ANALYSIS must replace the drawn geometry and bump the layer's
 *    generation, never leave the previous overlay stacked behind the new one;
 *  - a CLOSED scan must take its derived layers with it — a contour layer that
 *    outlives the scan it was derived from is a claim about data no longer
 *    loaded, and would keep drawing over whatever is opened next.
 *
 * The store already models regeneration (`put` bumps `generation`) and source
 * ownership (`bySource`); this wires the overlay to the same events so the two
 * cannot disagree about what is on screen.
 */

import { DerivedLayerStore, type DerivedLayer } from '../model/DerivedLayer';
import { ContourOverlay, type ContourOverlayHost } from '../render/ContourOverlay';
import type { ContourFeatureModel } from '../terrain/contour/contourFeatureModel';
import type { SourceFormat } from '../io/sniffFormat';

/** The stable id of the contour layer derived from a given scan. */
export function contourLayerId(scanId: string): string {
  return `contours:${scanId}`;
}

/** What a contour layer needs to be built and placed. */
export interface ContourLayerInput {
  /** The scan the contours were derived FROM (owns the layer's lifetime). */
  readonly scanId: string;
  readonly model: ContourFeatureModel;
  /** Fixes the scene frame — a Y-up scan is drawn through the inverse rotation. */
  readonly format: SourceFormat;
  readonly renderOrigin: readonly [number, number, number] | null;
  /** Vertical exaggeration currently applied to the scene. Default 1. */
  readonly zScale?: number;
  /** Coverage honesty, carried from the analysis that produced the contours. */
  readonly coverage?: DerivedLayer['coverage'];
  /** True when the analysis was exploratory rather than evidence-graded. */
  readonly evidenceExploratory?: boolean;
  /** The scientific record digest, when the product is graded. */
  readonly provenanceDigest?: string | null;
}

/** The overlay factory, injectable so tests do not construct three.js objects. */
export type ContourOverlayFactory = (host: ContourOverlayHost) => ContourOverlay;

export interface ContourLayerServiceDeps {
  /** `viewer.derivedLayerHost()` — scene membership + redraw, nothing more. */
  readonly host: ContourOverlayHost;
  /** The app's derived-layer store. Shared, so other products can join it. */
  readonly store: DerivedLayerStore;
  readonly makeOverlay?: ContourOverlayFactory;
}

export interface ContourLayerService {
  /** Build or REGENERATE the contour layer for a scan, and draw it. */
  show(input: ContourLayerInput): DerivedLayer;
  /** The layer record for a scan, if one exists. */
  layerFor(scanId: string): DerivedLayer | undefined;
  setVisible(scanId: string, visible: boolean): DerivedLayer | undefined;
  setOpacity(scanId: string, opacity: number): DerivedLayer | undefined;
  setHeightOffset(scanId: string, offset: number): DerivedLayer | undefined;
  setIndexEmphasis(scanId: string, on: boolean): DerivedLayer | undefined;
  /** Drop every derived layer owned by a scan, and stop drawing it. */
  clearForScan(scanId: string): void;
  /** Release the overlay and its GPU resources. */
  dispose(): void;
}

export function createContourLayerService(deps: ContourLayerServiceDeps): ContourLayerService {
  const makeOverlay = deps.makeOverlay ?? ((host) => new ContourOverlay(host));
  // ONE overlay, reused across regenerations. A per-analysis overlay would need
  // the caller to remember to dispose the previous one, which is exactly the
  // "stale overlay left drawn" bug this service exists to make impossible.
  let overlay: ContourOverlay | null = null;
  // The scan the overlay currently draws, so a different scan's controls cannot
  // silently drive geometry belonging to another.
  let drawnScanId: string | null = null;

  const ensureOverlay = (): ContourOverlay => {
    overlay ??= makeOverlay(deps.host);
    return overlay;
  };

  /** Apply a display patch to the store, then mirror it onto the overlay. */
  const patch = (
    scanId: string,
    mutate: (id: string) => DerivedLayer | undefined,
    paint: (o: ContourOverlay) => void,
  ): DerivedLayer | undefined => {
    const next = mutate(contourLayerId(scanId));
    // Only paint when the overlay is actually showing THIS scan; a control for a
    // background scan updates its record without touching what is on screen.
    if (next && overlay && drawnScanId === scanId) paint(overlay);
    return next;
  };

  return {
    show(input) {
      const o = ensureOverlay();
      o.setModel({
        model: input.model,
        format: input.format,
        renderOrigin: input.renderOrigin,
        zScale: input.zScale ?? 1,
      });
      drawnScanId = input.scanId;
      const id = contourLayerId(input.scanId);
      // `put` REPLACES the record (bumping generation), so the display state the
      // user chose has to be carried across explicitly. Without this, re-running
      // the analysis silently snaps a hidden or faded layer back to fully
      // visible — the user's choice undone by a background recompute.
      const prev = deps.store.get(id);
      const layer = deps.store.put({
        id,
        type: 'contours',
        name: 'Contours',
        sourceScanIds: [input.scanId],
        coverage: input.coverage ?? 'unknown',
        evidenceExploratory: input.evidenceExploratory ?? false,
        provenanceDigest: input.provenanceDigest ?? null,
        visible: prev?.visible,
        opacity: prev?.opacity,
        style: prev ? { ...prev.style } : undefined,
      });
      // The record is the source of truth for display state, so a regeneration
      // re-asserts ALL of it onto the freshly built geometry.
      o.setVisible(layer.visible);
      o.setOpacity(layer.opacity);
      if (typeof layer.style.heightOffset === 'number') o.setHeightOffset(layer.style.heightOffset);
      if (typeof layer.style.indexEmphasis === 'boolean') o.setIndexEmphasis(layer.style.indexEmphasis);
      return layer;
    },

    layerFor(scanId) {
      return deps.store.get(contourLayerId(scanId));
    },

    setVisible(scanId, visible) {
      return patch(scanId, (id) => deps.store.setVisible(id, visible), (o) => { o.setVisible(visible); });
    },

    setOpacity(scanId, opacity) {
      return patch(scanId, (id) => deps.store.setOpacity(id, opacity), (o) => { o.setOpacity(opacity); });
    },

    setHeightOffset(scanId, offset) {
      return patch(
        scanId,
        (id) => deps.store.setStyle(id, { heightOffset: offset }),
        (o) => { o.setHeightOffset(offset); },
      );
    },

    setIndexEmphasis(scanId, on) {
      return patch(
        scanId,
        (id) => deps.store.setStyle(id, { indexEmphasis: on }),
        (o) => { o.setIndexEmphasis(on); },
      );
    },

    clearForScan(scanId) {
      for (const layer of deps.store.bySource(scanId)) deps.store.remove(layer.id);
      // Stop drawing only if the overlay belonged to THIS scan — closing a
      // background scan must not blank the contours of the one on screen.
      if (drawnScanId === scanId && overlay) {
        overlay.dispose();
        overlay = null;
        drawnScanId = null;
      }
    },

    dispose() {
      overlay?.dispose();
      overlay = null;
      drawnScanId = null;
    },
  };
}
