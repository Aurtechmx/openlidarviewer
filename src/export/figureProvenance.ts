/**
 * figureProvenance.ts
 *
 * Figure provenance — the ordered PNG text-chunk entries a rendered figure
 * carries so it can answer, months later and far from this app, "which build
 * drew you, in what coordinate system, coloured how, seen from where, and
 * was anything clipped away?".
 *
 * This is deliberately NOT the terrain-shaped `buildExportProvenance` (which
 * documents an analysis pipeline: method registry ids, validation metrics,
 * confidence). A figure's provenance is about the RENDER — build identity,
 * CRS, colour mapping, camera, clip — and it lives inside the PNG itself as
 * standard `tEXt`/`iTXt` chunks rather than in a sidecar, because a bare PNG
 * gets copied into slide decks and tickets without its sidecars.
 *
 * Keyword scheme: the two registered PNG keywords every metadata tool
 * understands (`Software`, `Creation Time`), then namespaced `olv:*` keys
 * for the app-specific facts. The `Creation Time` value is CALLER-supplied —
 * no `new Date()` in here — so the builder is deterministic and the tests
 * can pin exact output.
 *
 * Honesty contract: an unknown fact produces NO entry. A figure with no CRS
 * carries no `olv:crs` chunk at all; nothing is fabricated or emitted empty.
 *
 * Pure data + string formatting: no DOM, no three.js, no I/O.
 */

import type { PngTextEntry } from './pngTextChunks';
import type { FigureCameraPose, FigureClipSummary } from './types';

/** The `Software` chunk value — the app's stable public name. */
export const FIGURE_SOFTWARE = 'OpenLiDARViewer';

/** Everything a caller may (but need not) know about the rendered figure. */
export interface FigureProvenanceInput {
  /** Build identity line — `buildIdentityProvenance()` verbatim. */
  readonly build: string;
  /** Caller-supplied creation timestamp (ISO 8601) — see module doc. */
  readonly timestamp: string;
  readonly crs?: { name: string; unit: string; epsg?: number } | null;
  readonly colorMode?: string | null;
  readonly palette?: string | null;
  readonly camera?: FigureCameraPose | null;
  readonly clip?: FigureClipSummary | null;
}

/** Fixed-precision triple: `1.000,-5.250,3.000`. 3 decimals ≈ mm at metre
 *  scale — plenty for "where was the camera", stable across float noise. */
function fmtTriple(v: readonly [number, number, number]): string {
  return `${v[0].toFixed(3)},${v[1].toFixed(3)},${v[2].toFixed(3)}`;
}

/**
 * Build the ordered text-chunk entries for one figure. Order is part of the
 * contract (tools display chunks in file order): the two registered keywords
 * first, then the `olv:*` facts from most to least universally present.
 */
export function buildFigureProvenance(input: FigureProvenanceInput): PngTextEntry[] {
  const entries: PngTextEntry[] = [
    { keyword: 'Software', text: FIGURE_SOFTWARE },
    { keyword: 'Creation Time', text: input.timestamp },
    { keyword: 'olv:build', text: input.build },
  ];

  if (input.crs) {
    const epsg = input.crs.epsg !== undefined ? ` (EPSG:${input.crs.epsg})` : '';
    entries.push({ keyword: 'olv:crs', text: `${input.crs.name}${epsg} · ${input.crs.unit}` });
  }

  // A palette only means something as a modifier of the colour mode it
  // ramps — a palette without a mode is not a colour mapping, so it emits
  // nothing rather than a free-floating ramp name.
  if (input.colorMode) {
    const palette = input.palette ? ` · ${input.palette}` : '';
    entries.push({ keyword: 'olv:colormap', text: `${input.colorMode}${palette}` });
  }

  if (input.camera) {
    const parts = [`pos ${fmtTriple(input.camera.position)}`];
    if (input.camera.target) parts.push(`target ${fmtTriple(input.camera.target)}`);
    if (input.camera.fovDeg !== undefined) parts.push(`fov ${input.camera.fovDeg.toFixed(1)}°`);
    entries.push({ keyword: 'olv:camera', text: parts.join(' · ') });
  }

  if (input.clip) {
    entries.push({
      keyword: 'olv:clip',
      text: `${input.clip.mode} · min ${fmtTriple(input.clip.min)} · max ${fmtTriple(input.clip.max)}`,
    });
  }

  return entries;
}

/**
 * Pull a palette label out of a mode-specific options bag without importing
 * the whole options union: the height-map exporter calls its ramp `ramp`,
 * the contour exporter calls its raster palette `palette`. `ramp` wins when
 * both appear (it is the more specific of the two). Non-string values are
 * never stringified — a number is not a palette name.
 */
export function paletteLabelOfOptions(
  options: Readonly<Record<string, unknown>> | undefined,
): string | null {
  if (!options) return null;
  if (typeof options.ramp === 'string') return options.ramp;
  if (typeof options.palette === 'string') return options.palette;
  return null;
}
