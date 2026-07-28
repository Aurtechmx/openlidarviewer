/**
 * colorModeSupport.ts
 *
 * Whether a cloud carries the attribute a colour mode needs.
 *
 * A preset declares the colour mode it moves into, and that mode is not
 * always available: an airborne survey with no classification field cannot
 * render Classification, and a photogrammetric cloud with no intensity cannot
 * render Intensity. Asking the renderer anyway produces a uniform wash, which
 * a user reads as a broken render rather than as absent data.
 *
 * Pure — no DOM, no three.js — so the rule is testable on its own and the
 * Viewer only decides what to do with the answer.
 */

import type { ColorMode } from './colorModes';

/** The attributes this check needs. Structural, so tests can pass a literal. */
export interface ColorModeCloudFacts {
  readonly colors?: Uint8Array;
  readonly intensity?: Uint16Array;
  readonly classification?: Uint8Array;
  readonly normals?: Float32Array;
  readonly gpsTime?: Float64Array;
}

const present = (a?: { length: number }): boolean => a != null && a.length > 0;

/**
 * True when `cloud` can be rendered in `mode`.
 *
 * Elevation and density derive from positions, which every cloud has, so they
 * are always available. Unknown modes return true rather than false: a mode
 * this function has not been taught about should fall through to the renderer
 * that owns it, not be silently suppressed here.
 */
export function cloudSupportsColorMode(cloud: ColorModeCloudFacts, mode: ColorMode): boolean {
  switch (mode) {
    case 'rgb':
      return present(cloud.colors);
    case 'intensity':
      return present(cloud.intensity);
    case 'classification':
      return present(cloud.classification);
    case 'normal':
      return present(cloud.normals);
    case 'gpsTime':
      return present(cloud.gpsTime);
    default:
      return true;
  }
}

/**
 * Which clouds should change colour mode, given the mode a preset asks for.
 *
 * Returned as a list of ids rather than performed here, so the decision stays
 * free of three.js and the Viewer keeps sole ownership of the mutation. A
 * cloud already in the mode is skipped, and so is one that cannot render it.
 */
export function planColorModeChanges(
  entries: Iterable<readonly [string, { readonly mode: ColorMode; readonly cloud: ColorModeCloudFacts }]>,
  mode: ColorMode,
): string[] {
  const ids: string[] = [];
  for (const [id, entry] of entries) {
    if (entry.mode === mode) continue;
    if (!cloudSupportsColorMode(entry.cloud, mode)) continue;
    ids.push(id);
  }
  return ids;
}

/** The parts of the Viewer this rule needs. Structural, so tests pass a literal. */
export interface ColorModeHost {
  readonly clouds: Iterable<readonly [string, { readonly mode: ColorMode; readonly cloud: ColorModeCloudFacts }]>;
  readonly streaming: {
    readonly currentMode: ColorMode;
    readonly sourceDefaultMode: ColorMode;
    setColorMode(mode: ColorMode): void;
  } | null;
  setCloudColorMode(id: string, mode: ColorMode): void;
  notifyColorContextChanged(): void;
}

/**
 * Move a host into `mode`, skipping anything that cannot render it.
 *
 * The whole rule lives here rather than in the Viewer: it is a decision about
 * data availability, not about rendering, and it is worth testing without a
 * GPU. The host interface keeps three.js out of this module.
 */
export function applyPresetColorMode(host: ColorModeHost, mode: ColorMode): void {
  for (const id of planColorModeChanges(host.clouds, mode)) host.setCloudColorMode(id, mode);
  const st = host.streaming;
  if (st && streamingShouldFollow(st.sourceDefaultMode, st.currentMode, mode)) {
    st.setColorMode(mode);
    host.notifyColorContextChanged();
  }
}

/**
 * Whether the streaming renderer should follow a preset into `mode`.
 *
 * The tiles carry only what the format serves, which the source reports as its
 * default mode. Elevation is the exception: it derives from position, which
 * every tile has.
 */
export function streamingShouldFollow(
  sourceDefaultMode: ColorMode,
  currentMode: ColorMode,
  mode: ColorMode,
): boolean {
  if (currentMode === mode) return false;
  return mode === 'elevation' || sourceDefaultMode === mode;
}
