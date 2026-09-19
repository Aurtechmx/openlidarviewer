/**
 * presentationMode.ts
 *
 * What a captured figure is a picture OF, and what an exporter is allowed to
 * capture while the renderer is reconstructing pixels.
 *
 * Every Studio export renders to the live on-screen canvas and encodes what is
 * there. That is what makes a screenshot a screenshot: re-rendering the scene
 * some other way would hand back an image the user never saw, and an export
 * that quietly disagrees with the screen is worse than one that is labelled.
 * So the capture stays what the screen shows, and the figure says so.
 *
 * Saying so is not decoration here. The Continuity Field may put pixels on
 * screen that no sample was recorded at, and four of the seven raster modes
 * encode geometry in their pixel values: a height map's grey level is an
 * elevation, a depth map's is a range, a normal map's channels are a surface
 * orientation, a contour raster's lines are drawn from the same elevations.
 * Those files are read back as data by people who were not in the room. A
 * reconstructed pixel arriving in one of them is an invented elevation, and no
 * label on the side of the image prevents it from being read as a measurement.
 *
 * Hence two different answers rather than one. Appearance rasters are captured
 * as they stand and labelled. Geometry rasters suspend reconstruction for the
 * duration of the capture, so every pixel in the file traces back to a sample,
 * and the figure records the mode it was CAPTURED in rather than the mode the
 * live view was showing — the same rule the colour mode already follows, where
 * an export that forces `elevation` records `elevation` because that is the
 * artefact's truth.
 *
 * The line between invented and measured is drawn where the support vocabulary
 * already draws it. `accumulated` pixels are built from source samples across
 * frames of one epoch and trace back to measurements, so accumulation is not
 * reconstruction. `reconstructed` pixels are borrowed from neighbours by the
 * gap-closing pass and trace back to no sample of their own. Only micro-gap
 * fill invents, so only micro-gap fill triggers the refusal.
 *
 * Point-cloud data exports are not in scope and are unaffected. They are
 * written from the authoritative points, never from the framebuffer, so no
 * screen-space pass can reach them.
 *
 * Pure: no three.js, no canvas, no DOM. The caller owns the renderer and
 * performs the suspension; this decides only whether one is required and what
 * the resulting figure may claim.
 */
import type { ContinuityCapabilities } from '../render/continuity/continuityField';
import type { PngTextEntry } from './pngTextChunks';
import type { ExportMode } from './types';

/**
 * Whether a raster's pixel values are read back as geometry.
 *
 * The question is not whether the export is scientific — all of them are used
 * that way — but whether a pixel carries a number a reader would treat as
 * measured. An orthographic RGB pixel is an appearance; a height-map pixel is
 * an elevation. Intensity sits with appearance on purpose: it is a recorded
 * attribute rather than a position, and inventing one misstates a return
 * strength, not a coordinate.
 */
export const GEOMETRY_BEARING_MODES: readonly ExportMode[] = [
  'height-map',
  'depth',
  'normal',
  'contour',
];

/** Whether {@link GEOMETRY_BEARING_MODES} contains `mode`. */
export function encodesGeometry(mode: ExportMode): boolean {
  return GEOMETRY_BEARING_MODES.includes(mode);
}

/**
 * Whether the capabilities in force can put a pixel on screen that no sample
 * was recorded at.
 *
 * Micro-gap fill alone. Coverage sizing changes how large a sample is drawn,
 * which moves no pixel off the evidence; accumulation composes a pixel from
 * samples across frames, which keeps it traceable to measurements.
 */
export function reconstructsPixels(caps: ContinuityCapabilities): boolean {
  return caps.microGapFill;
}

/** What an exporter must do to the renderer before it captures. */
export type CapturePolicy =
  /** Capture the screen as it stands. */
  | 'as-is'
  /** Turn reconstruction off for the capture, then restore it. */
  | 'suspend-reconstruction';

