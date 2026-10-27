/**
 * boxToClip.ts — the "Use as clipping region" action on a Box measurement.
 *
 * Resolves the measurement by its stable id, runs the pure
 * {@link clipFromBoxMeasurement} decision, applies the clip through the Clip
 * panel's normal apply path, opens Tools → Clip box and says what happened. The
 * shell supplies everything through narrow accessors, so this is testable in
 * Node and adds one call site to `main.ts`.
 */

import { clipFromBoxMeasurement, type BoxMeasurementLike, type VerticalExtent } from '../render/clip/clipFromMeasurement';
import type { ClipBox } from '../render/clip/clipBox';

export interface BoxToClipDeps {
  /** Completed measurements (never the draft). */
  readonly measurements: () => readonly BoxMeasurementLike[];
  readonly activeLayerId: () => string | null;
  readonly layerCount: () => number;
  /** The scan's vertical extent in the clip's frame, or null when unknown. */
  readonly verticalExtent?: () => VerticalExtent | null;
  /** The Clip panel's public apply entry (`ClipPanel.adoptBounds`). */
  readonly adoptClip: (clip: ClipBox) => void;
  /** Glide the camera to the kept volume, so the orbit pivot is in what is drawn. */
  readonly frameClip?: () => void;
  /** Open Tools → Clip box. */
  readonly openClipPage: () => void;
  readonly toast: (message: string) => void;
}

/** How the box being turned into a clip was drawn. */
export interface BoxToClipOptions {
  /**
   * The box is a footprint: drawn with "Draw clipping box", or drawn looking
   * straight down. Its height is where two clicks happened to land, so the
   * clip takes the scan's full height instead.
   */
  readonly fullHeight?: boolean;
}

/** Apply Box measurement `id` as the clip. Returns true when it was applied. */
export function useBoxAsClip(deps: BoxToClipDeps, id: string, opts: BoxToClipOptions = {}): boolean {
  const m = deps.measurements().find((x) => x.id === id);
  const result = clipFromBoxMeasurement(m, {
    activeLayerId: deps.activeLayerId(),
    layerCount: deps.layerCount(),
    vertical: deps.verticalExtent?.() ?? null,
    fullHeight: opts.fullHeight === true || (m as { clipRegion?: boolean } | undefined)?.clipRegion === true,
  });
  if (!result.ok) {
    deps.toast(result.reason);
    return false;
  }
  deps.adoptClip(result.clip);
  deps.openClipPage();
  deps.frameClip?.();
  deps.toast(boxClipToast(result.heightExtended?.reason ?? null));
  return true;
}

/** What the toast says after a box became the clip, by why its height changed (if it did). */
export function boxClipToast(height: 'flat' | 'footprint' | null): string {
  const edit = 'Edit the bounds on Tools → Clip box.';
  if (height === 'footprint') return `Clipping to the box at the scan's full height: showing every point above and below its footprint. ${edit}`;
  if (height === 'flat') return `Clipping to the box: showing points inside it. The box was flat, so its height now spans the whole scan. ${edit}`;
  return `Clipping to the box: showing points inside it. ${edit}`;
}
