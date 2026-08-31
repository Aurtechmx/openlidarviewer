/**
 * exportImageAction.ts — the ExportPanel "export image" callback, lifted out of
 * the composition root.
 *
 * The Visual Export Studio ships in its own lazy chunk (`viewer.exportImage`
 * pulls it in on first use); the download triggers off the returned Blob. A
 * georeferenced ortho export returns world-file data and ships as a PNG + .pgw +
 * .prj ZIP that QGIS/ArcGIS place directly; every other export ships the bare
 * PNG. Packaging failures fall back to the bare PNG rather than sinking an
 * export that already rendered.
 *
 * The viewer and the drop zone are read through getters: both are assigned later
 * in main's boot than the ExportPanel is constructed, so the callback closes over
 * the getters, not the values.
 */

import type { ExportMode } from '../export/types';
import type { Viewer } from '../render/Viewer';
import { increment as recordUsage } from '../diagnostics/usageCounters';
import { loadPngWorldFile } from '../lazyChunks';
import { triggerDownload } from '../io/download';

/** The progress surface the action drives (a `DropZone`, structurally). */
export interface ExportImageProgress {
  setProgress(text: string | null, fraction?: number): void;
  setError(text: string): void;
}

export interface ExportImageActionDeps {
  /** The live viewer, or null before the first scan loads. */
  readonly getViewer: () => Viewer | null;
  /** The progress surface (assigned later in boot than the panel). */
  readonly getProgress: () => ExportImageProgress;
  readonly scans: { readonly activeId: string | null };
  readonly baseName: (name: string) => string;
  readonly currentClassScopeStamp: () => string;
}

const MODE_LABEL: Record<string, string> = {
  'orthographic-rgb': 'orthographic RGB',
  'height-map': 'height map',
  intensity: 'intensity map',
  classification: 'classification map',
  depth: 'depth map',
  normal: 'normal map',
  contour: 'contour map',
};

/** Render and download an image export for `mode`. */
export function exportImageAction(mode: ExportMode, deps: ExportImageActionDeps): void {
  const viewer = deps.getViewer();
  if (!viewer) return;
  const progress = deps.getProgress();
  const sourceName = deps.scans.activeId ? viewer.getCloud(deps.scans.activeId)?.name : viewer.streamingCloud?.name;
  const base = sourceName ? deps.baseName(sourceName) : 'openlidarviewer';
  const label = MODE_LABEL[mode] ?? mode;
  progress.setProgress(`Exporting ${label}…`);
  viewer
    // Thread the active class-scope stamp so a filtered export carries the
    // "showing N of M classes" banner; empty when nothing is hidden.
    .exportImage(mode, {}, deps.currentClassScopeStamp())
    .then(async (result) => {
      // Georeferenced ortho path: when the exporter returned world-file data
      // (true top-down ortho frame + known world origin + CRS WKT), the download
      // is one ZIP — PNG + `.pgw` + `.prj` — that QGIS/ArcGIS place directly.
      // Packaging failures fall back to the bare PNG.
      if (result.worldFile) {
        try {
          const { buildStudioPngPackage } = await loadPngWorldFile();
          const wf = result.worldFile;
          const pkg = buildStudioPngPackage({
            basename: `${base}-${mode}`,
            png: new Uint8Array(await result.blob.arrayBuffer()),
            extent: wf.extent,
            widthPx: wf.widthPx,
            heightPx: wf.heightPx,
            worldOrigin: wf.worldOrigin,
            wkt: wf.wkt,
          });
          if (pkg) {
            triggerDownload(new Blob([pkg.zip as BlobPart], { type: 'application/zip' }), pkg.filename);
            recordUsage('export', mode);
            progress.setProgress(null);
            return;
          }
        } catch (err) {
          console.warn('[image-export] world-file packaging failed — shipping bare PNG:', err);
        }
      }
      triggerDownload(result.blob, `${base}-${mode}.png`);
      recordUsage('export', mode);
      progress.setProgress(null);
    })
    .catch((err: unknown) => {
      recordUsage('error', 'export');
      progress.setProgress(null);
      // Surface the orchestrator's explicit reason through the shared toast UI
      // rather than a modal alert.
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[image-export]', err);
      progress.setError(`Image export failed: ${msg}`);
    });
}
