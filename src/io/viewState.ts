/**
 * viewState.ts
 *
 * The single capture/apply seam for a restorable view state — the bundle a
 * named saved view and the session's global state both use (see
 * `ViewStateBundle` in ./session). Two exports, one contract:
 *
 *   • `buildViewState` — emit-only-when-set pruning on the capture side, so
 *     an unset field is never serialised as noise and a camera-only view
 *     keeps its v6 byte-shape.
 *   • `applyViewStateInOrder` — the ordered apply on the restore side. The
 *     ORDER is the point: display fields first, camera strictly LAST, so a
 *     restored figure's framing can never be nudged by a later field (a
 *     clip re-fit, a filter-driven re-render, a render-settings change).
 *     Every field is independently guarded — an absent field never fires
 *     its sink, and no field's absence blocks another's application.
 *
 * The host (main.ts) supplies the sinks; this module supplies the order and
 * the guards. Keeping the orchestration here — pure, with type-only imports,
 * so it adds no runtime weight and no session-parser code to the eager
 * startup shell — is what lets the ordering contract be unit-tested at all:
 * main.ts is an app bootstrap that cannot be imported by a test.
 *
 * Streaming honesty: applying a bundle re-applies settings and re-renders.
 * On a streaming (COPC/EPT) cloud the resident node set varies with budget
 * and load order, so a restored state reproduces the recipe — camera, clip,
 * colour, filters — not byte-identical point membership.
 */

import type { SavedCameraState } from '../render/annotate/types';
import type { ColorMode } from '../render/colorModes';
import type { ClipBox } from '../render/clip/clipBox';
import type {
  SessionPointFilters,
  SessionRenderSettings,
  ViewStateBundle,
} from './session';

// Re-exported so the host can name the bundle type without importing the
// (lazily-loaded) session module by name — a type-only re-export, erased at
// compile time, so the parser chunk stays off the eager shell.
export type { ViewStateBundle } from './session';

/**
 * The host-side appliers, one per bundle field. Each receives a value that
 * is guaranteed present and non-empty (the guards live in
 * {@link applyViewStateInOrder}); host-specific preconditions that this
 * module cannot know — "the elevation window needs a loaded scan to convert
 * against" — stay inside the corresponding sink.
 */
export interface ViewStateSinks {
  render(settings: SessionRenderSettings): void;
  colorMode(mode: ColorMode): void;
  classFilter(hiddenCodes: number[]): void;
  pointFilters(filters: SessionPointFilters): void;
  clip(clip: ClipBox): void;
  camera(camera: SavedCameraState): void;
}

/**
 * Apply a view-state bundle through the host's sinks in the one supported
 * order, camera LAST. Fields are independently guarded: absent (or empty,
 * for the class filter) fields fire nothing, and skipping one never skips
 * another.
 */
export function applyViewStateInOrder(vs: ViewStateBundle, sinks: ViewStateSinks): void {
  if (vs.render) sinks.render(vs.render);
  if (vs.colorMode) sinks.colorMode(vs.colorMode);
  if (vs.classFilter && vs.classFilter.length > 0) sinks.classFilter(vs.classFilter);
  if (vs.pointFilters) sinks.pointFilters(vs.pointFilters);
  if (vs.clip) sinks.clip(vs.clip);
  // The camera goes last so the restored pose is the FINAL word on framing —
  // nothing applied after it can move the viewpoint a reviewer regenerates.
  if (vs.camera) sinks.camera(vs.camera);
}

/**
 * Prune a raw capture down to the fields that actually carry something:
 * an empty class filter, a point-filter block with no window, and absent
 * fields are all dropped. Returns `undefined` when NOTHING is set, so a
 * camera-only saved view can store "no bundle" rather than an empty object
 * (and serialise byte-identically to its v6 form).
 */
export function buildViewState(raw: ViewStateBundle): ViewStateBundle | undefined {
  const out: ViewStateBundle = {};
  if (raw.camera) out.camera = raw.camera;
  if (raw.render) out.render = raw.render;
  if (raw.colorMode) out.colorMode = raw.colorMode;
  if (raw.classFilter && raw.classFilter.length > 0) out.classFilter = raw.classFilter;
  if (raw.pointFilters && (raw.pointFilters.elevation || raw.pointFilters.intensity)) {
    out.pointFilters = raw.pointFilters;
  }
  if (raw.clip) out.clip = raw.clip;
  return Object.keys(out).length > 0 ? out : undefined;
}
