/**
 * snapshotAction.ts — Save view as a PNG, lifted out of the composition root.
 *
 * Entirely client-side. Placed measurements and annotations are burned into
 * the image, so the snapshot is usable as inspection evidence; a clean scan
 * with neither exports the bare render. The live scene is rendered through the
 * class-mask shader, so a filtered view carries the same class-scope banner
 * the Studio export path stamps. Figure provenance (build, CRS, colour map,
 * camera, clip) is embedded as PNG text chunks.
 *
 * A reference plane that is on screen is part of the view, so it is in the
 * pixels, and the provenance says so in an `olv:reference-plane` chunk. The
 * scope stamp, the view context and that note are read as soon as the capture
 * resolves, before any further await, so a later change to the view cannot
 * reach them; a change during the capture itself is not guarded.
 */

import type { FigureViewContext } from '../export/types';
import { loadExportStudio, loadScanReportRenderer } from '../lazyChunks';
import { triggerDownload } from '../io/download';

/** The viewer surface a snapshot uses. `Viewer` satisfies it structurally. */
export interface SnapshotViewer {
  snapshot(options: { annotations: boolean; measurements: boolean; colorbar: boolean }): Promise<Blob>;
  readonly annotate: { getAnnotations(): readonly unknown[] };
  readonly measure: { getMeasurements(): readonly unknown[] };
  figureViewContext(): FigureViewContext;
}

export interface SnapshotActionDeps {
  readonly viewer: SnapshotViewer;
  /** The class-scope stamp, empty when no class is hidden. */
  readonly classScopeStamp: () => string;
  /** The reference plane's provenance note while it is drawn, else null. */
  readonly referencePlaneNote: () => string | null;
  readonly onError: (message: string) => void;
  /** Injected by the tests; the browser download otherwise. */
  readonly download?: (blob: Blob, filename: string) => void;
}

export async function saveSnapshot(deps: SnapshotActionDeps): Promise<void> {
  const { viewer } = deps;
  try {
    const blob = await viewer.snapshot({
      annotations: viewer.annotate.getAnnotations().length > 0,
      measurements: viewer.measure.getMeasurements().length > 0,
      // The labelled colorbar for a continuous scalar mode, so exported colours
      // read back to values and units. Self-gating in the Viewer.
      colorbar: true,
    });
    const scope = deps.classScopeStamp();
    const figureView = { ...viewer.figureViewContext(), referencePlane: deps.referencePlaneNote() };
    // With an empty stamp (nothing hidden) the helper returns the input Blob unchanged.
    let stamped = await (await loadScanReportRenderer()).composeClassScopeBannerOntoBlob(blob, scope);
    // The stamping code lives in the lazy Studio chunk. A chunk-load or stamping
    // failure is swallowed: the snapshot must never sink on a metadata enrichment.
    try {
      const studio = await loadExportStudio();
      stamped = await studio.stampFigureProvenanceOntoBlob(stamped, figureView);
    } catch (err) {
      console.warn('[snapshot] provenance stamping skipped:', err);
    }
    (deps.download ?? triggerDownload)(stamped, 'openlidarviewer.png');
  } catch {
    deps.onError('Could not save the view');
  }
}
