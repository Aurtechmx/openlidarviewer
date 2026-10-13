/**
 * boxToClip.ts — the "Use as clipping region" action on a Box measurement.
 *
 * Resolves the measurement by its stable id, runs the pure
 * {@link clipFromBoxMeasurement} decision, applies the clip through the Clip
 * panel's normal apply path, opens Tools → Clip and says what happened. The
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
  /** Open Tools → Clip. */
  readonly openClipPage: () => void;
  readonly toast: (message: string) => void;
}

/** Apply Box measurement `id` as the clip. Returns true when it was applied. */
export function useBoxAsClip(deps: BoxToClipDeps, id: string): boolean {
  const m = deps.measurements().find((x) => x.id === id);
  const result = clipFromBoxMeasurement(m, {
    activeLayerId: deps.activeLayerId(),
    layerCount: deps.layerCount(),
    vertical: deps.verticalExtent?.() ?? null,
  });
  if (!result.ok) {
    deps.toast(result.reason);
    return false;
  }
  deps.adoptClip(result.clip);
  deps.openClipPage();
  deps.frameClip?.();
  const h = result.heightExtended;
  deps.toast(h
    ? 'Clipping to the box: showing points inside it. The box was flat, so its height now spans the whole scan. Edit the bounds under Tools → Clip.'
    : 'Clipping to the box: showing points inside it. Edit the bounds under Tools → Clip.');
  return true;
}
