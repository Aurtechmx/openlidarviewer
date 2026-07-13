/**
 * figureMetadata.ts
 *
 * The one-call bridge between a rendered PNG `Blob` and its embedded
 * provenance: fill in the build identity, build the ordered text-chunk
 * entries, splice them into the PNG bytes, hand back a stamped Blob.
 *
 * Used by BOTH figure surfaces so they can never drift:
 *   - `runStudioExport` (this chunk) stamps every Studio image export;
 *   - `saveSnapshot` in main.ts reaches it through the `loadExportStudio()`
 *     seam, so the stamping code stays in the lazy export chunk and adds
 *     nothing to the eager shell.
 *
 * Fault tolerance is the load-bearing property: metadata is an ENRICHMENT
 * of an export that already succeeded at the GPU layer. Any failure here —
 * a payload that is not actually a PNG, a decode quirk, an exotic Blob
 * implementation — returns the input Blob unchanged with a console warning,
 * never a rejection. Mirrors the compose helpers in ScanReportRenderer.
 */

import { buildIdentityProvenance } from '../build/buildIdentity';
import { buildFigureProvenance } from './figureProvenance';
import { encodePngTextChunks } from './pngTextChunks';
import type { FigureCameraPose, FigureClipSummary } from './types';

/** The per-figure facts a caller supplies; build identity is filled here. */
export interface FigureStampContext {
  readonly crs?: { name: string; unit: string; epsg?: number } | null;
  readonly colorMode?: string | null;
  readonly palette?: string | null;
  readonly camera?: FigureCameraPose | null;
  readonly clip?: FigureClipSummary | null;
}

/**
 * Embed figure provenance into a PNG Blob as `tEXt`/`iTXt` chunks. The
 * timestamp parameter exists for deterministic tests; production callers
 * take the default. MUST be the LAST step of an export pipeline — any later
 * canvas decode/re-encode would strip the chunks.
 */
export async function stampFigureProvenanceOntoBlob(
  png: Blob,
  context: FigureStampContext,
  timestamp: string = new Date().toISOString(),
): Promise<Blob> {
  try {
    const entries = buildFigureProvenance({
      build: buildIdentityProvenance(),
      timestamp,
      crs: context.crs ?? null,
      colorMode: context.colorMode ?? null,
      palette: context.palette ?? null,
      camera: context.camera ?? null,
      clip: context.clip ?? null,
    });
    const bytes = new Uint8Array(await png.arrayBuffer());
    const stamped = encodePngTextChunks(bytes, entries);
    return new Blob([stamped as unknown as BlobPart], { type: 'image/png' });
  } catch (err) {
    console.warn('[export] figure provenance stamping skipped:', err);
    return png;
  }
}
