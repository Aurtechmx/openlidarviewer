/**
 * streamingCompatibility.ts — resolve a streaming cloud's compatibility state
 * against the static layers currently loaded.
 *
 * Lifted from `Viewer._streamingCompatibility`. The rule is the general
 * `classifyLayerCompatibility`, but the streaming caller needs one specific
 * answer — the STREAM's state, given everything else on screen — so it keyed
 * the stream under a reserved id, classified the whole set, and read that id
 * back. That adapter was a refusal boundary with no test: get it wrong and a
 * stream in a different frame silently joins a combined estimate.
 *
 * As a pure function it takes descriptors, not clouds, so the Viewer maps its
 * layer set (plain metadata reads, no three.js) and calls this. The reserved
 * id is generated so no real layer can occupy it.
 */

import { classifyLayerCompatibility } from '../model/layerCompatibility';
import type { CompatibilityInput, LayerCompatibility } from '../model/layerCompatibility';
import { compatibilityFrameOf } from '../model/compatibilityFrame';
import { resolvedFromCrsInfo, type CrsSource, type ResolvedCrs } from '../geo/CoordinateTypes';
import type { CrsInfo } from '../io/crs';

/** A layer descriptor without its id — the caller does not assign ids here. */
export type LayerFrame = Omit<CompatibilityInput, 'id'>;

/**
 * A reserved id for the stream that cannot collide with a real layer's.
 *
 * `classifyLayerCompatibility` keys by id, and static clouds are keyed by name.
 * A NUL byte cannot appear in a filename, and the prefix keeps it recognisable
 * in a debugger. Any static descriptor that carried this exact id would shadow
 * the stream's result, so it must be unreachable, not merely unlikely.
 */
const STREAM_ID = '\0openlidar:stream';

/**
 * The streaming cloud's compatibility state given the static layers.
 *
 * Returns `verified` when the stream stands alone or shares a full frame,
 * `horizontal-only` / `unknown` / `incompatible` otherwise — the same ladder
 * every layer is judged on. Falls back to `unknown` if the classifier somehow
 * omits the stream, which is the safe (unproven) answer.
 */
export function resolveStreamingCompatibility(
  statics: readonly LayerFrame[],
  stream: LayerFrame,
): LayerCompatibility {
  const inputs: CompatibilityInput[] = [
    ...statics.map((s, i) => ({ ...s, id: `static:${i}` })),
    { ...stream, id: STREAM_ID },
  ];
  const states = classifyLayerCompatibility(inputs);
  return states.get(STREAM_ID) ?? 'unknown';
}

/**
 * The CRS a layer is classified on: the host's resolved CRS (override applied)
 * when a resolver is wired, else the declared metadata. `resolved === undefined`
 * means no resolver; `null` is a resolver's answer and is kept.
 */
export function resolvedOrDeclared(
  resolved: ResolvedCrs | null | undefined,
  declared: CrsInfo | null | undefined,
  source: CrsSource = 'las-vlr',
): ResolvedCrs | null {
  return resolved !== undefined ? resolved : resolvedFromCrsInfo(declared ?? undefined, source);
}

/**
 * The stream's state from resolved CRSs, through the same descriptor adapter
 * the static layer list uses, so local-frame identity and overrides reach both.
 */
export function resolveStreamingCompatibilityFromCrs(
  statics: readonly (ResolvedCrs | null)[],
  stream: ResolvedCrs | null,
): LayerCompatibility {
  return resolveStreamingCompatibility(statics.map(compatibilityFrameOf), compatibilityFrameOf(stream));
}