/**
 * The policy for one export.
 *
 * A raster that encodes geometry gets the suspension whenever reconstruction
 * is possible; everything else is captured as it stands.
 */
export function capturePolicyFor(
  mode: ExportMode,
  caps: ContinuityCapabilities,
): CapturePolicy {
  return encodesGeometry(mode) && reconstructsPixels(caps)
    ? 'suspend-reconstruction'
    : 'as-is';
}

/** How the pixels in a captured figure were produced. */
export type PresentationMode =
  /** Samples rasterised as they are. Nothing added. */
  | 'source'
  /** Samples sized from local coverage. No pixel without a sample. */
  | 'coverage-sized'
  /** Pixels composed across frames, each tracing back to samples. */
  | 'accumulated'
  /** Gaps between samples closed. Some pixels were not measured. */
  | 'reconstructed';

/**
 * The presentation mode of the CAPTURED figure.
 *
 * Takes the policy as well as the capabilities because a suspended capture is
 * not a picture of the live view: the exporter turned reconstruction off, so
 * the file contains no invented pixel and must not be labelled as if it did.
 * Labelling it by what the screen was doing a moment earlier would be a false
 * warning, and a warning that is wrong the first time is ignored the tenth.
 *
 * Richest description wins: a frame that reconstructs also accumulates and
 * sizes, and the one word a reader needs is the one that carries the caveat.
 */
export function presentationOfCapture(
  caps: ContinuityCapabilities,
  policy: CapturePolicy,
): PresentationMode {
  if (policy !== 'suspend-reconstruction' && reconstructsPixels(caps)) {
    return 'reconstructed';
  }
  if (caps.temporalAccumulation) return 'accumulated';
  if (caps.coverageSizing) return 'coverage-sized';
  return 'source';
}

/** Whether a figure in this mode contains pixels no sample was recorded at. */
export function containsInventedPixels(mode: PresentationMode): boolean {
  return mode === 'reconstructed';
}

/**
 * The presentation entries for a figure's PNG text chunks.
 *
 * Two keys at most. `olv:presentation` is always emitted: 'source' is a fact
 * about the figure worth stating, not an absence, and a reader who finds no
 * presentation key on some figures and 'source' on others cannot tell an
 * un-stamped file from a plainly rendered one.
 *
 * `olv:reconstructed-share` is emitted only when the figure actually contains
 * invented pixels AND a caller counted them. Capabilities say what the renderer
 * was permitted to do; only a census says what it did, and a share inferred
 * from the permission would be a number nobody counted.
 *
 * The share arrives already computed rather than as a census to tally here,
 * which keeps one definition of it. `reconstructedShare` in `supportCensus`
 * owns that definition, including the decision to exclude background from the
 * denominator, and a second implementation on this side of the boundary would
 * be free to drift from it. It also keeps this module free of any runtime
 * dependency on the renderer: a figure's metadata needs a number, not a
 * framebuffer.
 *
 * Null means no counted share — nothing was censused, or the frame drew
 * nothing. Both are the same absence to a reader, and the honesty contract
 * shared with `figureProvenance` emits no entry for a fact that is not known. A
 * share outside `[0, 1]`, or one that is not finite, is treated the same way:
 * it is not a share, and printing it would put a figure nobody measured into a
 * file that outlives this app.
 */
export function buildPresentationProvenance(
  mode: PresentationMode,
  reconstructedShare?: number | null,
): PngTextEntry[] {
  const entries: PngTextEntry[] = [{ keyword: 'olv:presentation', text: mode }];
  if (!containsInventedPixels(mode)) return entries;
  const share = reconstructedShare;
  if (share == null || !Number.isFinite(share) || share < 0 || share > 1) return entries;
  entries.push({
    keyword: 'olv:reconstructed-share',
    text: `${(share * 100).toFixed(2)}% of drawn pixels closed from neighbours`,
  });
  return entries;
}
