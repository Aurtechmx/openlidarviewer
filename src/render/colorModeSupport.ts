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
 *
 * Applying a mode returns a `ColorModeApplication`: a caller that reports a
 * preset as applied needs to be able to see that one layer refused it, or it
 * will describe a scene the renderer is not showing.
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

/** A layer that kept its old mode because the requested one has no data behind it. */
export interface UnsupportedColorModeLayer {
  readonly id: string;
  /** The mode the layer stayed in. Reported so a caller can name what is on screen. */
  readonly keptMode: ColorMode;
}

/**
 * How each layer answered a requested colour mode.
 *
 * One pass over the layers, so a caller that both mutates and reports reads the
 * same decision twice rather than re-deriving it and risking a drift between
 * what was applied and what was announced.
 */
export interface ColorModePlan {
  /** Layers that can render the mode and are not in it yet. */
  readonly changed: readonly string[];
  /** Layers already in the mode. Nothing to do, and not a shortfall. */
  readonly unchanged: readonly string[];
  /** Layers that cannot render the mode at all. */
  readonly unsupported: readonly UnsupportedColorModeLayer[];
}

/**
 * Sort the layers into changed / unchanged / unsupported for `mode`.
 *
 * Returned as data rather than performed here, so the decision stays free of
 * three.js and the Viewer keeps sole ownership of the mutation.
 */
export function classifyColorModeChanges(
  entries: Iterable<readonly [string, { readonly mode: ColorMode; readonly cloud: ColorModeCloudFacts }]>,
  mode: ColorMode,
): ColorModePlan {
  const changed: string[] = [];
  const unchanged: string[] = [];
  const unsupported: UnsupportedColorModeLayer[] = [];
  for (const [id, entry] of entries) {
    if (entry.mode === mode) unchanged.push(id);
    else if (!cloudSupportsColorMode(entry.cloud, mode)) {
      unsupported.push({ id, keptMode: entry.mode });
    } else changed.push(id);
  }
  return { changed, unchanged, unsupported };
}

/**
 * Which clouds should change colour mode, given the mode a preset asks for.
 *
 * The ids `classifyColorModeChanges` put in `changed`. Kept as its own name
 * because "what do I mutate" is the only question most callers have.
 */
export function planColorModeChanges(
  entries: Iterable<readonly [string, { readonly mode: ColorMode; readonly cloud: ColorModeCloudFacts }]>,
  mode: ColorMode,
): string[] {
  return [...classifyColorModeChanges(entries, mode).changed];
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
 * What the streaming source did with a requested colour mode.
 *
 * `unavailable` is the only shortfall of the four: `none` means the session has
 * no streaming source to move, and `already` means it was in the mode.
 */
export type StreamingColorModeOutcome = 'none' | 'followed' | 'already' | 'unavailable';

/**
 * What a colour-mode move actually did.
 *
 * Returned rather than discarded because a caller that announces "preset
 * applied" has to know whether the preset was only PARTLY applied. A cloud with
 * no classification keeps the mode it had; presenting the whole preset as active
 * would describe a scene the renderer is not showing.
 */
export interface ColorModeApplication {
  /** The mode that was requested. */
  readonly mode: ColorMode;
  /** Layers moved into `mode`. */
  readonly changed: readonly string[];
  /** Layers already in `mode` before the call. */
  readonly unchanged: readonly string[];
  /** Layers that cannot render `mode`, with the mode each kept instead. */
  readonly unsupported: readonly UnsupportedColorModeLayer[];
  /** What the streaming source did. */
  readonly streaming: StreamingColorModeOutcome;
  /** True when at least one layer, or the streaming source, could not take `mode`. */
  readonly partial: boolean;
}

/**
 * Move a host into `mode`, skipping anything that cannot render it.
 *
 * The whole rule lives here rather than in the Viewer: it is a decision about
 * data availability, not about rendering, and it is worth testing without a
 * GPU. The host interface keeps three.js out of this module.
 *
 * The layers are classified in one pass BEFORE anything is mutated, so the
 * report describes the state the call started from and cannot count a layer
 * twice as `setCloudColorMode` changes it underneath the iteration.
 */
export function applyPresetColorMode(host: ColorModeHost, mode: ColorMode): ColorModeApplication {
  const plan = classifyColorModeChanges(host.clouds, mode);
  for (const id of plan.changed) host.setCloudColorMode(id, mode);
  const streaming = applyStreamingColorMode(host, mode);
  return {
    mode,
    ...plan,
    streaming,
    partial: plan.unsupported.length > 0 || streaming === 'unavailable',
  };
}

/**
 * Move the streaming source into `mode` if the tiles can carry it, and say which.
 *
 * Split out so the outcome is decided in one place: the mutation and the word
 * used to report it come from the same branch, so they cannot disagree.
 */
function applyStreamingColorMode(host: ColorModeHost, mode: ColorMode): StreamingColorModeOutcome {
  const st = host.streaming;
  if (!st) return 'none';
  if (st.currentMode === mode) return 'already';
  if (!streamingShouldFollow(st.sourceDefaultMode, st.currentMode, mode)) return 'unavailable';
  st.setColorMode(mode);
  host.notifyColorContextChanged();
  return 'followed';
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
